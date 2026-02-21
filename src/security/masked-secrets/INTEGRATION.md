# Masked Secrets — Integration Guide

## Overview

This module provides three layers of secret protection:

1. **Preflight** — Block dangerous commands, substitute `{{secret:NAME}}` refs
2. **Redaction** — Scrub leaked secret values from command output
3. **Store** — Load and manage secrets from .env / process.env / config

## Integration Points

### 1. Gateway Startup (`src/daemon/` or `src/gateway/`)

Initialize the MaskedSecrets instance when the gateway starts:

```ts
import { createMaskedSecrets } from "../security/masked-secrets/index.js";

// Read config from openclaw.json
const maskedSecrets = createMaskedSecrets(config.security?.maskedSecrets);
```

The instance should be a singleton, accessible to the exec tool.

### 2. Shell Command Execution (`src/agents/bash-tools.exec.ts`)

**Before execution** — in the `runExecProcess` flow or wherever the command string
is finalized before being passed to `spawn`:

```ts
// Preflight: check + substitute
const preflight = maskedSecrets.preflight(command);
if (!preflight.allowed) {
  return { error: preflight.reason };
}
const realCommand = preflight.processedCommand ?? command;

// Execute realCommand (agent never sees this)
```

**After execution** — before output is returned to the agent:

```ts
// Redact any leaked secrets from output
const { text: safeStdout } = maskedSecrets.redact(rawStdout);
const { text: safeStderr } = maskedSecrets.redact(rawStderr);

// Return safeStdout/safeStderr to the agent
```

### 3. Config Schema (`src/config/zod-schema.ts`)

Add masked secrets config to the schema:

```ts
maskedSecrets: z.object({
  enabled: z.boolean().default(true),
  mask: z.array(z.string()).default([]),
  outputPatterns: z.array(z.string()).optional(),
  blockedCommands: z.array(z.string()).optional(),
  blockSecretFileReads: z.boolean().default(true),
  secretFilePaths: z.array(z.string()).optional(),
}).optional(),
```

### 4. System Prompt (`src/auto-reply/reply/prompt-builder.ts`)

Inform the agent about the `{{secret:NAME}}` syntax:

```
## Secrets

To use API keys or secrets in commands, use the reference syntax:
  curl -H "Authorization: Bearer {{secret:MY_API_KEY}}" https://api.example.com

Available secrets: ${secretNames.join(", ")}

Do NOT try to read .env files or print environment variables directly.
```

### 5. Process Output Streaming (`src/agents/bash-tools.process.ts`)

For background processes that stream output, redaction needs to happen
on each chunk before it reaches the agent:

```ts
// In the log/poll output handler:
const { text: safeChunk } = maskedSecrets.redact(rawChunk);
```

## Config Example

```json5
// openclaw.json
{
  security: {
    maskedSecrets: {
      enabled: true,
      mask: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "BRAVE_API_KEY"],
      blockSecretFileReads: true,
    },
  },
}
```

## Testing

```bash
cd ~/Projects/openclaw
npx vitest run src/security/masked-secrets/
```

## Files

| File              | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `types.ts`        | Type definitions                               |
| `secret-store.ts` | Secret loading, storage, and matching          |
| `substitution.ts` | `{{secret:NAME}}` → real value replacement     |
| `redaction.ts`    | Output scrubbing (exact match + pattern match) |
| `preflight.ts`    | Pre-execution command checks                   |
| `index.ts`        | Public API facade                              |
| `*.test.ts`       | Unit tests for each module                     |

## Security Notes

- Secret values are held in memory only (SecretStore). They are never written
  to disk, logs, or chat history.
- The `{{secret:NAME}}` reference syntax is designed to be safe to store in
  chat history — it contains no sensitive data.
- Pattern-based redaction catches common API key formats even if they're not
  in the store (defense in depth).
- Short values (< 8 chars) are excluded from exact-match redaction to prevent
  false positives.
- This is NOT a perfect security boundary — a determined attacker could encode
  secrets (base64, hex, etc.) to bypass redaction. It's a safety net, not a
  sandbox. For true isolation, use SkillSandbox-style OS-level enforcement.
