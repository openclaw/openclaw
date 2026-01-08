# MS Teams provider refactor plan (production-ready)

Goal: refactor the MS Teams provider code (`src/msteams/*`) for long-term maintainability and correctness **without changing user-facing behavior** (except incidental bug fixes discovered during refactor).

Status (2026-01-08): implemented (Phases 1–3) with unit tests; `pnpm lint && pnpm build && pnpm test` pass.

## Why refactor

Current pain points in `src/msteams/monitor.ts` / `src/msteams/send.ts` / `src/msteams/conversation-store.ts`:

- **Mixed concerns**: HTTP server wiring, SDK handler, routing, policy resolution, and outbound delivery live in one file.
- **Duplicated outbound logic**: proactive vs in-thread sending is implemented in multiple places (monitor + send).
- **Weak typing boundary**: custom “SDK-like” shapes + structural casts make it harder to evolve safely.
- **Conversation store is fragile**: JSON file writes are un-locked and non-atomic; no TTL; potential corruption under concurrency.
- **Hard to test**: key logic (policy precedence and delivery behavior) is not isolated/pure.

## Non-goals

- Rewriting the provider around a different SDK.
- Introducing new configuration knobs beyond what already exists (`msteams.replyStyle`, `requireMention`, etc.).
- Changing routing semantics, payload envelope format, or session key logic.
- Adding new CLI commands (unless needed for validation/testing).

## Target architecture (module split)

### 1) Policy resolution (pure + tested)

Add `src/msteams/policy.ts` (and `src/msteams/policy.test.ts`) containing pure functions:

- `resolveMSTeamsRouteConfig({ cfg, teamId, conversationId }): { teamConfig?, channelConfig? }`
- `resolveMSTeamsReplyPolicy({ isDirectMessage, cfg, teamConfig?, channelConfig? }): { requireMention: boolean; replyStyle: "thread" | "top-level" }`

Acceptance: precedence is encoded and unit-tested:

- Channel overrides > team defaults > global defaults > implicit defaults.
- DM behavior: `replyStyle` is forced to `"thread"`, mention-gating is bypassed.
- Defaulting behavior matches existing runtime logic (e.g. `requireMention -> default replyStyle` heuristic).

### 2) Outbound delivery (single implementation)

Add `src/msteams/messenger.ts` (and `src/msteams/messenger.test.ts`) to centralize:

- chunking (`resolveTextChunkLimit`, `chunkMarkdownText`, `SILENT_REPLY_TOKEN`)
- send mode selection (`"thread"` vs `"top-level"`)
- media URL message splitting (same semantics as current)
- error formatting + consistent structured logs

Surface (current implementation):

- `renderReplyPayloadsToMessages(replies, { textChunkLimit, chunkText, mediaMode })`
- `sendMSTeamsMessages({ replyStyle, adapter, appId, conversationRef, context?, messages })`
  - uses `context.sendActivity` for `"thread"`
  - uses `adapter.continueConversation` for `"top-level"`

Acceptance: `src/msteams/monitor.ts` and `src/msteams/send.ts` both use the messenger, so there’s exactly one “how do we send a message” implementation.

### 3) SDK typing boundary (type-only imports; no eager runtime deps)

Add `src/msteams/sdk-types.ts` exporting the minimal types we depend on:

- Turn context type (`sendActivity`, `activity` with fields we read)
- Conversation reference type for `continueConversation`
- Adapter interface subset (`continueConversation`, `process`)

Implementation note:

- Use `import type …` from the Microsoft SDK packages (or fallback to minimal structural types if the SDK does not export them cleanly).
- Keep current dynamic runtime imports (`await import("@microsoft/agents-hosting")`) intact; type-only imports compile away.

Acceptance: eliminate bespoke `TeamsTurnContext` / ad-hoc casts where possible, while preserving lazy-load behavior (some casting may remain if SDK typings are stricter than runtime behavior).

### 4) Conversation store interface + hardened FS implementation

Introduce a store interface (e.g. `src/msteams/conversation-store.ts`) and move the current file-backed store to `src/msteams/conversation-store-fs.ts`.

Store interface:

- `upsert(conversationId, reference)`
- `get(conversationId)`
- `findByUser({ aadObjectId?, userId? })`
- `list()`
- `remove(conversationId)`

FS implementation hardening:

- **Atomic writes**: write to `*.tmp` then `rename` (or equivalent).
- **Locking**: use `proper-lockfile` (already a dependency) to guard read-modify-write.
- **TTL + pruning**:
  - persist `lastSeenAt`
  - prune on every write and/or on a timer
  - cap size (keep existing `MAX_CONVERSATIONS` behavior, but deterministic + documented)
- **Permissions**:
  - dir is already `0700`; ensure file is written with `0600`

Tests:

- Use an in-memory store implementation for unit tests.
- Add FS store tests only where stable (avoid flaky timing issues).

Acceptance: no store corruption under concurrent writes in-process; behavior preserved for CLI `send` lookup.

### 5) Monitor wiring becomes “thin”

Refactor `src/msteams/monitor.ts` so it:

- loads config + credentials
- creates adapter + express routes
- routes inbound messages to a smaller `handleInboundMessage(...)` function
- delegates:
  - policy decisions to `policy.ts`
  - outbound sends to `messenger.ts`
  - reference persistence to the store abstraction

Acceptance: `monitor.ts` is mostly wiring and orchestration; logic-heavy parts are tested in isolation.

## Implementation phases (incremental, safe)

### Phase 1 (behavior-preserving extraction)

1. Add `src/msteams/policy.ts` + `src/msteams/policy.test.ts`.
2. Add `src/msteams/messenger.ts` + `src/msteams/messenger.test.ts` (unit test chunking + send mode selection; mock context/adapter).
3. Refactor `src/msteams/monitor.ts` to use policy + messenger (no behavior change).
4. Refactor `src/msteams/send.ts` to use messenger (no behavior change).
5. Extract inbound helpers (`stripMentionTags`, mention detection, conversation ID normalization) into `src/msteams/inbound.ts` + tests.
6. Ensure `pnpm lint && pnpm build && pnpm test` pass.
7. If testing manifest/RSC updates, fully quit/relaunch Teams and reinstall the app to flush cached app metadata.

### Phase 2 (store hardening)

1. Introduce store interface + in-memory test store.
2. Move FS store to its own module; add locking + atomic writes + TTL.
3. Update `monitor.ts` + `send.ts` to depend on the interface (inject FS store from wiring).
4. Add targeted tests.

### Phase 3 (production reliability)

1. Add retry/backoff around outbound sends (careful: avoid duplicate posts; only retry safe failures).
2. Error classification helpers (auth misconfig, transient network, throttling).
3. Improve `probeMSTeams` to validate credentials (optional; can be separate).

## Done criteria / checkpoints

- Phase 1 done:
  - New policy tests cover precedence and DM behavior.
  - `monitor.ts` + `send.ts` share outbound sending via messenger.
  - No new runtime imports that break lazy-load behavior.
- Phase 2 done:
  - Store is locked + atomic + bounded.
  - Clear migration story (keep same file format/version or bump explicitly).
- Phase 3 done:
  - Retries are safe and bounded; logs are structured and actionable.

## Notes / edge cases to validate during refactor

- “Channel config” keys: currently based on `conversation.id` (e.g. `19:…@thread.tacv2`). Preserve that.
- `replyStyle="top-level"` correctness: ensure the conversation reference normalization is centralized and tested.
- Mention-gating: preserve current detection behavior (`entities` mention matching `recipient.id`), but isolate it for future improvements.
- Teams client caches app manifests; after uploading a new package or changing RSC permissions, fully quit/relaunch Teams (not just close the window) and reinstall the app to force the version + permission refresh.
