# Upstream PR 7 — Route `octo.*` lifecycle events through the internal hook dispatcher

**Status:** draft (M0-21). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target file:** `src/hooks/internal-hooks.ts`
**Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Extend the `InternalHookEventType` union in `src/hooks/internal-hooks.ts` with a new `"octo"` event type so that user-defined hooks in `~/.openclaw/hooks/` can react to Octopus Orchestrator lifecycle events (mission create, arm spawn, arm completed). This is a vocabulary-only change: the dispatcher machinery (`registerInternalHook`, `triggerInternalHook`, `hasInternalHookListeners`, `createInternalHookEvent`) is generic over the event type and requires no behavioral changes.

Octo dispatch sites that call `triggerInternalHook(createInternalHookEvent("octo", "mission.create", ...))` land in the Octopus control-plane code in a later PR; this PR just opens the door in the central union so those call sites type-check.

## Rationale

- **Single typed union is the integration seam.** `InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message"` is the one place the hook subsystem enumerates lifecycle event families. Adding `"octo"` here is the minimum-surface-area edit that unblocks typed dispatch everywhere else.
- **No runtime changes.** The handler registry (`Map<string, InternalHookHandler[]>`) is keyed by string and already handles `"${type}:${action}"` lookups uniformly. Adding a new type literal costs zero runtime behavior for deployments that never fire `octo.*` events.
- **Feature-flag gating is automatic.** When `octo.enabled: false` (default through Milestone 1), no octo subsystem code runs, so no `octo.*` events are produced. The dispatch sites added in later PRs are dead code in that configuration. No runtime gating is needed at the hook layer itself — the absence of producers is the gate.
- **User-authored hooks need a stable event vocabulary.** Hook authors declare the events they listen to via `events:` in frontmatter (see `src/hooks/frontmatter.ts`, `resolveOpenClawMetadata`). That field is a free-form string list today, so authors can write `events: [octo:mission.create]` once the dispatcher produces the event. Registering the type in the union makes the vocabulary first-class rather than a convention.
- **Parallel with `"message"`.** The `"message"` type already uses a multi-word dotted action namespace (`received`, `sent`, `transcribed`, `preprocessed`). The octo type follows the same shape with `mission.create`, `arm.spawn`, `arm.completed`, so there is nothing novel to learn for reviewers or hook authors.

## Expected changes

One edit to `src/hooks/internal-hooks.ts`:

1. **Extend the `InternalHookEventType` union** with `"octo"`, appended at the end to keep the diff minimal and preserve the existing ordering of existing types.

No other edits are required:

- `hooks.ts` re-exports the type via `import("./internal-hooks.js").InternalHookEventType`, so the re-export picks up the new literal automatically.
- `frontmatter.ts` treats `events` as a string list and does not validate against the union, so hook manifests referencing `octo:*` will parse without changes.
- `policy.ts`, `loader.ts`, `module-loader.ts`, and the bundled handlers (`src/hooks/bundled/*`) do not branch on event type literals and need no changes.
- The dispatcher functions (`registerInternalHook`, `triggerInternalHook`, `hasInternalHookListeners`, `createInternalHookEvent`) accept `InternalHookEventType` and work unchanged.

## Diff preview

```diff
--- a/src/hooks/internal-hooks.ts
+++ b/src/hooks/internal-hooks.ts
@@ -14,7 +14,13 @@ import { formatErrorMessage } from "../infra/errors.js";
 import { createSubsystemLogger } from "../logging/subsystem.js";
 import { resolveGlobalSingleton } from "../shared/global-singleton.js";

-export type InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message";
+export type InternalHookEventType =
+  | "command"
+  | "session"
+  | "agent"
+  | "gateway"
+  | "message"
+  | "octo";
```

Expected action literals under the new `"octo"` type (produced by dispatch sites added in later PRs, not this one):

- `octo:mission.create` — a mission has been created
- `octo:arm.spawn` — a grip/arm has been spawned onto a harness
- `octo:arm.completed` — an arm has reached a terminal state (completed, failed, cancelled)

These are NOT hardcoded in the union — the action field is already a free-form `string`, matching the existing convention for `"command"` and `"message"`.

## Test plan

- `pnpm test src/hooks/internal-hooks.test.ts` (and the sibling hook tests `message-hooks.test.ts`, `plugin-hooks.test.ts`) must continue to pass unchanged.
- Add a unit test that registers a handler for `registerInternalHook("octo", handler)` and verifies that `triggerInternalHook(createInternalHookEvent("octo", "mission.create", "test-session"))` invokes it. This asserts that the new type literal flows through the dispatcher end-to-end.
- Add a second unit test registering a handler for `registerInternalHook("octo:mission.create", handler)` and verifying scoped dispatch works the same way it does for `command:new`.
- Type check: `pnpm tsc --noEmit` should pass. Any code path that accepts an `InternalHookEventType` will now also accept `"octo"`.

## Rollback plan

Remove the `"octo"` literal from the `InternalHookEventType` union. The dispatcher itself was not touched, so there is nothing else to revert in this file. Any dispatch sites that land in later PRs and reference `"octo"` will then fail to type-check, which is the desired loud failure mode.

## Dependencies on other PRs

- None for this file. This PR is a prerequisite for the octo dispatch call sites (mission orchestrator, arm lifecycle manager) that fire the events. Those PRs land in a later milestone and will import nothing new from this file — they just pass `"octo"` as the `type` argument to `createInternalHookEvent`.

## Reviewer guidance

Reviewer does NOT need to understand the full Octopus Orchestrator design to merge this PR. The only question is: "should `InternalHookEventType` grow a new `octo` literal to make the hook vocabulary first-class for a new subsystem?" The answer follows the existing precedent — every subsystem that fires hooks has its own type literal (`command`, `session`, `agent`, `gateway`, `message`). Octopus is a new subsystem and gets a new literal by the same reasoning.

Potential schema touchpoint: if upstream adds (or already has) a TypeBox / Zod schema for hook manifest frontmatter that validates the `events:` list against the `InternalHookEventType` union, that schema will need a parallel update to accept `octo:*` action strings. At pin `9ece252`, `src/hooks/frontmatter.ts` treats `events` as a free-form string list (`normalizeStringList(metadataObj.events)`) with no union validation, so no schema update is required today. Flag this for future hardening if the schema tightens.

For full Octopus context: `docs/octopus-orchestrator/HLD.md` (Feature advertisement and lifecycle section), `docs/octopus-orchestrator/INTEGRATION.md` (Required Upstream Changes, hook handler row), `docs/octopus-orchestrator/DECISIONS.md` (OCTO-DEC-027 for the feature flag).
