# Gateway Runtime And Delivery

Gateway server tests and startup paths should not materialize bundled plugin
runtime when they only need plugin-owned static descriptors.

## Guardrails

- For plugin-owned Gateway behavior such as auth-bypass paths, prefer a
  lightweight public artifact resolver before falling back to the full channel
  plugin.
- Keep the full plugin contract and the lightweight artifact backed by the same
  plugin-owned helper so behavior does not diverge.
- Do not load broad bundled channel registries from Gateway HTTP/server code
  just to answer static questions.
- If adding a new plugin-owned Gateway descriptor, add the core resolver,
  plugin artifact, and mirrored full-plugin export in the same change.
- In Gateway server tests, reuse suite-level servers, authenticated contexts,
  and clients when the behavior under test does not require a fresh
  connect/auth handshake. Reset runtime state explicitly instead of restarting
  the whole server per case.
- Keep schedulers, pollers, and background loops disabled in manual-RPC tests
  unless the test is specifically proving automatic scheduling or lifecycle
  behavior.

## Best-Effort Callbacks And Telemetry

- When adding or changing best-effort telemetry and callbacks, keep network
  delivery off turn execution and token delivery paths. Queue outbound work
  through its lifecycle owner; keep the queue bounded and define visible
  overflow/coalescing behavior. An inline callback that can wait on a remote
  endpoint defeats that boundary.
- Authorization, approval, required persistence, and user-requested delivery are
  not best-effort telemetry. Classify hooks by their caller contract, not a void
  return type; preserve required ordering and failure behavior. Callback failure
  must neither grant permission nor silently discard required work.

## Write Target And Outcome

- Bind a mutation to its intended logical target before its first side effect.
  A failure must not silently redirect the write to another account, profile,
  Gateway, or session. Report the failure or reconcile the original target.
- A timeout can follow an accepted write. Use the existing owner's idempotency
  and outcome-reconciliation contract before retrying; an error alone does not
  prove non-execution. Transport retry or explicit failover may follow an existing
  contract, including model-call auth-profile failover. That is not permission
  to redirect an unrelated user-bound write to report success.

## Run Authority And Worker Upgrades

- `src/infra/agent-run-registry.ts` owns run liveness. `src/gateway/worker-environments/placement-turn-claims.ts` owns worker-turn liveness. Validate both at use time; HMAC verification, TTL, and matching identifiers do not establish live authority.
- For durable effects after awaited work, compose every applicable live-authority assertion into the owning synchronous pre-commit guard; rechecking only after the mutation returns is too late.
- Sessionless runs retain prepared admission authority without inventing session projection. Canonical idempotency reservation owns deduplication; abort-map binding occurs only for registered projected runs.
- Worker launch, recovery, reclaim, and RPC use require an exact live placement, environment, owner epoch, placement generation, and turn claim.
- The current worker execution-context dialect is an upgrade boundary. Reject incompatible workers and reprovision them; do not emit legacy payloads, locally downgrade execution, or revive pre-restart claims.

## Approval Identity Persistence

- The approval store may lazily create its additive execution-identity companion table only when writing a valid bound identity.
- Identity rows record provenance only. Authorization and decision consumption must use the parent approval and current live authority, never the companion row.
- Preserve schema version and older-reader tolerance. Changes to this surface require enabled, disabled, integrity, downgrade, and candidate-reopen proof.

## Verification

- Benchmark the affected Gateway test file before/after with
  `pnpm test <file>`.
- Run `pnpm build` when changing Gateway lazy-loading or bundled plugin
  artifacts.
