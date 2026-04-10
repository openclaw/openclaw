# Upstream PR 1 — Register `octo.*` methods in `server-methods-list.ts`

**Status:** draft (M0-15). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target file:** `src/gateway/server-methods-list.ts`
**Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Advertise the Octopus Orchestrator method set (`octo.*`) from the central Gateway method list so clients that probe `listGatewayMethods()` see the control-plane surface. The Octopus method names are already defined — and schema-validated — in `src/octo/wire/methods.ts` (the `OCTO_METHOD_NAMES` const array). This PR makes them visible to the Gateway's method directory.

Method dispatch itself is NOT wired up by this PR — dispatch lives in `src/octo/wire/gateway-handlers.ts` and lands in a later milestone. Registering the names here is a prerequisite: without it, even a correctly-dispatching handler would be invisible to `listGatewayMethods()` consumers (doctor checks, feature detection, etc.).

## Rationale

- **Method surface visibility.** `listGatewayMethods()` is the canonical inventory of Gateway methods. Tooling (doctor, CLI method discovery, integration tests) depends on it as the source of truth. Octopus methods must appear here or they are invisible to every tool that asks "what does this Gateway support?".
- **Feature-flag gating happens at dispatch, not at listing.** Per OCTO-DEC-027, when `octo.enabled: false` (the default through Milestone 1), the method handlers return a structured `not_enabled` error. The method NAMES still appear in the list because they describe what this Gateway binary CAN do, not what it's currently configured to do. This matches how the existing `BASE_METHODS` array works: methods are listed regardless of whether their subsystems are enabled at runtime.
- **Single source of truth.** `OCTO_METHOD_NAMES` is generated from `OCTO_METHOD_REGISTRY` in `src/octo/wire/methods.ts`, which is itself driven by the TypeBox method schemas. Hand-maintaining the method list in two places (here and in the octo wire module) would drift. Spreading `OCTO_METHOD_NAMES` into `BASE_METHODS` avoids duplication by construction.
- **No behavior change for `octo.enabled: false` deployments.** The added names cost one import, one array spread, and a handful of bytes in the response. There is no side effect until a client actually calls one of the listed methods AND `octo.enabled: true` is set in `openclaw.json`.

## Expected changes

Two edits to `src/gateway/server-methods-list.ts`:

1. **Add an import** for `OCTO_METHOD_NAMES` from `src/octo/wire/methods.ts`. The relative path from `src/gateway/` is `../octo/wire/methods.js` (NodeNext resolution; `.js` suffix even though the source file is `.ts`).
2. **Spread `OCTO_METHOD_NAMES` into the `BASE_METHODS` array literal**, at the end of the existing entries, adjacent to the WebChat block and before the closing bracket. Placement at the end keeps the diff focused on a single append-style change.

No changes to `listGatewayMethods()` itself — the existing dedup logic (`Array.from(new Set([...BASE_METHODS, ...channelMethods]))`) handles the spread uniformly.

## Diff preview

```diff
--- a/src/gateway/server-methods-list.ts
+++ b/src/gateway/server-methods-list.ts
@@ -1,4 +1,5 @@
 import { listChannelPlugins } from "../channels/plugins/index.js";
+import { OCTO_METHOD_NAMES } from "../octo/wire/methods.js";
 import { GATEWAY_EVENT_UPDATE_AVAILABLE } from "./events.js";

 const BASE_METHODS = [
@@ -123,6 +124,8 @@ const BASE_METHODS = [
   "chat.history",
   "chat.abort",
   "chat.send",
+  // Octopus Orchestrator control plane (octo.* methods). Runtime gating
+  // happens in the dispatcher per OCTO-DEC-027 (octo.enabled feature flag).
+  ...OCTO_METHOD_NAMES,
 ];
```

## Test plan

- `pnpm test` — existing unit tests covering `listGatewayMethods()` must continue to pass. Add a test case (or extend an existing one) asserting that the returned array contains at least one `octo.*` name.
- Manual: `openclaw doctor` (or equivalent method-listing CLI entrypoint) on a fresh checkout must show the `octo.*` methods alongside existing methods.
- Schema round-trip: the new names should be a superset of what the test introspection currently asserts; no names should be removed.

## Rollback plan

Revert the two-line import + array-spread change. The `OCTO_METHOD_NAMES` const in `src/octo/wire/methods.ts` stays in place (it's already used by octo-internal code), so rollback is strictly removing the exposure from the Gateway's directory without touching the octo subsystem itself.

## Dependencies on other PRs

- None. This PR is the foundation for the rest of the upstream PR wave (M0-16 through M0-25). Subsequent PRs can depend on the method names being visible but do not require them to be handled — handling is separate.

## Reviewer guidance

Reviewer does NOT need to understand the full Octopus Orchestrator design to merge this PR. The only question is: "should method names from `src/octo/wire/methods.ts` be visible from `listGatewayMethods()`?" The answer is yes because the alternative is a parallel method directory, which drifts. Everything else (dispatch, feature-flag enforcement, runtime behavior) is out of scope for this PR.

For full Octopus context: `docs/octopus-orchestrator/HLD.md`, `docs/octopus-orchestrator/DECISIONS.md` (OCTO-DEC-027 for the feature flag, OCTO-DEC-028 for the method surface).
