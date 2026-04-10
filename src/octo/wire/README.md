# Wire Contracts (`src/octo/wire/`)

The wire module holds the shared TypeBox schemas, primitives, and envelope types that both the Head Controller and the Node Agent (and the CLI and Gateway handlers) depend on. Everything that crosses a process boundary in Octopus — `ArmSpec`, `GripSpec`, `MissionSpec`, the `octo.*` JSON-RPC method request/response pairs, push event envelopes, and feature advertisements — is defined here so there is a single source of truth for validation and type inference.

Per HLD §"Code layout and module boundaries", this directory contains:

- `primitives.ts` — shared TypeBox primitives (`NonEmptyString`, id types, timestamps, etc.).
- `schema.ts` — `ArmSpec`, `GripSpec`, `MissionSpec` schemas plus `validateArmSpec` and friends.
- `methods.ts` — TypeBox schemas for `octo.*` request/response methods.
- `events.ts` — TypeBox schemas for `octo.*` push events and the event envelope.
- `features.ts` — `FeaturesOctoSchema` and the `buildFeaturesOcto` advertiser (planned).
- `gateway-handlers.ts` — Gateway WebSocket request and event handlers, wiring `octo.*` traffic into Head services (lands M1-14 onward).

The primitives, schema, methods, and events files were authored in Milestones M0-01 through M0-05 and are real implementations. Test files (`*.test.ts`) live beside their subjects. This module is the `wire/` half of the Head/Node split noted in HLD §"Code layout": both sides import from here but nothing here imports from either side.
