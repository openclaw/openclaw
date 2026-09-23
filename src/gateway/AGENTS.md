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
- Sessionless runs retain prepared admission authority without inventing session projection. Canonical idempotency reservation owns deduplication; a source-specific RPC wait becomes terminal only after that source's replay payload publishes. Lifecycle completion or another source cannot close that barrier; abort-map binding occurs only for registered projected runs.
- Worker launch, recovery, reclaim, and RPC use require an exact live placement, environment, owner epoch, placement generation, and turn claim.
- The current worker execution-context dialect is an upgrade boundary. Reject incompatible workers and reprovision them; do not emit legacy payloads, locally downgrade execution, or revive pre-restart claims.

## Approval Identity Persistence

- The approval store may lazily create its additive execution-identity companion table only when writing a valid bound identity.
- Identity rows record provenance only. Authorization and decision consumption must use the parent approval and current live authority, never the companion row.
- Preserve schema version and older-reader tolerance. Changes to this surface require enabled, disabled, integrity, downgrade, and candidate-reopen proof.

## Session Row Projection

- `session-row-projection-access.ts` binds request contexts to their runtime owner; context copies retain that binding, and the runtime owns projection disposal. Keep the generic request context independent of projection implementation types.
- `session-row-projection.ts` owns resident materialized session rows. Owner publications through `sessionChanges` invalidate exact session identities; SQLite publications run after commit, and reads retain fresh sharing identity after yields.
- Writers that create or rename keys publish the destination keys, including Doctor repairs. A broad store invalidation refreshes existing identities; it does not discover new keys by scanning.
- Startup is per physical store: first admission, replacement, or reappearance after a hot `session.store` change hydrates that store once through the existing loader. Remove rows when their store leaves the topology. Incognito stores stay excluded across database generations.
- Projection work retains its creation owner's async context, never a publisher's temporary startup-admission borrow. Successful deferred database preparation publishes topology after ending that borrow.
- Legacy ACP-key and missing-title repairs belong only to Doctor. Gateway admission and reads may select compatible stored metadata but never normalize or persist it.
- Archived rows retain list metadata, indexes, and board membership. Exact reads and selected list pages materialize them through a bounded cache sized for the requested page. Broad catalog/config/topology invalidations evict archived materializations; publications maintain cold parent/identity indexes and promote unarchived entries. Sharing filters consume metadata even when a row is cold, and backfill requires a current materialized row.
- After hydration, clean materialized list/describe/event snapshots execute no SQLite statements. Dirty rows acquire stored metadata through exact-key readers. Resident materialization never reads transcript payloads; optional previews and fallback-model facts use bounded read-only background enrichment, and usage comes from its persistence owner. Background transcript work yields to foreground request lifetimes and rechecks that priority before publishing its result. Never scan an already resident store to serve a request.
- The profile owner retains durable display facts, roles, and merge aliases while a projection is active. Its committed writes update exact catalog keys before publishing through `sessionChanges`; physical shared-store admission hydrates the catalog once. Person-reference selection reads that catalog, including profiles without sessions. Synthetic plugin readers and selected-profile bindings acquire current exact identity facts from the same catalog after readiness; display prefix matching never grants authority.
- Prepare federation scopes on topology publication. Resolve sentinel precedence before viewer/activity filtering; model inheritance and child links use the same physical parent. A list awaits projection readiness; keyed describe/resolve/history reads prepare only their requested row, independently of bulk refresh. Requests select, authorize, present, and reply synchronously with the current viewer and clock; do not insert a result-promise await before the RPC response.
- Recheck `needsMaterialization` in the consuming frame after readiness awaits: a commit can arrive as a promise settles. Successful drains join subsequent dirty work; failed refreshes keep their keys dirty for the next signal or read.
- Queued events capture the projection generation before awaited work and reject a replaced identity before publishing. Keyed mutations use the shared per-connection snapshot presenter; broad invalidations remain keyless. Authorized incognito describe, history, resolve, and event reads share transient exact-key preparation outside the resident roster; generation checks bind both the process-local database and session lifecycle.
- Incognito reads reuse shared authorization and the existing exact read-only lookup. They may read ephemeral SQLite, requested transcript fields, and bounded child metadata, never admit a store or retain rows; incognito rows remain excluded from discovery and resident memory.
- Cancellation receipts prepare rows inside the existing kill hold, revalidate the run and captured session generation, then publish synchronously before releasing ownership. Ordinary events retain coalesced publication.
- Agent event ingestion never waits for row enrichment: tool/progress consumers must capture reply content before completion. Optional tool-row metadata can be absent while rows are dirty; full lifecycle row publications await readiness.
- Carry physical store ownership into transcript/title/usage readers independently of the logical agent used for model and visibility policy. Reuse the prepared fallback model instead of reading it twice.
- Event authorization consumes committed sharing metadata and the membership snapshot independently of full-row materialization. `sessions.changed` and `session.message` producers still await display-row readiness. Synchronous board/progress/suggestion events must neither query SQLite nor lose authorized delivery while display rows are dirty; member revocations publish before those events.

## Verification

- Benchmark the affected Gateway test file before/after with
  `pnpm test <file>`.
- Run `pnpm build` when changing Gateway lazy-loading or bundled plugin
  artifacts.
