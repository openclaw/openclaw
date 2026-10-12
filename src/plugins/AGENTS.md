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
- Admit plugins once at load/registration through existing manifest, provenance, load-policy owners. All loaded plugins pass results/stream events by reference; never per-value copying, deep validation, or second boundary. Plugins must not mutate values after handing them to host. Managed callables scoped; bind each stream's scope, abort propagation, lease once for its lifetime. See [SDK contract](../../docs/plugins/sdk-runtime.md#plugin-value-boundary).
- Preserve discovery/activation laziness. Loader/registry/public-artifact changes must not eagerly import bundled plugin runtime barrels when metadata, light exports, or typed contracts suffice.
- Separate light/heavy plugin runtime surfaces: discovery, inventory, setup-state checks stay light until actual execution needs heavy module.
- Loader/registry changes affecting plugin authors: update public SDK, docs, contract tests; never rely on incidental internals.
- Prefer explicit manifest/descriptor-owned activation planning over “load everything in this scope”. Broad registry materialization = exception, not design center.
- Never normalize "plugin-owned" into "core-owned" via scattered direct `plugins.entries.<id>.config` reads in unrelated core paths. Prefer generic helpers, plugin runtime hooks, manifest metadata, explicit auto-enable wiring.
- Plugin-owned tools/provider fallbacks needing core participation: generic contract; honor plugin disablement + SecretRef semantics.
- Contract loading/tests: dedicated bundled registry path. Never depend on provider activation through unrelated production resolution flows.
- Prefer shared provider-family helpers over ad hoc registry-hook policy. Multiple providers sharing replay policy, tool compat, stream wrapper composition, or payload patch behavior: centralize helper before another plugin-local lambda.
- Separate provider policy layers: auth/catalog/onboarding → plugin-owned; transport/replay/tool compat families → shared helpers; registry/runtime code composes layers, never re-encoding policy inline.
- Provider hook growing nested wrapper composition/repeated compat flags = regression signal. Extract shared helper/composer, never another plugin near-copy.
- Mutable global runtime registry state = compatibility scaffolding, not desired request-time execution source of truth. New runtime flows: prefer immutable/request-scoped handles.
- Setup/discovery/doctor needing plugin runtime: explicit + narrow. Never quietly import broad runtime surfaces into cold control-plane paths.
- Resolver/public-surface loader tests: generated tiny plugin fixtures for broad `api.js` / `runtime-api.js` fallback behavior. Never real bundled plugin source APIs merely for path resolution proof.

## Availability And Selection

- Gateway plugin metadata stable while Gateway runs. Reuse current snapshots, install records, discovery, lookup tables, bounded process caches; no per-call stat/read/hash freshness. Metadata changes: restart or plugin owner's explicit reload/install/doctor flow. Caches: lifecycle-owned, test-clearable, not broad persistent stores.
- Repeated availability checks/catalog selection: prepared local facts. Remote catalog discovery/provider probes → initialization or owner's refresh, never each request/UI render. Repeated discovery: second request-time cache/polling loop ≠ fix.
- Keep configured/eligible state distinct from live health. Present credential/cached descriptor ≠ reachable service. Explicit health probes, credential refresh, actual provider/tool execution retain network contracts.

## Verification

- Loader/registry/activation/public-artifact changes that can change bundled plugin import fanout: `pnpm build`.
- Changes that can alter bundled plugin startup cost: re-profile affected plugin entrypoint:
  `OPENCLAW_LOCAL_CHECK=0 node --import tsx scripts/profile-extension-memory.mts --extension <id> --skip-combined --concurrency 1`
