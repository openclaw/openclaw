# Plugin SDK Boundary

This directory is the public contract between plugins and core. Changes here
can affect bundled plugins and third-party plugins.

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
  - `src/plugin-sdk/entrypoints.ts`
  - `src/plugin-sdk/api-baseline.ts`
  - `src/plugin-sdk/plugin-entry.ts`
  - `src/plugin-sdk/core.ts`
  - `src/plugin-sdk/provider-entry.ts`

## Boundary Rules

- Prefer narrow, purpose-built subpaths over broad convenience re-exports.
- Do not expose implementation convenience from `src/channels/**`,
  `src/agents/**`, `src/plugins/**`, or other internals unless you are
  intentionally promoting a supported public contract.
- Keep public SDK entrypoints cheap at module load. If a helper is only needed
  on async paths such as send, monitor, probe, directory-live, login, or setup,
  prefer a narrow `*.runtime` subpath over re-exporting it through a broad SDK
  barrel that hot channel entrypoints import on startup.
- Keep SDK facades acyclic. Do not add back-edge re-exports that route a
  lightweight contract file back through heavier policy or runtime modules.
- Do not mix static and dynamic imports for the same runtime surface when
  shaping SDK seams. If a surface must stay lazy, keep the eager side on a
  light contract file and the deferred side on a dedicated runtime subpath.
- Prefer `api.runtime` or a focused SDK facade over telling extensions to reach
  into host internals directly.
- When core or tests need bundled plugin helpers, prefer the plugin package
  `api.ts` or `runtime-api.ts` plus generic SDK capabilities. Do not add a
  provider-named `src/plugin-sdk/<id>.ts` seam just to make core aware of a
  bundled channel's private helpers.

## Verification

- If you touch SDK seams that affect lazy loading, hot channel entrypoints, or
  bundled plugin import topology, run `pnpm build`.
- If the change can alter bundled channel startup cost, also run the isolated
  entrypoint profiler for the affected plugin:
  `OPENCLAW_LOCAL_CHECK=0 node scripts/profile-extension-memory.mjs --extension <id> --skip-combined --concurrency 1`

## Expanding The Boundary

- Additive, backwards-compatible changes are the default.
- When adding or changing a public subpath, keep these aligned:
  - docs in `docs/plugins/*`
  - `scripts/lib/plugin-sdk-entrypoints.json`
  - `src/plugin-sdk/entrypoints.ts`
  - `package.json` exports
  - API baseline and export checks
- If a bundled channel/helper need crosses package boundaries, first ask
  whether the need is truly generic. If yes, add a narrow generic subpath. If
  not, keep it plugin-local through `api.ts` / `runtime-api.ts`.
- Breaking removals or renames are major-version work, not drive-by cleanup.
