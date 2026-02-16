# Test Plan for Web UI LAN Scopes Fix

## Issue
After upgrading to 2026.2.14, accessing the Web UI over LAN (non-localhost HTTP) shows "Error: missing scope: operator.read" on all pages except Overview.

## Root Cause
When the Web UI is accessed over plain HTTP (LAN IP), `crypto.subtle` is unavailable, so no device auth is sent. The server then clears all scopes as a security measure (line 421-424 in message-handler.ts), even when `gateway.controlUi.allowInsecureAuth: true` is configured.

## Fix
Preserve scopes for Control UI clients when `allowInsecureAuth` is enabled.

## Testing Steps

### Prerequisites
1. OpenClaw gateway running with config:
   ```json
   {
     "gateway": {
       "controlUi": {
         "allowInsecureAuth": true
       }
     }
   }
   ```
2. Access gateway over LAN IP (e.g., http://192.168.1.100:18789)

### Before Fix (2026.2.14)
1. Navigate to Web UI over LAN IP
2. Click on any page besides Overview
3. **Expected failure:** "Error: missing scope: operator.read"

### After Fix
1. Navigate to Web UI over LAN IP
2. Click on Sessions, Agents, Config, etc.
3. **Expected success:** Pages load normally, no scope errors

### Edge Cases to Test
1. **Localhost access** (should work both before and after)
2. **HTTPS access** (should work with device auth)
3. **allowInsecureAuth: false** (should reject non-localhost HTTP)
4. **Non-Control-UI clients** (should still have scopes cleared when no device auth)

### Security Validation
- Scopes are only preserved when:
  - Client is Control UI (`GATEWAY_CLIENT_IDS.CONTROL_UI`)
  - `allowInsecureAuth` is explicitly enabled
  - This prevents unauthorized clients from self-declaring scopes
