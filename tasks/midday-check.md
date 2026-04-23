# Midday check - 2026-04-23

## Open PRs (suboss87 on openclaw/openclaw)

| PR     | Title                                                                     | Status                                     |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------ |
| #69685 | fix(agents): strip final tags from persisted assistant message            | open, 4 comments, last activity 2026-04-23 |
| #66225 | fix(agents): align final tag regexes to handle self-closing variant       | open, 6 comments, last activity 2026-04-23 |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name       | open, 3 comments, last activity 2026-04-19 |
| #68446 | fix(whatsapp): stop DM allowFrom fallback into group policy sender bypass | open, 2 comments, last activity 2026-04-18 |

## PR feedback check

Could not read PR comments from openclaw/openclaw this run - MCP session is scoped to
suboss87/openclaw only. PRs #69685 and #66225 had recent timestamps but comments were not
accessible. Manual review recommended.

## Bug hunt

Evaluated 15 fresh bugs filed 2026-04-23. Picked #70447 (Discord slash commands in thread hang
on "thinking..." and crash with partial channel error).

Root cause confirmed: `channel.parentId` throws `Cannot access rawData on partial Channel` when
Carbon provides an unfetched `GuildThreadChannel` for thread interactions. The `"parentId" in
channel` guard only checks key presence, not whether the channel is fetched. Three sites
affected: two in `dispatchDiscordCommandInteraction` and one in `resolveDiscordChannelContext`.

Fix: wrapped each `channel.parentId` access in try/catch. When partial, falls back to
`undefined`; `resolveDiscordThreadParentInfo` already handles that by fetching thread info.

Regression test added: `native-command.thread-partial-channel.test.ts` - creates a mock
partial channel where the `parentId` getter throws, verifies command.run() completes without
error and reaches dispatch. All 22 native-command tests pass.

## Actions this run

- Opened fix branch `fix/discord-thread-slash-command-partial-channel` from origin/main
- Committed fix + regression test (cf6785c)
- PR opened on fork: https://github.com/suboss87/openclaw/pull/2

## Escalation

PR was created on suboss87/openclaw (fork) rather than openclaw/openclaw - MCP session
restricted to fork only. PR needs to be cross-submitted upstream manually or via a session
with openclaw/openclaw MCP access.

No human feedback addressable this run due to MCP repo restriction on PR comment reads.
