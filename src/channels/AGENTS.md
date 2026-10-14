# Channels Boundary

`src/channels/**` = core channel implementation. Plugin authors: no direct imports from tree.

## Public Contracts

- Docs:
  - `docs/plugins/sdk-channel-plugins.md`
  - `docs/plugins/architecture.md`
  - `docs/plugins/sdk-overview.md`
- Definition files:
  - `src/channels/plugins/types.plugin.ts`
  - `src/channels/plugins/types.core.ts`
  - `src/channels/plugins/types.adapters.ts`
  - `src/plugin-sdk/core.ts`
  - `src/plugin-sdk/channel-contract.ts`

## Boundary Rules

- Extension-facing channel surfaces: `openclaw/plugin-sdk/*`, never direct `src/channels/**` imports.
- Bundled/third-party channel needing new seam: typed SDK contract/facade first.
- Hot import paths: `channel.ts`, `shared.ts`, `channel.setup.ts`, `gateway.ts`, `outbound.ts`. Never statically pull async-only surfaces (send, monitor, probe, directory-live, setup/login flows, large `runtime-api.ts` barrels) into them unless startup truly needs them.
- Prefer small local seam (`channel-api.ts`, `*.runtime.ts`, `*.runtime-api.ts`) to keep heavy runtime off hot path.
- Core discovery used by Gateway/agent tools: lightweight bundled-plugin artifacts first; full channel plugin loading only as fallback.
- Test caller needing only already-registered plugin fixtures: offer loaded-plugin-only mode; never silently fall back to bundled runtime materialization.
- Target parsing, thread-binding hints, native command descriptors, message tool descriptors, gateway auth bypass paths, setup-promotion hints: small plugin-owned helpers reused by full channel plugin + lightweight artifact.
- Repeated test helper calls: install/reset test plugin registry in same lifecycle scope as runtime reset. `beforeAll` registry + `afterEach` runtime reset = later tests may fall through to bundled/default runtime loading.
- Never mix static/dynamic imports for same heavy module family across channel boundary change. Lazy path: lazy end to end.
- Shared channel changes affect built-in + extension channels. Check routing, pairing, allowlists, command gating, onboarding, reply behavior across full set.

## Verification

- Hot channel entrypoint/lazy-loading seam changes: `pnpm build`.
- Bundled plugin channel changes that can affect startup/import cost:
  `OPENCLAW_LOCAL_CHECK=0 node --import tsx scripts/profile-extension-memory.mts --extension <id> --skip-combined --concurrency 1`
