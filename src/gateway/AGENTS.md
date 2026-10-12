# Gateway Runtime And Delivery

Gateway startup/tests needing only static descriptors must not load bundled plugin runtime.

## Guardrails

- Resolve plugin-owned Gateway behavior (including auth bypass) through lightweight public artifacts before full plugins. Share one plugin-owned helper; never load broad channel registries for static HTTP/server questions.
- Add a descriptor's core resolver, plugin artifact, and mirrored full-plugin export together.
- Reuse suite servers, authenticated contexts, and clients unless proving fresh connect/auth; reset state explicitly. Disable schedulers/pollers/background loops in manual-RPC tests unless proving their lifecycle.

## Best-Effort Callbacks And Telemetry

- Keep network telemetry/callbacks off turn/token paths. Queue through the lifecycle owner with bounds and visible overflow/coalescing.
- Classify by caller contract, not void returns: authorization, approval, required persistence and user-requested delivery are not best-effort; retain ordering/failure semantics. Callback failure must not grant permission or discard required work.

## Write Target And Outcome

- Bind the target before its first side effect. Never redirect failed writes across accounts, profiles, Gateways, or sessions; report/reconcile the original target.
- Timeouts may follow accepted writes: use the owner's idempotency/outcome reconciliation before retrying. Existing transport/failover contracts (including model-call auth-profile failover) never authorize redirecting unrelated user-bound writes.

## Run Authority And Worker Upgrades

- `src/infra/agent-run-registry.ts` owns run liveness; `src/gateway/worker-environments/placement-turn-claims.ts` owns worker-turn liveness. Validate both at use time; HMAC, TTL, and matching IDs do not establish live authority.
- After awaits, compose all applicable live-authority assertions in the owner's synchronous pre-commit guard, never after mutation.
- Sessionless runs retain prepared admission authority without session projection; canonical reservation owns deduplication. Source-specific RPC waits end only on that source's replay publication, never lifecycle completion/another source. Bind abort maps only for registered projected runs.
- Worker launch, recovery, reclaim, and RPC require an exact live placement, environment, owner epoch, placement generation, and turn claim.
- Reject/reprovision incompatible execution-context dialects; never emit legacy payloads, downgrade locally, or revive pre-restart claims.

## Approval Identity Persistence

- Create the additive execution-identity companion table lazily, only for valid bound identity writes. Rows record provenance; parent approvals and live authority govern authorization/decision consumption.
- Preserve schema version and older-reader tolerance. Prove enabled, disabled, integrity, downgrade, and candidate-reopen behavior when changing this surface.

## Session Row Projection

- `session-row-projection-access.ts` binds contexts/copies to the runtime owner responsible for disposal. Keep projection types out of generic contexts.
- `session-row-projection.ts` owns resident rows. Publish exact-identity invalidations through `sessionChanges`, after SQLite commit; retain fresh sharing identity across yields.
- Creation/rename writers, including Doctor, publish destination keys. Broad invalidation refreshes known identities without discovery scans.
- Hydrate each physical store once via the existing loader on admission/replacement/reappearance after hot `session.store` changes. Remove departed rows; exclude incognito across generations.
- Retain the creation owner's async context, never the publisher's startup-admission borrow. Publish successfully prepared topology after ending the borrow.
- Doctor alone repairs legacy ACP keys, embedded ACP metadata, and missing titles. Refuse unmigrated ACP stores before runtime handoff with offline repair guidance; reads consume canonical metadata, never normalize/persist legacy shapes.
- Archives retain list metadata, indexes, and board membership. Exact/selected-page reads use a page-sized bounded cache, evicted by broad catalog/config/topology invalidations. Maintain cold parent/identity indexes, promote unarchived entries, filter sharing from cold metadata; backfill only current materialized rows.
- Neutral/display-only commits advance projection config, retaining session facts; the profile owner refreshes display. Topology-only admission reconciles generations, retaining unchanged stores. Keep revocation/catalog publications independent; provenance changes/forced invalidation refresh broadly. Compare live previous config with the prior publication's fingerprint AND serialized resolution facts: in-place changes select broad `config`. Same-object publication stays broad unless validated against that record; `setRuntimeConfigSourceSnapshotIfCurrent` sends no session change for proven equivalence.
- Retain completed catalogs while model-owner replacement is pending/owner absent. Resume on that exact promise's settlement, including failure, never unpaired scoped auth events.
- Hydrated clean list/describe/event snapshots execute no SQL; dirty metadata uses exact-key readers. Resident materialization never reads transcripts; requests never scan resident stores. Optional previews/fallback-model facts use bounded read-only background enrichment; usage comes from its persistence owner. Transcript enrichment yields to foreground lifetimes and rechecks priority before publication.
- The profile owner retains durable display facts, roles, and merge aliases during projection life; committed writes update exact catalog keys before `sessionChanges`. Hydrate once per physical shared-store admission. Person selection includes sessionless profiles; synthetic plugin readers/selected-profile bindings acquire current exact catalog identities after readiness. Display prefixes never authorize.
- Prepare federation scopes on topology publication; resolve sentinel precedence before viewer/activity filters. Model inheritance/child links share the physical parent. Lists await readiness; keyed describe/resolve/history prepare only requested rows independent of bulk refresh. Select/authorize/present/reply synchronously with current viewer/clock; no result-promise await before response.
- Recheck `needsMaterialization` in the consuming frame after readiness awaits. Successful drains join later work; failed refreshes retain dirty keys until the next signal/read.
- Queued events capture generation before awaits; reject replaced identities before publication. Keyed mutations share the per-connection snapshot presenter; broad invalidations stay keyless. Incognito describe/history/resolve/event reads prepare transient exact keys outside the roster; generation checks bind database/session lifecycle.
- Incognito reads reuse shared authorization/exact read-only lookup for ephemeral SQLite, requested transcript fields, and bounded child metadata. Never admit stores, retain rows, or include incognito in discovery/resident memory.
- Cancellation receipts prepare within the kill hold, revalidate run/session generation, then publish synchronously before release. Coalesce ordinary events.
- Ingestion never waits for enrichment: tool/progress consumers capture replies before completion. Optional tool-row metadata may be absent while dirty; full lifecycle publications await readiness.
- Carry physical store ownership into transcript/title/usage reads independently of logical model/visibility policy. Reuse prepared fallback models.
- Authorize events from committed sharing metadata/membership snapshots independently of full rows. `sessions.changed`/`session.message` await display readiness. Synchronous board/progress/suggestion events must neither query SQLite nor lose authorized delivery while dirty; publish member revocations first.

## Verification

- For session-creation publication ownership or restart-delivery custody changes, prove public `sessions.create` in an isolated Gateway with an explicit non-main session, then a post-publication read/turn. Creation-helper tests alone do not prove this flow.
- Prove trusted changes locally with touched tests (`pnpm test <file> --maxWorkers=1`) and targeted typecheck/lint/format; measure affected Gateway test time before/after. Run `pnpm build` for lazy-loading or bundled-plugin artifact changes.
- Follow the root proof policy: PR CI for broad proof, boxes only for otherwise unavailable coverage with immediate admission; no queue waits, provider fallbacks, or reruns/re-pushes just for green. Read CI failure classification before attributing red.
