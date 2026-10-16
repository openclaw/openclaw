# Gateway Runtime And Delivery

Gateway startup/tests needing only static descriptors must not load bundled plugin runtime.

## Guardrails

- Resolve plugin-owned Gateway behavior (including auth bypass) via lightweight public artifacts before full plugins. Share one plugin-owned helper; never broad channel registries for static HTTP/server questions.
- Add descriptor's core resolver, plugin artifact, mirrored full-plugin export together.
- Reuse suite servers, authenticated contexts, clients unless proving fresh connect/auth; reset state explicitly. Manual-RPC tests: disable schedulers/pollers/background loops unless proving lifecycle.

## Process-Owned Files

- Gateway owns its files (auth profiles, agent/workspace identity, database identity, config): load once, serve from the owner's memory, update write-through on its own writes. Hot request paths never re-read, stat, or realpath them.
- Rare external writers (CLI processes, Doctor, manual edits): one watcher per owner or the config reload watcher, never per-request checks. List writers that bypass the Gateway before caching.
- Authority revalidates the owner's in-memory revision, not disk; a swapped/foreign database file must still be detected before the next privileged write.

## Best-Effort Callbacks And Telemetry

- Network telemetry/callbacks off turn/token paths. Queue via lifecycle owner with bounds + visible overflow/coalescing.
- Classify by caller contract, not void returns: authorization, approval, required persistence, user-requested delivery ≠ best-effort; retain ordering/failure semantics. Callback failure must not grant permission/discard required work.

## Write Target And Outcome

- Bind target before first side effect. Never redirect failed writes across accounts, profiles, Gateways, sessions; report/reconcile original target.
- Timeouts may follow accepted writes: owner's idempotency/outcome reconciliation before retry. Existing transport/failover contracts (including model-call auth-profile failover) never authorize redirecting unrelated user-bound writes.

## Run Authority And Worker Upgrades

- Run liveness: `src/infra/agent-run-registry.ts`; worker-turn liveness: `src/gateway/worker-environments/placement-turn-claims.ts`. Validate both at use time; HMAC, TTL, matching IDs ≠ live authority.
- After awaits: compose all applicable live-authority assertions in owner's synchronous pre-commit guard, never after mutation.
- Sessionless runs: retain prepared admission authority without session projection; canonical reservation owns deduplication. Source-specific RPC waits end only on that source's replay publication, never lifecycle completion/another source. Bind abort maps only for registered projected runs.
- Worker launch/recovery/reclaim/RPC: exact live placement, environment, owner epoch, placement generation, turn claim required.
- Incompatible execution-context dialects: Reject/reprovision; never legacy payloads, local downgrade, or revived pre-restart claims.

## Approval Identity Persistence

- Additive execution-identity companion table: create lazily, only for valid bound identity writes. Rows = provenance; parent approvals + live authority govern authorization/decision consumption.
- Preserve schema version + older-reader tolerance. Changes: prove enabled, disabled, integrity, downgrade, candidate-reopen behavior.

## Session Row Projection

- `session-row-projection-access.ts` binds contexts/copies to runtime disposal owner. Projection types stay out of generic contexts.
- `session-row-projection.ts` owns resident rows. Publish exact-identity invalidations via `sessionChanges` after SQLite commit; retain fresh sharing identity across yields.
- Creation/rename writers, including Doctor: publish destination keys. Broad invalidation refreshes known identities without discovery scans.
- Hydrate each physical store once via existing loader on admission/replacement/reappearance after hot `session.store` changes. Remove departed rows; exclude incognito memory namespaces from durable-store hydration.
- Retain creation owner's async context, never publisher's startup-admission borrow. End borrow before publishing successfully prepared topology.
- Doctor alone repairs legacy ACP keys, embedded ACP metadata, missing titles. Refuse unmigrated ACP stores before runtime handoff with offline repair guidance; reads consume canonical metadata, never normalize/persist legacy shapes.
- Archives retain list metadata, indexes, board membership. Exact/selected-page reads: page-sized bounded cache, evicted by broad catalog/config/topology invalidations. Maintain cold parent/identity indexes, promote unarchived entries, filter sharing from cold metadata; backfill only current materialized rows.
- Neutral/display-only commits: advance projection config, retain session facts; profile owner refreshes display. Topology-only admission: reconcile generations, retain unchanged stores. Keep revocation/catalog publications independent; provenance changes/forced invalidation refresh broadly. Compare live previous config with prior publication's fingerprint AND serialized resolution facts: in-place changes select broad `config`. Same-object publication stays broad unless validated against that record; `setRuntimeConfigSourceSnapshotIfCurrent` sends no session change for proven equivalence.
- Retain completed catalogs while model-owner replacement pending/owner absent. Resume on exact promise's settlement, including failure, never unpaired scoped auth events.
- Hydrated clean list/describe/event snapshots: no SQL. Dirty metadata: exact-key readers. Resident materialization never reads transcripts; requests never scan resident stores. Optional previews/fallback-model facts: durable window cache with bounded writer-owned backfill on misses; usage from persistence owner. Backfill yields to foreground lifetimes and checks session identity before publication.
- Prepared row consumers use worker-admitted durable facts or memory actors. Missing durable facts reenter `SessionRowFactsPending` preparation; canonical SQLite validation stays at database admission, outside synchronous projection consumers.
- Profile owner retains durable display facts, roles, merge aliases during projection life; committed writes update exact catalog keys before `sessionChanges`. Hydrate once per physical shared-store admission. Person selection includes sessionless profiles; synthetic plugin readers/selected-profile bindings acquire current exact catalog identities after readiness. Display prefixes never authorize.
- Prepare federation scopes on topology publication; resolve sentinel precedence before viewer/activity filters. Model inheritance/child links share physical parent. Lists await readiness; keyed describe/resolve/history prepare only requested rows independent of bulk refresh. List selection/filtering runs in the projection-owned session-list worker using published metadata and captured disclosure inputs; page presentation shares the event renderer. After worker awaits, recheck the selection/profile/policy revision and current audience before synchronously authorizing and replying. Exact events retain their bounded synchronous presenter.
- After readiness awaits: recheck `needsMaterialization` in consuming frame. Successful drains join later work; failed refreshes retain dirty keys until next signal/read.
- Queued events capture generation before awaits; reject replaced identities before publication. Keyed mutations share per-connection snapshot presenter; broad invalidations stay keyless. Authorized incognito describe/history/resolve/event reads consume committed memory actor facts outside the roster. Retain the selected actor and check live disclosure authority at publication; no database generations or currency probes.
- Incognito uses the session actor memory backend, with no SQLite database or worker. Existing-only reads never create state; explicit creation uses the same owner. Read requested transcript fields and bounded child metadata through actor operations with shared authorization. Exclude incognito from durable discovery and the resident roster. Session close plus transport teardown ends authority; work already handed to a transport may finish during close.
- Cancellation receipts: prepare within kill hold, revalidate run/session generation, publish synchronously before release. Coalesce ordinary events.
- Ingestion never waits for enrichment: tool/progress consumers capture replies before completion. Optional tool-row metadata may be absent while dirty; full lifecycle publications await readiness.
- Carry physical store ownership into transcript/title/usage reads independently of logical model/visibility policy. Reuse prepared fallback models.
- Authorize events from committed sharing metadata/membership snapshots independently of full rows. `sessions.changed`/`session.message` await display readiness. Synchronous board/progress/suggestion events: neither query SQLite nor lose authorized delivery while dirty; publish member revocations first.

## Verification

- Session-creation publication ownership/restart-delivery custody changes: prove public `sessions.create` in isolated Gateway with explicit non-main session, then post-publication read/turn. Creation-helper tests alone ≠ flow proof.
- Trusted changes: local touched tests (`pnpm test <file> --maxWorkers=1`) + targeted typecheck/lint/format; measure affected Gateway test time before/after. Lazy-loading/bundled-plugin artifact changes: `pnpm build`.
- Root proof policy: broad proof via PR CI; boxes only for otherwise unavailable coverage with immediate admission. No queue waits, provider fallbacks, reruns/re-pushes just for green. Before attributing red: read CI failure classification.
