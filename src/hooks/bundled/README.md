# Bundled Hooks（轉為繁體中文）
（轉為繁體中文）
This directory contains hooks that ship with OpenClaw. These hooks are automatically discovered and can be enabled/disabled via CLI or configuration.（轉為繁體中文）
（轉為繁體中文）
## Available Hooks（轉為繁體中文）
（轉為繁體中文）
### 💾 session-memory（轉為繁體中文）
（轉為繁體中文）
Automatically saves session context to memory when you issue `/new`.（轉為繁體中文）
（轉為繁體中文）
**Events**: `command:new`（轉為繁體中文）
**What it does**: Creates a dated memory file with LLM-generated slug based on conversation content.（轉為繁體中文）
**Output**: `<workspace>/memory/YYYY-MM-DD-slug.md` (defaults to `~/.openclaw/workspace`)（轉為繁體中文）
（轉為繁體中文）
**Enable**:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks enable session-memory（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
### 📝 command-logger（轉為繁體中文）
（轉為繁體中文）
Logs all command events to a centralized audit file.（轉為繁體中文）
（轉為繁體中文）
**Events**: `command` (all commands)（轉為繁體中文）
**What it does**: Appends JSONL entries to command log file.（轉為繁體中文）
**Output**: `~/.openclaw/logs/commands.log`（轉為繁體中文）
（轉為繁體中文）
**Enable**:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks enable command-logger（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
### 😈 soul-evil（轉為繁體中文）
（轉為繁體中文）
Swaps injected `SOUL.md` content with `SOUL_EVIL.md` during a purge window or by random chance.（轉為繁體中文）
（轉為繁體中文）
**Events**: `agent:bootstrap`（轉為繁體中文）
**What it does**: Overrides the injected SOUL content before the system prompt is built.（轉為繁體中文）
**Output**: No files written; swaps happen in-memory only.（轉為繁體中文）
**Docs**: https://docs.openclaw.ai/hooks/soul-evil（轉為繁體中文）
（轉為繁體中文）
**Enable**:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks enable soul-evil（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
### 🚀 boot-md（轉為繁體中文）
（轉為繁體中文）
Runs `BOOT.md` whenever the gateway starts (after channels start).（轉為繁體中文）
（轉為繁體中文）
**Events**: `gateway:startup`（轉為繁體中文）
**What it does**: Executes BOOT.md instructions via the agent runner.（轉為繁體中文）
**Output**: Whatever the instructions request (for example, outbound messages).（轉為繁體中文）
（轉為繁體中文）
**Enable**:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks enable boot-md（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Hook Structure（轉為繁體中文）
（轉為繁體中文）
Each hook is a directory containing:（轉為繁體中文）
（轉為繁體中文）
- **HOOK.md**: Metadata and documentation in YAML frontmatter + Markdown（轉為繁體中文）
- **handler.ts**: The hook handler function (default export)（轉為繁體中文）
（轉為繁體中文）
Example structure:（轉為繁體中文）
（轉為繁體中文）
```（轉為繁體中文）
session-memory/（轉為繁體中文）
├── HOOK.md          # Metadata + docs（轉為繁體中文）
└── handler.ts       # Handler implementation（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## HOOK.md Format（轉為繁體中文）
（轉為繁體中文）
```yaml（轉為繁體中文）
---（轉為繁體中文）
name: my-hook（轉為繁體中文）
description: "Short description"（轉為繁體中文）
homepage: https://docs.openclaw.ai/hooks#my-hook（轉為繁體中文）
metadata:（轉為繁體中文）
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }（轉為繁體中文）
---（轉為繁體中文）
# Hook Title（轉為繁體中文）
（轉為繁體中文）
Documentation goes here...（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
### Metadata Fields（轉為繁體中文）
（轉為繁體中文）
- **emoji**: Display emoji for CLI（轉為繁體中文）
- **events**: Array of events to listen for (e.g., `["command:new", "session:start"]`)（轉為繁體中文）
- **requires**: Optional requirements（轉為繁體中文）
  - **bins**: Required binaries on PATH（轉為繁體中文）
  - **anyBins**: At least one of these binaries must be present（轉為繁體中文）
  - **env**: Required environment variables（轉為繁體中文）
  - **config**: Required config paths (e.g., `["workspace.dir"]`)（轉為繁體中文）
  - **os**: Required platforms (e.g., `["darwin", "linux"]`)（轉為繁體中文）
- **install**: Installation methods (for bundled hooks: `[{"id":"bundled","kind":"bundled"}]`)（轉為繁體中文）
（轉為繁體中文）
## Creating Custom Hooks（轉為繁體中文）
（轉為繁體中文）
To create your own hooks, place them in:（轉為繁體中文）
（轉為繁體中文）
- **Workspace hooks**: `<workspace>/hooks/` (highest precedence)（轉為繁體中文）
- **Managed hooks**: `~/.openclaw/hooks/` (shared across workspaces)（轉為繁體中文）
（轉為繁體中文）
Custom hooks follow the same structure as bundled hooks.（轉為繁體中文）
（轉為繁體中文）
## Managing Hooks（轉為繁體中文）
（轉為繁體中文）
List all hooks:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks list（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
Show hook details:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks info session-memory（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
Check hook status:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks check（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
Enable/disable:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks enable session-memory（轉為繁體中文）
openclaw hooks disable command-logger（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Configuration（轉為繁體中文）
（轉為繁體中文）
Hooks can be configured in `~/.openclaw/openclaw.json`:（轉為繁體中文）
（轉為繁體中文）
```json（轉為繁體中文）
{（轉為繁體中文）
  "hooks": {（轉為繁體中文）
    "internal": {（轉為繁體中文）
      "enabled": true,（轉為繁體中文）
      "entries": {（轉為繁體中文）
        "session-memory": {（轉為繁體中文）
          "enabled": true（轉為繁體中文）
        },（轉為繁體中文）
        "command-logger": {（轉為繁體中文）
          "enabled": false（轉為繁體中文）
        }（轉為繁體中文）
      }（轉為繁體中文）
    }（轉為繁體中文）
  }（轉為繁體中文）
}（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Event Types（轉為繁體中文）
（轉為繁體中文）
Currently supported events:（轉為繁體中文）
（轉為繁體中文）
- **command**: All command events（轉為繁體中文）
- **command:new**: `/new` command specifically（轉為繁體中文）
- **command:reset**: `/reset` command（轉為繁體中文）
- **command:stop**: `/stop` command（轉為繁體中文）
- **agent:bootstrap**: Before workspace bootstrap files are injected（轉為繁體中文）
- **gateway:startup**: Gateway startup (after channels start)（轉為繁體中文）
（轉為繁體中文）
More event types coming soon (session lifecycle, agent errors, etc.).（轉為繁體中文）
（轉為繁體中文）
## Handler API（轉為繁體中文）
（轉為繁體中文）
Hook handlers receive an `InternalHookEvent` object:（轉為繁體中文）
（轉為繁體中文）
```typescript（轉為繁體中文）
interface InternalHookEvent {（轉為繁體中文）
  type: "command" | "session" | "agent" | "gateway";（轉為繁體中文）
  action: string; // e.g., 'new', 'reset', 'stop'（轉為繁體中文）
  sessionKey: string;（轉為繁體中文）
  context: Record<string, unknown>;（轉為繁體中文）
  timestamp: Date;（轉為繁體中文）
  messages: string[]; // Push messages here to send to user（轉為繁體中文）
}（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
Example handler:（轉為繁體中文）
（轉為繁體中文）
```typescript（轉為繁體中文）
import type { HookHandler } from "../../src/hooks/hooks.js";（轉為繁體中文）
（轉為繁體中文）
const myHandler: HookHandler = async (event) => {（轉為繁體中文）
  if (event.type !== "command" || event.action !== "new") {（轉為繁體中文）
    return;（轉為繁體中文）
  }（轉為繁體中文）
（轉為繁體中文）
  // Your logic here（轉為繁體中文）
  console.log("New command triggered!");（轉為繁體中文）
（轉為繁體中文）
  // Optionally send message to user（轉為繁體中文）
  event.messages.push("✨ Hook executed!");（轉為繁體中文）
};（轉為繁體中文）
（轉為繁體中文）
export default myHandler;（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Testing（轉為繁體中文）
（轉為繁體中文）
Test your hooks by:（轉為繁體中文）
（轉為繁體中文）
1. Place hook in workspace hooks directory（轉為繁體中文）
2. Restart gateway: `pkill -9 -f 'openclaw.*gateway' && pnpm openclaw gateway`（轉為繁體中文）
3. Enable the hook: `openclaw hooks enable my-hook`（轉為繁體中文）
4. Trigger the event (e.g., send `/new` command)（轉為繁體中文）
5. Check gateway logs for hook execution（轉為繁體中文）
（轉為繁體中文）
## Documentation（轉為繁體中文）
（轉為繁體中文）
Full documentation: https://docs.openclaw.ai/hooks（轉為繁體中文）
