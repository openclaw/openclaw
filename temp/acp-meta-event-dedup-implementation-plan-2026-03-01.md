# ACP Meta Event Dedupe Implementation Plan (2026-03-01)

## Goal

Eliminate ACP thread spam from repeated meta/progress updates while preserving full raw ACP event logs for debugging and audits.

## Problem Summary

- Raw ACP streams can contain repeated updates with identical payloads (for example `usage_update` and repeated `tool_call_update` snapshots).
- OpenClaw currently projects many of these events into user-visible thread messages.
- Result: noisy thread output like repeated `⚙️ usage updated ...` and duplicated `🧰 call_...`.

## Design Decision

- Keep `~/.acpx/sessions/*.stream.ndjson` as raw, lossless source of truth.
- Apply dedupe/throttle/filter only in OpenClaw ACP projection before channel delivery.
- Do not mutate ACPX persistence format for this UX issue.
- Reuse canonical formatters:
  - System/meta notices must use `prefixSystemMessage(...)` from `src/infra/system-message.ts`.
  - Tool lifecycle/progress lines must use a shared tool-summary formatter path (no ACP-local emoji string assembly).

## Scope

- In scope:
  - ACP message projection/filtering in OpenClaw.
  - Config controls for ACP meta visibility.
  - Tests for dedupe behavior.
- Out of scope:
  - Rewriting historical session/event files.
  - Changing ACP wire protocol semantics.
  - Removing raw event logging in ACPX.

## Implementation Plan

### 1. Add ACP meta visibility config

- File: `src/config/types.acp.ts`
- File: `src/config/zod-schema.ts`
- File: `src/config/schema.help.ts`
- File: `src/config/schema.labels.ts`
- Add:
  - `acp.stream.metaMode?: "off" | "minimal" | "verbose"`
  - `acp.stream.showUsage?: boolean`
  - `acp.stream.deliveryMode?: "live" | "final_only"`
  - `acp.stream.maxTurnChars?: number`
  - `acp.stream.maxToolSummaryChars?: number`
  - `acp.stream.maxStatusChars?: number`
  - `acp.stream.maxMetaEventsPerTurn?: number`
  - `acp.stream.tagVisibility?: Partial<Record<AcpSessionUpdateTag, boolean>>`
- Defaults:
  - `metaMode: "minimal"`
  - `showUsage: false`
  - `deliveryMode: "live"`
  - `maxTurnChars: 24000` (guardrail for giant streamed output per turn)
  - `maxToolSummaryChars: 320` (prevents giant tool summary lines)
  - `maxStatusChars: 320` (prevents giant status lines)
  - `maxMetaEventsPerTurn: 64` (prevents meta flood)
  - `tagVisibility` defaults:
    - `agent_message_chunk: true`
    - `tool_call: true`
    - `tool_call_update: true` (still deduped by lifecycle/content rules)
    - `usage_update: false`
    - `available_commands_update: false`
    - `current_mode_update: false`
    - `config_option_update: false`
    - `session_info_update: false`
    - `plan: false`
    - `agent_thought_chunk: false`

### 2. Introduce ACP projector dedupe state

- File: `src/auto-reply/reply/acp-projector.ts`
- Add per-turn dedupe memory:
  - Last emitted status text hash.
  - Last emitted usage tuple (`used`, `size`).
  - Tool lifecycle state map keyed by `toolCallId`.
  - Last emitted tool update content hash per `toolCallId`.
- Reset dedupe state on turn completion (`done`/`error`) and on new projector construction.

### 3. Define projection rules

- File: `src/auto-reply/reply/acp-projector.ts`
- Rules:
  - Tag-gate first:
    - classify incoming ACP updates by `sessionUpdate` tag in runtime parser.
    - apply `tagVisibility` before rendering/projecting user-facing messages.
    - keep raw ACP logs unchanged (filter only affects user-visible projection).
  - `deliveryMode = live`:
    - current behavior: stream block chunks as deltas arrive.
  - `deliveryMode = final_only`:
    - append all `text_delta` into the existing chunker, but do not drain on each delta.
    - drain/flush once on terminal event (`done`/`error`) using the same `flush(true)` path.
    - keep the same `BlockReplyPipeline` and coalescer path (no second sender implementation).
    - preserve ordering guarantees (tool/status summaries flush through existing pipeline rules).
  - `metaMode = off`: no `status` and no `tool_call` summaries (text stream only).
  - `metaMode = minimal`:
    - allow first `tool_call` start (`in_progress`) per `toolCallId`.
    - allow terminal tool status once (`completed`/`failed`).
    - suppress identical repeated status lines.
    - suppress repeated `tool_call_update` snapshots with same rendered text.
  - `metaMode = verbose`:
    - allow all status/tool summaries except exact immediate duplicates.
  - Text budget:
    - track emitted visible text chars per turn.
    - if `maxTurnChars` is reached, stop forwarding further `text_delta` for that turn.
    - emit one bounded notice (`output truncated`) exactly once when truncation begins.
  - Meta budgets:
    - truncate status/tool summary text to `maxStatusChars` / `maxToolSummaryChars`.
    - if `maxMetaEventsPerTurn` is reached, suppress additional meta events for the turn.
    - preserve final assistant text delivery even when meta cap is reached.
  - `showUsage = false`:
    - suppress usage status entirely.
  - `showUsage = true`:
    - emit usage only when `(used,size)` changed from last emitted tuple.

### 4. Normalize ACP status classification

- File: `extensions/acpx/src/runtime-internals/events.ts`
- Keep raw parsing, but provide stable status text categories where possible:
  - Distinguish `sessionUpdate` tags (including `usage_update`) so projector can gate by tag reliably.
  - Improve tool-call fallback label rendering:
    - avoid leaking raw `toolCallId` noise (`call_...`) as the primary user-visible label when title is missing.
    - render stable human fallback (`tool call`) and keep raw ids only in debug logs/raw stream.
- Runtime event metadata contract (backward-compatible):
  - ACP runtime events may include optional metadata fields used by projection/dedupe/edit:
    - tool lifecycle: `toolCallId`, `status`, `title`, `tag`
    - usage/status: `tag`, `used`, `size`
  - These fields are optional. If absent, projection must fall back to current text-based behavior.
  - Do not break existing ACPX output shape; only enrich when available.
- If needed, evolve runtime event shape with optional metadata fields while keeping existing consumers working.

### 5. Keep channel-agnostic behavior

- File: `src/auto-reply/reply/dispatch-acp.ts`
- Ensure dedupe/filter is done before any channel-specific delivery path.
- Do not add Discord-only conditions in ACP projection logic.

### 5.1. Canonical message formatting (no ACP-local style drift)

- File: `src/auto-reply/reply/acp-projector.ts`
- File: `src/infra/system-message.ts`
- File: shared tool summary formatter (`src/agents/tool-display.ts`)
- Rules:
  - ACP system/meta notices (`usage updated`, `available commands updated`, truncation notices, lifecycle notices) must be rendered with `prefixSystemMessage(...)`.
  - ACP tool lifecycle/progress lines must use shared tool summary formatting from `src/agents/tool-display.ts` (`resolveToolDisplay` + `formatToolSummary`), not hardcoded ACP-local emoji prefixes.
  - ACP emits normalized events + metadata and delegates final user-facing string shaping to shared formatters.
- Outcome:
  - Consistent style across main/subagent/ACP.
  - Lower drift risk when global system/tool styling changes.

### 6. Wire fast-abort triggers to ACP cancel

- File: `src/auto-reply/reply/abort.ts`
- File: `src/auto-reply/reply/dispatch-from-config.ts`
- Behavior:
  - ACP path must use the same abort trigger detector/vocabulary as main path (no ACP-specific exceptions).
  - When fast-abort resolves a concrete target session and that session is ACP-enabled,
    call ACP manager cancel (`cancelSession`) with reason `fast-abort`.
  - Keep existing queue/lane cleanup as fallback so abort remains robust even if ACP cancel fails.
  - Preserve channel-agnostic handling (no Discord-specific conditionals).
- Confirmed policy:
  - `wait` follows the same cancel behavior as main path (same as `stop` class in trigger handling semantics).

### 7. Edit-in-place tool lifecycle updates (when channel supports edit)

- File: `src/auto-reply/reply/acp-projector.ts`
- File: `src/auto-reply/reply/dispatch-acp.ts`
- File: `src/auto-reply/reply/reply-dispatcher.ts`
- File: outbound message-action path (`src/infra/outbound/message-action-runner.ts` usage)
- Behavior:
  - On first `tool_call`, send one tool lifecycle message and store returned message handle keyed by `toolCallId`.
  - On later `tool_call_update`, attempt in-place edit of the same message when channel action `edit` is supported.
  - If edit is unsupported or fails, gracefully fall back to sending a new tool message.
  - Keep this channel-agnostic: capability detection via channel action support, not Discord-specific checks.
- Required plumbing:
  - Extend ACP tool-delivery path to keep outbound send receipts for tool messages using a stable handle shape:
    - `{ channel, accountId, to, threadId, messageId }`
  - Persist handle keyed by `sessionKey + toolCallId` for update/edit lookup.
  - Allow dispatcher delivery callback to surface delivery metadata needed for follow-up edit actions.
  - If `messageId` is unavailable, skip edit attempt and fall back to normal new-message send.
  - Preserve existing ordering semantics with block/final messages.

### 8. Typing indicator parity for ACP-bound sessions

- File: `src/auto-reply/reply/dispatch-from-config.ts`
- File: `src/auto-reply/reply/dispatch-acp.ts`
- File: `src/auto-reply/reply/typing-mode.ts` (reuse existing signaler; no ACP-specific duplicate loop)
- Behavior:
  - ACP turns should trigger the same typing lifecycle as non-ACP runs:
    - start typing on first visible work (text delta or tool-start based on policy),
    - keepalive/refresh while turn is active,
    - stop typing when ACP turn reaches terminal state (`done`/`error`) and dispatch queue is idle.
  - Respect existing typing mode/policy resolution from current channel/account/session settings.
  - Keep this channel-agnostic and routed through existing typing callbacks.
- Design constraint:
  - Do not add a second ACP-only typing controller. Reuse `createTypingSignaler` patterns and existing dispatcher idle hooks.

### 9. Test coverage

- File: `src/auto-reply/reply/acp-projector.test.ts`
- Add tests:
  - Default tag visibility suppresses `usage_update` and keeps tool lifecycle summaries.
  - Explicitly enabling `usage_update` allows deduped usage lines through.
  - Disabling `tool_call` and/or `tool_call_update` suppresses those summaries without affecting text output.
  - `available_commands_update` remains hidden by default.
  - `deliveryMode=final_only` holds text deltas until terminal event.
  - `deliveryMode=final_only` emits one final block payload using existing pipeline flush.
  - `deliveryMode=live` preserves current incremental streaming behavior.
  - Suppresses duplicate `usage updated` when values unchanged.
  - Emits usage when values change and `showUsage=true`.
  - Suppresses all usage when `showUsage=false`.
  - Suppresses duplicate `tool_call`/`tool_call_update` snapshots for same call id.
  - Emits start and terminal tool lifecycle exactly once in `minimal`.
  - `metaMode=off` emits no tool/status summaries.
  - `metaMode=verbose` allows non-identical progress lines.
  - Truncates oversized status/tool summaries to configured limits.
  - Stops forwarding text deltas after `maxTurnChars` and emits a single truncation notice.
  - Enforces `maxMetaEventsPerTurn` without breaking final reply delivery.
  - Tool fallback label does not default to long raw `call_...` ids in normal projection.
  - System/meta lines are produced via `prefixSystemMessage(...)` (idempotent, no double prefix).
  - Tool lifecycle lines use shared tool-summary formatting path (no ACP-local string rendering).
- File: `src/auto-reply/reply/abort.test.ts`
- Add tests:
  - plain-language `stop` on ACP-bound session triggers ACP `cancelSession`.
  - non-ACP sessions keep existing fast-abort behavior.
  - ACP cancel failure does not skip queue/lane cleanup.
- File: ACP dispatch typing tests
- Add tests:
  - ACP `text_delta` starts typing according to configured typing mode.
  - ACP tool-start events refresh typing when policy allows.
  - ACP terminal events stop typing/mark idle reliably.
  - No typing regressions for non-ACP paths.
- File: ACP dispatch/integration tests
- Add tests:
  - `tool_call_update` edits prior tool message when edit capability exists.
  - fallback to new message send when edit capability is unavailable.
  - fallback to new message send when edit call fails.
  - tool lifecycle still dedupes correctly with edit mode enabled.
- Optional integration check:
  - File: `src/auto-reply/reply/dispatch-from-config.test.ts`
  - Simulate ACP noisy stream and assert bounded outbound message count.

### 10. Manual verification

- Start ACP thread-bound Codex session.
- Send prompt that triggers long-running tool updates.
- Confirm:
  - No repeated identical `⚙️ usage updated ...` lines.
  - No repeated identical `🧰 call_...` lines.
  - Tool updates prefer editing the initial tool message instead of posting a new message each time (for channels with edit support).
  - Channels without edit support still work via normal new-message fallback.
  - Final assistant text still delivered correctly.
  - Typing indicator appears during active ACP turn and clears after completion.
- During an active ACP turn, send plain-language `stop` in the thread and confirm
  the in-flight ACP turn is cancelled (not only locally aborted).
- Check raw `.stream.ndjson` still contains full event stream.

## Acceptance Criteria

- User-visible ACP thread output no longer shows repeated identical usage/tool meta spam.
- Raw ACPX event log remains unchanged and lossless.
- Dedupe logic is channel-agnostic and centralized in ACP projection.
- `final_only` delivery mode exists without introducing a second ACP sending path.
- Tool lifecycle updates use edit-in-place when supported, with safe fallback to new-message sends.
- ACP-bound sessions use the same typing lifecycle behavior as non-ACP runs.
- New config keys are documented and validated.
- Unit tests for projector dedupe pass.
- ACP no longer hardcodes system/tool message formatting independently from shared formatters.

## Rollout Notes

- Safe default should reduce noise immediately (`showUsage=false`, `metaMode=minimal`).
- Operators can switch to `metaMode=verbose` for debugging without code changes.
