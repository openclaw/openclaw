# Control UI Guide

Keep UI ownership rules here; repo-global architecture, proof, and Git rules stay in root `AGENTS.md`.

## Solid migration

For Lit 3/Web Awesome ports and Solid 2 components or projections, follow the
[Solid skill](../.agents/skills/solid/SKILL.md) and assigned migration order for
conversion, lifecycle, interop, and proof. State ownership below still applies.
Remove Lit-specific guidance with the final Lit sweep.

## State Ownership And Async Results

- The Gateway owns shared state; renderer copies are caches, and views own presentation state. Reuse the owning store/controller and Gateway contract for session, config, and authorization decisions.
- Scope caches and requests to their connection, agent, and session. Before publishing, check the owner and request generation; old results must not overwrite newer intent or another context.
- Optimistic updates retain visible recovery state and reconcile with authority. Old requests must not roll back newer edits. Failed writes follow the Gateway's [target and outcome contract](../src/gateway/AGENTS.md#write-target-and-outcome), never a renderer-selected fallback account/connection.
- Background updates may refresh their scoped cache, never replace foreground selection or publish another context's state.

## Session Roster Refresh

- `src/lib/sessions/session-list-query.ts` owns held-window reconciliation. Lifecycle, participants, placement, patch/send/steer, run-start/settlement/capacity, and title snapshots may skip list reads only with unchanged membership, lineage, pin/owner/archive facts, and nondecreasing recency. Tree events need complete access-scoped `ancestorSessions` and any `ancestorSessionRefs`; references need the held row's admitted content revision. Preserve each row's generation and field receipts. Certified nested rows own their facts; only explicit null clearing receipts may fill omissions from the envelope.
- Keep authoritative refreshes for unknown rows, incomplete ancestor coverage, broad/catalog changes, Gateway-owned filters, failed/overlapping reads, and uncertain owner-prefix boundaries. Events never create filtered membership; only complete unfiltered active-only Current Work windows may admit certified full active rows below.
- Use compact rows and bounded source attribution. Enrichment flags/global-or-unknown inclusion preserve membership when kind is unchanged; dashboard filters need matching `hasBoard`/`boardFace` receipts. Gallery pagination extends the shared managed window; load full settings from descriptors on demand. Child membership uses the Gateway retention owner's `childOwnerSessionKeys`. Parent-only events must certify the complete child window; unheld ancestors need explicit exclusion or an admitted reference resolved through connection row provenance.
- Cached lineage re-adoption changes presentation, not managed membership. Preserve fresh descriptor/event invalidation. Apply admitted descriptor rows immediately; incomplete ancestor coverage gets one paced coordinator refresh, never a read per event.
- Unfiltered History and Current Work apply admitted rows without list refetches. History's shared row-provenance owner retains field clocks, recap updates, and clearing receipts; returned lists alone own membership. `excludeSubagents` ignores key-proven child exclusions only with complete access-scoped ancestor coverage; held parents and certified references still update. Missing held parents or supplied unheld ancestors need authority; named unheld parents absent from certified coverage may be invisible. Merge live facts on refresh, never replay/coalesce History packets. Missing initial membership needs catch-up; query/connection changes reset provenance. History requires forward activity clocks and preserves omitted recap enrichment; person/search filters retain authoritative refreshes.
- Current Work coalesces only consecutive full active snapshots of one generation, retaining first receipt/latest tail. Partial events, references, terminal snapshots, and other identities are FIFO barriers. A complete window below its limit may admit a certified active row with real session ID/kind, sampled after the accepted list and generation retirement/liveness clocks; preserve Gateway cron-run exclusion. Truncated/full windows, conflicting generations, partial unknown rows, ambiguous settlement, and incomplete-window removals need authority.
- Current Work applies ancestor snapshots/references through the shared reconciler; pending references retain prerequisite full-row receipts. Its controller caps generation-coalesced fence records at 1,000; the reconciler owns independent retirement, liveness-observation, and generation-authority facts. Only retirement prunes stale returned rows. Fresh certified full rows may resolve older clocked liveness; unclocked observations/conflicting generations need a list read. Query/connection changes clear records. Authoritative lists clear uncertainty and covered retirements before pending replay, preserving later retirements. Saturation blocks unseen admission until an authoritative read restores bounded state.
- Healthy applied row traffic retains one fallback refresh after at least 60 seconds, including whole-query people/pulse facets. `src/lib/sessions/event-refresh-coordinator.ts` owns pacing and pending/trailing invalidation: sample a four-to-five-second collection window once when armed; events cannot postpone it. After automatic refresh, wait three times its duration, bounded to five–15 seconds.
- Explicit refresh, filter/agent changes, reconnects, and foreground replacement bypass backoff and absorb pending invalidation. Recheck visibility/current intent after background admission; hidden pages retain one catch-up until visible.

## i18n Rules

- Foreign `src/i18n/locales/*.ts` files are stable source-owned lazy adapters; translations come from canonical grouped `src/i18n/.i18n/*.tm.jsonl`. Never hand-edit translation memory, locale/fallback metadata unless a targeted generated-output fix is requested.
- English lives in `src/i18n/locales/en.ts`, static `en-agents.ts`, and lazy `en-*.ts` registrars. `scripts/lib/control-ui-i18n-catalog.ts` owns ordered composition and raw source hashes for generation, verification, and Vite; it reads `.catalog` data without runtime registration. Wiring owners: `scripts/control-ui-i18n.ts`, `scripts/lib/control-ui-i18n-sync-plan.ts`, `ui/config/control-ui-locales.ts`, and `ui/src/i18n/lib/{types,registry}.ts`.
- Register lazy English synchronously at each consumer, including Settings search before page load. Keep startup/shared copy eager; preserve shared `en` and sibling namespaces. Retain empty subtree anchors when extraction changes flattened order/grouped memory aliases. Never import the host catalog owner into runtime.
- Source PRs update English/adapters/wiring, run keyless `pnpm ui:i18n:baseline`, and commit changed raw-copy baseline. Exclude fallback/locale metadata and translation memory: CI rejects mixed diffs except canonical `release/YYYY.M.PATCH` branches or detected complete canonical-memory migrations.
- Deterministic, keyless `pnpm ui:i18n:verify` checks English shape, runtime wiring, and raw-copy drift in lint/changed-check UI. Foreign parity belongs to the post-merge bot and strict generated-output gate.
- Serialized `control-ui-locale-refresh` translates after merge and opens a generated PR with exact-head auto-merge. Authenticated `pnpm ui:i18n:sync` is the maintainer/release repair path; new keys require provider auth. For drift, use the workflow or release prep, never manual translation/merging of generated outputs.
- `pnpm release:prep` syncs before freeze; `pnpm ui:i18n:check` is the zero-fallback release/generated-output gate. `pnpm ui:i18n:report` reports hardcoded-copy priorities and fallback metadata, not drift.

## CSS / Template Linting

- `pnpm lint` applies Solid 2 oxlint rules to `ui/**/*.tsx`; use split effects and follow the [Solid skill](../.agents/skills/solid/SKILL.md#traps-that-compile-but-break). `tools/solid-lint` isolates plugin tooling dependencies; its corpus is `test/scripts/oxlint-solid.test.ts`.
- `pnpm lint:ui:styles` (included in lint) checks `ui/src` stylesheets and Lit CSS templates through `config/stylelint.config.mjs`/postcss-lit. Stylelint owns error rules; oxfmt owns formatting.
- Shared 24×24 Lucide icons use `strokeIcon()` in `src/components/icons-tools.ts` for inline stroke attributes inside shadow roots. Bodies must be `svg` template fragments, never `html` (wrong namespace).
- `pnpm lint:ui:lit` is a slow opt-in template diagnostic with existing findings, not a CI gate.

## Stylesheet Policy

- No universal targets/pseudo-elements after a `:has()` compound, `:has()` with `::placeholder`, or descendants after sibling-relative `:has(+ …)` on repeated items. Use owner-set classes, named children, or a custom property on the subject. No `:has()` subjects on `.shell`, `.content`, `.chat-thread`, `.chat-split-view`, `:root`, `html`, or `body`, including modifiers, `:is()`/`:where()`, and nested `&`: insertions restyle their subtree; stylelint cannot resolve nesting. Third-party global CSS uses Vite PostCSS; `config/control-ui-web-awesome-page-rule.ts` drops Web Awesome's never-matching `:is(html, body):has(wa-page)` rule.
- New-tab links/controls use pointer cursors; state-changing controls keep the default arrow.
- Colors use `src/styles/base.css` tokens (`color-no-hex`). Token definitions, `lobster-pet.css` artwork, and `--theme-chip-*` previews have stated exemptions. Prefer tokens in currently ungated Lit CSS templates too.
- `max-width` breakpoints use 400/560/640/768/900/1100/1320px, plus the 932×500 landscape-phone compound. Round new thresholds up; new rungs require updating the config comment and this rule.
- Duplicate selectors are errors; deliberate topic reopens need `stylelint-disable-next-line no-duplicate-selectors -- <reason>`.
- `node --import tsx scripts/audit-control-ui-dead-css.mts` is advisory. Verify selectors before deleting; extend dynamic-stem detection instead of its allowlist.
- Nest CSS only while rewriting a section; no conversion sweeps.
- No `@layer`: shared light-DOM CSS depends on import order/specificity and lazy page CSS. Reconsider only with computed-style parity across all routes on the mocked dev server.

## Gateway Coupling

- UI and Gateway ship as one install/version. Never add older-Gateway method fallbacks or version-conditional UI behavior. `isGatewayMethodAdvertised` only gates config/plugin-dependent features.
- The handshake rejects Gateway-served same-origin skew. Exempt `pnpm ui:dev`, custom `gateway.controlUi.root`, and cross-origin/connection-settings dialing remain unsupported for mismatch: no compat, visible failure at the first missing method. Rejecting them at connect is a separate server-owned product change.

## Build Chunking

- Generated `config/control-ui-boot-modules.json` records ready `/new` and `/chat` captures: fetched modules reachable from HTML/requested dynamic entries, static imports, and dynamic imports resolving into fetched chunks. Keep route-exclusive/shared `control-ui-boot-*` groups separate in `config/control-ui-chunking.ts`; co-located chat-only code must stay out of New Session. `entries` lists requested dynamic entries; `config/control-ui-boot-preloads.ts` follows their static dependencies into inert route preload templates activated by the Gateway. CSS hints preload bytes without changing insertion order.
- For material boot-path changes, run `pnpm ui:boot-manifest:gen`, then `pnpm ui:build` to verify grouped output. Generation uses a temporary build with measured groups disabled/inactive templates to prevent stale-capture feedback. Never hand-edit the manifest.

## Live Verification

- The Gateway serves `dist/control-ui`; source edits need `pnpm ui:build`. Verify the served `/assets/index-*.js` hash changed before trusting a live result.

## Scope

- Keep UI-specific rules here; root `AGENTS.md` owns repo-global workflow.

## Visual Proof

- Substantial UI design changes follow the [Control UI stress test](../.agents/skills/control-ui-e2e/SKILL.md#ui-stress-test): inspect states in an HTML gallery and collect per-example feedback.
- Never capture the Discord invitation card. Mock/E2E harnesses seed canonical browser dismissal; invitation tests may use `communityInviteDismissed: false` without screenshots/videos.
