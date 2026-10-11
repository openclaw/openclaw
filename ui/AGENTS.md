# Control UI Guide

This directory owns Control UI-specific guidance that should not live in the repo root.

## Solid migration

For Lit 3/Web Awesome ports and new Solid 2 components or projections, follow the
[Solid skill](../.agents/skills/solid/SKILL.md) and the
assigned migration work order. It owns conversion, lifecycle, interop, and proof
guidance. The state-ownership rules below still apply. The browser floor is in place;
the Lit-specific guidance below goes with the final Lit sweep.

Solid route modules expose `renderSolid(props)` from the existing lazy page import.
The outlet mounts that renderer once and supplies live `data`, `loaderPending`, and
`presented` props; loader updates must preserve page-local state. Unported route
modules keep `render`. Keep page imports inside their route's `component` loader.

## State Ownership And Async Results

- The Gateway owns shared state that other clients or channels can change.
  Renderer copies are caches; local presentation state belongs to the view. Reuse the
  owning store or controller and Gateway contract instead of implementing session,
  configuration, or authorization decisions again in the UI.
- Scope cached data and in-flight requests to the actual connection, agent, and
  session they concern. Before publishing a result, check that its owner and
  request generation are still current. A late result from a prior context must
  not replace newer intent or populate the newly selected context.
- Optimistic updates retain enough state for visible recovery, then reconcile
  with the authoritative result. An old request must not roll back a newer edit.
  Failed writes follow the Gateway's
  [target and outcome contract](../src/gateway/AGENTS.md#write-target-and-outcome),
  not a fallback account or connection selected by the renderer.
- Background updates may refresh their own scoped cache; they must not replace
  the foreground selection or publish another context's state into its view.

## Session Roster Refresh

- Session rosters apply nested Gateway row snapshots through the shared reconciler.
  `lib/sessions/session-list-query.ts` owns whether a snapshot preserves a held
  window: lifecycle, participants, placement, patch/send/steer, run-start/settlement/capacity, and title
  updates can avoid list reads when membership, lineage, and pin/owner/archive
  facts stay unchanged and recency does not move backwards. Tree events require
  the Gateway's complete, access-scoped `ancestorSessions` snapshots plus any
  `ancestorSessionRefs`; references require the held row's admitted content revision. Each row
  retains its own generation and field receipts. Certified nested rows own their
  facts; only explicit null clearing receipts may fill omissions from the event
  envelope. Unknown rows, incomplete ancestor coverage, broad changes, catalog
  changes, Gateway-owned filters, failed reads,
  owner-prefix boundary uncertainty, and overlapping reads retain an authoritative
  refresh. Events never create filtered list membership; Current Work's complete
  unfiltered active-only window may admit a certified full active row as described below.
- List callers use compact rows and bounded source attribution. Enrichment flags
  and inclusion of global/unknown kinds do not change held membership when kind
  stays unchanged; dashboard filters require matching `hasBoard`/`boardFace`
  receipts. Gallery pagination extends the shared managed window. Full settings
  come from row descriptors on demand. Applied row traffic retains one fallback
  through the refresh coordinator after at least 60 seconds.
  Child-query membership uses `childOwnerSessionKeys` from the Gateway's retention
  owner. Parent-only events must certify the complete child window; unheld
  ancestors need explicit exclusion facts, or an admitted reference resolved
  through the connection's existing row provenance.
- Re-adopting cached lineage rows changes presentation without invalidating
  managed list membership. Fresh descriptor reads and Gateway events retain
  their authoritative invalidation paths.
- Descriptor observations apply admitted rows immediately; incomplete ancestor coverage retains one paced authoritative descriptor refresh through the coordinator instead of a read per event.
- Activity's current-work and unfiltered history views apply admitted row events without refetching the list.
  History uses the shared row-provenance owner: admitted live rows retain field clocks,
  including recap updates and clearing receipts, while returned lists remain the sole
  membership authority. Its `excludeSubagents` query ignores key-proven child exclusions
  only with complete access-scoped ancestor coverage; held parent snapshots and certified
  references still update locally. Missing held parents or supplied unheld ancestors
  require authority; named unheld parents absent from certified coverage may be invisible.
  Refreshes merge those live facts instead of replaying/coalescing
  History packets; missing initial membership retains a catch-up read. Query/connection
  changes reset provenance. Current Work coalesces only consecutive full active snapshots
  for one generation, retaining the first receipt and latest tail. Partial events,
  references, terminal snapshots, and other identities are FIFO barriers. A complete Current Work window below its limit
  admits a certified active snapshot sampled after the accepted list and that session
  generation's observed retirement and liveness clocks, with a real session ID and kind, preserving
  the Gateway's cron-run exclusion. Truncated/full windows, conflicting generations,
  partial unknown rows, ambiguous settlement, and removals from an incomplete window require an authoritative
  refresh. History requires forward activity clocks and retains omitted recap enrichment;
  person/search filters keep authoritative refreshes. Healthy row traffic retains one
  fallback refresh after at least 60 seconds, including whole-query people and pulse facets.
  Current Work applies supplied ancestor snapshots and references through the shared
  row reconciler; pending references retain their prerequisite full row receipts.
  Its controller retains at most 1,000 fence records, coalesced by session generation;
  the Current Work reconciler owns their independent retirement, liveness-observation,
  and generation-authority facts. Only retirements prune stale returned rows. A fresh
  certified full row can resolve older clocked liveness, while unclocked observations
  and conflicting generations require a list read. Query/connection changes clear
  records; an authoritative list clears uncertainty and covered retirements before
  pending events replay, preserving later retirements. Saturation blocks
  unseen admission until an authoritative read restores the bounded state.
- `lib/sessions/event-refresh-coordinator.ts` owns automatic refresh pacing:
  collect events in a four-to-five-second window sampled once when armed so
  browsers spread their reads and subsequent events cannot postpone them.
  After each automatic refresh, wait three times its duration
  (at least five seconds, at most 15 seconds) before the next automatic read.
  Trailing invalidation stays with that owner, including while a request is pending.
- Explicit refreshes, filter/agent changes, reconnects, and foreground replacements
  bypass event backoff and absorb pending invalidation. Recheck visibility and
  current intent after background admission; hidden pages retain one catch-up
  refresh until visible.

## i18n Rules

- Foreign-language files in `ui/src/i18n/locales/*.ts` are stable, source-owned lazy-module adapters; their translations are generated from canonical grouped memory in `ui/src/i18n/.i18n/*.tm.jsonl`.
- Do not hand-edit translation memory, locale metadata, or fallback metadata unless a targeted generated-output fix is explicitly requested.
- English source lives in `ui/src/i18n/locales/en.ts`, its static `en-agents.ts` dependency, and lazy `en-*.ts` registrar catalogs. `scripts/lib/control-ui-i18n-catalog.ts` owns complete ordered composition and raw source-hash dependencies for generation, verification, and Vite; it reads `.catalog` data without runtime registration. Related wiring:
  - `scripts/control-ui-i18n.ts`
  - `scripts/lib/control-ui-i18n-catalog.ts`
  - `scripts/lib/control-ui-i18n-sync-plan.ts`
  - `ui/config/control-ui-locales.ts`
  - `ui/src/i18n/lib/types.ts`
  - `ui/src/i18n/lib/registry.ts`
- Register lazy English synchronously at each lazy consumer, including Settings search before a destination page loads. Keep startup/shared copy eager. Preserve the shared `en` object and sibling namespaces; leave empty whole-subtree anchors in `en.ts` when extraction would change flattened source order and grouped translation-memory aliases. Never import the host-only catalog owner into the runtime.
- Contributor flow: update English strings and locale adapters/wiring, run keyless `pnpm ui:i18n:baseline`, and commit source files plus any changed raw-copy baseline. Do not include catalog fallback metadata, locale metadata, or translation memory in a source PR; CI rejects mixed source/generated diffs outside canonical `release/YYYY.M.PATCH` branches or an explicitly detected complete canonical-memory ownership migration.
- `pnpm ui:i18n:verify` is deterministic and keyless. `pnpm lint` and the changed-check UI lane run it. It validates English catalog shape, runtime locale wiring, and raw-copy baseline drift; foreign catalog parity belongs to the post-merge bot and strict generated-output gate.
- Translation flow: the serialized `control-ui-locale-refresh` workflow translates after merge, opens an isolated generated PR, and enables auto-merge for its exact head. `pnpm ui:i18n:sync` remains the authenticated maintainer/release repair path; do not run it without provider auth when new keys exist.
- `pnpm release:prep` runs the locale sync before release freeze, then `pnpm ui:i18n:check` remains the strict generated-output/release gate with zero fallbacks.
- Prioritization report: `pnpm ui:i18n:report [--surface <name>] [--locale <locale>] [--top <n>]` shows current hardcoded-copy focus areas and locale fallback metadata. It is not a drift gate; use `pnpm ui:i18n:check` for that.
- If locale outputs drift, let the workflow reconcile them or run release prep. Do not manually translate, merge, or hand-maintain generated translation memory or locale metadata.

## CSS / Template Linting

- `pnpm lint` applies `eslint-plugin-solid`'s Solid 2 rules to `ui/**/*.tsx` through oxlint. Never destructure component props; use split effects, current Solid APIs, and `prop:` for explicit DOM properties. The private `tools/solid-lint` workspace isolates the plugin's TypeScript 5.9 tooling dependencies from the repository's TypeScript 7 checker. Its positive/negative corpus runs with `pnpm test test/scripts/oxlint-solid.test.ts --maxWorkers=1`.
- `pnpm lint:ui:styles` runs stylelint over `ui/src` stylesheets and Lit `css` templates in TypeScript and TSX (postcss-lit). `pnpm lint` includes it; error-class rules only, oxfmt owns formatting. Config: `config/stylelint.config.mjs`.
- Icons: shared 24x24 Lucide icons go through `strokeIcon()` in `ui/src/components/icons-tools.ts` so stroke presentation attributes stay inline and render inside shadow roots. Icon bodies are `svg\`\``fragments, never`html\`\`` (wrong namespace renders nothing).
- `pnpm lint:ui:lit` is an opt-in lit-analyzer diagnostic for template bindings (slow, ~9 min; known baseline of pre-existing findings). It is not a CI gate.

## Stylesheet Policy

- No universal targets or pseudo-elements after a `:has()` compound, no `:has()` with `::placeholder` (measured ~9/~8 ms subtree restyles per insertion with 534 messages), and no descendant after a sibling-relative `:has(+ …)` on repeated items (it restyled every position-rail tick per transcript row); use owner-set classes, named children, or a custom property on the `:has()` subject. Stylelint enforces these. No `:has()` on `.shell`, `.content`, `.chat-thread`, `.chat-split-view`, `:root`, `html`, or `body` compounds, including modifiers, `:is()`/`:where()` list subjects, and nested `&` forms: every insertion below a `:has()` subject schedules a global `:has` restyle of that subtree (stylelint cannot resolve nesting). Third-party global CSS goes through the Vite PostCSS pipeline; `ui/config/control-ui-web-awesome-page-rule.ts` drops Web Awesome's never-matching `:is(html, body):has(wa-page)` rule.
- Cursors: links and controls that open a new tab use the pointer; state-changing controls keep the default arrow.
- Colors: stylesheet colors flow through custom-property tokens defined in `ui/src/styles/base.css`; `color-no-hex` enforces this. Exempt surfaces (token definitions, `lobster-pet.css` sprite artwork, `--theme-chip-*` preview swatches) each carry a stated contract. Lit `css\`\`` templates are not yet gated — prefer tokens there too.
- Breakpoints: `max-width` media conditions use the canonical ladder 400/560/640/768/900/1100/1320px (plus the 932×500 landscape-phone compound); stylelint's allowed-list enforces it. New thresholds round up to the next rung. Don't add rungs without updating the config comment and this note.
- Duplicate selectors are lint errors; deliberate topic-section reopens use `stylelint-disable-next-line no-duplicate-selectors -- <reason>`.
- Dead CSS: `node --import tsx scripts/audit-control-ui-dead-css.mts` reports class selectors with no production reference (AST-based, understands `X--${...}` stems and `classMap`). Advisory, not a gate — verify by hand before deleting; extend the script's stem detection rather than its allowlist when it misses a dynamic family.
- Native CSS nesting: opportunistic only — nest when already rewriting a section; no conversion sweeps.
- `@layer` is deliberately not used: the shared light-DOM stylesheet's precedence relies on import order plus specificity, page CSS imports lazily per component, and measured `no-descending-specificity` hits are within-file — layering the import manifest would flip unlayered-vs-layered precedence across ~48 lazily imported page files for no measured win. Revisit only with computed-style parity proof across all routes on the mocked dev server (PR #123156/#123160 show the evidence pattern).

## Gateway Coupling

- The Control UI ships from and with its Gateway: one install, one version (product decision, 2026-08-16). UI code never carries gateway-version compatibility — no fallbacks to older methods when a current core method is missing, no version-conditional behavior for older gateways.
- Method-advertisement checks (`isGatewayMethodAdvertised`) remain only as feature gates for config/plugin-dependent surfaces, never as version compat.
- The handshake rejects gateway-served same-origin skew. The admission-exempt paths (`pnpm ui:dev`, custom `gateway.controlUi.root`, cross-origin/connection-settings dialing) are unsupported for version mismatch without enforcement: they carry no compat code and fail visibly at the first missing method, by design. Tightening admission to reject them at connect is a server-side product change owned separately.

## Build Chunking

- `ui/config/control-ui-boot-modules.json` is generated from ready `/new` and `/chat` captures. Each route records only fetched modules reachable from the HTML entry and the dynamic entries it requested (static imports, plus dynamic imports that resolve into an already-fetched chunk without a request), so chat-only code co-located in a fetched common chunk stays out of New Session. Shared modules and each route's exclusive modules get separate `control-ui-boot-*` groups in `ui/config/control-ui-chunking.ts`, reducing requests without pulling chat-only code into New Session. Its `entries` record contains the dynamic entry points actually requested by each route; `control-ui-boot-preloads.ts` follows their static dependencies to emit inert route preload templates, which the Gateway activates for the requested route. CSS hints preload bytes without changing stylesheet insertion order. Regenerate with `pnpm ui:boot-manifest:gen` when boot-path surfaces change materially; it builds into a temporary directory with all measured boot groups disabled and inactive preload templates so stale entries cannot feed back into the capture. Rebuild with `pnpm ui:build` afterward to verify grouped output. Do not hand-edit the manifest.

## Live Verification

- The Gateway serves the prebuilt bundle from `dist/control-ui`; editing `ui/src` changes nothing live until `pnpm ui:build`. Confirm the served `/assets/index-*.js` hash changed before trusting a live result.

## Scope

- Keep UI-specific rules here.
- Leave repo-global architecture, verification, and git workflow rules in the root `AGENTS.md`.

## Visual Proof

- For substantial UI design changes, follow the [Control UI E2E skill's UI stress test](../.agents/skills/control-ui-e2e/SKILL.md#ui-stress-test) to review states in an HTML gallery and collect feedback per example.
- Visual proofs never include the Discord invitation card: the mock and E2E harness seed its canonical browser dismissal before rendering. Dedicated invitation behavior tests may opt into a fresh visitor with `communityInviteDismissed: false`, but do not capture invitation screenshots or videos.
