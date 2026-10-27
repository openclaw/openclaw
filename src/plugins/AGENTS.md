# Plugins Boundary

Own plugin discovery, manifest validation, loading, registry assembly, contract enforcement.

## Public Contracts

- Docs:
  - `docs/plugins/architecture.md`
  - `docs/plugins/manifest.md`
  - `docs/plugins/sdk-overview.md`
  - `docs/plugins/sdk-entrypoints.md`
- Definition files:
  - `src/plugins/types.ts`
  - `src/plugins/runtime/types.ts`
  - `src/plugins/contracts/registry.ts`
  - `src/plugins/public-surface-loader.ts`
  - `src/plugins/public-surface-runtime.ts`
  - `src/plugins/provider-public-artifacts.ts`
  - `src/plugins/web-provider-public-artifacts.ts`

## Boundary Rules

- Separate control-plane/runtime-plane concerns: discovery, manifest parsing, config validation, setup/onboarding hints, activation planning → control plane; actual plugin execution → runtime resolution.
- Preserve manifest-first behavior: discovery, config validation, setup work from metadata before plugin runtime executes.
- Align loader behavior with documented Plugin SDK/manifest contracts. No private backdoors for bundled plugins unavailable to external plugins.
- Plugin values: admit once at load/registration through existing manifest, provenance, load-policy owners, then pass by reference. Plugins must not mutate values after handing them to host. Managed callables scoped; bind each stream's scope, abort propagation, lease once for its lifetime. See [plugin value boundary](../../docs/plugins/sdk-runtime.md#plugin-value-boundary).
- Control-plane paths (discovery, inventory, setup, doctor) stay on metadata, light exports, typed contracts. Import plugin runtime only for execution, through an explicit narrow surface; loader/registry/public-artifact changes never eagerly import bundled runtime barrels.
- Prefer explicit manifest/descriptor-owned activation planning over “load everything in this scope”. Broad registry materialization = exception, not design center.
- Never normalize "plugin-owned" into "core-owned" via scattered direct `plugins.entries.<id>.config` reads in unrelated core paths. Prefer generic helpers, plugin runtime hooks, manifest metadata, explicit auto-enable wiring.
- Plugin-owned tools/provider fallbacks needing core participation: generic contract; honor plugin disablement + SecretRef semantics.
- Contract loading/tests: dedicated bundled registry path. Never depend on provider activation through unrelated production resolution flows.
- Separate provider policy layers: auth/catalog/onboarding → plugin-owned; transport/replay/tool compat families → shared helpers; registry/runtime code composes layers, never re-encoding policy inline.
- Mutable global runtime registry state = compatibility scaffolding, not desired request-time execution source of truth. New runtime flows: prefer immutable/request-scoped handles.
- Resolver/public-surface loader tests: generated tiny plugin fixtures for broad `api.js` / `runtime-api.js` fallback behavior. Never real bundled plugin source APIs merely for path resolution proof.

## Availability And Selection

- Gateway plugin metadata stable while Gateway runs. Metadata changes: restart or plugin owner's explicit reload/install/doctor flow. Caches: lifecycle-owned, test-clearable, not broad persistent stores.
- Repeated availability checks/catalog selection: prepared local facts. Remote catalog discovery/provider probes → initialization or owner's refresh, never each request/UI render.
- Keep configured/eligible state distinct from live health. Present credential/cached descriptor ≠ reachable service. Explicit health probes, credential refresh, actual provider/tool execution retain network contracts.

## Verification

- Loader/registry/activation/public-artifact changes that can change bundled plugin import fanout: `pnpm build`.
- Changes that can alter bundled plugin startup cost: re-profile affected plugin entrypoint:
  `pnpm test:extensions:memory -- --extension <id> --skip-combined --concurrency 1`
