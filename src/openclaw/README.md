# OpenClaw Isolation Layer

This directory contains OpenClaw OpenClaw-specific extensions that are isolated from upstream code to minimize merge conflicts.

## Purpose

When merging from upstream (clawdbrain), only minimal changes are needed in upstream files (typically 1-2 lines per file to import and call OpenClaw functions). All OpenClaw-specific logic lives in this directory.

## Files

### `agent-config-overrides.ts`
Per-agent configuration override logic:
- `resolveOpenClawThinkingLevel()` - Thinking level resolution with per-agent defaults
- `resolveOpenClawVerboseLevel()` - Verbose level resolution with per-agent defaults

**Upstream integration:** Imported by `src/auto-reply/reply/*.ts` files

### `thinking-budget-integration.ts`
Thinking budget conflict detection and warnings:
- `warnIfThinkingBudgetConflict()` - Emits warnings when budget conflicts with context

**Upstream integration:** Imported by `src/agents/pi-embedded-runner/run/attempt.ts`

## Merge Strategy

When merging from upstream:
1. Accept upstream changes to core files
2. Re-add minimal import statements (1 line per file)
3. Replace their resolution logic with OpenClaw function calls (1-2 lines)
4. All complex OpenClaw logic remains untouched in this directory

## Related Files

### OpenClaw-Owned (No Conflicts)
- `src/agents/thinking-budgets.ts` - Token budget constants
- `src/agents/thinking-budgets.test.ts` - Budget tests
- `src/agents/agent-scope.test.ts` - Agent resolution tests
- `src/commands/agents.commands.thinking-config.ts` - CLI command

### Minimal Upstream Changes
- `src/config/types.agents.ts` - Added `thinkingDefault`, `verboseDefault` fields
- `src/config/zod-schema.agent-runtime.ts` - Added validation
- `src/agents/agent-scope.ts` - Added helper functions (append-only)
- `src/auto-reply/reply/get-reply-directives.ts` - 2 lines (import + call)
- `src/auto-reply/reply/get-reply-directives-apply.ts` - 2 lines
- `src/auto-reply/reply/directive-handling.fast-lane.ts` - 2 lines
- `src/auto-reply/reply/model-selection.ts` - 1 param + 1 line
- `src/agents/pi-embedded-runner/run/attempt.ts` - 2 lines (import + call)
- `src/cli/program/register.agent.ts` - Command registration (append-only)
