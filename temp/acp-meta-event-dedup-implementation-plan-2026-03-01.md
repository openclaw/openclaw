# ACP Meta Event Dedupe Plan (2026-03-01)

## Goal

Keep ACP thread output readable by default while preserving full raw ACP logs.

## Scope

- In scope:
  - ACP projection behavior in OpenClaw.
  - ACP stream config keys for visibility + repeat suppression.
  - ACP projector tests.
- Out of scope:
  - ACPX raw stream persistence format.
  - ACP protocol changes.

## Configuration Shape

Use only these ACP stream controls for this behavior:

- `acp.stream.repeatSuppression?: boolean`
- `acp.stream.tagVisibility?: Partial<Record<AcpSessionUpdateTag, boolean>>`
- Existing delivery/size guards stay unchanged:
  - `deliveryMode`
  - `maxTurnChars`
  - `maxToolSummaryChars`
  - `maxStatusChars`
  - `maxMetaEventsPerTurn`

Removed from plan/config:

- `showUsage`
- `metaMode`

## Default Behavior (Minimal)

Default should be minimal-noise out of the box:

- `repeatSuppression: true`
- `tagVisibility` defaults:
  - `agent_message_chunk: true`
  - `tool_call: true`
  - `tool_call_update: true`
  - `usage_update: false`
  - `available_commands_update: false`
  - `current_mode_update: false`
  - `config_option_update: false`
  - `session_info_update: false`
  - `plan: false`
  - `agent_thought_chunk: false`

## Projection Rules

1. Apply `tagVisibility` first.
2. For visible tags:
   - `repeatSuppression=true`:
     - suppress identical repeated status lines.
     - suppress identical repeated usage tuples.
     - suppress duplicate tool lifecycle snapshots for the same `toolCallId`.
   - `repeatSuppression=false`:
     - forward repeated status/tool updates as they arrive.
3. Keep existing text streaming path and existing guardrails (`maxTurnChars`, meta caps).
   - In `deliveryMode=final_only`, defer all projected ACP output (text + meta/tool) until terminal turn events.
4. Keep canonical formatting:
   - system lines via `prefixSystemMessage(...)`
   - tool lines via shared tool formatter path.

## Tests

Projector tests must cover:

- default usage hidden by `tagVisibility`.
- enabling `usage_update` via `tagVisibility` works.
- repeated usage/status/tool updates are suppressed when `repeatSuppression=true`.
- repeated usage/status/tool updates are allowed when `repeatSuppression=false`.
- `available_commands_update` hidden by default.
- text streaming and truncation behavior unchanged.

## Acceptance Criteria

- No `showUsage` or `metaMode` in ACP stream config/types/schema/help/labels.
- `repeatSuppression` is the only repeat/dedupe toggle.
- `tagVisibility` defaults are minimal-noise.
- ACP projector behavior matches tests.
- Raw ACP logs remain unchanged/lossless.
