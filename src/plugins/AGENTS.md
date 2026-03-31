# Plugins Boundary

This directory owns plugin discovery, manifest validation, loading, registry
assembly, and contract enforcement.

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
  - `src/plugins/public-artifacts.ts`

## Boundary Rules

- Preserve manifest-first behavior: discovery, config validation, and setup
  should work from metadata before plugin runtime executes.
- Keep loader behavior aligned with the documented Plugin SDK and manifest
  contracts. Do not create private backdoors that bundled plugins can use but
  external plugins cannot.
- If a loader or registry change affects plugin authors, update the public SDK,
  docs, and contract tests instead of relying on incidental internals.
- Do not normalize "plugin-owned" into "core-owned" by scattering direct reads
  of `plugins.entries.<id>.config` through unrelated core paths. Prefer generic
  helpers, plugin runtime hooks, manifest metadata, and explicit auto-enable
  wiring.
- When plugin-owned tools or provider fallbacks need core participation, keep
  the contract generic and honor plugin disablement plus SecretRef semantics.
- Keep contract loading and contract tests on the dedicated bundled registry
  path. Do not make contract validation depend on activating providers through
  unrelated production resolution flows.
