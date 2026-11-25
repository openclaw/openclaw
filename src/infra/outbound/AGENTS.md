# Outbound Delivery

## Durable Delivery Ownership

- Shared durable delivery records progress at queue custody and platform-send
  boundaries. For queued sends, only the owner that canonically settles or
  removes custody may publish terminal completion or audit facts; identityless
  and crash-ambiguous sends remain with recovery/reconciliation, so live
  delivery and recovery never both publish a terminal outcome.

## Current-Source Completion

- An eligible message action completes the current source only when its
  requested or implicit destination matches that source and every
  transport-reported delivered recipient normalizes to it. Requested routing
  never overrides contradictory or mixed receipt data; inspect every physical
  part of an aggregate result. Missing recipient metadata preserves the
  existing plugin result contract. Completion eligibility does not widen
  transcript-mirror or restart-receipt ownership.

## Guardrails

- Prefer pure param/spec/normalization helpers for send-argument, media-source,
  alias, and payload-shape coverage. Do not import real delivery runtimes when
  the test only asserts normalized arguments.
- Avoid partial-real mocks with `importActual()` around broad outbound delivery
  modules. Mock the exact seam under test, then cover the real delivery runtime
  in a focused integration test.
- Before discovering plugin-owned media/action metadata, first check whether the
  call actually includes plugin-owned params. Standard send params should not
  trigger bundled channel message-tool discovery.

## Verification

- Shared helper change: run `src/channels/plugins/contracts/outbound-payload.contract.test.ts`
  and `src/infra/outbound/message-action-execution*.test.ts`.
