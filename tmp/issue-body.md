### Summary

When `dmPolicy` is set to `"pairing"`, Discord DM commands and messages are blocked entirely (`return null` / `return`) until the user completes pairing. This prevents legitimate operations like subagent spawn (`sessions_spawn`) from working, even on loopback connections.

The pairing flow should be **informational, not blocking** — send the pairing code but continue processing the command/message.

### Current behavior

In `message-handler.preflight.ts` and `native-command.ts`, when `dmPolicy === "pairing"` and the user is not yet paired:

1. `commandAuthorized` is set to `false`
2. Pairing code is sent to the user
3. Function returns `null` / early `return` — **blocking all further processing**

This means `sessions_spawn` and other commands fail with `gateway closed (1008): pairing required`.

### Proposed fix

Make pairing non-blocking:

- When `dmPolicy === "pairing"`: send the pairing request but **do not** set `commandAuthorized = false` and **do not** return early. Let the command proceed.
- When `dmPolicy === "allowlist"`: keep the existing blocking behavior (`commandAuthorized = false` + `return null`).

### Files affected

- `src/discord/monitor/message-handler.preflight.ts` — move `commandAuthorized = false` and `return null` into the `else` (allowlist) branch only
- `src/discord/monitor/native-command.ts` — same pattern
- Test file updated to expect non-blocking behavior (dispatch called + pairing sent)

### Related issues

- #12210 — sessions_spawn fails with "pairing required" for internal subagents
- #21236 — Gateway returns "pairing required" after update to 2026.2.19-2

### Environment

- OpenClaw 2026.2.19
- Windows 11, Node 22.17.1
- Discord channel, loopback gateway

### Patch reference

A working fix is available at: `jini92/MAIBOT@fix/discord-pairing-nonblocking` (commit 6186b9fa8)
