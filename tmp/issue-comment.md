### Update: Root cause identified and resolved

The `sessions_spawn` "pairing required" error was **not** caused by the Discord preflight code (which my branch `fix/discord-pairing-nonblocking` addresses). That fix is still valid for Discord DM-level pairing, but the subagent spawn issue had a different root cause.

**Root cause:** Gateway WebSocket handshake scope-upgrade blocking.

The paired device (`gateway-client`, loopback) had scopes `["operator.admin", "operator.approvals", "operator.pairing"]` but was requesting `operator.write`. This triggered a **scope-upgrade** pairing request in `src/gateway/server/ws-connection/message-handler.ts`:

```typescript
// Line ~662: silent is only true for "not-paired" + local
silent: isLocalClient && reason === "not-paired",
```

Since the reason was `"scope-upgrade"` (not `"not-paired"`), `silent` was `false` even for loopback connections, causing the connection to block and close with `1008: pairing required`.

**Fix applied locally:**

1. Added `"operator.write"` to the device's scopes in `~/.openclaw/devices/paired.json`
2. Cleared `pending.json`
3. Restarted gateway

**Suggested upstream fix:**
The `silent` flag logic should also auto-approve scope-upgrades for local loopback clients:

```typescript
// Current (blocks scope-upgrade on loopback):
silent: isLocalClient && reason === "not-paired",

// Suggested (auto-approve all local pairing):
silent: isLocalClient,
```

This would prevent loopback connections from ever being blocked by pairing, which is the expected behavior per the docs ("Localhost / loopback connections are always auto-approved").

**Status:** `sessions_spawn` now works correctly after the scope fix. The Discord preflight fix in the original branch is a separate improvement.
