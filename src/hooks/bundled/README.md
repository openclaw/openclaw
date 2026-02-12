# Bundled Hooks

This directory contains hooks that ship with OpenClaw. These hooks are automatically discovered and can be enabled/disabled via CLI or configuration.

## Available Hooks

### 💾 session-memory

Automatically saves session context to memory when you issue `/new`.

**Events**: `command:new`
**What it does**: Creates a dated memory file with LLM-generated slug based on conversation content.
**Output**: `<workspace>/memory/YYYY-MM-DD-slug.md` (defaults to `~/.openclaw/workspace`)

**Enable**:

```bash
openclaw hooks enable session-memory
```

### 📝 command-logger

Logs all command events to a centralized audit file.

**Events**: `command` (all commands)
**What it does**: Appends JSONL entries to command log file.
**Output**: `~/.openclaw/logs/commands.log`

**Enable**:

```bash
openclaw hooks enable command-logger
```

### 🚀 boot-md

Runs `BOOT.md` whenever the gateway starts (after channels start).

**Events**: `gateway:startup`
**What it does**: Executes BOOT.md instructions via the agent runner.
**Output**: Whatever the instructions request (for example, outbound messages).

**Enable**:

```bash
openclaw hooks enable boot-md
```

## Hook Structure

Each hook is a directory containing:

- **HOOK.md**: Metadata and documentation in YAML frontmatter + Markdown
- **handler.ts**: The hook handler function (default export)

Example structure:

```
session-memory/
├── HOOK.md          # Metadata + docs
└── handler.ts       # Handler implementation
```

## HOOK.md Format

```yaml
---
name: my-hook
description: "Short description"
homepage: https://docs.openclaw.ai/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---
# Hook Title

Documentation goes here...
```

### Metadata Fields

- **emoji**: Display emoji for CLI
- **events**: Array of events to listen for (e.g., `["command:new", "session:start"]`)
- **requires**: Optional requirements
  - **bins**: Required binaries on PATH
  - **anyBins**: At least one of these binaries must be present
  - **env**: Required environment variables
  - **config**: Required config paths (e.g., `["workspace.dir"]`)
  - **os**: Required platforms (e.g., `["darwin", "linux"]`)
- **install**: Installation methods (for bundled hooks: `[{"id":"bundled","kind":"bundled"}]`)

## Creating Custom Hooks

To create your own hooks, place them in:

- **Workspace hooks**: `<workspace>/hooks/` (highest precedence)
- **Managed hooks**: `~/.openclaw/hooks/` (shared across workspaces)

Custom hooks follow the same structure as bundled hooks.

## Managing Hooks

List all hooks:

```bash
openclaw hooks list
```

Show hook details:

```bash
openclaw hooks info session-memory
```

Check hook status:

```bash
openclaw hooks check
```

Enable/disable:

```bash
openclaw hooks enable session-memory
openclaw hooks disable command-logger
```

## Configuration

Hooks can be configured in `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": {
          "enabled": true
        },
        "command-logger": {
          "enabled": false
        }
      }
    }
  }
}
```

## Event Types

Currently supported events:

- **command**: All command events
- **command:new**: `/new` command specifically
- **command:reset**: `/reset` command
- **command:stop**: `/stop` command
- **agent:bootstrap**: Before workspace bootstrap files are injected
- **gateway:startup**: Gateway startup (after channels start)

More event types coming soon (session lifecycle, agent errors, etc.).

## Handler API

Hook handlers receive an `InternalHookEvent` object:

```typescript
interface InternalHookEvent {
  type: "command" | "session" | "agent" | "gateway";
  action: string; // e.g., 'new', 'reset', 'stop'
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[]; // Push messages here to send to user
}
```

Example handler:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
  console.log("New command triggered!");

  // Optionally send message to user
  event.messages.push("✨ Hook executed!");
};

export default myHandler;
```

## Testing

Test your hooks by:

1. Place hook in workspace hooks directory
2. Restart gateway: `pkill -9 -f 'openclaw.*gateway' && pnpm openclaw gateway`
3. Enable the hook: `openclaw hooks enable my-hook`
4. Trigger the event (e.g., send `/new` command)
5. Check gateway logs for hook execution

## Documentation

Full documentation: https://docs.openclaw.ai/hooks
