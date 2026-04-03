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
- Prefer lane-oriented, actor-oriented, and capability-oriented contracts over
  channel-branded plugin APIs. If a new seam can be expressed as "reply on this
  lane", "DM this actor", or "render this semantic interaction with fallbacks",
  use that instead of adding a Telegram/Discord/Slack-specific plugin contract.
- Do not expose implementation convenience from `src/channels/**`,
  `src/agents/**`, `src/plugins/**`, or other internals unless you are
  intentionally promoting a supported public contract.
- Prefer `api.runtime` or a focused SDK facade over telling extensions to reach
  into host internals directly.
- Keep raw channel namespaces on `api.runtime.channel.<id>` as host-owned escape
  hatches, not the preferred extension contract. New plugin-facing work should
  usually land in focused subpaths such as `conversation-runtime`,
  `outbound-runtime`, `interactive-runtime`, or `channel-contract`.
- When core or tests need bundled plugin helpers, expose them through
  the plugin package `api.ts` and a matching `src/plugin-sdk/<id>.ts` facade
  instead of importing plugin-private `src/**` files or `onboard.js`
  directly.

## Expanding The Boundary

- Additive, backwards-compatible changes are the default.
- When adding or changing a public subpath, keep these aligned:
  - docs in `docs/plugins/*`
  - `scripts/lib/plugin-sdk-entrypoints.json`
  - `src/plugin-sdk/entrypoints.ts`
  - `package.json` exports
  - API baseline and export checks
- If the seam is for bundled-provider onboarding/config helpers, update the
  generated plugin facades instead of teaching core tests or commands to reach
  into private extension files.
- Breaking removals or renames are major-version work, not drive-by cleanup.
