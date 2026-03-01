# ACP Thread Tool Editing + Final-Only Delivery Plan (2026-03-01)

## Goal

- For ACP-bound thread sessions, stop tool/message spam in-thread.
- Render each ACP tool call as one mutable thread message (create once, then edit on updates).
- Keep assistant text/tool output delivery final-only by default.
- Hide noisy ACP status tags by default.

## Problem Summary

- Today, ACP events in same-channel Discord thread delivery are projected as many new messages.
- Edit-on-update behavior exists, but only in a different routing path.
- Result: repeated `in_progress` / `update` / `completed` message bursts and poor UX.

## Non-Goals

- Do not change ACP/acpx wire protocol.
- Do not add adapter-specific behavior (Codex vs Claude vs others).
- Do not reintroduce legacy/compat aliases.

## Target UX

- User asks for work in ACP thread.
- For each tool call id:
  - One message appears when tool starts.
  - That same message is edited as updates arrive.
  - Final state is reflected in the same message.
- Assistant/user-facing answer text is sent once per turn (final-only).
- No `usage_update` / `available_commands_update` noise by default.

## Design Decisions

- Keep ACP event stream unchanged; only change OpenClaw projection/delivery.
- Treat `toolCallId` as the edit key.
- Persist message-handle map only in memory for active dispatch turn (no disk persistence needed).
- Keep repeat suppression on by default.
- Default ACP delivery mode remains `final_only`.

## Implementation Steps

### 1) Route ACP tool updates through edit-capable path in same-thread delivery

- File: `src/auto-reply/reply/dispatch-from-config.ts`
- Change ACP dispatch invocation so ACP thread replies use the delivery coordinator path that can edit tool messages, not only cross-channel route-reply mode.
- Ensure same-thread sends still capture `messageId` from send result.

### 2) Unify ACP tool message send/edit behavior

- File: `src/auto-reply/reply/dispatch-acp-delivery.ts`
- Refactor `deliver(...)` logic so edit is attempted whenever:
  - `kind === "tool"`
  - `meta.allowEdit === true`
  - `toolCallId` exists
  - prior tool message handle exists.
- Decouple edit eligibility from `shouldRouteToOriginating`.
- Add clear fallback: if edit fails or handle missing, send new message and cache returned `messageId`.

### 3) Keep projection semantics strict and minimal

- File: `src/auto-reply/reply/acp-projector.ts`
- Keep tool delivery metadata (`toolCallId`, status, allowEdit) stable.
- Ensure `tool_call` = starter, `tool_call_update` = editable updates.
- Keep repeat suppression default enabled and applied before delivery.
- Keep `final_only` behavior as default for assistant text + meta flush at terminal.

### 4) Defaults and config hygiene

- Files: ACP stream settings/config defaults and tests under `src/config/*` and ACP reply tests.
- Confirm defaults:
  - `deliveryMode = final_only`
  - `repeatSuppression = true`
  - `tagVisibility.usage_update = false`
  - `tagVisibility.available_commands_update = false`
- Ensure no duplicate/conflicting knobs are left.

### 5) Tests

- ACP delivery unit tests:
  - same-thread tool start + updates + complete => one message id edited, not N new posts.
  - edit failure path => fallback send works and message id cache updates.
- ACP projector tests:
  - repeated identical updates suppressed.
  - hidden tags stay hidden by default.
- End-to-end style reply test:
  - final-only turn sends terminal assistant text once.
  - no replay of prior turn output on next user turn.

## Validation (Manual)

- Spawn ACP Codex thread and run:
  - short command (`true`, `pwd`)
  - long command (`sleep 120`)
- Expected:
  - one tool message per toolCallId that gets edited in place.
  - one final assistant response per turn.
  - no usage/available-command noise unless explicitly enabled.

## Acceptance Criteria

- ACP thread tool updates are edit-in-place by default.
- Final-only behavior is default and observable.
- Hidden status tags are not shown by default.
- No repeated replay of prior-turn content.
- Unit/integration tests pass for the scenarios above.
