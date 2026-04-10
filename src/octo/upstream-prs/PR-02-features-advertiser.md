# Upstream PR 2 — Advertise `features.octo` from the `hello-ok` handshake

**Status:** draft (M0-16). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target file:** `src/gateway/server/ws-connection/message-handler.ts`
**Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Wire `buildFeaturesOcto` into the Gateway `hello-ok` handshake so that Octopus Orchestrator support is discoverable by clients via `features.octo`, alongside the existing `features.methods` and `features.events`. The builder itself — schema, capability defaults, and adapter validation — is already implemented in `src/octo/wire/features.ts` (landed in M0-07). This PR adds exactly one call site: the place where the `helloOk` response object is constructed.

No new schema, no new transport, no new config keys. This PR is purely the plumbing that exposes an existing, already-tested advertiser function on the wire.

## Rationale

- **Feature detection is the durable contract.** Per HLD.md §Feature advertisement via hello-ok.features.octo, clients feature-detect Octopus support via `features.octo?.enabled === true`. Old clients see nothing and render unchanged; new clients talking to old Gateways see the block absent and hide their Octopus UI. Adding the block to the handshake is the one-shot mechanism that makes that contract real.
- **The `octo` key is always present, even when disabled.** When `octo.enabled: false` (the default through Milestone 1), `buildFeaturesOcto({ enabled: false, adapters: [] })` returns the canonical disabled descriptor — empty adapters array, baseline capability block, `enabled: false`. Clients gate on `enabled === true`, not key presence. Always emitting the key simplifies the client contract and matches how the existing `features.methods` and `features.events` are always present regardless of runtime configuration.
- **Config layer owns the inputs, not the handshake.** `enabled` and `adapters` come from the loaded octo config (the `loadOctoConfig` result from M0-11, upstream of this PR). The handshake layer's job is strictly to pass those values through to the builder — no filtering, no policy, no opt-in logic. Opt-in gating (e.g. for `structured_acp` per OCTO-DEC-036) is a config-level decision performed before the handshake ever sees the adapter list.
- **Single write site.** The `helloOk` object is built in exactly one place: `src/gateway/server/ws-connection/message-handler.ts` around the `features: { methods: gatewayMethods, events }` line. Centralizing `features.octo` at that point avoids any drift risk.

## Expected changes

Two edits to `src/gateway/server/ws-connection/message-handler.ts`:

1. **Add an import** for `buildFeaturesOcto` from `src/octo/wire/features.ts`. The relative path from `src/gateway/server/ws-connection/` is `../../../octo/wire/features.js` (NodeNext resolution; `.js` suffix even though the source file is `.ts`).
2. **Extend the `features` object literal** inside the `helloOk` builder to include an `octo` key, computed by calling `buildFeaturesOcto` with `enabled` and `adapters` from the loaded octo config. When the config layer reports `enabled: false`, the builder returns the disabled descriptor and the key is still emitted.

The exact source of `enabled` and `adapters` at the call site depends on how the loaded octo config is threaded into the handshake context — this PR assumes an `octoConfig` accessor is available from the same module surface that already exposes other runtime config to the handshake (e.g. adjacent to `MAX_PAYLOAD_BYTES`, `TICK_INTERVAL_MS`). If that accessor is not yet in place, the reviewer should flag it and this PR should be rebased on top of the config-threading PR.

## Diff preview

```diff
--- a/src/gateway/server/ws-connection/message-handler.ts
+++ b/src/gateway/server/ws-connection/message-handler.ts
@@ -40,6 +40,7 @@
 import { buildGatewaySnapshot } from "../snapshot.js";
+import { buildFeaturesOcto } from "../../../octo/wire/features.js";
 import { mintCanvasCapabilityToken } from "../canvas-capability.js";
@@ -1209,7 +1210,13 @@
             version: resolveRuntimeServiceVersion(process.env),
             connId,
           },
-          features: { methods: gatewayMethods, events },
+          features: {
+            methods: gatewayMethods,
+            events,
+            octo: buildFeaturesOcto({
+              enabled: octoConfig.enabled,
+              adapters: octoConfig.adapters,
+            }),
+          },
           snapshot,
           canvasHostUrl: scopedCanvasHostUrl,
```

## Test plan

- `pnpm test` — existing handshake tests (e.g. `server.auth.browser-hardening.test.ts`, `client.watchdog.test.ts`, `call.test.ts`) must continue to pass. Their current `features: { methods: [], events: [] }` fixtures are a subset of the new shape and remain valid.
- Add a test asserting that `hello-ok.features.octo` is always present on the handshake, with `enabled: false`, `adapters: []`, and the baseline capability block when `octo.enabled: false` in config.
- Add a test asserting that when `octo.enabled: true` with a non-empty adapter list, the advertised `features.octo.adapters` matches the config (de-duplicated, insertion-order preserved — the builder enforces this).
- Manual: connect a client and inspect the `hello-ok` frame; confirm `features.octo` shape matches HLD.md §Feature advertisement.

## Rollback plan

Revert the two-line import + object-literal change. `buildFeaturesOcto` itself stays in place (it has no other call sites in the Gateway layer and is unit-tested in isolation in the octo subsystem), so rollback removes only the exposure on the wire without touching the advertiser or the config loader.

## Dependencies on other PRs

- Logically depends on M0-07 (already landed) for `buildFeaturesOcto`.
- Logically depends on M0-11 (`loadOctoConfig`) to supply `enabled` and `adapters` at the handshake call site. If the config accessor is not yet threaded into `message-handler.ts` at review time, that threading must land first or as part of the same PR stack.
- Does not depend on PR 1 (server-methods-list registration); the two advertisements — method list and feature block — are independent.

## Reviewer guidance

Reviewer does NOT need to understand the full Octopus Orchestrator design to merge this PR. The only question is: "should the `hello-ok` handshake always expose a `features.octo` block built by `buildFeaturesOcto`?" The answer is yes because that is the client-facing feature-detection contract specified in HLD.md §Feature advertisement via hello-ok.features.octo.

Ambiguity note: the handshake is constructed in a single site in `src/gateway/server/ws-connection/message-handler.ts` (the `helloOk` object literal around line 1205), but the loaded octo config is not yet obviously threaded into that file. If the reviewer identifies a preferred upstream seam for config access — for example a per-connection context already carrying other runtime config — this PR should adopt it rather than introducing a new accessor.

For full Octopus context: `docs/octopus-orchestrator/HLD.md` §Feature advertisement, `docs/octopus-orchestrator/INTEGRATION.md` §Client feature detection, and `docs/octopus-orchestrator/DECISIONS.md` OCTO-DEC-027 (feature flag) / OCTO-DEC-036 (adapter preference order).
