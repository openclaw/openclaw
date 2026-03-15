# OpenClaw Secrets Management

Secure credential management with OS keychain storage, TOTP 2FA approval gates, and agent-blind credential injection.

## Features

- **OS Keychain Storage** — macOS Keychain, Linux libsecret, Windows Credential Manager
- **Three-Tier Access** — `open` (no approval), `controlled` (4h TTL), `restricted` (15min TTL)
- **TOTP 2FA** — Time-based one-time passwords with ±30s drift tolerance
- **Agent-Blind Mode** — Agents see metadata only; broker injects values at runtime
- **Credential Broker** — Intercepts tool execution, resolves `credentialRef` parameters
- **Vault Backend Abstraction** — Pluggable storage (keychain default, future: 1Password, Bitwarden, Vault)
- **Audit Logging** — JSONL credential access log at `{dataDir}/audit/credentials.jsonl`
- **Elevated Access** — TOTP-gated sudo with 30-minute sessions

## Security Modes

| Mode       | Agent Sees Values? | TOTP Behavior | Use Case                      |
| ---------- | ------------------ | ------------- | ----------------------------- |
| `legacy`   | Yes                | Per tier      | Backward compatible (default) |
| `yolo`     | Yes                | Never         | Development/testing           |
| `balanced` | No (metadata)      | Session-based | Production recommended        |
| `strict`   | No (metadata)      | Per-action    | High-security environments    |

Configure in `openclaw.json`:

```json
{
  "security": {
    "credentials": {
      "mode": "balanced",
      "broker": {
        "enabled": true,
        "interceptTools": ["browser", "message", "exec"]
      }
    }
  }
}
```

## CLI Commands

```bash
openclaw secrets set <name> --tier <tier> --value <value>  # Store a secret
openclaw secrets get <name>                                 # Retrieve a secret
openclaw secrets grant <name> <totp-code> [--ttl <min>]    # Grant time-limited access
openclaw secrets revoke <name>                              # Revoke access
openclaw secrets list                                       # List all secrets
openclaw secrets delete <name> --confirm                    # Delete from keychain
openclaw secrets setup-totp                                 # Configure TOTP authenticator
openclaw secrets info                                       # Show broker/mode status
openclaw elevate <totp-code> <command>                      # TOTP-gated sudo
```

## Agent Tool

The `secrets` tool supports actions: `get`, `request`, `status`, `list`, `resolve`.

In `balanced`/`strict` modes, `get` returns metadata only:

```
✅ Secret available: github_token (expires in 3h 42m)
Type: github_pat
Hint: Personal access token for repo:write
Reference: secret:github_token
```

The `resolve` action returns a `credentialRef` string for use in other tool calls:

```
Use credentialRef: "secret:github_token" in tool parameters
```

## Credential Broker Flow

```
Agent → Tool call (credentialRef: "secret:github_token")
  → Broker intercepts (pi-tool-definition-adapter.ts)
  → Resolves via getSecret() (validates grant + tier)
  → Injects real value into params
  → Tool executes with credential
  → Response contains no secret value
```

## Architecture

```
src/secrets/
├── index.ts              # Main API (getSecret, setSecret, grantSecret, etc.)
├── keychain.ts           # Cross-platform OS keychain abstraction
├── grants.ts             # Time-limited access grant files
├── totp.ts               # RFC 6238 TOTP implementation
├── registry.ts           # Secret definitions from config
├── credential-broker.ts  # Agent-blind credential injection
├── vault-backend.ts      # Pluggable storage backend abstraction
├── audit.ts              # JSONL audit logging
└── README.md             # This file

src/cli/
├── secrets-cli.ts        # CLI commands (set, get, grant, revoke, list, etc.)
└── elevate-cli.ts        # TOTP-gated sudo CLI

src/agents/tools/
└── secrets-tool.ts       # Agent tool (get, request, status, list, resolve)
```

## Production Hardening

For production deployments, run OpenClaw as a dedicated service account:

```bash
sudo bash scripts/migrate-to-service-account.sh
```

This creates an `openclaw` system user with:

- No login shell, no sudo, no admin privileges
- Grants directory owned by your human user (AI can't self-approve)
- System service (launchd on macOS, systemd on Linux)
- Symlinks for easy human access to workspace

See `scripts/migrate-to-service-account.sh` for details.

## Testing

```bash
# Run all secrets tests
pnpm test src/secrets/

# Individual test suites
pnpm test src/secrets/totp.test.ts           # 21 tests
pnpm test src/secrets/grants.test.ts         # 24 tests
pnpm test src/secrets/keychain.test.ts       # 33 tests
pnpm test src/secrets/credential-broker.test.ts
pnpm test src/secrets/vault-backend.test.ts
pnpm test src/secrets/audit.test.ts
```
