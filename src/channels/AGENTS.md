# Channels Boundary

`src/channels/**` = core channel implementation.

## Ownership

- Core owns shared message tools, action vocabulary, dispatch; channels own account, security, conversation, transport contracts. Keep typed command/approval/URL/action distinctions until encoding; never infer commands from raw strings.

## Public Contracts

- Channel plugin types: `src/channels/plugins/types.{plugin,core,adapters}.ts`.

## Durable Ingress

Owned by `src/channels/message/ingress-drain.ts` and `ingress-monitor.ts` (+ claim-owner, retry-policy).
Proof: `src/channels/message/ingress-drain.test.ts`,
`ingress-claim-owner.test.ts`, `ingress-retry-policy.test.ts`.

- Completed rows tombstone via `complete()`, never `delete`.
- Complete at turn adoption, not settle. Deferred holds the claim; watchdog
  stays armed through deferral; watchdog timeouts use the shared retry disposition.
- One retry policy: attempt floor **and** age gate (defaults 8 / 24h).
- Claim refresh heartbeat while dispatching/deferred (`claimLeaseMs / 3`).
- Never silently complete on transient failure — release/fail via disposition.
- Pre-adoption supersede tombstones; post-adoption interruption is core-owned
  (reply-run registry / queue interrupt).

## Boundary Rules

- Hot import paths: `channel.ts`, `shared.ts`, `channel.setup.ts`, `gateway.ts`, `outbound.ts`. Never statically pull async-only surfaces (send, monitor, probe, directory-live, setup/login flows, large `runtime-api.ts` barrels) into them unless startup truly needs them.
- Prefer small local seam (`channel-api.ts`, `*.runtime.ts`, `*.runtime-api.ts`) to keep heavy runtime off hot path.
- Gateway/agent-tool discovery reads lightweight artifacts first (`extensions/AGENTS.md`); channel-specific fast-path data: target parsing, thread-binding hints, native command + message tool descriptors, auth bypass paths, setup-promotion hints.
- Callers that need only registered plugins: pass `{ loadedOnly: true }` to `resolveChannelPluginRegistration`; never fall back to bundled runtime.
- Repeated test helper calls: install/reset test plugin registry in same lifecycle scope as runtime reset. `beforeAll` registry + `afterEach` runtime reset = later tests may fall through to bundled/default runtime loading.
- Shared channel change: prove routing, pairing, allowlists, command gating, onboarding, replies across built-in + bundled channels.

## Verification

- Bundled plugin channel changes that can affect startup/import cost:
  `pnpm test:extensions:memory -- --extension <id> --skip-combined --concurrency 1`
