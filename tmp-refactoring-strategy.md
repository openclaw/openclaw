# Refactoring Strategy — Oversized Files

> **Target:** ~500–700 LOC per file (AGENTS.md guideline)
> **Baseline:** 681K total lines across 3,781 code files (avg 180 LOC)
> **Problem:** 50+ files exceed 700 LOC; top offenders are 2–4× over target

---

## Progress Summary

| Item                                | Before | After                                | Status  |
| ----------------------------------- | ------ | ------------------------------------ | ------- |
| `src/config/schema.ts`              | 1,114  | 353 + 729 (field-metadata)           | ✅ Done |
| `src/security/audit-extra.ts`       | 1,199  | 31 barrel + 559 (sync) + 668 (async) | ✅ Done |
| `src/infra/session-cost-usage.ts`   | 984    | —                                    | Pending |
| `src/media-understanding/runner.ts` | 1,232  | —                                    | Pending |

### All Targets (current LOC)

| Phase | File                             | Current LOC | Target |
| ----- | -------------------------------- | ----------- | ------ |
| 1     | session-cost-usage.ts            | 984         | ~700   |
| 1     | media-understanding/runner.ts    | 1,232       | ~700   |
| 2a    | heartbeat-runner.ts              | 956         | ~560   |
| 2a    | message-action-runner.ts         | 1,082       | ~620   |
| 2b    | tts/tts.ts                       | 1,445       | ~950   |
| 2b    | exec-approvals.ts                | 1,437       | ~700   |
| 2b    | update-cli.ts                    | 1,245       | ~1,000 |
| 3     | memory/manager.ts                | 2,280       | ~1,300 |
| 3     | bash-tools.exec.ts               | 1,546       | ~1,000 |
| 3     | ws-connection/message-handler.ts | 970         | ~720   |
| 4     | ui/views/usage.ts                | 3,076       | ~1,200 |
| 4     | ui/views/agents.ts               | 1,894       | ~950   |
| 4     | ui/views/nodes.ts                | 1,118       | ~440   |
| 4     | bluebubbles/monitor.ts           | 2,348       | ~650   |

---

## Naming Convention (Established Pattern)

The codebase uses **dot-separated module decomposition**: `<base-module>.<concern>.ts`

**Examples from codebase:**

- `provider-usage.ts` → `provider-usage.types.ts`, `provider-usage.fetch.ts`, `provider-usage.shared.ts`
- `zod-schema.ts` → `zod-schema.core.ts`, `zod-schema.agents.ts`, `zod-schema.session.ts`
- `directive-handling.ts` → `directive-handling.parse.ts`, `directive-handling.impl.ts`, `directive-handling.shared.ts`

**Pattern:**

- `<base>.ts` — main barrel, re-exports public API
- `<base>.types.ts` — type definitions
- `<base>.shared.ts` — shared constants/utilities
- `<base>.<domain>.ts` — domain-specific implementations

**Consequences for this refactoring:**

- ✅ Renamed: `audit-collectors-sync.ts` → `audit-extra.sync.ts`, `audit-collectors-async.ts` → `audit-extra.async.ts`
- Use `session-cost-usage.types.ts` (not `session-cost-types.ts`)
- Use `runner.binary.ts` (not `binary-resolve.ts`)

---

## Triage: What NOT to split

| File                                           | LOC   | Reason to skip                                                                   |
| ---------------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| `ui/src/ui/views/usageStyles.ts`               | 1,911 | Pure CSS-in-JS data. Zero logic.                                                 |
| `apps/macos/.../GatewayModels.swift`           | 2,790 | Generated/shared protocol models. Splitting fragments the schema.                |
| `apps/shared/.../GatewayModels.swift`          | 2,790 | Same — shared protocol definitions.                                              |
| `*.test.ts` files (bot.test, audit.test, etc.) | 1K–3K | Tests naturally grow with the module. Split only if parallel execution needs it. |
| `ui/src/ui/app-render.ts`                      | 1,222 | Mechanical prop-wiring glue. Large but low complexity. Optional.                 |

---

## Phase 1 — Low-Risk, High-Impact (Pure Data / Independent Functions)

These files contain cleanly separable sections with no shared mutable state. Each extraction is a straightforward "move functions + update imports" operation.

### 1. ✅ `src/config/schema.ts` (1,114 → 353 LOC) — DONE

| Extract to                        | What moves                                                          | LOC |
| --------------------------------- | ------------------------------------------------------------------- | --- |
| `config/schema.field-metadata.ts` | `FIELD_LABELS`, `FIELD_HELP`, `FIELD_PLACEHOLDERS`, sensitivity map | 729 |

**Result:** schema.ts reduced to 353 LOC. Field metadata extracted to schema.field-metadata.ts (729 LOC).

### 2. ✅ `src/security/audit-extra.ts` (1,199 → 31 LOC barrel) — DONE

| Extract to                      | What moves                                                                                                                                             | LOC |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| `security/audit-extra.sync.ts`  | 7 sync collectors (config-based, no I/O): attack surface, synced folders, secrets, hooks, model hygiene, small model risk, exposure matrix             | 559 |
| `security/audit-extra.async.ts` | 6 async collectors (filesystem/plugin checks): plugins trust, include perms, deep filesystem, config snapshot, plugins code safety, skills code safety | 668 |

**Result:** Used centralized sync vs. async split (2 files) instead of domain scatter (3 files). audit-extra.ts is now a 31-line re-export barrel for backward compatibility. Files renamed to follow `<base>.<concern>.ts` convention.

### 3. `src/infra/session-cost-usage.ts` (984 → ~700 LOC)

| Extract to                            | What moves                                                                                                                                                                      | LOC  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `infra/session-cost-usage.types.ts`   | 20+ exported type definitions                                                                                                                                                   | ~130 |
| `infra/session-cost-usage.parsers.ts` | `emptyTotals`, `toFiniteNumber`, `extractCostBreakdown`, `parseTimestamp`, `parseTranscriptEntry`, `formatDayKey`, `computeLatencyStats`, `apply*` helpers, `scan*File` helpers | ~240 |

**Why:** Types + pure parser functions. Zero side effects. Consumers just import them.

### 4. `src/media-understanding/runner.ts` (1,232 → ~700 LOC)

| Extract to                             | What moves                                                                                                         | LOC  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---- |
| `media-understanding/runner.binary.ts` | `findBinary`, `hasBinary`, `isExecutable`, `candidateBinaryNames` + caching                                        | ~150 |
| `media-understanding/runner.cli.ts`    | `extractGeminiResponse`, `extractSherpaOnnxText`, `probeGeminiCli`, `resolveCliOutput`                             | ~200 |
| `media-understanding/runner.entry.ts`  | local entry resolvers, `resolveAutoEntries`, `resolveAutoImageModel`, `resolveActiveModelEntry`, `resolveKeyEntry` | ~250 |

**Why:** Three clean layers (binary discovery → CLI output parsing → entry resolution). One-way dependency flow.

---

## Phase 2 — Medium-Risk, Clean Boundaries

These require converting private methods or closure variables to explicit parameters, but the seams are well-defined.

### 5. `src/infra/heartbeat-runner.ts` (956 → ~560 LOC)

| Extract to                         | What moves                                                                                                     | LOC  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---- |
| `infra/heartbeat-runner.config.ts` | Active hours logic, config/agent/session resolution, `resolveHeartbeat*` helpers, `isHeartbeatEnabledForAgent` | ~370 |
| `infra/heartbeat-runner.reply.ts`  | Reply payload helpers: `resolveHeartbeatReplyPayload`, `normalizeHeartbeatReply`, `restoreHeartbeatUpdatedAt`  | ~100 |

### 6. `src/infra/outbound/message-action-runner.ts` (1,082 → ~620 LOC)

| Extract to                                        | What moves                                                                                           | LOC  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---- |
| `infra/outbound/message-action-runner.media.ts`   | Attachment handling (max bytes, filename, base64, sandbox) + hydration (group icon, send attachment) | ~330 |
| `infra/outbound/message-action-runner.context.ts` | Cross-context decoration + Slack/Telegram auto-threading                                             | ~190 |

### 7. `src/tts/tts.ts` (1,445 → ~950 LOC, then follow-up)

| Extract to              | What moves                                               | LOC  |
| ----------------------- | -------------------------------------------------------- | ---- |
| `tts/tts.directives.ts` | `parseTtsDirectives` + related types/constants           | ~260 |
| `tts/tts.providers.ts`  | `elevenLabsTTS`, `openaiTTS`, `edgeTTS`, `summarizeText` | ~200 |
| `tts/tts.prefs.ts`      | 15 TTS preference get/set functions                      | ~165 |

**Note:** Still ~955 LOC after this. A second pass could extract config resolution (~100 LOC) into `tts-config.ts`.

### 8. `src/infra/exec-approvals.ts` (1,437 → ~700 LOC)

| Extract to                          | What moves                                                                                                                                                       | LOC  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `infra/exec-approvals.shell.ts`     | `iterateQuoteAware`, `splitShellPipeline`, `analyzeWindowsShellCommand`, `tokenizeWindowsSegment`, `analyzeShellCommand`, `analyzeArgvCommand`                   | ~250 |
| `infra/exec-approvals.allowlist.ts` | `matchAllowlist`, `matchesPattern`, `globToRegExp`, `isSafeBinUsage`, `evaluateSegments`, `evaluateExecAllowlist`, `splitCommandChain`, `evaluateShellAllowlist` | ~350 |

**Note:** Still ~942 LOC. Follow-up: `exec-command-resolution.ts` (~220 LOC) and `exec-approvals-io.ts` (~200 LOC) would bring it under 700.

### 9. `src/cli/update-cli.ts` (1,245 → ~1,000 LOC)

| Extract to                  | What moves                                                                                | LOC  |
| --------------------------- | ----------------------------------------------------------------------------------------- | ---- |
| `cli/update-cli.helpers.ts` | Version/tag helpers, constants, shell completion, git checkout, global manager resolution | ~340 |

**Note:** The 3 command functions (`updateCommand`, `updateStatusCommand`, `updateWizardCommand`) are large but procedural with heavy shared context. Deeper splitting needs an interface layer.

---

## Phase 3 — Higher Risk / Structural Refactors

These files need more than "move functions" — they need closure variable threading, class decomposition, or handler-per-method patterns.

### 10. `src/memory/manager.ts` (2,280 → ~1,300 LOC, then follow-up)

| Extract to                    | What moves                                                                                                                                    | LOC  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `memory/manager.embedding.ts` | `embedChunksWithVoyageBatch`, `embedChunksWithOpenAiBatch`, `embedChunksWithGeminiBatch` (3 functions ~90% identical — **dedup opportunity**) | ~600 |
| `memory/manager.batch.ts`     | `embedBatchWithRetry`, `runBatchWithFallback`, `runBatchWithTimeoutRetry`, `recordBatchFailure`, `resetBatchFailureCount`                     | ~300 |
| `memory/manager.cache.ts`     | `loadEmbeddingCache`, `upsertEmbeddingCache`, `computeProviderKey`                                                                            | ~150 |

**Key insight:** The 3 provider embedding methods share ~90% identical structure. After extraction, refactor into a single generic `embedChunksWithProvider(config)` with provider-specific config objects. This is both a size and a logic DRY win.

**Still ~1,362 LOC** — session sync + search could be a follow-up split.

### 11. `src/agents/bash-tools.exec.ts` (1,546 → ~1,000 LOC)

| Extract to                          | What moves                                                       | LOC  |
| ----------------------------------- | ---------------------------------------------------------------- | ---- |
| `agents/bash-tools.exec.process.ts` | `runExecProcess` + supporting spawn helpers                      | ~400 |
| `agents/bash-tools.exec.helpers.ts` | Security constants, `validateHostEnv`, normalizers, PATH helpers | ~200 |

**Challenge:** `runExecProcess` reads closure variables from `createExecTool`. Extraction requires passing explicit params.

### 12. `src/gateway/server/ws-connection/message-handler.ts` (970 → ~720 LOC)

| Extract to                                 | What moves                              | LOC  |
| ------------------------------------------ | --------------------------------------- | ---- |
| `ws-connection/message-handler.auth.ts`    | Device signature/nonce/key verification | ~180 |
| `ws-connection/message-handler.pairing.ts` | Pairing flow                            | ~110 |

**Challenge:** Everything is inside a single deeply-nested closure sharing `send`, `close`, `frame`, `connectParams`. Extraction requires threading many parameters. Consider refactoring to a class or state machine first.

---

## UI Files

### 13. `ui/src/ui/views/usage.ts` (3,076 → ~1,200 LOC)

| Extract to                   | What moves                                                                                       | LOC  |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ---- |
| `views/usage.aggregation.ts` | Data builders, CSV export, query engine                                                          | ~550 |
| `views/usage.charts.ts`      | `renderDailyChartCompact`, `renderCostBreakdown`, `renderTimeSeriesCompact`, `renderUsageMosaic` | ~600 |
| `views/usage.sessions.ts`    | `renderSessionsCard`, `renderSessionDetailPanel`, `renderSessionLogsCompact`                     | ~800 |

### 14. `ui/src/ui/views/agents.ts` (1,894 → ~950 LOC)

| Extract to                 | What moves                            | LOC  |
| -------------------------- | ------------------------------------- | ---- |
| `views/agents.tools.ts`    | Tools panel + policy matching helpers | ~350 |
| `views/agents.skills.ts`   | Skills panel + grouping logic         | ~280 |
| `views/agents.channels.ts` | Channels + cron panels                | ~380 |

### 15. `ui/src/ui/views/nodes.ts` (1,118 → ~440 LOC)

| Extract to                      | What moves                                  | LOC  |
| ------------------------------- | ------------------------------------------- | ---- |
| `views/nodes.exec-approvals.ts` | Exec approvals rendering + state resolution | ~500 |
| `views/nodes.devices.ts`        | Device management rendering                 | ~230 |

---

## Extension: BlueBubbles

### 16. `extensions/bluebubbles/src/monitor.ts` (2,348 → ~650 LOC)

| Extract to                         | What moves                                                                                      | LOC    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| `monitor.normalize.ts`             | `normalizeWebhookMessage`, `normalizeWebhookReaction`, field extractors, participant resolution | ~500   |
| `monitor.debounce.ts`              | Debounce infrastructure, combine/flush logic                                                    | ~200   |
| `monitor.webhook.ts`               | `handleBlueBubblesWebhookRequest` + registration                                                | ~1,050 |
| Merge into existing `reactions.ts` | tapback parsing, reaction normalization                                                         | ~120   |

**Key insight:** Message/reaction normalization share ~300 lines of near-identical field extraction — dedup opportunity similar to memory providers.

---

## Execution Plan

| Wave        | Files                                                          | Total extractable LOC | Est. effort  | Status                                |
| ----------- | -------------------------------------------------------------- | --------------------- | ------------ | ------------------------------------- |
| **Wave 1**  | #1–#4 (schema, audit-extra, session-cost, media-understanding) | ~2,600                | 1 session    | ✅ #1 done, ✅ #2 done, #3–#4 pending |
| **Wave 2a** | #5–#6 (heartbeat, message-action-runner)                       | ~990                  | 1 session    | Not started                           |
| **Wave 2b** | #7–#9 (tts, exec-approvals, update-cli)                        | ~1,565                | 1–2 sessions | Not started                           |
| **Wave 3**  | #10–#12 (memory, bash-tools, message-handler)                  | ~1,830                | 2 sessions   | Not started                           |
| **Wave 4**  | #13–#16 (UI + BlueBubbles)                                     | ~4,560                | 2–3 sessions | Not started                           |

### Ground Rules

1. **No behavior changes.** Every extraction is a pure structural move + import update.
2. **Tests must pass.** Run `pnpm test` after each file extraction.
3. **Imports only.** New files re-export from old paths if needed to avoid breaking external consumers.
4. **Dot-naming convention.** Use `<base>.<concern>.ts` pattern (e.g., `runner.binary.ts`, not `binary-resolve.ts`).
5. **Centralized patterns over scatter.** Prefer 2 logical groupings (e.g., sync vs async) over 3-4 domain-specific fragments.
6. **Update colocated tests.** If `foo.test.ts` imports from `foo.ts`, update imports to the new module.
7. **CI gate.** Each PR must pass `pnpm build && pnpm check && pnpm test`.

---

## Metrics

After all waves complete, the expected result:

| Metric                          | Before | After (est.)               |
| ------------------------------- | ------ | -------------------------- |
| Files > 1,000 LOC (non-test TS) | 17     | ~5                         |
| Files > 700 LOC (non-test TS)   | 50+    | ~15–20                     |
| New files created               | 0      | ~35                        |
| Net LOC change                  | 0      | ~0 (moves only)            |
| Largest core `src/` file        | 2,280  | ~1,300 (memory/manager.ts) |
