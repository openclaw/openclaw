# Upstream PR 5 — Cron job type `octo.mission`

**Status:** draft (M0-19). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target files:**

- `src/gateway/protocol/schema/cron.ts`
- `src/cron/service/timer.ts`
- `src/cron/types.ts`

**Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Add a new cron payload variant, `kind: "octo.mission"`, so a cron entry in `openclaw.json` can launch an Octopus Orchestrator mission on a schedule. When the cron runtime fires an `octo.mission` job, it dispatches `octo.mission.create` via the existing Gateway pipeline, tagging the resulting mission with `metadata.source: "cron"` and `metadata.cron_id: <jobId>`.

Cron execution semantics — isolated session allocation, stagger, timezone handling, run-log persistence, failure alerts — are unchanged. Only the dispatch action in the isolated-job branch is new. The new variant joins the existing `payload.kind` discriminated union (`systemEvent`, `agentTurn`, `octo.mission`).

A notational aside: `docs/octopus-orchestrator/INTEGRATION.md` §Automation trigger surfaces documents this shape with a top-level `type: "octo.mission"` field for brevity. In the real schema the discriminator lives on `payload.kind`, consistent with `agentTurn`/`systemEvent`. The INTEGRATION.md example is shorthand; the normative shape is the one in this PR's diff.

## Rationale

- **Cron is the first automation trigger surface for Octopus.** Per INTEGRATION.md, the orchestrator needs three inbound trigger surfaces: cron, webhook, and manual RPC. Cron is the lowest-risk starting point because the scheduling, isolation, and run-log infrastructure already exist — this PR only adds a new dispatch leaf.
- **Discriminated-union extension matches the existing pattern.** The cron payload is already a TypeBox `Type.Union` over `kind` literals. Adding `octo.mission` follows the same pattern as the existing `agentTurn` variant; the dispatcher switch in `executeDetachedCronJob` grows one branch.
- **Feature flag enforcement lives at dispatch, not at schedule.** Per OCTO-DEC-027, when `octo.enabled: false` the Octopus subsystem is inert. Cron still fires on schedule regardless of `octo.enabled`, but the dispatcher returns a structured `{ status: "skipped", error: "octo.mission dispatch: not_enabled" }` outcome. This matches how other subsystem-disabled paths surface in cron run logs, and it keeps the cron fire-loop decoupled from the Octopus runtime state.
- **Isolation is inherited from the existing `isolated` session target.** An `octo.mission` job's `sessionTarget` must be `isolated` (same as `agentTurn`). Running mission dispatch against a user's main session would conflate roles; cron mission jobs are always detached.
- **Provenance via `metadata.source` / `metadata.cron_id`.** Missions created by cron carry these two fields so mission-history listings and the Octopus dashboard can filter cron-launched work from user-initiated work. The cron_id is the existing job id, so cross-referencing `cron.runs.tail` with `octo.mission.list` is trivial.

## Expected changes

Three files touched:

1. **`src/gateway/protocol/schema/cron.ts`** — Extend `CronPayloadSchema` (and `CronPayloadPatchSchema`) to include the `octo.mission` variant: `kind: Type.Literal("octo.mission")`, `template: NonEmptyString`, optional `args: Type.Record(Type.String(), Type.Unknown())`.
2. **`src/cron/service/timer.ts`** — In `executeDetachedCronJob`, replace the bare `job.payload.kind !== "agentTurn"` gate with a switch over `kind` so `octo.mission` dispatches via the new `deps.dispatchOctoMissionCreate` helper (injected like the existing `runIsolatedAgentJob`). The new helper returns a `CronRunOutcome`-shaped result; the `not_enabled` case is surfaced as `status: "skipped"`.
3. **`src/cron/types.ts`** — Add `CronOctoMissionPayload` to the `CronPayload` union and define its fields (`template`, `args`).

Dispatcher wiring note: `deps.dispatchOctoMissionCreate` is injected by the same `CronServiceState.deps` factory that already supplies `runIsolatedAgentJob`. In the default binding it calls the Gateway's `octo.mission.create` handler through the in-process dispatch path (no HTTP hop). When `octo.enabled: false`, the handler returns `not_enabled` synchronously and the dispatcher records a `skipped` outcome.

## Diff preview

```diff
--- a/src/gateway/protocol/schema/cron.ts
+++ b/src/gateway/protocol/schema/cron.ts
@@ -130,6 +130,15 @@ export const CronPayloadSchema = Type.Union([
   cronAgentTurnPayloadSchema({
     message: NonEmptyString,
     toolsAllow: Type.Array(Type.String()),
   }),
+  Type.Object(
+    {
+      kind: Type.Literal("octo.mission"),
+      template: NonEmptyString,
+      args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
+    },
+    { additionalProperties: false },
+  ),
 ]);

--- a/src/cron/service/timer.ts
+++ b/src/cron/service/timer.ts
@@ -1253,9 +1253,29 @@ async function executeDetachedCronJob(
 ): Promise<
   CronRunOutcome & CronRunTelemetry & { delivered?: boolean; deliveryAttempted?: boolean }
 > {
-  if (job.payload.kind !== "agentTurn") {
-    return { status: "skipped", error: "isolated job requires payload.kind=agentTurn" };
+  const kind = job.payload.kind;
+  if (kind === "octo.mission") {
+    if (abortSignal?.aborted) return resolveAbortError();
+    const res = await state.deps.dispatchOctoMissionCreate({
+      cronId: job.id,
+      template: job.payload.template,
+      args: job.payload.args,
+      abortSignal,
+    });
+    // Feature flag off: surface as skipped, do NOT retry. Cron logs once.
+    if (res.status === "not_enabled") {
+      return { status: "skipped", error: "octo.mission dispatch: not_enabled" };
+    }
+    return {
+      status: res.status,
+      error: res.error,
+      summary: res.summary,
+      sessionId: res.missionId,
+    };
+  }
+  if (kind !== "agentTurn") {
+    return { status: "skipped", error: "isolated job requires payload.kind in {agentTurn,octo.mission}" };
   }
   if (abortSignal?.aborted) {
     return resolveAbortError();
   }

--- a/src/cron/types.ts
+++ b/src/cron/types.ts
@@ -84,7 +84,14 @@ export type CronFailureAlert = {
   accountId?: string;
 };

-export type CronPayload = { kind: "systemEvent"; text: string } | CronAgentTurnPayload;
+export type CronOctoMissionPayload = {
+  kind: "octo.mission";
+  template: string;
+  args?: Record<string, unknown>;
+};
+
+export type CronPayload =
+  | { kind: "systemEvent"; text: string }
+  | CronAgentTurnPayload
+  | CronOctoMissionPayload;
```

## Test plan

- `pnpm test src/gateway/protocol/cron-validators.test.ts` — extend to accept a valid `octo.mission` payload and reject one missing `template`.
- `pnpm test src/cron/service/timer.test.ts` — new case: an isolated job with `payload.kind=octo.mission` triggers `deps.dispatchOctoMissionCreate` exactly once and records a successful outcome.
- `pnpm test src/cron/service/timer.regression.test.ts` — new case: when `dispatchOctoMissionCreate` returns `not_enabled`, the run record is `status=skipped` with the explicit error string, and the job is NOT disabled (next fire still computes).
- Manual: configure a minute-level `octo.mission` cron job in `openclaw.json` with `octo.enabled: true`; verify mission appears in `octo.mission.list` with `metadata.source="cron"` and `metadata.cron_id` matching the job id.
- Manual: flip `octo.enabled: false`, verify cron still fires but run-log shows `skipped / not_enabled` with no mission created.

## Rollback plan

Revert the three hunks. Because `octo.mission` is additive to a discriminated union, existing stored jobs are unaffected (they use `systemEvent` or `agentTurn`). No migration of `cron/store.json` is required either on rollout or rollback.

## Dependencies on other PRs

- PR 1 (M0-15) — `octo.*` methods registered in `server-methods-list.ts`; the dispatcher needs `octo.mission.create` visible.
- PR 2 (M0-16) — `octo.enabled` config flag parsed from `openclaw.json`, for the `not_enabled` gate.
- Does NOT depend on PR 3 (`octo.mission.create` handler implementation) to MERGE — the dispatcher talks to `deps.dispatchOctoMissionCreate`, and in a split-rollout the default binding can stub to `{ status: "not_enabled" }` until PR 3 lands.

## Reviewer guidance

The reviewer should focus on two questions:

1. Is adding a new variant to the `payload.kind` union the right extension point, versus a sibling top-level `type` field? The union is the right answer: every code path that already switches on `payload.kind` (normalize, delivery-plan, timeout-policy, initial-delivery) gets exhaustiveness-checked by the TS compiler, which flags any path that forgot to handle `octo.mission`. A sibling `type` field would silently bypass those checks.
2. Is `not_enabled` a skip or an error in the run log? This PR chooses `skipped` to match how other "subsystem off" paths surface (they do not pollute the error counters and do not trigger failure-alert cooldowns). If reviewers prefer `error` semantics the change is localized to one branch.

For full Octopus context: `docs/octopus-orchestrator/INTEGRATION.md` §Automation trigger surfaces, `docs/octopus-orchestrator/DECISIONS.md` OCTO-DEC-027 (feature flag).
