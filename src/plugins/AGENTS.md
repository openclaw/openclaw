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

## Model Listing

- The hot path holds no network request. `models.list`, picker opens (web, TUI, channels) and chat replies read the last published rows; provider discovery and catalog refresh run in the background. A provider that never answers delays none of them.
- `models.list` p99 < 300 ms after any config change, catalog swap, sign-in/out, key removal, plugin reload or restart. Rows and prices publish as one snapshot. During a rebuild, keep serving previous rows and apply removals at once: a removed key, provider or retired model disappears immediately.
- Signed-in provider: its authenticated listing decides which models appear; the catalog only adds metadata and prices. New models appear without an OpenClaw upgrade. Catalog data comes from the published catalog, never a runtime models.dev fetch.
- List with the credential and runtime version that will execute the turn. Aliases fold through the shared normalizer on every publication path: one row per model per provider, labeled with its provider.
- A failed listing keeps the last good rows and names the provider; a successful empty listing replaces them. Bundled rows never stand in for either.
- Thinking levels, request shape and toggles come from listed capabilities through one resolver, never exact model-ID rules. Offer only controls request construction honors. A fact the catalog cannot yet express may use an ID rule only with a comment citing its live probe or vendor source.
- New model in a known family: a manifest row with its thinking data and `input`, not new entries in ID lists.
- Thinking profile is row data. A row with `compat.defaultThinkingLevel` owns its profile: core builds the ladder from `thinkingLevelMap` and `compat.supportedReasoningEfforts`, plus `compat.adaptiveThinking`, `thinkingRequired` (stays on when `reasoning: false`) and `thinkingLevelLabels`. Do not add a `resolveThinkingProfile` hook for a model a row can describe; hooks are the fallback for rows without that field. Add each owning row to `src/plugins/contracts/catalog-thinking-profiles.contract.test.ts`.
- `compat.thinkingLevels` states the offered ladder outright (for example when the map aliases a level the picker should hide); a row with it owns its profile even without a default.
- Profile and map are one unit. A hosted row published before the bundled row owned its profile keeps the bundled map, and a configured map without `compat.defaultThinkingLevel` can only exclude levels (`null`). Callers that pass no catalog use `buildThinkingCatalog`, never configured rows alone.
- Live listing needs `catalog.liveModelDiscovery` on the entry and `modelCatalog.discovery: { <provider>: "refreshable" }` in the manifest; without the manifest half the Gateway never refreshes the provider.
- Row ID is the ID the vendor lists. Manifest `modelIdNormalization` aliases fold typed input only; the live listing keeps the vendor's spelling, so a row under a short alias would sit beside an unenriched listed row.
- Admission is one core rule, `buildLiveModelProviderConfig` in `src/plugin-sdk/provider-catalog-live-runtime.ts`: every listed chat model, non-chat filtered once. Plugins narrow it only through its documented gates (`readModelId`, `acceptUnknownModel`, capability-aware projections that drop rows whose request shape they cannot build). Fix listing gaps there, not per provider.
- Catalog data is live behavior: manifest rows reach every released install through the hosted catalog (`openclaw/catalog`, every 4 h) with no release, and released readers act on `thinkingLevelMap`, `compat` and `input`. Before changing them on a shipped row, compare offered levels and request bodies on the latest stable, extended-stable and beta readers (`pnpm catalog:compare-released --candidate <bundle.json>`), state the result in the PR, and change only what a dated live probe of that route supports ([`pnpm test:live:thinking-probe`](../../docs/help/testing-live/model-smoke.md#thinking-probe-what-a-route-accepts-per-level)). Keep probe records out of the repo; the PR states the command and one line per result.
- Hosted rows parse strictly. One unknown row field makes released readers (2026.10.8 and earlier) reject the whole refresh and keep their last catalog; current main skips only that row. New facts go inside `compat` or `thinkingLevelMap`; any other field needs a schema decision first.

## Verification

- Loader/registry/activation/public-artifact changes that can change bundled plugin import fanout: `pnpm build`.
- Changes that can alter bundled plugin startup cost: re-profile affected plugin entrypoint:
  `pnpm test:extensions:memory -- --extension <id> --skip-combined --concurrency 1`
