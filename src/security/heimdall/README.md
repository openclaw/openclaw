# Heimdall Security Layer

**Deterministic security enforcement for OpenClaw agents.**

---

## Overview

Heimdall is OpenClaw's security layer that enforces access control, rate limiting, input sanitization, and output filtering for agent tool calls. It provides defense-in-depth through a multi-stage pipeline:

```
GATE → SANITIZE → AUTHORIZE → FILTER
```

| Stage         | Purpose                                   |
| ------------- | ----------------------------------------- |
| **GATE**      | Rate limiting (prevent abuse)             |
| **SANITIZE**  | Input validation (prevent injection)      |
| **AUTHORIZE** | Tool ACL (access control by sender tier)  |
| **FILTER**    | Output redaction (prevent secret leakage) |

---

## Sender Tiers

Heimdall uses a **4-tier authorization model**:

| Tier       | Use Case                                | Tool Access                           | Configuration               |
| ---------- | --------------------------------------- | ------------------------------------- | --------------------------- |
| **OWNER**  | Human administrators, direct CLI        | All tools (hardcoded bypass)          | `senderTiers.owners` list   |
| **SYSTEM** | Internal runtime (cron, heartbeat, CLI) | Read-only + safe ops (same as MEMBER) | `internal: true` flag       |
| **MEMBER** | Team members, normal users              | Read-only + safe ops                  | `senderTiers.members` list  |
| **GUEST**  | External users, unauthorized            | Minimal (read-only or deny-all)       | Everyone else (fail-closed) |

**Resolution order:**

```
isTrustedInternal → OWNER list → MEMBER list → allowFrom → GUEST (fail-closed)
```

**Privilege levels:**

```
OWNER >> SYSTEM = MEMBER > GUEST
```

**Note:** SYSTEM and MEMBER have **identical tool access** by default. SYSTEM is a **trust boundary marker** for internal operations, not a privilege escalation.

---

## SYSTEM Tier (New in 2026.2)

**The SYSTEM tier provides least-privilege security for trusted internal runtime operations.**

### Key Properties

- ✅ **Conservative baseline** — same as MEMBER tier (read-only + safe operations)
- ✅ **Non-delegable** — subagents do NOT inherit SYSTEM tier
- ✅ **Auditable** — all operations logged with optional tracing fields
- ✅ **Configurable** — can be extended via `toolACL` config

### When to Use

| Use SYSTEM tier for: | Rationale                                        |
| -------------------- | ------------------------------------------------ |
| Cron jobs            | Automated tasks need minimal privileges          |
| Heartbeat tasks      | Health checks, status updates (read-only)        |
| CLI invocations      | Script-driven operations                         |
| Maintenance tasks    | Cleanup, monitoring, reporting                   |
| Internal APIs        | Service-to-service calls within trusted boundary |

### Usage

```typescript
import { createOpenClawCodingTools } from "./agents/pi-tools.js";

// Cron job example
const tools = createOpenClawCodingTools({
  config,
  senderId: "cron",
  internal: true, // ← SYSTEM tier flag
  sessionKey: "agent:cron:daily-sync",
});

// Result: senderTier = "system"
// Allowed tools: search, read, sessions_list, web_fetch, etc.
```

### Default Tool Access

**SYSTEM tier uses `DEFAULT_MEMBER_SAFE` list:**

```typescript
(search,
  read,
  sessions_list,
  sessions_history,
  session_status,
  image,
  memory_search,
  memory_get,
  web_search,
  web_fetch,
  agents_list);
```

**Blocked by default:**

- File writes: `write`, `edit`, `sandboxed_write`, `sandboxed_edit` (dangerous patterns)
- Command execution: `exec`, `process` (dangerous patterns), `bash` (not in safe list)
- Code patching: `apply_patch` (dangerous pattern)
- MCP operations: `mcp__*__execute_*`, `mcp__*__write_*`, `mcp__*__delete_*` (dangerous patterns)

### Extending SYSTEM Tier

To allow additional tools, add custom `toolACL` entry:

```json
{
  "agents": {
    "defaults": {
      "heimdall": {
        "enabled": true,
        "toolACL": [
          {
            "pattern": "message",
            "allowedTiers": ["system", "member", "owner"]
          },
          {
            "pattern": "sessions_send",
            "allowedTiers": ["system", "member", "owner"]
          }
        ]
      }
    }
  }
}
```

**📚 Full documentation:** [SYSTEM_TIER.md](../../../docs/heimdall/SYSTEM_TIER.md)

---

## Configuration

**Enable Heimdall in `openclaw.json`:**

```json
{
  "agents": {
    "defaults": {
      "heimdall": {
        "enabled": true,
        "senderTiers": {
          "owners": [111, "thebtf"],
          "members": [222, "alice"]
        },
        "defaultGuestPolicy": "read-only",
        "toolACL": [
          {
            "pattern": "browser",
            "allowedTiers": ["member", "owner"]
          },
          {
            "pattern": "exec",
            "allowedTiers": ["owner"]
          }
        ],
        "rateLimit": {
          "enabled": true,
          "windowMs": 60000,
          "maxMessages": 30,
          "guestMaxMessages": 5
        },
        "outputFilter": {
          "enabled": true
        },
        "audit": {
          "enabled": true,
          "logBlockedTools": true,
          "logRedactions": true
        }
      }
    }
  }
}
```

---

## Tool ACL (Access Control)

**Tool ACL determines which tools are allowed for each sender tier.**

### Evaluation Order

1. **OWNER bypass** — always allowed (hardcoded, cannot be restricted)
2. **Normalize tool name** — trim, lowercase, apply aliases
3. **Custom toolACL** — first matching glob pattern wins
4. **Default rules:**
   - Dangerous patterns → deny
   - Safe lists → allow (SYSTEM/MEMBER use same safe list)
   - Otherwise → deny (fail-closed)

### Dangerous Patterns (Blocked by Default)

```
exec, process, apply_patch, write, edit,
sandboxed_write, sandboxed_edit,
mcp__*__execute_*, mcp__*__write_*, mcp__*__delete_*
```

### Safe List (MEMBER & SYSTEM)

```
search, read, sessions_list, sessions_history, session_status,
image, memory_search, memory_get, web_search, web_fetch, agents_list
```

### Custom ACL Patterns

**Glob patterns** supported: `*` matches any sequence.

```json
{
  "toolACL": [
    {
      "pattern": "browser",
      "allowedTiers": ["member", "owner"]
    },
    {
      "pattern": "mcp__github__*",
      "allowedTiers": ["owner"]
    },
    {
      "pattern": "telegram_*",
      "allowedTiers": ["system", "member", "owner"]
    }
  ]
}
```

---

## Rate Limiting

**Sliding window rate limiting per sender.**

```json
{
  "rateLimit": {
    "enabled": true,
    "windowMs": 60000, // 1 minute
    "maxMessages": 30, // 30 messages/min for OWNER/MEMBER/SYSTEM
    "guestMaxMessages": 5 // 5 messages/min for GUEST
  }
}
```

**Per-sender buckets:** Each `senderId` gets independent counter.

**Behavior on limit:**

- Block tool call
- Log `rate_limit` event
- Return error to agent

---

## Input Sanitization

**Dangerous patterns in tool inputs are blocked.**

### Built-in Patterns

- Command injection: `$(...)`, `` `...` ``, `$\{...\}`, `; rm -rf`, `| bash`
- Path traversal: `../`, `..\\`, absolute paths in sandboxed tools
- Script injection: `<script>`, `javascript:`, `eval(`, `setTimeout(`

### Custom Patterns

```json
{
  "sanitize": {
    "enabled": true,
    "customPatterns": [
      {
        "pattern": "DROP TABLE",
        "reason": "SQL injection attempt"
      }
    ]
  }
}
```

---

## Output Filtering

**Sensitive data is redacted from tool outputs.**

### Built-in Patterns

- API keys: OpenAI, Anthropic, Google, AWS
- Secrets: JWT tokens, bearer tokens, passwords
- Credentials: Database connection strings, private keys

### Redaction Format

```
[REDACTED:OpenAI API Key]
[REDACTED:AWS Secret Key]
[REDACTED:JWT Token]
```

### Custom Patterns

```json
{
  "outputFilter": {
    "enabled": true,
    "customPatterns": [
      {
        "name": "Internal API Token",
        "regex": "int_tok_[a-zA-Z0-9]{32}",
        "flags": "g"
      }
    ]
  }
}
```

---

## Audit Logging

**Structured security event logging.**

### Events Logged

| Event          | Description                         |
| -------------- | ----------------------------------- |
| `tool_blocked` | Tool call denied by ACL             |
| `redaction`    | Sensitive data redacted from output |
| `rate_limit`   | Rate limit exceeded                 |
| `sanitization` | Dangerous input pattern detected    |

### Log Format

```json
{
  "event": "tool_blocked",
  "toolName": "exec",
  "senderTier": "system",
  "reason": "Tool not in SYSTEM tier safe list",
  "internal_reason": "cron",
  "correlation_id": "cron-job-abc123",
  "timestamp": "2026-02-12T02:57:00.000Z"
}
```

### Configuration

```json
{
  "audit": {
    "enabled": true,
    "logBlockedTools": true,
    "logRedactions": true,
    "logRateLimits": true,
    "logSanitization": true
  }
}
```

**Log file:** `~/.openclaw/logs/heimdall-audit.jsonl` (JSON lines)

---

## Testing

**Test suites:**

```bash
npm test -- src/security/heimdall
```

**Test files:**

- `tool-acl.test.ts` — Tool ACL rules (60 tests)
- `sender-tier.test.ts` — Tier resolution (23 tests)
- `rate-limit.test.ts` — Rate limiting (12 tests)
- `sanitize.test.ts` — Input sanitization (22 tests)
- `output-filter.test.ts` — Output filtering (20 tests)
- `audit-internal-tier.test.ts` — SYSTEM tier audit (6 tests)
- `subagent-inheritance.test.ts` — Non-delegation (6 tests)
- `integration.test.ts` — Full pipeline (15 tests)

**Total:** 240+ tests

---

## Security Considerations

### Non-Delegation (SYSTEM Tier)

**SYSTEM tier is NOT inherited by subagents.**

```typescript
// Parent session (cron job)
const parentTools = createOpenClawCodingTools({
  config,
  internal: true, // ← SYSTEM tier
  senderId: "cron",
});

// Subagent session (spawned by parent)
const subagentTools = createOpenClawCodingTools({
  config,
  internal: false, // ← NOT inherited
  senderId: "cron", // Parent senderId propagated
});

// Result:
// - Parent: senderTier = "system"
// - Subagent: senderTier = "guest" (senderId not in config)
```

**Why:**

- Prevents confused deputy attacks
- Principle of attenuation (delegated privileges ≤ delegator)
- Audit trail clarity (SYSTEM = direct internal, not delegated)

### Precedence Over OWNER

**`internal: true` overrides OWNER tier** (by design).

```typescript
// User in owners list
config.agents.defaults.heimdall.senderTiers.owners = [111];

// OWNER credentials + internal flag
const tools = createOpenClawCodingTools({
  config,
  senderId: 111,
  internal: true, // ← Overrides OWNER resolution
});

// Result: senderTier = "system" (NOT "owner")
```

**Rationale:** Automated calls should have minimal privileges, even with owner credentials.

### Fail-Closed

**Unknown senders default to GUEST tier** (minimal access).

```typescript
// Sender not in owners/members list
const tools = createOpenClawCodingTools({
  config,
  senderId: "unknown",
  internal: false,
});

// Result: senderTier = "guest"
// Allowed tools: read-only if defaultGuestPolicy = "read-only", else deny-all
```

---

## Migration Guide

### From No Security to Heimdall

**Step 1:** Enable Heimdall without restrictions

```json
{
  "heimdall": {
    "enabled": true,
    "toolACL": [
      {
        "pattern": "*",
        "allowedTiers": ["guest", "member", "owner", "system"]
      }
    ]
  }
}
```

**Step 2:** Add owners/members to senderTiers

```json
{
  "senderTiers": {
    "owners": [111, "alice"],
    "members": [222, "bob"]
  }
}
```

**Step 3:** Enable audit logging

```json
{
  "audit": {
    "enabled": true,
    "logBlockedTools": true
  }
}
```

**Step 4:** Remove wildcard ACL, use defaults

```json
{
  "toolACL": [
    // Only add exceptions, defaults will apply
    {
      "pattern": "browser",
      "allowedTiers": ["member", "owner"]
    }
  ]
}
```

**Step 5:** Enable rate limiting and output filtering

```json
{
  "rateLimit": { "enabled": true },
  "outputFilter": { "enabled": true }
}
```

### From `senderIsOwner: true` to `internal: true`

**Before (privilege escalation risk):**

```typescript
const tools = createOpenClawCodingTools({
  config,
  senderIsOwner: true, // ← Forced OWNER tier
  senderId: "cron",
});

// Result: senderTier = "owner" (full access)
```

**After (least privilege):**

```typescript
const tools = createOpenClawCodingTools({
  config,
  internal: true, // ← SYSTEM tier
  senderId: "cron",
});

// Result: senderTier = "system" (read-only + safe operations)
```

**Breaking changes:**

- ❌ Internal calls NO LONGER have `write`, `edit`, `exec` by default
- ✅ Must extend via `toolACL` if these tools are needed
- ✅ Audit trail now accurate (SYSTEM tier logged, not OWNER)

---

## Architecture

### Pipeline Flow

```
Agent Tool Call
    ↓
Heimdall GATE (rate limit check)
    ↓
Heimdall SANITIZE (input validation)
    ↓
Heimdall AUTHORIZE (tool ACL check)
    ↓
Tool Execution
    ↓
Heimdall FILTER (output redaction)
    ↓
Return to Agent
```

### Modules

| Module            | File                | Purpose                             |
| ----------------- | ------------------- | ----------------------------------- |
| **types**         | `types.ts`          | Type definitions, SenderTier enum   |
| **sender-tier**   | `sender-tier.ts`    | Tier resolution logic               |
| **tool-acl**      | `tool-acl.ts`       | Tool access control (AUTHORIZE)     |
| **rate-limit**    | `rate-limit.ts`     | Sliding window rate limiting (GATE) |
| **sanitize**      | `sanitize.ts`       | Input validation (SANITIZE)         |
| **output-filter** | `output-filter.ts`  | Secret redaction (FILTER)           |
| **audit**         | `audit.ts`          | Structured event logging            |
| **config**        | `resolve-config.ts` | Config resolution and validation    |

### Integration Points

| File                           | Integration                                                    |
| ------------------------------ | -------------------------------------------------------------- |
| `pi-tools.ts`                  | Tool creation, sender tier resolution, `internal` flag mapping |
| `pi-tools.before-tool-call.ts` | GATE → SANITIZE → AUTHORIZE hook                               |
| `pi-tools.policy.ts`           | Tool filtering by ACL                                          |
| `cron/isolated-agent/run.ts`   | Cron jobs use `internal: true`                                 |
| `commands/agent.ts`            | CLI uses `internal: true`                                      |

---

## Related Documentation

- **[SYSTEM_TIER.md](../../../docs/heimdall/SYSTEM_TIER.md)** — Detailed SYSTEM tier usage guide
- **[tool-acl.ts](./tool-acl.ts)** — Tool ACL implementation
- **[sender-tier.ts](./sender-tier.ts)** — Tier resolution logic
- **[audit.ts](./audit.ts)** — Audit logging interface

---

**Version:** 2026.2.12
**Implementation:** Phase 1-3 complete
**Author:** thebtf
**Co-Authored-By:** Claude Sonnet 4.5
