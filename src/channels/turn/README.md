# Channel Turn Runtime

This directory owns the shared channel turn lifecycle. It is the small runtime
layer that turns one inbound channel event into an assembled, recorded,
dispatched, and finalized turn. It is not a separate agent kernel and should not
grow into a parallel runtime.

## Lifecycle

`kernel.ts` keeps the common turn flow in one place:

1. Ingest and classify the inbound channel event.
2. Assemble the channel turn and record the inbound payload through the existing
   channel recorder.
3. Dispatch the prepared turn through the channel reply path.
4. Finalize the turn and surface structured, payload-free diagnostics.

Channel adapters should use the public SDK entrypoints and contracts instead of
importing this directory directly. See `src/channels/AGENTS.md` for the channel
boundary rules.

## Delivery State

`turn-event-state.ts` models a payload-free event timeline for one turn. The
events are append-like and intentionally small: message receipt, turn start,
delivery requirements, delivery outcome, tool causality support, and turn
completion or failure.

Turn event metadata is sanitized before it enters the local event timeline.
Sensitive-looking keys such as body, text, payload, secret, token, cookie,
password, credential, authorization, content, and raw are redacted, and long
operational strings are bounded.

The current enforced guarantee is deliberately narrow:

- Telegram direct messages require visible delivery.
- A Telegram direct turn without a visible reply is materialized as failed with
  `missing_visible_delivery`.
- The first layer records `delivery.failed` and `turn.failed` instead of
  throwing or retrying. This avoids duplicate replies while still making the
  unhealthy state visible to diagnostics, tests, and finalizers.

`materializeTurnState(...)` derives whether visible delivery was required, sent,
and whether clean completion is allowed. `validateTurnCompletion(...)` is the
single validation helper used by the kernel and tests.

## Adapter Guidance

- Read `result.turnState` in `onFinalize` when an adapter needs to distinguish a
  clean completion from a missing visible reply.
- Use `ChannelTurnLogEvent.turnState` for diagnostics and health summaries.
- Extension-facing code should import `TurnState` through
  `openclaw/plugin-sdk/channel-inbound`.
- Do not write raw message text, private mail contents, secrets, or full tool
  payloads into turn event metadata.

## Current Limits

The spike supports `tool.called` and `tool.result` events, but the shared tool
execution path is not instrumented here yet. A future iteration can attach tool
events through the same event recorder once delivery health is stable.

There is no persistent event store in this directory. `InMemoryTurnEventStore`
exists for focused tests and for small runtime slices that need an append-like
store shape without committing to a storage backend. It is bounded by default
and reports dropped older events through `stats()`.
