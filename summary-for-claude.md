# Summary for Claude — Cursor CLI integration (OpenClaw)

Context and essential info for another agent to carry on.

## What was done

OpenClaw now has a **cursor-cli** backend: the Cursor Agent CLI is used like `claude-cli`, with auth via **OAuth** (`cursor agent login`), not the Cursor Background Agents API key.

### Session changes (2026-01-30)

- **`--version` now shows commit hash**: e.g. `2026.1.29 (67b2c05)` — uses `resolveCommitHash()` from `src/infra/git-commit.ts`
- **`--agent` defaults to `"main"`**: No need to pass `--agent main` every time
- **Gateway schema**: Already had `model` field — just needed gateway restart with new build
- **Plugin manifest created**: `extensions/cursor-agent/openclaw.plugin.json` (was missing, caused config validation errors)
- **Global install**: After building, run `npm install -g .` to install dev version globally
- **Onboarding**: Added cursor-cli to auth choice options (`src/commands/auth-choice.apply.cursor-cli.ts`)
- **TUI JSONL parsing**: Fixed to handle cursor-cli format (`src/agents/cli-runner/helpers.ts`)
- **Provider-specific loggers**: `agent/cursor-cli`, `agent/codex-cli`, `agent/claude-cli` subsystems (`src/agents/cli-runner.ts`)

## Two Cursor integrations

1. **cursor-agent** (extension) — Background Agents API, API key from dashboard, remote runs.
2. **cursor-cli** (core) — CLI backend, OAuth via `cursor agent login`, local runs.

## Key files

| Area                    | Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI backend config      | `src/agents/cli-backends.ts` — `DEFAULT_CURSOR_BACKEND`, `cursor-cli` in `resolveCliBackendIds` / `resolveCliBackendConfig`                                                                                                                                                                                                                                                                                                                                         |
| Credentials (keychain)  | `src/agents/cli-credentials.ts` — `readCursorCliCredentials()`, `readCursorCliCredentialsCached()`, `CursorCliCredential`; reads macOS Keychain `cursor-access-token` / `cursor-refresh-token`                                                                                                                                                                                                                                                                      |
| Model selection         | `src/agents/model-selection.ts` — `cursor-cli` in `isCliProvider()`                                                                                                                                                                                                                                                                                                                                                                                                 |
| Runner                  | `src/agents/cli-runner.ts` — generic runner with provider-specific loggers (`agent/cursor-cli`, `agent/codex-cli`, `agent/claude-cli`). `src/agents/cursor-cli-runner.ts` — `runCursorCliAgent()` wrapper                                                                                                                                                                                                                                                           |
| Onboarding              | `src/commands/auth-choice.apply.cursor-cli.ts` — cursor-cli auth choice handler for onboarding wizard                                                                                                                                                                                                                                                                                                                                                               |
| JSONL parsing           | `src/agents/cli-runner/helpers.ts` — `parseCliJsonl()` handles cursor-cli format                                                                                                                                                                                                                                                                                                                                                                                    |
| Auth profile ID         | `src/agents/auth-profiles/constants.ts` — `CURSOR_CLI_PROFILE_ID = "cursor:cursor-cli"`                                                                                                                                                                                                                                                                                                                                                                             |
| Version with commit     | `src/cli/program/help.ts` — imports `resolveCommitHash()`, shows `version (commit)`                                                                                                                                                                                                                                                                                                                                                                                 |
| Default agent           | `src/cli/program/register.agent.ts` — `--agent <id>` defaults to `"main"`                                                                                                                                                                                                                                                                                                                                                                                           |
| Agent command `--model` | `src/cli/program/register.agent.ts` — `--model <provider/model>`; `src/commands/agent-via-gateway.ts` — `model` in opts and gateway params; `src/gateway/protocol/schema/agent.ts` — `model` in `AgentParamsSchema`; `src/gateway/server-methods/agent.ts` — passes `model` to `agentCommand`; `src/commands/agent/types.ts` — `model?: string` in `AgentCommandOpts`; `src/commands/agent.ts` — parses `opts.model` and uses it for this run (over session/config) |
| Models status (auth)    | `src/commands/models/list.types.ts` — `effective.kind` includes `"cli"`, `cliAuth?: boolean`; `src/commands/models/list.auth-overview.ts` — for `cursor-cli` calls `readCursorCliCredentials()`, sets `effective: { kind: "cli", detail: "cursor agent login (keychain)" }` and `cliAuth: true`; `src/commands/models/list.status-command.ts` — filter keeps entries with `cliAuth`, Missing auth hint for cursor-cli: `Run \`cursor agent login\``                 |
| Plugin manifest         | `extensions/cursor-agent/openclaw.plugin.json` — required for extension to load                                                                                                                                                                                                                                                                                                                                                                                     |

## How it works

- **Auth:** User runs `cursor agent login` (OAuth). Cursor stores tokens in macOS Keychain (`cursor-access-token`, `cursor-refresh-token`, account `cursor-user`). OpenClaw does **not** store cursor tokens; it only reads them via `readCursorCliCredentials()` (darwin only).
- **Execution:** OpenClaw runs `cursor agent --print --output-format stream-json [--model <model>] [--workspace <path>]` with the user message. Same pattern as claude-cli (serialized runs, JSONL parsing).
- **Default backend:** In `cli-backends.ts`, `DEFAULT_CURSOR_BACKEND` uses `command: "cursor"`, `args: ["agent", "--print", "--output-format", "stream-json"]`, `output: "jsonl"`, `modelArg: "--model"`, `modelAliases` for opus/sonnet/gpt/codex/gemini, etc.

## Config (user)

- **Path:** `~/.openclaw/openclaw.json`
- **Relevant block (already added):**
  - `agents.defaults.model`: `{ "primary": "cursor-cli/auto", "fallbacks": ["anthropic/claude-sonnet-4-5"] }`
  - `agents.defaults.cliBackends.cursor-cli`: command/args/output/input/modelArg/serialize (optional override of defaults in code).

## Usage

```bash
# One-time auth (Cursor CLI OAuth)
cursor agent login

# Use default model (cursor-cli if configured as primary)
openclaw agent --message "Hello"

# Explicit model for this run
openclaw agent --message "Hello" --model cursor-cli/auto
openclaw agent --message "Hello" --model cursor-cli/opus-4.5
openclaw agent --message "Hello" --model anthropic/claude-sonnet-4-5

# Check auth / models
openclaw models

# Check version (now includes commit hash)
openclaw --version
# Output: 2026.1.29 (67b2c05)
```

## Development workflow

```bash
# Build
pnpm build

# Build UI (for Control UI)
pnpm ui:build

# Install globally (after building)
npm install -g .

# Restart gateway to pick up changes
openclaw gateway restart

# Or run dev gateway directly
pnpm openclaw gateway run --force
```

## Current state

- **Working:** cursor-cli backend registration, keychain credential reading, `--model` on `openclaw agent`, gateway passing `model`, models status treating cursor-cli as authenticated when keychain has tokens and showing the right missing-auth hint, version with commit hash, default agent "main", **onboarding auth choice for cursor-cli**.
- **Not done:** No automated tests for cursor-cli in this session. E2E would require `cursor` on PATH and (optionally) mock or real login.
- **Platform:** Cursor keychain auth is macOS-only in code (`platform === "darwin"` in `readCursorCliCredentials`); other platforms would need another auth story (e.g. env or file) if desired.

## Fixed bugs

### ✅ TUI cursor-cli JSONL parsing (f84aa51)

Fixed in `src/agents/cli-runner/helpers.ts` — `parseCliJsonl()` now handles cursor-cli's format:

```json
{ "type": "assistant", "message": { "content": [{ "type": "text", "text": "..." }] } }
```

## UI improvement opportunities (remaining)

1. **Model picker** (`src/commands/model-picker.ts`) — Could add cursor-cli as a visible option in interactive model selection
2. **Auth overview** (`src/commands/models/list.auth-overview.ts`) — Already shows cursor-cli auth status, works well
3. **Control UI config form** (`ui/src/ui/views/config-form.*.ts`) — Could add cursor-cli backend selection dropdown in the agents section
4. ~~**Onboarding**~~ ✅ Done — `src/commands/auth-choice.apply.cursor-cli.ts`
5. **Gateway model catalog** (`src/gateway/server-model-catalog.ts`) — cursor-cli models could appear in `models.list` API for UI display
6. ~~**Fix TUI JSONL parsing**~~ ✅ Done — `src/agents/cli-runner/helpers.ts`

## Repo / env

- **Repo:** OpenClaw (openclaw/openclaw). Guidelines in `CLAUDE.md` / `AGENTS.md`.
- **Build/test:** `pnpm build`, `pnpm test`, `pnpm lint`. Prefer Bun for running TS.
- **Config path:** `~/.openclaw/openclaw.json`; agent dir e.g. `~/.openclaw/agents/main/agent`.

## Extension vs core

- **Extension** `extensions/cursor-agent`: Background Agents API (API key, dashboard), webhooks, remote runs. Config under `channels.cursorAgent`.
- **Core** cursor-cli: CLI backend (OAuth via `cursor agent login`), local `cursor` process. Config under `agents.defaults.cliBackends.cursor-cli` and `agents.defaults.model.primary`.

Use this doc to continue work on cursor-cli, models status, UI integration, or related agent/CLI behavior.
