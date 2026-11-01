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

- New surface: small versioned host/kernel seam + narrow purpose-built documented subpath; no broad convenience barrels or re-exports.
- Never expose implementation convenience from `src/channels/**`, `src/agents/**`, `src/plugins/**`, or other internals unless intentionally promoting supported public contract.
- Public SDK entrypoints: cheap module load. Async-only helper (send, monitor, probe, directory-live, login, setup): prefer narrow `*.runtime` subpath, not broad SDK barrel re-export imported by hot channel entrypoints at startup.
- SDK facades: acyclic. No back-edge re-exports routing lightweight contract file through heavier policy/runtime modules.
- Never mix static/dynamic imports for same runtime surface when shaping SDK seams. Lazy surface: eager side on light contract file, deferred side on dedicated runtime subpath.
- Core/tests needing bundled plugin helpers: plugin package `api.ts` / `runtime-api.ts` + generic SDK capabilities. No provider-named `src/plugin-sdk/<id>.ts` seam merely to expose bundled channel's private helpers to core.
- Provider work: family-level over provider-specific seams. Shared helpers describe reusable replay policy, tool-schema compat, payload normalization, stream-wrapper composition, transport decoration. No new SDK export wrapping only one provider's local implementation unless second consumer already exists.
- SDK subpaths: resolve one capability/runtime need at a time. No new surfaces requiring broad runtime registry access by default.

## Versioned Required Capabilities

- Always: shipped Plugin SDK parameter contract gains required host authority → versioned type requiring it. Legacy type source-compatible for documented deprecation window; migrate every bundled/internal caller in same change.
- Always: generic closure-bound host capabilities. Bind every exposed tool, preparer, callback, approval operation, native-action surface. Retained copies must fail after owner/capability closure, including closure during awaited policy work.
- Never: legacy optionality as capability-free runtime path, reconstructed host authority inside plugin, provider-specific authority in generic contract.
- Ask first: SDK + security owner acceptance before shortening compatibility window, making shipped type source-incompatible, or widening capability's trust, authority, persistence boundary.

## Verification

- SDK seams affecting lazy loading, hot channel entrypoints, bundled plugin import topology: `pnpm build`.
- Changes that can alter bundled channel startup cost: also run isolated affected-plugin entrypoint profiler:
  `pnpm test:extensions:memory -- --extension <id> --skip-combined --concurrency 1`

## Expanding The Boundary

- Before deprecation, removal, or an incompatible behavior/security change, use [plugin-sdk-impact](../../.agents/skills/plugin-sdk-impact/SKILL.md) to query public ClawHub consumers and interpret coverage alongside local callers.
- Compatibility (SDK surface too large): internal and bundled callers get no compat barrels, aliases, or fallback exports; replace old entrypoints freely and migrate all bundled/internal plugins in the same change. Third-party-visible exports: deprecate unused ones, but breaking removals/renames need a shipped replacement, an announced stable-release deprecation window, and explicit maintainer approval; never drive-by cleanup. Leave removal dates unset until the owner approves them.
- Adding/changing public subpath: update docs in `docs/plugins/*`, `scripts/lib/plugin-sdk-entrypoints.json`, `scripts/lib/plugin-sdk-entries.mts`; run `pnpm plugin-sdk:sync-exports` (`package.json` exports), then `pnpm plugin-sdk:check-exports` and `pnpm plugin-sdk:api:diff`.
- Deprecated synchronous SQLite SDK members have an approved final compatibility day of 2026-12-31; remove them in the first January 2027 stable release, without an SDK major. Keep replacements, actionable warnings, and the member migration guide aligned with that window; this preparation does not authorize early removal.

## Choose The Capability Surface

New capability: first path expressing actual requirement:

1. Extend existing owner or use existing command, skill, plugin, supported integration.
2. Use existing plugin contract. Prefer bundle plugins for skills, MCP servers, configuration; code plugins for runtime hooks, providers, channels, tools. Vendor behavior → vendor plugin; feature behavior → feature owner.
3. Missing contract → narrow generic core/SDK capability; move existing bundled implementations + callers together. Repeated independent requests for same capability → contract review, never another parallel manager/hook.
4. Universal core surface only for fundamental need existing extension points cannot express. Explain gap + ongoing cost; new hook needs concrete consumer.

- Example: new channel action → shared message action contract first.
- Setup screen needing plugin metadata → manifest/lightweight artifact, never plugin execution runtime.
