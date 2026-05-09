# Gateway Protocol Boundary

This directory defines the Gateway wire contract for operator clients and
nodes.

## Public Contracts

- Docs:
  - `docs/gateway/protocol.md`
  - `docs/gateway/bridge-protocol.md`
  - `docs/concepts/architecture.md`
- Definition files:
  - `src/gateway/protocol/schema.ts`
  - `src/gateway/protocol/schema/*.ts`
  - `src/gateway/protocol/index.ts`

## Boundary Rules

- Treat schema changes as protocol changes, not local refactors.
- Prefer additive evolution. If a change is incompatible, handle versioning
  explicitly and update all affected clients.
- Keep schema, runtime validators, docs, tests, and generated client artifacts
  in sync.
- New Gateway methods, events, or payload fields should land through the typed
  protocol definitions here rather than ad hoc JSON shapes elsewhere.
- Keep protocol modules data-first and acyclic. Do not route protocol exports
  back through heavier gateway runtime or server-method helpers that make the
  contract surface expensive or order-dependent at import time.
