# Control UI Guide

## Solid

- Before writing, reviewing, or refactoring any Solid code here, read the [Solid skill](../.agents/skills/solid/SKILL.md) in full, the installed `node_modules/solid-js/CHEATSHEET.md` it points to, and the references it routes you to; for existing code, the [refactor checklist](../.agents/skills/solid/references/refactor-checklist.md). State ownership below still applies.

The Control UI and its plugin views use Solid 2 and native primitives; never add Lit or Web Awesome.

Solid route modules expose `renderSolid(props)` from the existing lazy page import.
The outlet mounts that renderer once and supplies live `data`, `loaderPending`, and
`presented` props; loader updates must preserve page-local state. Keep page
imports inside their route's `component` loader.

## State Ownership And Async Results

- Gateway owns shared state; renderer copies = caches; views own presentation state. Reuse owning store/controller + Gateway contract for session, config, authorization decisions.
- Scope caches/requests to connection, agent, session. Before publishing: check owner + request generation; old results must not overwrite newer intent/another context.
- Optimistic updates: retain visible recovery state + reconcile with authority. Old requests must not roll back newer edits. Failed writes follow Gateway [target and outcome contract](../src/gateway/AGENTS.md#write-target-and-outcome), never renderer-selected fallback account/connection.
- Background updates may refresh scoped cache, never replace foreground selection/publish another context's state.

## Session Roster Refresh

- `src/lib/sessions/session-list-query.ts` owns held-window reconciliation. Lifecycle, participants, placement, patch/send/steer, run-start/settlement/capacity, title snapshots may skip list reads only with unchanged membership, lineage, pin/owner/archive facts + nondecreasing recency. Tree events: complete access-scoped `ancestorSessions` + any `ancestorSessionRefs`; references need held row's admitted content revision. Preserve each row's generation + field receipts. Certified nested rows own facts; only explicit null clearing receipts may fill omissions from envelope.
- Authoritative refreshes required: unknown rows, incomplete ancestor coverage, broad/catalog changes, Gateway-owned filters, failed reads, uncertain owner-prefix boundaries. Overlapping reads recheck later row receipts against their accepted membership; covered facts merge without trailing reads. Events never create filtered membership; only complete unfiltered active-only Current Work windows may admit certified full active rows below.
- Sidebar windows may exclude certified rows below a full recency window; owned rows must also fall below the bounded owner prefix. Owner-first overflow crossing into the shared page still needs authority. The connection's decoded row cache expands matching ancestor references without advancing wire baselines; evicted or mismatched references retain authoritative refresh behavior. Involving-me members need current viewer ownership or participant receipts and explicit non-hidden state; bounded participants cannot prove non-membership or admit unseen members.
- Compact rows + bounded source attribution. Enrichment flags/global-or-unknown inclusion preserve membership when kind unchanged; dashboard filters need matching `hasBoard`/`boardFace` receipts. Gallery pagination extends shared managed window; load full settings from descriptors on demand. Child membership: Gateway retention owner's `childOwnerSessionKeys`. Parent-only events must certify complete child window; unheld ancestors need explicit exclusion or admitted reference resolved through connection row provenance.
- Cached lineage re-adoption changes presentation, not managed membership. Preserve fresh descriptor/event invalidation. Apply admitted descriptor rows immediately; incomplete ancestor coverage gets one paced coordinator refresh, never read per event.
- Unfiltered History/Current Work: apply admitted rows without list refetches. History's shared row-provenance owner retains field clocks, recap updates, clearing receipts; returned lists alone own membership. `excludeSubagents` ignores key-proven child exclusions only with complete access-scoped ancestor coverage; held parents/certified references still update. Missing held parents/supplied unheld ancestors need authority; named unheld parents absent from certified coverage may be invisible. Merge live facts on refresh, never replay/coalesce History packets. Missing initial membership needs catch-up; query/connection changes reset provenance. History: forward activity clocks required; preserve omitted recap enrichment; person/search filters retain authoritative refreshes.
- Current Work: coalesce only consecutive full active snapshots of one generation, retaining first receipt/latest tail. Partial events, references, terminal snapshots, other identities = FIFO barriers. Complete window below limit may admit certified active row with real session ID/kind, sampled after accepted list + generation retirement/liveness clocks; preserve Gateway cron-run exclusion. Truncated/full windows, conflicting generations, partial unknown rows, ambiguous settlement, incomplete-window removals need authority.
- Current Work: apply ancestor snapshots/references via shared reconciler; pending references retain prerequisite full-row receipts. Controller caps generation-coalesced fence records at 1,000; reconciler owns independent retirement, liveness-observation, generation-authority facts. Only retirement prunes stale returned rows. Fresh certified full rows may resolve older clocked liveness; unclocked observations/conflicting generations need list read. Query/connection changes clear records. Authoritative lists clear uncertainty + covered retirements before pending replay, preserving later retirements. Saturation blocks unseen admission until authoritative read restores bounded state.
- Healthy applied roster row traffic does not schedule a fallback list read. Activity retains its 60-second fallback for whole-query people/pulse facets. `src/lib/sessions/event-refresh-coordinator.ts` owns pacing + pending/trailing invalidation: sample four-to-five-second collection window once when armed; events cannot postpone it. After automatic refresh: wait three times its duration, bounded to five–15 seconds.
- Accepted local creates refresh observed list membership independently of primary reads/bootstrap. Remote create events use coordinator collection/backoff with other invalidations; the Gateway still owns owner/involvement/search filtering. Retain visibility, bootstrap admission, and queued navigation ownership.
- Explicit refresh, filter/agent changes, reconnects, foreground replacement bypass backoff + absorb pending invalidation. Recheck visibility/current intent after background admission; hidden pages retain one catch-up until visible.

## Reload Performance

- Reload cost is main-thread render/reconcile triggered per Gateway message; JSON parse and transport are negligible. Measured no win or regressions (2026-10-15, Team-scale bench, quiet AWS, ≥7 interleaved pairs): socket worker/SharedWorker, delivery scheduling/chunking, batched boot RPC, V8 compile hints/chunk sizing, cached DOM shell replay. WebSocket permessage-deflate saves bytes on slow links, not render time. Retry only with new evidence.
- Cut work at its owner: memoize values read per item (`createMemo`), render reused UI as components rather than helper calls, keep row identity through placement/history/live updates, check cheap state before reading layout.
- Measure with `scripts/bench-control-ui-cold-load.ts` (long-task and render-pass probes) over several untraced runs; single DevTools traces inflate timing. Confirm the hot function with `--cpu-profile` first; never mix profiled and unprofiled timings.

## i18n Rules

- Foreign `src/i18n/locales/*.ts` = stable source-owned lazy adapters; translations from canonical grouped `src/i18n/.i18n/*.tm.jsonl`. Never hand-edit translation memory, locale/fallback metadata unless targeted generated-output fix requested.
- English: `src/i18n/locales/en.ts`, static `en-agents.ts`, lazy `en-*.ts` registrars. `scripts/lib/control-ui-i18n-catalog.ts` owns ordered composition + raw source hashes for generation, verification, Vite; reads `.catalog` data without runtime registration. Wiring owners: `scripts/control-ui-i18n.ts`, `scripts/lib/control-ui-i18n-sync-plan.ts`, `ui/config/control-ui-locales.ts`, `ui/src/i18n/lib/{types,registry}.ts`.
- Standalone reader English: `src/shared/public-session-copy.ts` (the `publicReader` namespace in the catalog owner above). `scripts/lib/public-session-locales.mts` projects reader-only dictionaries from canonical memory into Gateway builds; source execution and untranslated keys use English. No runtime filesystem reads or separate foreign reader catalogs.
- `src/shared/control-ui-locale.ts` owns supported locales, ordered browser-language matching, and direction for UI and public reader; UI registry owns only lazy imports.
- Register lazy English synchronously at each consumer, including Settings search before page load. Keep startup/shared copy eager; preserve shared `en` + sibling namespaces. Retain empty subtree anchors when extraction changes flattened order/grouped memory aliases. Never import host catalog owner into runtime.
- Source PRs: update English/adapters/wiring, run keyless `pnpm ui:i18n:baseline`, commit changed raw-copy baseline. Exclude fallback/locale metadata + translation memory: CI rejects mixed diffs except canonical `release/YYYY.M.PATCH` branches or detected complete canonical-memory migrations.
- Deterministic keyless `pnpm ui:i18n:verify`: English shape, runtime wiring, raw-copy drift in lint/changed-check UI. Foreign parity: post-merge bot + strict generated-output gate.
- Foreign drift: the `control-ui-locale-refresh` workflow or release prep fixes it; never translate by hand or merge generated locale output.

## CSS / Template Linting

- `pnpm lint`: Solid 2 oxlint rules on `ui/**/*.tsx` and TypeScript helpers in `src/lib/reactive/`, `src/components/solid/`, and `src/test-helpers/`; plain domain owners keep their own contracts. Follow the [Solid idioms](../.agents/skills/solid/references/idioms.md) for split effects, tracking, and lifecycle. `tools/solid-lint` isolates plugin tooling dependencies; corpus: `test/scripts/oxlint-solid.test.ts`.
- `pnpm lint:ui:styles` (included in lint): `ui/src` stylesheets via `config/stylelint.config.mjs`. Stylelint owns error rules; oxfmt owns formatting.

## Stylesheet Policy

- `:has()` limits: stylelint's `selector-disallowed-list` enforces them on raw selectors (config comments say why). Apply the same limits by hand to nested `&` selectors, which stylelint cannot resolve.
- New-tab links/controls: pointer cursors; state-changing controls: default arrow.
- Colors: use `src/styles/base.css` tokens.
- Breakpoints: stylelint's allowed list owns the ladder; add a rung only in config, with a comment.
- `node --import ./scripts/tsx.mjs scripts/audit-control-ui-dead-css.mts` advisory. Verify selectors before deleting; extend dynamic-stem detection, not allowlist.
- Nest CSS only while rewriting section; no conversion sweeps.
- No `@layer`: shared light-DOM CSS depends on import order/specificity + lazy page CSS. Reconsider only with computed-style parity across all routes on mocked dev server.

## Modal Completion Actions

- Place workflow completion actions last in `<openclaw-modal-actions>`, after content, status and validation errors. The native modal stylesheet owns right alignment, wrapping and label containment. Keep submit buttons inside their native form; no renderer or custom-element registration is needed. Caller styles own spacing, not competing alignment or mobile full-width rules. Header X/Expand and field-local controls are not completion actions. Scrollable panels respect `--openclaw-modal-height-limit` so the footer stays reachable. Set the intended width with `--openclaw-modal-width` on the native host and let child panels fill the shell instead of imposing a wider independent width.

## Gateway Coupling

- UI/Gateway ship as one install/version. Never older-Gateway method fallbacks/version-conditional UI behavior. `isGatewayMethodAdvertised` only gates config/plugin-dependent features.
- Handshake rejects Gateway-served same-origin skew. Exempt `pnpm ui:dev`, custom `gateway.controlUi.root`, cross-origin/connection-settings dialing remain unsupported for mismatch: no compat, visible failure at first missing method. Rejection at connect = separate server-owned product change.

## Build Chunking

- Generated `config/control-ui-boot-modules.json` records ready `/new` + `/chat` captures: fetched modules reachable from HTML/requested dynamic entries, static imports, dynamic imports resolving into fetched chunks. Keep route-exclusive/shared `control-ui-boot-*` groups separate in `config/control-ui-chunking.ts`; co-located chat-only code must stay out of New Session. `entries` lists requested dynamic entries; `config/control-ui-boot-preloads.ts` follows static dependencies into inert route preload templates activated by Gateway. CSS hints preload bytes without changing insertion order.
- Material boot-path changes: `pnpm ui:boot-manifest:gen`, then `pnpm ui:build` to verify grouped output. Generation: temporary build with measured groups disabled/inactive templates, preventing stale-capture feedback. Never hand-edit manifest.

## Live Verification

- Gateway serves `dist/control-ui`; source edits need `pnpm ui:build`. Before trusting live result: verify served `/assets/index-*.js` hash changed.

## Visual Proof

- Large design changes: run the [UI stress test](../.agents/skills/control-ui-e2e/SKILL.md#ui-stress-test).
- Never capture the retired Discord invitation artwork. Mock/E2E harnesses default to `communityInvite: false`; compact Community entry scenarios opt in with `communityInvite: true`. Capture only the current entry and on-demand sheet, with synthetic content.
