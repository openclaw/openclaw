# Channels Boundary

`src/channels/**` is core channel implementation. Plugin authors should not
import from this tree directly.

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

- Keep extension-facing channel surfaces flowing through `openclaw/plugin-sdk/*`
  instead of direct imports from `src/channels/**`.
- When a bundled or third-party channel needs a new seam, add a typed SDK
  contract or facade first.
- Channel plugins should project generic reply payloads and semantic interactive
  actions into native channel UX. Prefer adding capability flags and outbound
  projection hooks over asking plugins to call Telegram/Discord/Slack/Lark
  APIs directly.
- When a channel cannot render rich UI, degrade through documented text and
  command fallbacks instead of inventing a channel-specific plugin-side branch.
- Remember that shared channel changes affect both built-in and extension
  channels. Check routing, pairing, allowlists, command gating, onboarding, and
  reply behavior across the full set.
