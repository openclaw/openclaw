# Shared progress-lane engine

**Status:** scaffold / sister PR to #87072 (Telegram interleaved progress).
**Goal:** one channel-agnostic engine that projects an agent's reasoning + tool/event stream into a live, edited progress message — replacing the per-channel duplicates (Telegram's `interleaved-progress` in #87072, Discord's `streaming.progress.commentary` from merged #85200). Maintainer (obviyus) requested the shared approach.

## Why

Two channels already implement the same concept independently:

- **Telegram** — `extensions/telegram/src/interleaved-progress.ts` (reasoning + tool lines + timestamps + rolling timer + tool-args + 4096 spill).
- **Discord** — `extensions/discord/src/preview-streaming.ts` (`streaming.progress.commentary`).

Feishu / MSTeams / lmstudio all have their own `*stream*` modules too. The **throttle core is already shared** (`src/channels/draft-stream-loop.ts`); only the _progress projection_ is duplicated. This unifies that projection.

## Design — three layers

```
agent runner ──generic callbacks──▶  PROGRESS-LANE ENGINE  ──▶  per-channel SINK  ──▶ wire
 onReasoningStream/onToolStart/...     (transcript + ingest)     (render + edit)    (shared throttle)
```

1. **Transcript model (pure, channel-neutral)** — hoisted verbatim from `interleaved-progress.ts`: delta-append + overlap-fold dedup, `computeSpill(maxChars, overlap)` (already parameterized per-channel), no-content guard, tag-strip, final-answer strip, status-line append. Produces `LaneSegment[]`, not channel text.
2. **Ingest controller** — `createProgressLane({ sink, config })` (this dir, `controller.ts`): subscribes to the generic callbacks, mutates the transcript, owns the rolling timer + spill offset + per-stream checkpoints, decides "render now".
3. **Channel sink** — `ProgressLaneSink` (this dir, `sink.ts`): each channel renders `LaneSegment[]` to its format and edits its durable message over its existing draft-stream. The shared `draft-stream-loop` throttle stays underneath.

## Superset, not lowest-common-denominator

The engine is seeded from the **richer** Telegram model so nothing regresses. Discord's `commentary` is **one mode** of it, not the ceiling. Every Telegram capability stays and becomes cross-channel:

| Capability                                      | Source                                   | In the engine                                                             |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| rolling "still running" poll / timer            | controller `setInterval`                 | engine-owned; **cadence is per-channel config** (20s for TG's rate limit) |
| timestamps (`[HH:MM:SS]` + wall-clock)          | `appendStatusLine(ts)` + timer suffix    | pure transcript model                                                     |
| unstripped tool options (`interleavedToolArgs`) | `resolveInterleavedToolLine({showArgs})` | pure helper + config `toolArgs`                                           |
| 4096 / 2000 / card spill                        | `computeSpill(maxChars)`                 | per-channel `maxChars` on the sink                                        |
| reasoning / commentary / tool rows              | the transcript model                     | config toggles                                                            |

## Unified config (superset — nothing dropped)

```
streaming.progress.{
  commentary,   # Discord (#85200, merged)
  reasoning,    # Telegram
  toolRows,     # Telegram (tool lines)
  toolArgs,     # Telegram (unstripped command)
  timer,        # Telegram (poll + cadence)
  timestamps,   # Telegram
}
```

Reconcile `streaming.preview.interleavedProgress`/`interleavedToolArgs` (TG) and `streaming.progress.commentary` (Discord) into this one namespace. Maintainers pick canonical names; the engine reads them.

## Per-channel sink guide ("how for Teams and others")

Each channel implements `ProgressLaneSink` over its **existing** edit primitive — the engine never touches channel APIs:

| Channel      | Edit primitive (exists)                                                | `render()` target    | Notes                                             |
| ------------ | ---------------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| **Telegram** | `telegram/src/draft-stream.ts` (`editMessageText`)                     | HTML                 | `maxChars` 4096; seed/reference impl              |
| **Discord**  | `discord/src/draft-stream.ts` + `preview-streaming.ts` (message edit)  | markdown             | `maxChars` 2000; absorbs the merged `commentary`  |
| **MSTeams**  | `msteams/src/reply-stream-controller.ts` + `block-streaming-config.ts` | Adaptive Card blocks | segments → card rows; `update()` patches the card |
| **Feishu**   | `feishu/src/streaming-card.ts`                                         | Feishu card          | segments → card; card update primitive            |
| **lmstudio** | `lmstudio/src/stream.ts`                                               | plain                | minimal sink                                      |

Teams/Feishu render to **card blocks** rather than a flat string, so their `render()` returns a card payload — the `LaneSegment[]` contract supports this (structured segments, not pre-rendered markdown).

## Migration roadmap (each step ships green-to-green)

1. **Hoist** `interleaved-progress.ts` pure helpers → `progress-lane/transcript.ts` (rewire imports to relative; no behavior change). _(start here)_
2. **Extract** `createProgressLane` from `telegram/bot-message-dispatch.ts`; Telegram becomes a sink. **Telegram stays bit-identical** so #87072 doesn't regress.
3. **Discord** implements the sink → full interleaved lane on Discord; deprecate the bespoke `commentary` path behind the unified config.
4. **Config** reconcile into `streaming.progress.*`.
5. **MSTeams / Feishu / lmstudio** implement the sink.

## Open questions for obviyus / bryanpearson

- Canonical config names + whether `streaming.progress.commentary` stays as the alias.
- `LaneSegment` shape: flat-markdown string vs structured segments (cards need structured — leaning structured).
- Whether step 1+2 lands first (Telegram-only, internal refactor) then channels follow, or all-at-once.

Cross-refs: #87072 (Telegram interleaved), #85200 (merged Discord commentary), #85164 (its source, bryanpearson).
