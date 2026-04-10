# Upstream PR 6 — Task Flow: `octo_mirrored` sync mode and `octo.mission` step type

**Status:** draft (M0-20). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target file:** `src/tasks/task-flow-registry.types.ts` (primary), plus a small additive hook in `src/tasks/task-flow-registry.ts` (constructor + ingestion entry point).
**Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Extend Task Flow with the minimal upstream surface needed to host mirrored Octopus Orchestrator missions as first-class flow records. Three additive changes:

1. A new `TaskFlowSyncMode` variant, `"octo_mirrored"`, sibling to the existing `"task_mirrored"` and `"managed"` modes. Semantics: the flow record is an observer-only projection whose state of record lives in an external owner (the Octopus event log).
2. A reserved current-step vocabulary entry, `octo.mission`, used as `currentStep` on octo-mirrored flows so any future step-type-aware consumer can discriminate. Task Flow's `currentStep` is currently a free-form string, so this is a vocabulary reservation, not a schema change.
3. A new constructor, `createTaskFlowForOctoMission(...)`, and an ingestion entry point, `applyOctoMissionEvent(...)`, that maps an octo event envelope to a Task Flow patch. Both are thin wrappers over the existing `createFlowRecord` / `updateFlowRecordByIdExpectedRevision` surface, added so the octo adapter has a single, named seam to target.

This PR does NOT add an octo dispatcher, does not wire Task Flow into the Octopus event bus, and does not change any existing Task Flow state transitions. It exposes a named surface; the octo side binds to it via `src/octo/adapters/openclaw/taskflow-bridge.ts` (see Reviewer guidance).

## Rationale

- **Mirrored mode is observer-only by construction.** Per OCTO-DEC-030, every Octopus mission automatically creates a mirrored Task Flow record so existing `openclaw tasks flow list` consumers see octo work as a first-class flow without reimplementing flow tracking. The authoritative mission state lives in the Octopus event log; the Task Flow record is a projection. Distinguishing `"octo_mirrored"` from `"managed"` is how Task Flow learns "do not schedule, do not reconcile, do not treat `endedAt` as a liveness signal — this record is driven from outside."
- **Reuse `task_mirrored`'s existing restraint.** Task Flow already models a non-managed projection for background tasks via `syncMode: "task_mirrored"` (see `createTaskFlowForTask`). The guardrail at `task-flow-registry.ts` that rejects patches when `syncMode !== "task_mirrored"` (lines ~299, ~621 of the current file) is the exact pattern octo needs. Adding `"octo_mirrored"` as a sibling — rather than overloading `task_mirrored` with a source discriminator — keeps the two projection sources independent: task-mirrored flows follow the task lifecycle, octo-mirrored flows follow mission events, and neither needs to branch on the other.
- **`octo.mission` as a step-type vocabulary reservation, not a schema.** Task Flow's `currentStep` field is a free-form string today (see `TaskFlowRecord.currentStep?: string` in `task-flow-registry.types.ts`). Reserving `octo.mission` as the canonical value for octo-mirrored flows lets future consumers (doctor, dashboards, future step-type registries) discriminate without forcing a strict-union change now. If/when Task Flow grows a real step-type registry, `octo.mission` is already in the vocabulary.
- **Event ingestion is a named seam, not a subsystem.** `applyOctoMissionEvent` is deliberately thin — it receives an `{ flowId, expectedRevision, event }` triple and translates a small fixed set of octo event kinds (`mission.started`, `mission.step`, `mission.waiting`, `mission.completed`, `mission.failed`, `mission.cancelled`) to the existing `FlowRecordPatch` shape. The translation table is intentionally short and lives next to the constructor so reviewers can see the full surface in one place.
- **No behavior change for non-octo deployments.** With `octo.enabled: false` (the default through Milestone 1), nothing constructs an `octo_mirrored` flow and nothing calls `applyOctoMissionEvent`. The new variant is unreachable at runtime, the reserved `currentStep` string is never written, and existing Task Flow callers are unaffected.

## Expected changes

1. **`src/tasks/task-flow-registry.types.ts`**: extend `TaskFlowSyncMode` to include `"octo_mirrored"`. Add an exported string constant `OCTO_MISSION_STEP_TYPE = "octo.mission"` alongside the types, as the canonical `currentStep` vocabulary entry.
2. **`src/tasks/task-flow-registry.ts`**:
   - Extend `normalizeRestoredFlowRecord`'s `syncMode` ternary to recognize `"octo_mirrored"` as a valid restored value (no `controllerId` required, matching `task_mirrored`).
   - Add the `createTaskFlowForOctoMission(params)` constructor next to `createTaskFlowForTask`. It delegates to `createFlowRecord` with `syncMode: "octo_mirrored"`, `currentStep: OCTO_MISSION_STEP_TYPE`, and caller-provided `ownerKey`, `goal`, `notifyPolicy`, and `requesterOrigin`.
   - Add `applyOctoMissionEvent({ flowId, expectedRevision, event })` that routes to `updateFlowRecordByIdExpectedRevision` with a patch derived from the event kind. The event envelope shape is intentionally narrow: `{ kind: string; summary?: string; stateJson?: JsonValue; blockedSummary?: string; endedAt?: number }`. The full octo event type stays in `src/octo/wire/events.ts`; Task Flow only sees the projection.
   - Relax the `current.syncMode === "managed"` guard in `updateFlowRecordByIdUnchecked`/`applyFlowPatch` to also permit `"octo_mirrored"` updates through `applyOctoMissionEvent` (but not through the generic patch path). The simplest shape: add a capability check that allows observer-mode patches only via the named entry point.

Exact file layout of the delta is in the diff preview below.

## Diff preview

```diff
--- a/src/tasks/task-flow-registry.types.ts
+++ b/src/tasks/task-flow-registry.types.ts
@@ -9,7 +9,13 @@ export type JsonValue =
   | JsonValue[]
   | { [key: string]: JsonValue };

-export type TaskFlowSyncMode = "task_mirrored" | "managed";
+export type TaskFlowSyncMode = "task_mirrored" | "managed" | "octo_mirrored";
+
+// Reserved currentStep vocabulary entry for octo-mirrored flows.
+// Task Flow's currentStep is free-form today; this constant pins the
+// canonical value so future step-type-aware consumers can discriminate
+// mirrored Octopus mission flows without a schema migration.
+export const OCTO_MISSION_STEP_TYPE = "octo.mission" as const;

 export type TaskFlowStatus =
   | "queued"
--- a/src/tasks/task-flow-registry.ts
+++ b/src/tasks/task-flow-registry.ts
@@ -12,6 +12,7 @@ import type {
   TaskFlowStatus,
   TaskFlowSyncMode,
   JsonValue,
+  OCTO_MISSION_STEP_TYPE,
 } from "./task-flow-registry.types.js";
 import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";

@@ -90,7 +91,11 @@ function cloneFlowRecord(record: TaskFlowRecord): TaskFlowRecord {
 }

 function normalizeRestoredFlowRecord(record: TaskFlowRecord): TaskFlowRecord {
-  const syncMode = record.syncMode === "task_mirrored" ? "task_mirrored" : "managed";
+  const syncMode: TaskFlowSyncMode =
+    record.syncMode === "task_mirrored"
+      ? "task_mirrored"
+      : record.syncMode === "octo_mirrored"
+        ? "octo_mirrored"
+        : "managed";
   const controllerId =
     syncMode === "managed"
       ? (normalizeOptionalString(record.controllerId) ?? "core/legacy-restored")
@@ -435,6 +440,48 @@ export function createTaskFlowForTask(params: {
   });
 }

+export type OctoMissionEventEnvelope = {
+  kind:
+    | "mission.started"
+    | "mission.step"
+    | "mission.waiting"
+    | "mission.completed"
+    | "mission.failed"
+    | "mission.cancelled";
+  summary?: string;
+  stateJson?: JsonValue;
+  blockedSummary?: string;
+  endedAt?: number;
+};
+
+export function createTaskFlowForOctoMission(params: {
+  ownerKey: string;
+  goal: string;
+  notifyPolicy: TaskNotifyPolicy;
+  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
+  createdAt?: number;
+}): TaskFlowRecord {
+  return createFlowRecord({
+    syncMode: "octo_mirrored",
+    ownerKey: params.ownerKey,
+    goal: params.goal,
+    notifyPolicy: params.notifyPolicy,
+    requesterOrigin: params.requesterOrigin,
+    currentStep: OCTO_MISSION_STEP_TYPE,
+    status: "queued",
+    createdAt: params.createdAt,
+  });
+}
+
+export function applyOctoMissionEvent(params: {
+  flowId: string;
+  expectedRevision: number;
+  event: OctoMissionEventEnvelope;
+}): TaskFlowUpdateResult {
+  return updateFlowRecordByIdExpectedRevision({
+    flowId: params.flowId,
+    expectedRevision: params.expectedRevision,
+    patch: mapOctoEventToPatch(params.event),
+  });
+}
+
 function updateFlowRecordByIdUnchecked(
   flowId: string,
   patch: FlowRecordPatch,
```

The helper `mapOctoEventToPatch` is a straight switch over `event.kind` returning a `FlowRecordPatch` (`mission.started` → `{ status: "running" }`, `mission.waiting` → `{ status: "waiting", waitJson: event.stateJson }`, `mission.completed` → `{ status: "succeeded", endedAt: event.endedAt }`, etc.) and lives in the same file directly below `applyOctoMissionEvent`. Omitted from the diff preview for brevity; the upstream maintainer will likely want to place it next to existing status-mapping helpers.

## Test plan

- `pnpm test` — all existing `task-flow-registry*.test.ts` tests must continue to pass. The new `"octo_mirrored"` arm of `normalizeRestoredFlowRecord` should not affect any existing fixture (no existing persisted record has that syncMode).
- Add a unit test: `createTaskFlowForOctoMission` produces a record with `syncMode: "octo_mirrored"`, `currentStep: "octo.mission"`, `status: "queued"`, and no `controllerId`.
- Add a unit test: `applyOctoMissionEvent` with `kind: "mission.completed"` transitions a queued octo-mirrored flow to `succeeded` with a populated `endedAt`.
- Add a unit test: a `managed`-mode flow rejects `applyOctoMissionEvent` (the guardrail should recognize mode mismatch and return `{ applied: false, reason: ... }` rather than clobber managed state).
- Manual: `openclaw tasks flow list` on a deployment with a hand-crafted octo-mirrored record must show the record with `currentStep` = `octo.mission` and status transitions driven only by the ingestion hook.

## Rollback plan

Revert the two-file delta. Because no existing caller constructs `octo_mirrored` flows and no restored fixture carries that syncMode, the only effect of a revert is removing the named seam the octo bridge targets. The octo adapter falls back gracefully per `src/octo/adapters/openclaw/taskflow-bridge.ts` rollback plan: "mirrored mode degrades to no flow records written; missions continue to run on their own state of record, the only loss is visibility in the Task Flow UI."

## Dependencies on other PRs

- Soft dependency on PR 1 (`octo.*` method registration in `server-methods-list.ts`). This PR does not call those methods, but the observable behavior (`openclaw tasks flow list` showing octo missions) only matters when `octo.enabled: true`, which assumes the method surface is reachable.
- No hard dependency on any earlier PR in the wave; this surface can land independently and sit dormant until the octo side binds to it.

## Reviewer guidance

Reviewer does not need to understand the full Octopus Orchestrator design to merge this PR. The single review question is: "should Task Flow host a second observer-mode projection source, distinct from the existing `task_mirrored` task-backed projection, with a narrow named ingestion seam?" The answer is yes because the alternative is a parallel flow registry that fragments `openclaw tasks flow list` — exactly the outcome OCTO-DEC-030 is designed to avoid.

**Bridge relationship (OCTO-DEC-033).** The downstream octo consumer of this surface is `src/octo/adapters/openclaw/taskflow-bridge.ts`, currently a placeholder landed in Octopus milestone M0-10. That file wraps the exact exports this PR adds: `createTaskFlowForOctoMission`, `applyOctoMissionEvent`, `OctoMissionEventEnvelope`, `OCTO_MISSION_STEP_TYPE`, and the `"octo_mirrored"` syncMode literal. No other Octopus code imports Task Flow directly. When upstream Task Flow's internals change shape, the bridge absorbs the diff. Reviewers should therefore feel free to rename, relocate, or restructure the new exports inside the Task Flow module as long as the named surface remains resolvable — the octo side is designed to follow.

**Ambiguities the maintainer should resolve.**

- The octo team identified `src/tasks/task-flow-registry.ts` and `src/tasks/task-flow-registry.types.ts` as the clearest entry points, but the Octopus integration doc (`docs/octopus-orchestrator/INTEGRATION.md`) historically referred to a hypothetical `src/taskflow/step-types.ts`, which does not exist in the current tree. If Task Flow grows a dedicated step-type module in the future, `OCTO_MISSION_STEP_TYPE` should move there.
- Task Flow's `currentStep` is a free-form string today. If the maintainer prefers a strict union discriminator instead of a vocabulary constant, the octo side is happy to follow — the bridge will adapt.
- `applyOctoMissionEvent`'s envelope shape (`kind` enum) is deliberately minimal. If Task Flow already has a richer event-ingestion convention the octo team should reuse, please point us at it and we will rewrite the ingestion helper against that convention.

For full Octopus context: `docs/octopus-orchestrator/HLD.md`, `docs/octopus-orchestrator/INTEGRATION.md` §Task Flow (formerly ClawFlow), `docs/octopus-orchestrator/DECISIONS.md` (OCTO-DEC-030 mirrored-mode default, OCTO-DEC-033 bridge file placement).
