# Plugin SDK Boundary

Public contract between plugins/core; changes can affect bundled + third-party plugins.

## Source Of Truth

- Docs:
  - `docs/plugins/sdk-overview.md`
  - `docs/plugins/sdk-entrypoints.md`
  - `docs/plugins/sdk-runtime.md`
  - `docs/plugins/sdk-migration.md`
  - `docs/plugins/architecture.md`
- Definition files:
  - `package.json`
  - `scripts/lib/plugin-sdk-entrypoints.json`
  - `scripts/lib/plugin-sdk-entries.mts`
  - `src/plugin-sdk/api-baseline.ts`
  - `src/plugin-sdk/plugin-entry.ts`
  - `src/plugin-sdk/core.ts`
  - `src/plugin-sdk/provider-entry.ts`

## Boundary Rules

- Host loads plugins; plugins must not reach through SDK into arbitrary host internals.
- Follow [plugin value boundary](../../docs/plugins/sdk-runtime.md#plugin-value-boundary): admit plugins at load/registration; all loaded plugins pass values by reference. Plugins must not mutate values after handing them to host. Keep invocation scope/lifecycle ownership; no per-value copying/deep validation.
- Prefer small versioned host/kernel seam + narrow documented SDK entrypoints over broad convenience barrels.
- Prefer narrow purpose-built subpaths over broad convenience re-exports.
- Never expose implementation convenience from `src/channels/**`, `src/agents/**`, `src/plugins/**`, or other internals unless intentionally promoting supported public contract.
- Public SDK entrypoints: cheap module load. Async-only helper (send, monitor, probe, directory-live, login, setup): prefer narrow `*.runtime` subpath, not broad SDK barrel re-export imported by hot channel entrypoints at startup.
- SDK facades: acyclic. No back-edge re-exports routing lightweight contract file through heavier policy/runtime modules.
- Never mix static/dynamic imports for same runtime surface when shaping SDK seams. Lazy surface: eager side on light contract file, deferred side on dedicated runtime subpath.
- Prefer `api.runtime`/focused SDK facade over extensions reaching directly into host internals.
- Core/tests needing bundled plugin helpers: plugin package `api.ts` / `runtime-api.ts` + generic SDK capabilities. No provider-named `src/plugin-sdk/<id>.ts` seam merely to expose bundled channel's private helpers to core.
- Resolver/facade loader tests = broad source API coverage exception. Generated tiny plugin fixtures for `api.js` / `runtime-api.js` fallback behavior; never real bundled plugin source APIs.
- Provider work: family-level over provider-specific seams. Shared helpers describe reusable replay policy, tool-schema compat, payload normalization, stream-wrapper composition, transport decoration. No new SDK export wrapping only one provider's local implementation unless second consumer already exists.
- Stable contract encoded by options: prefer named helpers over raw options objects. Example: "OpenAI-style Anthropic tool payload compat" helper, not same mode flags passed by every plugin.
- Align transport/runtime policy + plugin-facing helpers. Same behavior in plugin registration/core runtime: one shared helper, never two drifting paths.
- SDK subpaths: resolve one capability/runtime need at a time. No new surfaces requiring broad runtime registry access by default.
- SDK export mainly letting setup/config/control-plane execute plugin runtime = usually boundary smell. Metadata/descriptor-driven control-plane seams first.

## Versioned Required Capabilities

- Always: shipped Plugin SDK parameter contract gains required host authority → versioned type requiring it. Legacy type source-compatible for documented deprecation window; migrate every bundled/internal caller in same change.
- Always: generic closure-bound host capabilities. Bind every exposed tool, preparer, callback, approval operation, native-action surface. Retained copies must fail after owner/capability closure, including closure during awaited policy work.
- Never: legacy optionality as capability-free runtime path, reconstructed host authority inside plugin, provider-specific authority in generic contract.
- Never: hand-edit generated SDK baselines, declarations, hashes, budgets. Regenerate canonically.
- Ask first: SDK + security owner acceptance before shortening compatibility window, making shipped type source-incompatible, or widening capability's trust, authority, persistence boundary.

## Verification

- SDK seams affecting lazy loading, hot channel entrypoints, bundled plugin import topology: `pnpm build`.
- Changes that can alter bundled channel startup cost: also run isolated affected-plugin entrypoint profiler:
  `OPENCLAW_LOCAL_CHECK=0 node --import tsx scripts/profile-extension-memory.mts --extension <id> --skip-combined --concurrency 1`

## Expanding The Boundary

- SDK surface too large. No convenience compat barrels, aliases, fallback exports. Replace old entrypoints when cleaner.
- Public third-party API = only compat exception: document/version breaks, migrate ALL bundled/internal plugins first, then aggressively deprecate unused exports.
- Adding/changing public subpath: align:
  - docs in `docs/plugins/*`
  - `scripts/lib/plugin-sdk-entrypoints.json`
  - `scripts/lib/plugin-sdk-entries.mts`
  - `package.json` exports
  - API diff + export checks
- Bundled channel/helper crossing package boundaries: first ask whether truly generic. Yes → narrow generic subpath. No → plugin-local `api.ts` / `runtime-api.ts`.
- Expanding provider-facing seams: update/add matching narrow contract tests — Plugin SDK diff/export checks for public subpaths + most direct provider/plugin tests for centralized behavior.
- Breaking removals/renames require a shipped replacement, an announced stable-release deprecation window, and explicit maintainer approval; never drive-by cleanup. Leave removal dates unset until the owner approves them.

## Choose The Capability Surface

New capability: first path expressing actual requirement:

1. Extend existing owner or use existing command, skill, plugin, supported integration.
2. Use existing plugin contract. Prefer bundle plugins for skills, MCP servers, configuration; code plugins for runtime hooks, providers, channels, tools. Vendor behavior → vendor plugin; feature behavior → feature owner.
3. Missing contract → narrow generic core/SDK capability; move existing bundled implementations + callers together. Repeated independent requests for same capability → contract review, never another parallel manager/hook.
4. Universal core surface only for fundamental need existing extension points cannot express. Explain gap + ongoing cost; new hook needs concrete consumer.

- Example: new channel action → shared message action contract first.
- Setup screen needing plugin metadata → manifest/lightweight artifact, never plugin execution runtime.
