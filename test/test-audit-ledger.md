# Test audit ledger

In progress. Started at `96e05f7ca44`: 21,443 JS/TS test files, native suites,
and 860 fixture-named paths. Inventory/scans are discovery, not completed review.
Source-only findings below have no runtime verdict unless a landed batch says so.
The linked PRs retain detailed history, proof and failure attribution; this file
keeps the current campaign state instead of repeating historical checkpoints.

## Landed batches

- [189083](https://github.com/openclaw/openclaw/pull/189083): Two CI source-literal assertions; actual manifest admission at 40/41/45/46 rows remains. 662 planning tests on macOS and Linux; focused lint/format.
- [189143](https://github.com/openclaw/openclaw/pull/189143): SDK superseded-writer replay and repeated surrogate block; real Gateway takeover, full mixed-text reconstruction and coarse boundaries remain. Strengthened FTS admission before delete proof. Untouched baseline 105/5 suites; SQLite view-collision fault caught; final proof in PR.
- [189180](https://github.com/openclaw/openclaw/pull/189180): Hook helper replays, obsolete echo mocks and mocked TTS capability case/inventory; actual import/dispatch and real-registry SDK rows remain. 76→73 tests/7 suites; wrong audio capability fault caught.
- [189212](https://github.com/openclaw/openclaw/pull/189212): Unused mock context engine and CLI-history entry builder; actual registration and remaining history fixtures remain. 182 passed/3 platform skips/10 suites before and after; full-tree exports 3→2.
- [189230](https://github.com/openclaw/openclaw/pull/189230): Uninvoked private target-resolution registrar and SDK facade, including build/alias/docs registrations. 146 passed/1 Windows-only skip/8 suites; no runtime or public API caller found.
- [189259](https://github.com/openclaw/openclaw/pull/189259): Absorbed workshop mock and unused CLI config/Tailscale/bootstrap controls; durable workshop restore keeper remains. 55→54/5 suites; replay fault caught three persisted rows instead of two; −68 test/support LOC.
- [189268](https://github.com/openclaw/openclaw/pull/189268): Unused Nostr fixture rows/labels and three voice-call fixture-shape assertions; exact sanitizer, streamed error and signed webhook proof remain. 124/8 suites before and after; −34 support/test LOC, no declarations removed.
- [189289](https://github.com/openclaw/openclaw/pull/189289): DeepInfra mock request-policy replay; real POST, CONNECT proxy and blocked-I/O keepers remain. 35→34/2 suites; dropping policy fails three real requests while two denial controls pass; −55 test LOC.
- [189313](https://github.com/openclaw/openclaw/pull/189313): Setup-failure cleanup replay and DM tool-result replay; shared exact-error/settlement table and registered delivered-payload keeper remain. 178→176/3 suites; skipped settlement fails all three keeper rows, dropped tool handoff fails payload; −33 test LOC.
- [189333](https://github.com/openclaw/openclaw/pull/189333): File Transfer helper metadata/no-load replay and Diffs loopback replay; registered entry and full access matrix remain. 33→29/4 suites; wrong metadata, eager import and rejected local access faults caught. −25 test LOC; 48 CI checks pass. Ledger compacted to about11 KB.
- [189373](https://github.com/openclaw/openclaw/pull/189373): Incomplete MCP preview absence case; the retained identity matrix checks factory admission with public and mapped-private controls. 40→39/3 suites; removing the requester guard leaves the retired case green and fails the keeper. −16 test LOC; 50 CI checks pass.

- [189405](https://github.com/openclaw/openclaw/pull/189405): Five implied/mock/self assertions and one unused import; all180 cases remain. Five owner faults fail ten keeper cases; all removal phases clean before/after; 47 CI checks pass. −6 test LOC, no declarations or production removed.

- [189429](https://github.com/openclaw/openclaw/pull/189429): 49 unselected failover fixture rows and newly unused alias/imports; all55 selected inputs and consumer bytes identical. 257 tests/14 suites before/after, all removal phases clean, 56 CI checks pass. −189 support LOC; no declarations, assertions or production changed.

- [189460](https://github.com/openclaw/openclaw/pull/189460): Two unused core test publications, exact retirement-map rows and two generated cast allowances; native lifecycle/factory owners and all14 consumer files plus both live fixtures preserved. 195 tests/14 suites before/after/final head; all removal phases clean; CI gate green. −38 net production LOC; no declarations or assertions removed.

- [189510](https://github.com/openclaw/openclaw/pull/189510): Obsolete ElevenLabs/Tlon mocks, unused xAI inspector and impossible Nextcloud fixture branch; all159 cases/eight suites remain. Baseline/candidate/final head pass, all removal phases clean, CI green. −30 net test/support LOC; no declarations removed.

- [189543](https://github.com/openclaw/openclaw/pull/189543): 18 unused Memory Wiki payload cells and four implied provider assertions; all 49 cases/four suites remain. Baseline/candidate/final head pass, five owner faults caught, CI green. Existing TTS export findings match before/after; no new scan findings. −4 net test LOC; no declarations or production changed.

- [189578](https://github.com/openclaw/openclaw/pull/189578): Unused Workboard open/manifest helpers and exclusive arguments/bookkeeping; all20 cases/seven suites remain. Baseline/candidate/final head pass; proof-enabled6 cases/two suites retain26 PNGs before/after. −47 support/test LOC; no declarations/assertions removed. Existing TTS findings match, fresh review clear, 49 CI checks pass. Shared-browser baseline/candidate have no local WebM; untouched recording path retained, separate follow-up.

- [189612](https://github.com/openclaw/openclaw/pull/189612): Eight redundant Knowledge YAML inputs and four orphaned Mattermost traces; unchanged sole-fixture rejection keeper and all 24 cases/three suites remain. Baseline/candidate/final head pass, scanner-diagnostic fault caught, all removal phases clean, fresh review clear,48 CI checks pass. −118 fixture LOC; no declarations/assertions/production changed.

- [189651](https://github.com/openclaw/openclaw/pull/189651): Five repeated background view cases consolidated; unique Faded selection assertion carried, all 12 state-owner bodies unchanged. Chromium 31→26 cases/two suites, selection fault caught, all removal phases clean, fresh review clear, 45 CI checks pass. −115 net test LOC; production unchanged.

All landed removal batches completed focused checks, independent review and every removal
scan phase. Existing Knip findings were attributed, never suppressed; unused-file
scans were clean or retained attributed inherited findings; batch189966 records the unchanged release-publication export. PR189313 used the native inherited-failure
route: tested main introduced three unawaited SDK-host closes; the PR's original
file passes typed lint and the identical tested-main file reproduces all three.
Its failed CI remains failed; no current-head CI success is claimed. PR189510 retains an inherited local Tlon max-lines failure (1,028→1,024 effective lines); no allowance added, CI passed.

- [189966](https://github.com/openclaw/openclaw/pull/189966): Nine implied/repeated assertions and duplicate environment/admission bookkeeping; all193 cases/eight suites remain. Five owner faults caught, unchanged removal-scan diagnostics, fresh review clear, final native proof and56 CI checks pass. −16 test/support LOC; no declarations or production changed.

- [190025](https://github.com/openclaw/openclaw/pull/190025): Two duplicate OpenAI thinking-policy declarations and exclusive helper, partial embedding-body check and earlier OAuth pending assertion removed. Baseline193 to candidate/final191 cases across eight suites; three owner faults caught, unchanged removal diagnostics, fresh review clear,46 CI checks pass. −32 test LOC; production unchanged.

- [190081](https://github.com/openclaw/openclaw/pull/190081): Ten implied Feishu assertions and one orphan golden trace removed. All323 cases/seven suites and four live goldens remain; four owner faults caught, all removal scans clean, fresh review clear and46 CI checks pass. −21 test/fixture LOC; production unchanged.

- [190097](https://github.com/openclaw/openclaw/pull/190097): Three duplicate worker-inference declarations and their exclusive suite removed; two singleton recovery cases specialized without changing titles, inputs or executed assertions. Baseline34/three suites to candidate/final31/two suites; three owner faults caught, all removal scans clean, fresh review clear and47 CI checks pass. −125 test LOC; production unchanged.

- [190104](https://github.com/openclaw/openclaw/pull/190104): Legacy application-context fixture now registers its existing render disposer with the Solid cleanup owner. Real DOM context requests stop after cleanup; the new regression fails on the old fixture while rebinding remains green. Baseline4,309 to candidate/final4,310 cases across378 suites, including38 Chromium suites; focused checks, fresh review and49 CI checks pass. +23 test/support LOC; production unchanged.

- [190118](https://github.com/openclaw/openclaw/pull/190118): Installer fixture now advances the monotonic deadline owner. Its existing no-profile case catches the old clock mismatch. Baseline/candidate/final138 cases/nine ordinary consumer suites, including all four clock callers; focused checks, fresh review and46 CI checks pass. Zero net test/support LOC; production unchanged. Two built/native consumers select no fake clock and were not executed.

- [190131](https://github.com/openclaw/openclaw/pull/190131): Two implied surrogate predicates and their exclusive helper removed; all116 cases/five consumer suites remain. Both exact boundary assertions catch the raw-slice owner fault. Baseline/candidate/final pass, removal diagnostics match, focused checks and fresh review pass;56 CI checks pass. −6 test LOC; production unchanged. Baseline native Bun hash was stale; ordinary Vitest fallback used.

- [190218](https://github.com/openclaw/openclaw/pull/190218): Duplicate utility-only helper refusal removed; both other helper cases and all resolver/config consumers remain. Baseline56 to candidate/final55 cases/four suites; all five migrated resolver rows catch the exclusion-filter fault. All removal scans clean, focused checks and fresh review pass;53 CI checks pass. −11 test LOC; production unchanged.

- [190253](https://github.com/openclaw/openclaw/pull/190253): Path-policy mock setup now runs at file scope. Both selected POSIX cases fail on the old fixture and pass after repair; all19 cases pass before/after/final. Every declaration, input and assertion remains. Focused checks, fresh review and54 CI checks pass; zero net test LOC, production unchanged.

- [190275](https://github.com/openclaw/openclaw/pull/190275): Unsupported bootstrap body literals, two unobserved system builds and exclusive private scenario machinery retired. Both boundary declarations and all real assertions remain; baseline/candidate/final66 cases/two suites pass and actual notice-owner fault is caught. Scoped checks, fresh review and all four removal phases completed with unchanged inherited findings. Native inherited-CI landing attributes the two lint errors to later main and preserves the failed run/attempt. −80 test/helper LOC; production unchanged.

- [190360](https://github.com/openclaw/openclaw/pull/190360): Both structured-output expected states now use independent shallow snapshots. Actual exhausted-counter and pre-persistence error mutations pass the original comparisons and fail all six repaired cases; owners byte-restored. All16 cases/one suite pass on baseline, candidate and final head; scoped checks, fresh review and55 CI checks pass. Every declaration, input, assertion and gate remains; zero net test LOC, production unchanged. Rejected-assertion settlement warning under the intentional fault remains a separate follow-up.

- [190422](https://github.com/openclaw/openclaw/pull/190422): Frame-read responses must now exist inside the transcript prefix before Runtime replay. Actual first-response omission passes the original comparison and fails the repaired membership assertion; bridge byte-restored. Baseline, candidate and published final head pass27 cases/one suite; scoped checks, full-range fresh review and49 CI checks pass. All17 declarations, both read rows and every other assertion/input/fixture remain; zero net test LOC, production unchanged.

- [190455](https://github.com/openclaw/openclaw/pull/190455): Catch the actual credentialed browser rejection instead of fabricating an Error on fulfillment. Actual open-dispatch rejection-to-result fault passes the old case and fails the repaired Error assertion; temporary owner/test bytes restored. Untouched baseline, candidate and published final head pass115 cases/two suites; focused checks, full-range fresh review and47 CI checks pass. All60 physical declarations and every target/URL/assertion/fixture remain; one fewer test line, production unchanged.

- [190492](https://github.com/openclaw/openclaw/pull/190492): Remove five unused search-manager methods and close-all fixture/export/reset; independent zero-access accounting passes both cases. Both complete test bodies remain byte-identical. Dropped-code and bypassed-normalization owner faults each fail their retained keeper; owner bytes restored. Exact one-row mock allowance shrink and documented isolation repair the reproduced guard failure. Focused checks, full-range fresh review, final-head2 cases and52 CI checks pass. Both unused-file phases and script exports pass; dependency/production/full-tree export scans reproduce the same three worker-retention schemas on untouched base, recorded as inherited local failures. Eight fewer test lines and one obsolete baseline row; production unchanged.

- [190553](https://github.com/openclaw/openclaw/pull/190553): Remove duplicate search factory setup and an implied project-result length assertion. All six declarations/eight cases remain. Factory/FTS controls and actual cap201 keeper fault qualified; candidate/final eight pass. Both unused-file phases and script exports pass; dependency and production/full-tree export scans reproduce the same inherited Gateway finding on the exact base. Focused checks, fresh review and50 CI checks pass. Two fewer test lines; production unchanged.

- [190581](https://github.com/openclaw/openclaw/pull/190581): Check the trimmed synthetic chat key for secret echoes. Actual pending-response fault passes the old padded check and fails the strengthened assertion; owner byte-restored. All20 declarations/21 cases remain and baseline/candidate/final pass. Focused checks, full-range fresh review and54 CI checks pass; neutral CodeQL summary concerns unselected configurations. Zero net test LOC; production unchanged.

- [190596](https://github.com/openclaw/openclaw/pull/190596): Remove retired ephemeral queue setup from dreaming coordinator/narrative suites. All25 declarations/30 cases remain; zero-queue-access control passes, actual post-config promotion omission fails the processed-result keeper, and owners are byte-restored. Baseline/candidate/final30, focused checks, fresh review and49 CI checks pass. All removal phases completed; the sole unused media-type re-export reproduces on the exact base and remains recorded as an inherited local failure. Fifteen fewer test lines; production unchanged.

- [190636](https://github.com/openclaw/openclaw/pull/190636): Remove two implied diagnostic-tail assertions and their exclusive constant. All four stdout/stderr and chunk/rolling cases remain. Actual tail-cap reduction fails all four exact-output keepers; owner byte-restored. Baseline/candidate/final4, focused checks, all removal phases and fresh review pass;54 CI checks succeed. Three fewer test lines; production unchanged.

- [190659](https://github.com/openclaw/openclaw/pull/190659): Pin the memory-flush fallback fixture to UTC. Original UTC+14 fails its date equality; repaired host and UTC+14 pass all4, and epoch0 owner fault is caught. Baseline/candidate/final4, focused checks, exact +1 allocation and fresh review pass;50 CI checks succeed. All declarations/inputs/assertions remain; production unchanged.

- [190679](https://github.com/openclaw/openclaw/pull/190679): Restore the QMD filesystem spy in finally around the unchanged migration and assertions. Original normal/body-error probes expose the retained spy; repaired normal five pass and the body sentinel preserves only its intended failure. Baseline/candidate/final five, focused checks, exact +4 allocation and fresh review pass;47 CI checks succeed. All declarations/inputs/assertions remain; production unchanged.

- [190704](https://github.com/openclaw/openclaw/pull/190704): Verify color:red declarations in existing hover-guard outputs. Both actual clone-body and retained-body omission controls pass the originals and fail the repaired assertions; owner bytes restored. Baseline/candidate/final four cases, scoped checks, exact +5 allocation and fresh review pass;46 CI checks succeed. Every original declaration/input/assertion remains; production unchanged.

- [190714](https://github.com/openclaw/openclaw/pull/190714): Remove retired Matrix text-runtime fixture setup. Counted getters observe zero reads across12 fields, including whole edit-action and single-event preparation fixtures; all19 declarations/33 cases remain. Existing keepers catch missing edit delivery and canonical table-mode faults, with exact owner restoration. Standalone preparation, baseline/candidate/final33, scoped checks and fresh review pass;52 CI checks succeed. All removal phases completed; exact-base ImageLightbox finding remains attributed.34 fewer test lines; production unchanged.

- [190725](https://github.com/openclaw/openclaw/pull/190725): Remove four unused Matrix send-runtime fields and two absorbed absence assertions. All37 declarations/48 cases remain; zero-access getters and both actual owner faults qualify the keepers, with exact restoration. Baseline/candidate/published48, scoped checks, all removal phases and fresh review pass;50 CI checks succeed. Six fewer test lines; production unchanged.

- [190736](https://github.com/openclaw/openclaw/pull/190736): Compare Matrix account defaults with independent original literals. Actual DM and room-default overwrites each pass the original aliased comparison and fail the repaired expectation, with exact owner/test restoration. All five declarations/seven cases remain; baseline/candidate/published seven, focused checks and fresh review pass;53 CI checks succeed. Only two expected expressions change; zero net test lines, production unchanged.

- [190760](https://github.com/openclaw/openclaw/pull/190760): Retire the Matrix reaction test's partial approval-error classifier mock. Actual canonical legacy-not-found and transient-503 faults pass the old mocked keepers and fail the unmocked keepers, with exact restoration. All seven declarations/cases remain; baseline/candidate/published seven, focused checks, every removal scan and fresh review pass;51 CI checks succeed. Ten fewer test lines; production unchanged.

- [190810](https://github.com/openclaw/openclaw/pull/190810): Retire unused redaction fixture setup/cursor bookkeeping. Counted control passes all eight with zero unused-path consumers; disabling the actual YAML leak guard fails the retained leak keeper, with exact restoration. All four declarations/eight cases remain; baseline/candidate/published eight, focused checks, every removal scan and fresh review pass;57 CI checks succeed. Twelve fewer test lines; production unchanged.

- [190837](https://github.com/openclaw/openclaw/pull/190837): Remove the unread agent-tools MCP fixture tempRoot property. Counted getter control records zero reads; both mock and real stdio keepers catch an actual cwd fault, with exact restoration. All ten declarations/eleven cases remain; baseline/candidate/published eleven, focused checks, every removal scan and fresh review pass;59 CI checks succeed. Native reconciled the original accepted auto intent after changing mergeability projections. Zero net test lines; production unchanged.

- [190868](https://github.com/openclaw/openclaw/pull/190868): Remove the parity default catalog's unselected runtime-control-ui row. Actual request-deduplication fault fails the retained repeated-start keeper; owner/test bytes restored exactly. Both declarations/three cases remain; baseline/candidate/published three, focused checks, every removal scan and fresh review pass;57 CI checks succeed. Three fewer formatted test lines; production unchanged.

- [190883](https://github.com/openclaw/openclaw/pull/190883): Remove the allowlist frozen-input echo and implied DeepSeek DSML absence assertion. With both absent, actual in-place-sort and emitted-DSML faults fail their retained keepers; owner/test bytes restored exactly. All ten declarations/eighteen cases remain; baseline/candidate/published eighteen, focused checks, every removal scan and fresh review pass;56 CI checks succeed. Two fewer test lines; production unchanged.

- [190905](https://github.com/openclaw/openclaw/pull/190905): Own the fallback cache fixture's absent TTL environment and exercise enabled undefined/empty session writes with an empty-bucket oracle and valid-session control. The actual write-guard fault passes the original case and fails the repair; inherited positive TTL fails the original default-off case. Owner/test bytes restored exactly. All eight declarations/cases remain; baseline/candidate/positive-environment/published eight, focused checks and fresh review pass;54 CI checks succeed. Exact seven-line allocation; production unchanged.

- [190921](https://github.com/openclaw/openclaw/pull/190921): Snapshot the directory fleet test's independent expected realpath before the counted spy. The actual prepared-path normalizer fault passes the original case and fails the repair; owner/test bytes restored exactly. All ten declarations/cases remain; baseline/candidate/published ten, focused checks and fresh review pass. Exact one-line allocation; production unchanged. CI run41403464103 attempt1 retains its inherited Baseten private-import boundary failure and downstream aggregate. Native verified unchanged baseline/tested-merge failure inputs, separate security clearance and authorized inherited-CI squash landing; failed CI is not relabeled green.

- [190962](https://github.com/openclaw/openclaw/pull/190962): Exercise retired requester authority through the prepared MCP upload callback, then clear mock history before the independent transport-retirement assertions. Callback-only authority omission passes the originals and fails the repair; transport-guard omission fails the retained keeper. Owner/test bytes restored exactly. Both declarations/cases and all original inputs/assertions remain; baseline/candidate/published two, scoped checks and fresh review pass;54 CI checks succeed. Exact five-line allocation; production unchanged.

- [191012](https://github.com/openclaw/openclaw/pull/191012): Require each authored module flow to supply its shared channel binding before retained runner checks. Wrong imports in both real canary YAMLs pass the originals and fail both repaired rows; YAML/test bytes restored exactly. The original declaration, both channel rows and all27 authored assets remain; baseline/candidate/published two, scoped checks and fresh review pass;59 CI checks succeed. Exact five-line allocation; production unchanged. Local routing proof supplies no live-channel claim.

- [191031](https://github.com/openclaw/openclaw/pull/191031): Remove three confounding harness oracle inputs: identical public-metadata clone, unresolved workspace path and valid deferred credentials. Actual brand, normalization and post-credential authority faults pass the original9/8/2-case suites and fail only the intended repaired cases; owner/test bytes restored exactly. All nine declarations/20 cases/four suites remain; baseline/candidate/published20, scoped checks and fresh review pass;52 CI checks succeed. Zero net test lines; production unchanged.

- [191051](https://github.com/openclaw/openclaw/pull/191051): Remove five unused bundle-MCP plugin-enablement fixture lines. Original counted getter records zero reads; actual reversed merge precedence fails the retained user-override keeper after the cut. Owner restored exactly. All three declarations/cases and every assertion/other input remain; baseline/candidate/published three, all four removal components before/after, scoped checks and fresh review pass;54 CI checks succeed. Five fewer test lines; production unchanged.

- [191096](https://github.com/openclaw/openclaw/pull/191096): Exercise the returned plugin memory callback after session replacement and retire its fake row and minted grant. The actual returned-callback no-op passes all eight original cases and fails only the repaired revocation case; owner restored exactly. All seven physical declarations/ten cases and original assertions/inputs remain. Baseline/candidate/published ten, scoped checks and fresh review pass;54 CI checks succeed. Eleven additional test lines have an exact allocation; production and shared baseline unchanged.

- [191127](https://github.com/openclaw/openclaw/pull/191127): Require preserved preformatted text, complete URL targets and ordered table rows in three existing Telegram split cases. Each actual splitter fault passes its original named case and fails its repaired case; unselected cases are skipped. Owner restored exactly. All 54 physical declarations/84 cases and original assertions/inputs remain. Baseline/candidate/published 84, scoped checks and fresh review pass;51 CI checks succeed. Twelve additional test lines have an exact allocation; production and shared baseline unchanged.

- [191151](https://github.com/openclaw/openclaw/pull/191151): Give the blank Telegram quote fixture a matching source message ID so it reaches the whitespace guard. Removing that guard passes both original cases and fails only the repaired blank-quote case; the actual owner is restored exactly. All 10 physical declarations/20 cases, original assertions and existing inputs remain. Baseline/candidate/published 20, scoped checks and fresh review pass;53 CI checks succeed. One additional test line has an exact allocation; production and shared baseline unchanged.

- [191175](https://github.com/openclaw/openclaw/pull/191175): Clear inherited DNS-result ordering through the existing Telegram environment stub lifecycle. The original normal-runner IPv4-first control fails exactly one runtime-default row; the repaired inherited and clean runs pass all five. Both physical declarations, every assertion/input and the production owner remain. Baseline/candidate/published five, focused checks and fresh review pass; required CI and exact-head security pass. One additional test line has an exact allocation; shared baseline unchanged.

- [191248](https://github.com/openclaw/openclaw/pull/191248): Exercise valid config alongside the retired-key fixture through the real loader. Disabling the actual isolation option passes both original cases and fails only the repaired valid-config row at the retained environment assertion; owner restored exactly. Both physical declarations and every original input/assertion remain. Baseline two, candidate/published three, scoped checks and fresh review pass;52 CI checks and exact-head security succeed. Three additional test lines have an exact allocation; production and shared baseline unchanged.

- [191300](https://github.com/openclaw/openclaw/pull/191300): Remove three unselected Telegram media fixture variants and one menu count implied by the retained exact call array. Throwing fixture getters pass all seven media cases; an actual duplicate publication fails the original count and the retained array in separate controls. All14 physical declarations/17 cases remain;11 test/support lines removed. Baseline/candidate/published17, focused checks, fresh review with zero findings,52 CI checks and exact-head security pass. Local production Knip and the script wrapper reproduce two inherited export diagnostics on original sources; full-tree exports and both unused-file phases pass. No suppression; production and shared baseline unchanged.

- [191351](https://github.com/openclaw/openclaw/pull/191351): Remove the unselected null answer-stream option from the Telegram delivery helper. A throwing null branch passes all18 cases; both consumer bodies and six exports remain. All15 physical declarations/18 cases are retained; three support lines removed. Baseline/candidate/published18, focused checks, all removal phases, fresh review with zero findings, final required CI and exact-head security pass. The initial backend mock cut failed the exact mock-factory contract and was restored byte-for-byte; its old auto intent was retired before the reviewed replacement landed. Production and the shared test-line scalar are unchanged.

- [191393](https://github.com/openclaw/openclaw/pull/191393): Remove two fallback assertions implied by stronger keepers on the same strings. Actual serializer prefix-leak and canonical plain-fallback faults fail their retained keepers on both original and candidate tests. All eight declarations/cases and every fixture/input remain; two test lines removed. Baseline/candidate/published eight, the unchanged 35-case attempt sibling, focused checks and fresh review with zero findings pass. Exact-head CI has34 successful checks/28 intentional skips and successful security. Production/full-tree export scans and their wrapper reproduce the sole inherited buildRequestBody diagnostic on exact original sources; unused-file and script-only export phases pass. No suppression; production and shared baseline unchanged.

- [191431](https://github.com/openclaw/openclaw/pull/191431): Require pending-vote presence before comparing dispatch indexes, and settle its registration before monitor shutdown in finally. All two declarations/cases and every existing input/assertion remain. Actual pending-vote suppression passes the original two and fails the new positive keeper; body-failure probes distinguish zero settlements/running monitor from one settlement/stopped monitor. Owners and temporary probes are byte-restored. Baseline/candidate/published two, focused checks, exact +6 allocation and fresh review with zero findings pass. Exact-head CI has34 successes/28 intentional skips and successful security. Production and shared test-line scalar are unchanged.

- [191448](https://github.com/openclaw/openclaw/pull/191448): Enable native Anthropic compaction in the authored-context preservation fixture with three missing provider metadata fields. All eight declarations/twelve cases, inputs and existing assertions remain. Actual preservation-guard removal passes all twelve original cases and fails exactly the repaired identity assertion, with eleven other cases passing; the owner is byte-restored. Baseline/candidate/published twelve and unchanged canonical package sibling ten pass without skips. Focused checks, exact +3 allocation, normal hooks and fresh review with zero findings pass. Exact-head CI has30 successes/29 intentional skips and successful security. Production and shared scalar remain unchanged.

- [191460](https://github.com/openclaw/openclaw/pull/191460): Remove the implied Activity alphabet and question max100 predicates; exact strings, explicit length47, parser and malformed/legacy contracts remain. All five declarations/cases and every input remain; production and shared scalar unchanged, two fewer test lines. Untouched baseline, clean candidate and published five pass without skips; unchanged codec sibling five passes. Both independent builder faults fail only their retained exact-string keeper in original/candidate runs, with four other cases passing; owners byte-restored. All removal phases, focused checks, normal hooks and fresh review with zero findings pass. Exact-head CI has30 successes/29 intentional skips and successful security.

- [191480](https://github.com/openclaw/openclaw/pull/191480): Repair the existing presence scope-clearing case with distinct guild-scoped keys and two positive preconditions. All five declarations/cases, prior assertions and other case inputs remain; production and shared scalar unchanged, exact +2 allocation. Actual no-op clear passes original five and fails only the candidate's retained cleared-guild keeper; actual overbroad clear fails only the retained other-guild keeper in original/candidate runs. Each expected-failure run has four passes and the owner is byte-restored. Untouched baseline, clean candidate and published five pass without skips. Focused checks, normal hooks and fresh review with zero findings pass. Exact-head CI has31 successes/29 intentional skips and successful security.

- [191493](https://github.com/openclaw/openclaw/pull/191493): Remove three unused tasks arrays from private serialized Workboard seeds. All five declarations/seven cases and every row/assertion/clock/state check remain; production, shared builder type and scalar unchanged, three fewer test lines. Original/candidate throwing-getter runs pass seven with no tasks reads; injected actual read rejects all seven. Actual missing appearance clear fails the same retained icon keeper in original/candidate, six other passes each; owner byte-restored. Baseline, clean and published seven, focused checks, hooks and fresh review pass. All removal phases completed; two production scans reproduce the identical unused loadClawHubSecurityVerdicts export on the exact base, other phases pass. Exact-head CI has32 successes/28 intentional skips and successful security.

- [191506](https://github.com/openclaw/openclaw/pull/191506): Repair exact prior browser-history state and full-URL restoration proof. Preserve both declarations/cases, every prior assertion/input and production; seed one nondefault suite baseline and restore its entering environment, with independent expected state and an exact18-line allocation. Separate actual lost-state/lost-URL faults each pass original two and fail only the corresponding new candidate keeper, one other pass each. Owner/test bytes restored exactly. Untouched baseline, clean and published two, focused checks, hooks and fresh review with zero findings pass. Exact-head CI has32 successes/28 intentional skips and successful security.

- [191534](https://github.com/openclaw/openclaw/pull/191534): Remove one unread private TTS result member; retain all five declarations/ten cases, every row/input/assertion, public type and production. Original/candidate throwing-read controls pass ten, and injected actual read fails only the intended case. Actual wrong-agent option fails the same retained keeper in both versions, nine other passes each; owner/test bytes restored. Baseline/clean/published ten, unchanged adapter sibling seven, focused checks, hooks and fresh review pass. All seven removal phases completed; four failed export surfaces reproduce the same two compaction exports on exact original sources; unused-file/script phases pass, no suppression. One fewer test line; shared scalar unchanged. Exact-head CI has29 successes/29 skips and successful security.

- [191558](https://github.com/openclaw/openclaw/pull/191558): Remove one literal backslash-x1b absence predicate implied by the exact same-string output keeper. Retain all fourteen declarations/eighteen cases, all rows/inputs and other assertions; production and shared scalar unchanged, one fewer test line. An actual shared stdout/stderr parser fault fails the same exact-output keeper with the same corrupted aggregate on original/candidate, seventeen other passes each; owner/test bytes restored exactly. Untouched baseline, clean candidate and published eighteen pass without skips. All seven removal phases completed; only two production export surfaces fail and reproduce the same Doctor memory-provenance export on exact original sources. Five passing phases not repeated; no suppression. Focused checks, hooks and fresh review with zero findings pass. Exact-head CI has29 successes/29 intentional skips and successful security.

- [191572](https://github.com/openclaw/openclaw/pull/191572): Remove one guarded-fetch count implied by the exact four-entry audit-context projection of the same mock calls. Retain all ten declarations/twelve cases, inputs, rows and every other assertion, including the independent fetch count; production/shared scalar unchanged, one fewer test line. An actual upload-negotiation audit-context fault fails the same retained projection in original/candidate, eleven other passes each; owner/test bytes restored exactly. Baseline/clean/published twelve pass without skips. All seven removal phases completed; two failed production export surfaces reproduce the identical Doctor memory-provenance export on exact original sources, five passing phases not repeated and no suppression. Focused extension checks, hooks and fresh review with zero findings pass. Exact-head CI has30 successes/29 intentional skips and successful security.

- [191595](https://github.com/openclaw/openclaw/pull/191595): Replace three partial approval-truncation predicates with one independent exact-output keeper; retain both declarations/cases, all inputs, the inline escaping check and the complete second case. Production/shared scalar unchanged, two fewer test lines. An actual formatter split-surrogate fault passes both original cases but fails only the candidate's exact keeper, with one other pass; owner/test bytes restored exactly. Untouched baseline, clean candidate and published proof pass both without skips. All seven removal phases pass with zero findings; no baseline replay or suppression. Focused extension checks, hooks and fresh review with zero findings pass. Exact-head CI has30 successes/29 intentional skips and successful security.

- [191611](https://github.com/openclaw/openclaw/pull/191611): Add one independent argv-sensitivity comparison to the existing identity case. Retain the original format and synthetic-secret absence assertions, original input and declaration. An actual constant64hex owner fault passes the original case and fails only the new comparison; temporary owner/test bytes are restored exactly. Untouched baseline, clean candidate and published one pass without skips. No removal scan applies; focused checks, hooks and fresh review with zero findings pass. Exact-head CI has29 successes/29 intentional skips and successful security. Production/shared scalar unchanged; seven additional test lines.

- [191624](https://github.com/openclaw/openclaw/pull/191624): Correct the existing prototype fixture to use an own enumerable `__proto__` key. All32 declarations/48 cases, inputs and assertions remain. An actual own-key filter fault passes the original48 and fails only the repaired existing own-key assertion; owner/test bytes restore exactly. Untouched baseline, clean candidate and published48 pass without skips. No removal scan applies; focused checks, hooks and fresh review with zero findings pass. Exact-head CI has29 successes/29 intentional skips and successful security. Production/shared scalar unchanged; zero net test lines.

- [191634](https://github.com/openclaw/openclaw/pull/191634): Configure both the allowed and denied agents in the existing spawn allowlist fixture. All7 declarations/8 cases and every assertion remain. The actual owner fault admits configured agents outside an explicit allowlist: original8 pass; repaired fixture fails only the existing forbidden-status assertion, with7 passes. Exact owner/test restoration, baseline/clean/published8, focused checks, normal hooks and fresh review with zero findings pass. Exact-head CI has29 successes/29 intentional skips and successful security. Production/shared scalar unchanged; zero net test lines.

- [191753](https://github.com/openclaw/openclaw/pull/191753): Pass every invalid human-mention metadata array intact and use valid nonoverlapping spans for the eleven-recipient limit row, with ten accepted recipients as its positive boundary. All6 declarations/14 cases and original assertions remain. Actual end-bound and count-limit faults each pass the original14 and fail only the intended repaired row, with13 other passes; owner/test bytes restore exactly. Baseline/clean/published14, focused checks, hooks and fresh review with zero findings pass. Exact nine-line allocation; production/shared scalar unchanged. CI41602621426 retains five lines of inherited test-line debt and its downstream aggregate failure; exact allocation adds zero debt. Native independently verified security and authorized attributed-failure squash landing; failed CI is not called green.

- [191824](https://github.com/openclaw/openclaw/pull/191824): Remove three privacy assertions implied by exact-once complete warning arguments. All19 declarations/25 cases, fixtures, inputs and other assertions remain. Actual decoder-frame and stderr-error faults each fail only the retained keeper on original and candidate, with24 other passes; owners restore byte-for-byte. Baseline/candidate/published25, focused checks, all seven removal components and fresh review with zero actionable findings pass. Exact-head CI succeeds with58 completed jobs and no failures. Three fewer test lines; production/shared scalar unchanged. Native receipt and closeout complete.

- [191867](https://github.com/openclaw/openclaw/pull/191867): Require the replacement thinking-profile row and remove unrequested defaults setup. All four cases and original assertions remain; actual null/empty-row faults pass originals and fail only the repaired case. Zero matching defaults RPCs; baseline/candidate/published four, focused checks, all seven removal components and fresh review pass. Exact-head CI completed 60 jobs: 32 success/28 intentional skips, no failures. Four fewer test lines; production/shared scalar unchanged. Native receipt and closeout complete.

- [191917](https://github.com/openclaw/openclaw/pull/191917): Remove the first fingerprint's synthetic-text absence assertion implied by its anchored hash format. All eight declarations/12 cases remain; actual first-result disclosure fails the same keeper on original and candidate. Baseline/candidate/published12, scoped checks and fresh review pass; seven removal components completed with four identical original-test export failures attributed. Exact-head CI29 success/29 intentional skips, no failures. One fewer test line; production/shared scalar unchanged. Native receipt and closeout complete.

- [191966](https://github.com/openclaw/openclaw/pull/191966): Hold the actual stale bootstrap sessions.list reply across successor deletion rollback. All eight declarations/24 cases, inputs and original assertions remain. A bootstrap receipt-order fault passes the old row and fails its repaired stale-row keeper. Baseline/candidate/published24, siblings39, scoped checks and fresh review pass. CI41658854725 remains failed for the identical scheduled-main mock-exports defect in untouched config-secret-fields; native attributed-failure squash receipt and closeout are complete. Zero net test lines; production/shared scalar unchanged.

- [192039](https://github.com/openclaw/openclaw/pull/192039): Check the actual account revocation receipt outside the handler catch. Both existing cases and all assertions remain. An actual updater null-receipt control passes the old selected row and fails the repaired non-null assertion; owner bytes restore exactly. Baseline/candidate/published2, related10, scoped checks and fresh review pass. Exact-head CI29 success/29 skips, no failures. One fewer test line; production/shared scalar/allocation records unchanged. Native receipt and both checkout closeouts complete.

- [192103](https://github.com/openclaw/openclaw/pull/192103): Require the exact published roster when clearing a thinking override. All10 declarations/17 cases and original contracts remain. An actual null-event rejection passes the old selected row and fails the repaired stale-roster keeper; owner bytes restore exactly. Baseline/candidate/published17, related14, scoped checks and fresh review pass. Exact-head CI32 success/28 intentional skips, no failures. Two fewer test lines; production/shared scalar/allocation records unchanged. Native receipt and both checkout closeouts complete.

- [192149](https://github.com/openclaw/openclaw/pull/192149): Check prepared credentials and the real reconnect receipt outside the handler catch. Both cases, authority invocation, responses and calibrated SQL checks remain. Actual settled-worker receipt corruption passes the old selected row and fails the repaired identity keeper; owner bytes restore exactly. Baseline/clean/published2, related8, scoped checks and fresh review pass. Exact-head CI28 success/30 intentional skips, no failures. Five added test lines have an exact separate allocation; production/shared scalar unchanged. Native receipt and both checkout closeouts complete.

- [192198](https://github.com/openclaw/openclaw/pull/192198): Capture actual protocol IDs and establish startup polling before subscriber cancellation. All15 declarations/29 cases and original abort/request/timer keepers remain. Actual producer-abort omission passes the old selected row and fails the repaired no-further-request keeper; owner bytes restore exactly. Baseline/clean/published29, related25, scoped checks and fresh review pass. CI41704396708 has31 successes/27 intentional skips and failed test-lines/downstream aggregate: exact CI merge base and merge tree retain81 lines of inherited debt; the five-line repair has equal allocation credit. Native attributed-failure squash receipt and both checkout closeouts complete; failed CI is not green.

- [192236](https://github.com/openclaw/openclaw/pull/192236): Require recovered oversized thread identity before the existing error negatives. The single case and every prior contract remain. Actual catalog producer omission passes the original and fails the repaired identity keeper; owner/test bytes restore exactly. Baseline/clean/published1, related37, scoped checks and fresh review pass. CI41715915689 has29 successes/28 intentional skips and failed test-lines/downstream aggregate: exact CI base and merge tree retain355 lines of inherited debt; the one-line repair has equal allocation credit. Native attributed-failure squash receipt and both checkout closeouts complete; failed CI is not green.

- [192290](https://github.com/openclaw/openclaw/pull/192290): Include mandatory deny in the existing duplicate approval-decision fixture so it reaches uniqueness. All four declarations/28 cases and assertions remain. Actual consumed uniqueness omission passes the original28 and fails only the repaired replay rejection, with27 passes; owner/test bytes restore exactly. Baseline/clean/published28, related21, generated freshness, scoped checks and fresh review pass. CI41725885879 retains31 successes/27 skips and failed test-lines/downstream aggregate: exact CI base and merge retain294 lines of inherited debt, distinct from local296. Exact+3/+3 allocation adds no debt. Native attributed-failure squash receipt and both checkout closeouts complete; failed CI remains failed.

- [192351](https://github.com/openclaw/openclaw/pull/192351): Observe actual session CLI module evaluation before and after the deferred metadata callback. The single case, descriptors, forwarding and original assertions remain. Actual eager-owner import passes the original and fails the repaired observer; owner/test restore exactly. Baseline/clean/published1, related19, scoped checks and fresh review pass. Initial PR-caused mock fingerprint failure is repaired with supported isolation annotation and exact obsolete baseline retirement. Repaired CI41737007881 retains29 successes/28 skips and failed test-lines/downstream aggregate; exact CI base and actual merge preserve53 lines of inherited debt with+5/+5 credit. Native attributed-failure squash receipt and both checkout closeouts complete; failed CI remains failed.

- [192381](https://github.com/openclaw/openclaw/pull/192381): Require each forbidden computer-control name to be absent from the native-surface safe-deny exemption. The existing case, independent image-generation positive and all37 cases remain. Five actual producer faults pass the original selected case and fail the repaired name-specific keeper; owner/test bytes restore exactly. Baseline/clean/published37 and two selected host-policy cases pass;91 host cases remain outside that filter. Focused format, MDX, whitespace, zero-growth ratchet and fresh review pass. Local typecheck retains five identical original-test MCP errors; typed lint is blocked before analysis by the same SDK declaration failure. Exact-head CI29 success/29 planned skips and final security pass. Zero net test lines; production/shared scalar/allocations unchanged. Native receipt and both checkout closeouts complete.

- [192430](https://github.com/openclaw/openclaw/pull/192430): Explicitly disable Computer Use in both unrelated startup-lifetime fixture configurations. All two declarations/three cases and every assertion remain. Ambient activation makes all three original cases fail before their intended keepers; repaired enabled/disabled controls and all four intentional-enabled sibling cases pass. Baseline/clean/published3, scoped checks and full-range fresh review pass. Exact-head CI41752571483 retains29 successes/28 skips and failed test-lines/downstream aggregate; actual CI base/merge preserve145 inherited lines of debt, separate from local137, with exact+6/+6 allocation. Native attributed-failure squash receipt and both checkout closeouts complete; failed CI remains failed.

- [192466](https://github.com/openclaw/openclaw/pull/192466): Require the exact assistant payload instead of a marker anywhere in the CLI JSON. The single managed-Gateway case and every other assertion remain. An actual CLI JSON-writer fault passes the original and fails the repaired assertion using the same compiled artifact; producer bytes restore exactly and the normal rebuild removes the fault. Baseline/clean/published one, related discovery two, scoped checks and fresh review pass. Exact-head CI27 success/30 intentional skips and final security pass. Zero net test lines; production/shared scalar unchanged. Native receipt and both checkout closeouts complete.

- [192526](https://github.com/openclaw/openclaw/pull/192526): Give the compaction warning spy scope-bound restoration. All25 declarations/37 cases, inputs and assertions remain; one fewer test line. Identical early-return controls fail the original logger-identity check and pass with the repair before hook cleanup. Baseline, restored and final-head37 pass; scoped checks and fresh review pass. Exact-head CI29 success/29 intentional skips and security pass. Native squash receipt and both checkout closeouts complete. No native Codex or provider execution is claimed.

- [192551](https://github.com/openclaw/openclaw/pull/192551): Replace two singleton context-projection tables with ordinary cases. All25 declarations/29 expanded cases and every exercised assertion remain; ten fewer test lines. Baseline/candidate full result JSON matches for both fixtures, with identical case inventories after the intended history rename. Baseline/candidate/restored/published29, scoped checks and fresh review pass. Exact-head CI29 success/29 intentional skips and security pass. Native squash receipt and both checkout closeouts complete; production unchanged.

- [192580](https://github.com/openclaw/openclaw/pull/192580): Return independent mocked conversation receipts. All seven vectors and assertions remain, with zero test-line growth. The actual hosted-tool channel mutation passes the original seven oracles and fails all seven repaired equalities; exact restored and published seven pass. Scoped checks and fresh review pass; exact-head CI28 success/30 intentional skips and final security pass. Native squash receipt and both checkout closeouts complete; production unchanged.

- [192620](https://github.com/openclaw/openclaw/pull/192620): Remove the fabricated tool-authority fingerprint from the Copilot policy fixture. All assertions in the complete case remain; six fewer test lines. The untouched case fails before its native turn; the repaired case and three related cases pass through the deterministic native runtime. Scoped checks and fresh review pass; exact-head CI27 success/30 intentional skips and security pass. Native squash and checkout closeout complete; the separate source checkout remains retained by its lifecycle guard. Production unchanged. The historical cumulative-prompt nomination was withdrawn after actual runtime evidence contradicted it.

- [192637](https://github.com/openclaw/openclaw/pull/192637): Expire fixture-owned native MCP previews through the existing view owner. All six cases and original assertions remain. The identical zero-retention observer fails on the original and passes the repair; timer inventory isolates the two owned expiry callbacks. Published six, scoped checks and fresh review pass; exact-head CI30 success/29 skips and security pass. Native squash and both checkout closeouts complete; ten test lines have an equal separate allocation, production unchanged.

- [192652](https://github.com/openclaw/openclaw/pull/192652): Preserve the settlement observer's full mutation argument tuple. All three cases and prior assertions remain. The original revoked-authority control writes the forbidden assignment; the repaired control rejects at the actual mutation boundary without a write. Restored and published three, scoped checks, fresh review, CI and security pass. Native squash and both checkout closeouts complete; production unchanged.

- [192770](https://github.com/openclaw/openclaw/pull/192770): Release early-failure steering custody through the shared fixture's existing cancellation owner. All28 declarations/54 consumer cases and assertions remain; identical early-failure controls distinguish retained delivery/listener/timer/batch from actual cancellation. Baseline and restored54, scoped checks, fresh review, exact-head CI and security pass. Native squash and native checkout closeout complete; the separate managed checkout remains retained by its lifecycle guard. Production unchanged; no source reclassification or support credit.

- [192951](https://github.com/openclaw/openclaw/pull/192951): Remove inactive redaction config and stale labels from the mirror identity/replay fixture; every case, operation and assertion remains. Original/candidate primary36 and sibling2 pass, including published-head proof; two test lines removed. Focused checks and fresh review pass; inherited removal-scan diagnostics remain documented. CI29 successes/29 skips and exact-tuple security pass; native squash and both task checkout removals verified.

- [193008](https://github.com/openclaw/openclaw/pull/193008): Await a same-response rendered catalog before checking empty native catalogs. All six declarations/seven cases and both absence assertions remain; original and repaired seven pass. Discarded-response controls pass the original selected case and fail the repaired positive wait. Scoped checks and fresh review pass. Native attributed-failure squash preserves failed CI: the complete UI job has one unchanged baseline Offline/Disconnected expectation failure; final security passes. Both task checkout removals are verified; production unchanged.

- [193042](https://github.com/openclaw/openclaw/pull/193042): Remove unused long-turn HTTP response tracking; the complete real-Gateway case and all42 exec steps remain. Baseline/candidate/published1 pass, focused checks and fresh review complete. The local tokenjuice dependency finding remains attributed. CI41931060644 retains31 successes/27 skips and the inherited Offline/Disconnected failure plus downstream aggregate; exact-head security passed. Native attributed-failure squash and both checkout closeouts complete. Two fewer test lines; production unchanged.

- [193061](https://github.com/openclaw/openclaw/pull/193061): Remove repeated Docker upgrade baseline assertions; all five declarations/six cases remain. Original/candidate/published six pass, focused checks and fresh review complete; the unchanged tokenjuice dependency finding stays disclosed. Exact-head CI/security pass, native immediate squash and native checkout closeout complete. The separate managed checkout remains retained by its lifecycle guard. Eight fewer test lines; production unchanged.

- [193114](https://github.com/openclaw/openclaw/pull/193114): Seven unseeded Run Inspector privacy-list entries removed; all ten cases and seeded privacy assertions remain. Original/candidate/published browser suites pass10/10; scoped checks and fresh review completed, CI32 success/28 skipped and exact security tuple passed. Local tokenjuice dependency failure and export-scan timeout/timing gaps remain disclosed. Squash `4bd434d2a5d4` verified; native checkout removed, managed carrier retained for shared-store contention. No cases removed.

- [193386](https://github.com/openclaw/openclaw/pull/193386): Typing-preview checks now target the animated caret, with active-animation controls before pause and reduced-motion checks. Both omitted CSS rules escape the original assertions and fail the repaired ones; all nine cases remain. Original/candidate/published suites and scoped checks pass; exact-head CI32 success/28 skipped and security pass. Squash `01a5e160dabf` verified; native checkout removed, managed carrier retained. No cases removed.

- [193846](https://github.com/openclaw/openclaw/pull/193846): Remove the orphan MCP gate waiter and its two declarations/three cases after the last runtime consumer retired. Both process cleanup bodies remain byte-identical; original five and candidate/published two pass. Scoped checks, unused-file scans and fresh review complete; the unchanged Talk export scan failure stays disclosed. Exact-head CI31 success/30 skipped and security pass. Squash `e1e3660a25da` verified; native checkout removed, managed carrier retained for shared-store contention. Removes 73 test and 63 support lines without new census credit.

- [193887](https://github.com/openclaw/openclaw/pull/193887): Remove the redundant Swift AnyCodable adapter and its dedicated case; the three CLI/schema/public-package keepers remain byte-identical. Original four and candidate/published three pass; the actual canonical 6,457-byte Swift input is unchanged. All scoped/removal checks and fresh review pass; exact-head CI27 success/30 skipped and security pass. Squash `30568bed81c4` verified; native checkout removed, managed carrier retained. Removes ten test and five support lines without new census credit.

## Current qualification

- X spend, pinned main `ee3ec605a59c`: remove one midnight reservation replay
  already covered by the stronger limits table row. The keeper also checks
  idempotent settlement, exhaustion and release; separate cases retain stored
  receipt periods, reset and restart coverage. Spend and API-consumer suites pass
  before/after on one Blacksmith Testbox (37→36 cases). Ten fewer test lines;
  production unchanged. Format, lint, types and both unused-file scans pass.
  Every dependency/export phase ran; unchanged Gateway, UI and changelog export
  findings remain. Exact-head CI and security passed;
  [194931](https://github.com/openclaw/openclaw/pull/194931) merged as `9a848bb13bfb`.

- OC Path, pinned main `a606a90b4bf5`: remove one malformed-line append replay
  and two newline counts implied by exact output equality. The unchanged JSONL
  edit/emission keepers retain object rendering, malformed/blank bytes, ordering
  and CRLF coverage. Four focused suites pass before/after (25→24 cases) on one
  Blacksmith Testbox. Ten fewer test lines; production unchanged. Format, lint,
  types and both unused-file scans pass. All dependency/export phases ran; the
  unchanged UI export findings remain. Exact-head CI and security passed;
  [194908](https://github.com/openclaw/openclaw/pull/194908) merged as `1a505759c0fe`.

Cua, pinned main `058133da525b`: remove the scalar scroll-enum type assertion
from the text/key dispatch case. The installed-SDK enum parity test, both
platform scroll mappings and the SDK forwarding case remain unchanged. Both
focused suites pass before/after (59→59 cases), with one fewer test line and no
production changes. Format, typed lint, extension types and both unused-file
scans pass. Both dependency phases and all three export phases ran with unchanged
Gateway, UI and release-tool findings. Exact-head CI and landing remain pending.

Batch115, pinned main `230f05c7ca37`, repairs the read-coalescing recorder
on the actual socket returned by the mock constructor. The unchanged browser
case passed; adding a positive assertion for its already-held `models.list`
request failed on the original observer. The repaired observer records that same
request and clears its exact ID on response. One final untraced full-file run
passed (1/1, 16.88s Vitest; 61.647s routed), preserving all existing request
counts, metadata/branch-read oracles and the global duplicate negative. A prior
in-memory diagnostic correlated 11 unique sends and 11 responses with the actual
Gateway fixture requests; no current overlap occurred. The historical overlapping
`sessions.describe` signature remains an unattributed lead, not a production
verdict or a repaired coalescing defect. The case inventory and source census are
unchanged. The +20-line allocation covers actual-instance hooks and the paired
held-request/response observer checks; production and shared fixtures are unchanged.
Targeted typecheck, typed lint, formatting and the exact growth allocation passed.
PR [194212](https://github.com/openclaw/openclaw/pull/194212) merged as
`838f4bfc4d83` after exact-head CI and security passed.

Diagnostics OTel, pinned main `b97bc15cd7af`: remove the retired NodeSDK
comparison helper after production moved to a private `BasicTracerProvider`.
Keep all 11 sampler rows, the case covering six span-limit variables, and the
unchanged real-OTLP start/stop/restart suite. Both suites pass before and after
(33→33 cases); 21 fewer test lines, production unchanged. Format, typed lint,
extension types and both unused-file scans pass. Both dependency phases and all
three export phases completed with unchanged Gateway, UI and release-tool
export findings. Exact-head CI and landing remain pending.

Core tool-result classification, pinned main `9b8aa392679f`: consolidate three
duplicate cases into the existing table that checks both classification APIs.
Carry all six distinct completed/failure/exit inputs into that table; preserve
every existing row and network-error, authenticated-error and hostile-reflection
case. The unchanged baseline passed all 28 cases in
[CI job 128652430604](https://github.com/openclaw/openclaw/actions/runs/42455052153/job/128652430604)
at `f4976c968539`; the owner, test, dependency and harness inputs match the pinned
base. The containing workflow failed elsewhere. The candidate has 31 expanded
cases, 11 rather than 14 declarations, and 20 fewer test lines; production is
unchanged. At `32cb09b3f0ee`, all 31 cases passed on both Node and Bun in
[CI job 128671390378](https://github.com/openclaw/openclaw/actions/runs/42461299705/job/128671390378);
its separate broker-child exit-code assertion failed. Core types and lint passed.
All seven removal-scan phases completed in
[CI job 128671385713](https://github.com/openclaw/openclaw/actions/runs/42461299705/job/128671385713).
Both unused-file scans were clean; export scans found only the unchanged UI
`EventLoadProgress` export, removed by incoming main during conflict integration.
The integration preserved the classification test and both production owners.
PR: [195114](https://github.com/openclaw/openclaw/pull/195114).

Batches113–118, pinned main `a07facd84480`, used one native checkout and
separate scoped proofs. Unchanged baselines passed: destinations6, History1,
read coalescing1, fallback8, dictation33 and annotation lifetime11.
Their execution added no source-classification credit; the completed frozen UI
source census is reconciled separately below.

- Batch116: collapsed two clone-only fallback-divider axes, preserving all five
  declarations, the distinct embedded/separate-answer vectors, cloned inputs,
  independent equality, identity, restoration and malformed/unknown-marker checks.
  Candidate6/6 passed versus baseline8/8; two redundant expansions were removed,
  with no new source-classification credit. No actual history reload is claimed.
- Batch117: both premature-close negatives now inspect the recorded method
  independently of RPC option arity. The same real-shaped three-argument close
  canary passed both old negatives and failed both repaired negatives; temporary
  calls were removed and the complete candidate passed33/33, retaining all19
  declarations and eventual-close assertions.
- Batch118: register raw pane retirement immediately after acquisition, before
  runtime startup. The existing UI unit diagnostic observed four retained listeners
  after the publication/Undo case on the baseline and none after the repair.
  All11 cases passed before and after, including explicit-disconnect/remount
  siblings; their duplicate retirement remains safe. The separate first-case
  theme-style warning persists. No persistent-process leak is claimed.
- Batch113: give the disconnect presence entry its node role and wait for the
  selected destination to become disabled. The original invalid event passed both
  rows while catalog reads stayed3→3 and the option stayed enabled; the same
  invalid event failed both strengthened rows. Restored valid fixtures passed6/6
  with every destination, draft, reconnect and terminal assertion retained.
- Batch114: match the History roster response to its Research query and assert
  the complete visible-row snapshot together. Original1/1 passed with both Main
  and Research visible; the repaired assertion rejected both an unfiltered result
  and an empty result. Restored1/1 passed through filtering, transcript navigation
  and archive/Undo feedback. This proves browser request/render behavior against a
  fixture response, not backend search correctness.
- Batch115 was excluded from the five-fix PR. A positive exact-request canary failed
  with the old recorder and passed after observing the actual returned socket.
  The final candidate run then exposed an overlapping `sessions.describe`
  request at the existing duplicate-negative assertion. The recorder candidate
  and failure evidence are retained locally; the primary is restored byte-for-byte
  to the pinned base. No assertion was weakened, no product repair was attempted,
  and no repair or removal credit is claimed for this nominee.

The five repaired targets passed57 actual cases (6+1+6+33+11). The unchanged
coalescing suite retains its baseline1/1 evidence separately. Net test growth is14
lines, covered by one exact per-change allocation; the shared ceiling is unchanged.
Scoped UI types, typed lint, formatting, ledger MDX, whitespace and the test-line
ratchet passed. All three required removal scans passed with zero unused
dependencies, files or exports. The simplification pass preserved CSS visibility
in the settled History assertion; its final full browser flow passed again.
Independent review passed. [193906](https://github.com/openclaw/openclaw/pull/193906)
merged as `36e52993c9f8` after exact-head CI42155732506/attempt1 and matching
Security Review42156442602 succeeded; the57-case result above is actual scoped proof.

[192672](https://github.com/openclaw/openclaw/pull/192672) merged as
`285829cbf027` after corrected head `d80ab31b2a31` passed fresh review,
CI42158728018/attempt1 and matching Security Review42159692871. Its two HTTP502
landing responses and later ledger-conflict refusal remain historical recovery
evidence. The original five-case baseline, repaired suite and published-head proof
passed; the identical early-failure probe observed the original client retained
after hooks and the repaired client released, preserving all four siblings and
shutdown assertions. The correction preserved those test/allocation bytes and
baseline ledger history. Its local install inputs were unqualified, so no current
five-case execution or inventory is inferred from hosted aggregate success. Native
checkout removal was verified; the managed carrier was retained on shared-lock
contention, separately from completion.

[192719](https://github.com/openclaw/openclaw/pull/192719) qualification snapshot:
the original two-case baseline and repaired candidate passed. Identical temporary
config/admin guard omissions stayed green with the original fixtures and failed
only the intended repaired row; a separate enabled/admin/advertised browser probe
recorded one actual `terminal.open`. All production mutations were restored.
This is browser proof against an owned mock Gateway, not live terminal execution.
Original CI41819244430/attempt1 failed at workflow level with31 successful and28
skipped jobs and no aggregate; its Internal server error was subsequently
identified. The single whole-run recovery, attempt2, and matching Security
Review42157590390 succeeded on original head `6c2e2c648d77`.
The correction integrates baseline `285829cbf027`, resolves only the ledger
conflict, and retains the baseline's current terminal-unavailable wording while
carrying forward the capability fixture and its unchanged four-line allocation.
Old-head runtime and CI proof remain historical. Fresh corrected-head review,
hosted CI and matching security evidence are required by native admission; the
linked PR and native receipts record that qualification and landing disposition.
No corrected-head runtime pass or landing is claimed by this snapshot.

## Completed source review

These are local owner/support/caller/history/static-route closures at source census
`7c99ae1dd417`, with bounded transitive framework dependencies. Counts are scoped,
not additive when an aggregate overlaps a row. R=retain; F=repair proof/custody;
C=transfer assertions before consolidation; D=qualify deletion. Candidates are not
permission to delete without root qualification.

- Packages: All 471 suites read: normalization26; retry/tool repair8; media-understanding/generation common5; net-policy4; plugin SDK/workboard2; session URL3; ACP/worker11; media/LLM15; catalog/terminal21; Markdown11; Gateway client20; agent25; protocol88; AI172. Preserve wire, prompt-byte, Unicode, identity, process, lifecycle and package contracts.
- Memory host / SDK: Memory48 and SDK11 suites closed; only qualified reductions above. Stable borrowed references, independent coarse text boundaries and actual Gateway ownership remain.
- Routing, utility, startup: Routing/pairing19; utility/support35; poll/startup/picker8. No additional supported deletion.
- Core shared/state: Shared111/490 declarations; transcripts28; boards/projects23; worker36 entry files plus7 registrars; audit16/118; process118/577; MCP/proxy26/130. Preserve actual storage, worker/process, ownership and ordering proof.
- Core content/runtime: Templates31/230; logging64/465; meeting bot30/183 direct+inherited; hooks41; TTS23; media-understanding43/241; context/chat/Canvas19/139; generation19/103; web/fetch8/69; status/storage25/207; realtime1/13.
- Core setup/tools: Bootstrap/provider/interactive/plugin state21/179; daemon127/920; Talk39/250 plus inherited table; wizard30/239; security46/181; model commands35/215; catalog/memory SDK7/71; Doctor118/673.
- Core entrypoints: Root src25; root docs/scripts21/63; direct channels103; CLI Gateway31/246; admin/share/Bonjour8/41. Deeper nested channel owners remain open.
- Agent internals: all 2,347 suites under `src/agents`/15,973 physical sites: R15743/F224/C2/D4. Zero unread in this scope; other `src` directories remain separate. All83 registry and 58 sandbox suites are source-closed; tool display/schema and process custody retain their contracts. Separate reply/upstream scopes below. Preserve transport, requester isolation, authority, cancellation, durability and work-count contracts.
- Auto-reply: All429 suites plus43 separate upstream suites and invoked local registrars/support classified. Latest54/498: R495/F2/C1; qualified two duplicates landed above. Keep channel persistence, group/native routing, progress suppression and abort cases.
- CLI: Config/setup24/209; plugin lifecycle25/176; validation22/106; channel/root/message/device/skills/session98/542; execution/reply presentation overlaps the reply aggregate. Only qualified fixture reduction landed above.
- Control UI: all3,046 unique suites are source-closed through UI1250, with zero unread;16,257 physical sites: R12988/F3261/C1/D7. This reconciles the completed frozen `7c99ae1dd417` census, not new runtime or removal credit. Shared `page-request.node.test.ts` is counted once. Preserve native geometry, owner replacement, GC retention and conflict/authority contracts. The shared runner owns clocks and normal file mock restoration; six local cleanup nominations were withdrawn after owner inspection. Held-reply custody remains independent. Unqualified proof/custody repairs remain follow-ups; source closure does not imply runtime completion.
- Shared native: OpenClawKit209 files/2,528 sites: R2523/F3/C2. NativeState/MLX protocol5/46: R45/F1. Swabble6/12 R; MLX helper1/5 with one pending PCM consolidation.
- macOS: 304 Swift files/2,653 sites: R2635/F8/C9/D1. Native runtime qualification pending.
- iOS: 135 files/1,416 sites: R1370/F39/C6/D1; obsolete typography metadata scanner and a migration helper remain candidates. Native qualification pending.
- Android: Source classification complete: 324 declaration files/4,160 sites/143,748 test LOC: R4029/F107/C20/D4. All15 original support/assets read, another2,138 LOC. No unread declarations remain; native runtime/fault qualification remains pending.
- Provider plugins: Alibaba/Arcee/Cerebras/GMI/Qianfan/StepFun/Voyage/DuckDuckGo8/41; Fireworks/NVIDIA/Together/Novita13/45; Cohere/Featherless/Groq/LongCat/SGLang/SubQ12/33 retained.
- Further providers: Bedrock/OpenCode/Copilot/LM Studio/Kimi/Moonshot/ClawRouter/OpenRouter/Qwen/Venice/Microsoft/Foundry/Azure128/848: R847/F1; Vertex/Mantle11/62 R; Perplexity/DeepSeek/Mistral/Hugging Face17/69 R.
- Other audited plugins: Voice-call64/523 R522/F1; Nostr14/112 R; Prometheus7/55 R; IMAP/A2A13/103 R; MXC13/64 R61/F3; DeepInfra17/78 qualified above; MiniMax13/75 R74/F1.
- Plugin service owners: File Transfer21/162 R161/D1; active-memory11/122 R; Synology10/91 R; OpenShell11/88 R; Diagnostics OTel12/86 R83/F1/C2; AgentsAPI10/96 R; Cua12/83 R. All local support/assets live.
- Later plugin closures: LanceDB22/109 R; Logbook13/55 R; IRC15/99 R97/F2; Diffs14/58 R56/F1/C1; policy15/301 physical R298/F3; SMS16/158 R; team-reports21/138 R; Twitch15/86 R; TypeSafe10/50 R; X24/149 R148/C1; Zalo25/89 local R87/F2 plus9 inherited R and one duplicate row. Assertion-only candidates below do not remove their declarations.
- Plugin lane progress: the frozen aggregate checkpoint is Leaf4,305/combined4,379; no aggregate is inferred from the updated scoped closures below. Memory Core201/201 is source-closed:1,282 normalized physical sites R1159/F123 and1,900 expanded cases R1738/F160/C2, including inherited registrations once; all9 PostgreSQL suites are source-only, with no runtime claim. Matrix156/156 is source-closed:1,063 physical sites R945/F117/C1 and1,578 expanded cases R1427/F150/C1; all30 local support surfaces remain live. PostgreSQL proof remains source-only. 15 support-custody findings and support-removal nominations are separate. QA Lab329/329 is source-closed:1938 physical sites R1813/F125/C0/D0 and2989 expanded cases R2812/F177, including one inherited registration counted once; all52 local support files remain live; 40 support proof/custody findings are separate; no runtime claim. Telegram167/167 is source-closed:1,265 normalized physical sites R1117/F148 and2,112 expanded cases R1903/F209, including15 inherited sites/20 registrations counted once; all48 auxiliaries (45 local supports and three root facades/drivers) remain live and31 support proof/custody findings are separate. Discord257/257 is source-closed:1789 physical sites R1596/F193 and2648 expanded cases R2363/F285; its80 auxiliaries remain live and 24 support findings are separate. Codex448/448 is source-closed:157,630 entry LOC,3260 physical sites R3083/F177 and5397 expanded cases R5166/F231, including invoked registrars counted once; 7 support-custody findings are separate; native/worker execution remains unqualified. Two earlier source credits were duplicates after incorrect app-server path prefixes; unique counts above remove those credits and retain the later closures. No Codex suites remain unread; runtime qualification remains separate. Browser280/280 is source-closed:2,006 physical sites R1764/F242 and3,243 expanded cases R2909/F334; actual runtime qualification remains separate. Slack155/155 is source-closed:1,268 direct sites R1258/F10 and1,828 static invocations R1813/F15; all21 auxiliaries and seven live traces remain. MS Teams107/107 is source-closed. WhatsApp103/103 and Feishu104/104 are source-closed; their authority, timing and custody proof repairs remain follow-ups. OpenAI99/99 is closed:744 direct/support sites R737/F5/C2,1,238 static invocations R1228/F8/C2. Its18 supports and packaged icons remain live. Knowledge59, iMessage60, Workboard65, LINE61, Mattermost56, Signal44, memory-wiki50 and Crabbox53 are closed. Keep identity, transport, cache, compiler, storage, interaction and mutation contracts. Source-only; no runtime verdict.

- Exact root/scripts records cover129 accepted paths (reconciled from the earlier117), including: the seven earlier retention/APNs/appcast/architecture/Buzz/descendant/channel-read records, the ClawRouter managed-Gateway fixture, all ten `cli-json-stdout` entry suites, CLI message authority, SQLite maintenance, provider-stall cancellation and Codex account usage, managed proxy and node cancellation. The latter four retain1/1,1/2,1/3 and1/1 physical/expanded cases respectively. All are source-only records and add no aggregate credit: overlap with older root/docs/scripts summaries is unresolved. The gross test/scripts inventory remains1,606 candidate paths, not certified unread paths.

### Current-source script follow-up

At `e08aa74ea39e35d01ba8e8f84e317747aba1bf3f`, eight suites added after the frozen
census were reviewed with their owners, relevant callers, support and history.
All 23 declarations / 36 expanded cases are retained. These are standalone
counts, not additions to the overlapping root/scripts aggregate. This is source
review only: no runtime qualification, test removal or production change.

| Suite under `test/scripts/`           | Declarations / cases | Retained contract                                                                                                             |
| ------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `generated-output-utils.test.ts`      | 5 / 12               | Exact write/check results, empty output, one-read cost, metadata/mode preservation and real blocked-parent errors.            |
| `package-root-modules.test.ts`        | 3 / 3                | Independent parser oracle, packaged sibling imports and transitive closure with a missing-file diagnostic.                    |
| `perf-gc-collections.test.ts`         | 1 / 1                | Inclusive start/exclusive end, append behavior across observer batches and the next measurement window.                       |
| `setup-node-env-git.test.ts`          | 5 / 7                | Actual setup shell, privilege selection, bounded installation, capability recheck and failure propagation.                    |
| `shared-fixture-isolation.test.ts`    | 2 / 3                | Real enclosing Git repositories, ignored archive discovery and an authoritative empty root index.                             |
| `stylelint-selector-indexing.test.ts` | 5 / 5                | Selector semantics and normalized allowances scoped by identity, file, context and occurrence count; stale-allowance removal. |
| `vitest-declared-inputs.test.ts`      | 1 / 2                | Real dependency recording and selected-versus-full failure oracles for archive and manifest inputs.                           |
| `vitest-worker-run.test.ts`           | 1 / 3                | Borrowers settle after close, listeners detach and disposal preserves failures, including rejection before readiness.         |

The package parser oracle cannot replace manifest membership or missing-file
proof. Mocked inventory and UI coordinator tests cannot replace the real nested
Git and worker-owner boundaries. No safe consolidation was identified.

### Adaptive CI follow-up

At `9bdea97f3c1589841d1c1cf81a9bea7ae70886aa`, eight adaptive-CI suites were
reviewed with their owners, callers, support and history: 40 declarations / 85
expanded cases. These standalone counts do not add to the overlapping
root/scripts aggregate. No safe removal or consolidation was identified.

| Suite under `test/scripts/`      | Declarations / cases | Retained contract                                                                                                 |
| -------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ci-adaptive-costs.test.ts`      | 7 / 7                | Setup and audit costs, per-execution billing rounding, unknown prices and real CLI output.                        |
| `ci-adaptive-selection.test.ts`  | 4 / 11               | Full scheduled inventory, conservative fallback, incomplete history and recommendations that only add candidates. |
| `ci-adaptive-decisions.test.ts`  | 1 / 2                | Revision/tree-bound comparisons in shallow checkouts and dirty-checkout fallback.                                 |
| `ci-adaptive-evaluation.test.ts` | 4 / 10               | Project-qualified outcomes, unavailable evidence, source/timing validation and CLI reports.                       |
| `ci-adaptive-priors.test.ts`     | 8 / 29               | Bounded tree comparisons, artifact provenance, cutoff, consumer identity and unavailable-network fallback.        |
| `ci-adaptive-model.test.ts`      | 2 / 2                | Project-qualified dependencies, unknown inputs, validated model data and outcome-independent ranking.             |
| `ci-adaptive-jev.test.ts`        | 5 / 13               | Opaque identity, complete responses, provider fallback, shared deadline and usage accounting.                     |
| `ci-adaptive-markdown.test.ts`   | 9 / 11               | Content-qualified omissions, changed dependencies, symlinks and a shared selection graph.                         |

Three fixture repairs retain the existing declarations: give same-path projects
different dependencies; run invalid-tree cases against an isolated, bounded Git
tree with a successful control; preserve the comparison tree when changing only
the base revision. Previously the latter two checks could reject at unrelated
guards. The source classification was R77/F8 expanded cases, with no C/D cases.
All eight suites passed on the original and repaired tests (85 cases) with
Node 26.13.0 on macOS. Eight deliberate owner mutations escaped the original
tests and failed the repaired tests: project identity, tree identity,
completeness, path, mode, duplicate path, byte bound and comparison base.
Source bytes were restored after each mutation. No production code changed.

### CI observation and timing follow-up

At `2d5b14db1a64086d838c3f6a096a29900c299dfb`, four suites were reviewed with
their owners, callers, support, history and CI routing: 23 declarations / 34
expanded cases. These standalone counts do not add to the overlapping
root/scripts aggregate. All cases remain; no safe deletion or consolidation
was identified.

| Suite under `test/scripts/`        | Declarations / cases | Retained contract                                                                                                                                         |
| ---------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci-test-observations.test.ts`     | 14 / 17              | Checkout identity, immutable launch inputs, native outcomes, dependency graphs, bounded exports, privacy, malformed evidence and the real export command. |
| `ci-shard-timings-refresh.test.ts` | 3 / 11               | Runtime-specific wall costs, selection identity, runner exclusions and unchanged timing bytes on invalid evidence.                                        |
| `vitest-shard-timings.test.ts`     | 4 / 4                | Duplicate ownership rejection, whole-config identity, reordered selection history and named-shard duration persistence.                                   |
| `weighted-test-shards.test.ts`     | 2 / 2                | Deterministic weighted assignment across batches and rejection of an empty shard list.                                                                    |

One mixed declaration retains its interrupted/missing-dependency proof and
repairs the unavailable-repository control. Previously it sent a terminal event
without inventory, rejecting before any repository read. It now sends valid
inventory and requires the existing snapshot to remain byte-identical.
The named-shard timing test is renamed to describe its duration roundtrip;
unused persisted metadata fields are not restored as incidental assertions.
All four suites passed on the original and repaired tests (34 cases) under
Node 26.13.0 on macOS. A deliberate owner mutation that ignored the configured
repository root passed the original control and failed the repaired snapshot
assertion. Production and test bytes were restored after the mutation.
The baseline took 28.67 seconds and the candidate 22.67 seconds wall time;
these single runs establish correctness, not a performance improvement.

### PR preparation follow-up

At `3f805fa2e950994cdad3f9e857eb966cf5fa8103`, three preparation suites were
reviewed with their owners, callers, support, history and CI routing:
24 declarations / 56 expanded cases, with R53/F3 by expanded case.
These standalone counts do not add to the overlapping root/scripts aggregate.

| Suite under `test/scripts/`    | Original declarations / cases | Retained contract                                                                                                    |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pr-prepare-preflight.test.ts` | 2 / 12                        | Mode selection and real wrapper rejection before observations, locks or evidence retirement.                         |
| `pr-prepare-testbox.test.ts`   | 5 / 13                        | Remote argument normalization, input rejection, ordered stages, receipt integrity and last-success selection.        |
| `pr-prepare-gates.test.ts`     | 17 / 31                       | Local and hosted qualification, source/alias authority, Git publication, evidence replacement and workspace pinning. |

The stamp fixture now has two valid successes, so it distinguishes first-match
from last-match selection. The runtime-commit case requires exact-head verifier
dispatch as well as excluding parent reuse. The existing local-build fixture
now runs real workspace pinning and checks its plugin root at bootstrap;
the mock-only ordering case is consolidated into that keeper.
The candidate has 23 declarations / 55 expanded cases and 12 fewer test lines.
Qualification at `ac87d3b362f43d24e25aebbb241dfb7dd692e14a` used an independently
installed native PR checkout. The baseline passed all 56 cases (140.94 seconds
wall time); the candidate passed all 55 (108.38 seconds). These single runs do
not establish a speedup. A separate changed-suite run passed 43 cases in 23.52
seconds wall time: gates reported 6.495 seconds and Testbox 15.010 seconds.

Selected original tests passed with first-success stamp selection, skipped
exact-head verification and no-op real pinning. Their repaired keepers failed
under those same mutations. Reversing pin/bootstrap order failed both the old
ordering test and its keeper. The pinning mutations stopped before commands
were recorded and surfaced as a missing fixture commands file; the other two
failed their stamp and verifier assertions. All production and test bytes were
restored exactly after qualification.

Targeted tooling typecheck, lint, formatting and diff checks passed. The
production and full-tree unused-file scans passed with zero entries. Both
`deadcode:dependencies` (its export phase) and `deadcode:exports` reported exports
in four untouched files: `src/daemon/launchd.ts`,
`src/plugins/provider-external-auth.ts`, `src/plugins/provider-runtime.ts` and
`ui/src/pages/dashboards/dashboard-tools.tsx`. Script unused exports passed with
zero entries. The four files and both Knip configurations match the frozen base;
these unrelated findings remain recorded rather than expanding this patch.

Independent preservation review and full local ClawSweeper review found no
lost contract or actionable source finding. Hosted CI and landing remain
pending; local proof does not establish either.

### PR gate changed-test routing

At `ee9f6b4d5e0cd405a399b706b071a0e9998ef67f`, changing
`scripts/pr-lib/gates.sh` selected nine explicit test owners but omitted
`pr-prepare-testbox.test.ts`. One owner entry restores that suite in ordinary
local selection and bounded CI selection without changing discovery policy.

One parameterized regression in the existing routing suite covers both modes;
the bounded case also requires Testbox in the declared owner targets. Both cases
failed on the omitted target before the repair and passed afterward in an
independently installed native checkout. The focused baseline took 14.43 seconds
wall time and the repaired run 9.95 seconds; these single runs are correctness
evidence, not a performance comparison. The routing and planner suites passed
all 324 cases together in 109.94 seconds wall time.
The changed routing file separately passed all 114 cases in 33.08 seconds wall
time (31.29 seconds Vitest duration). It exercises real checkout inventories,
import-graph selection and subprocess routing; this repair adds no new fixture
or subprocess, and its bounded case retains the real CI selection boundary.

The regression adds 13 test lines, recorded in its own allocation. It adds no
fixtures, mocks, timers or parallel discovery path. Independent source review
found no lost contract or unnecessary scope. Targeted tooling typecheck, lint,
formatting, source-line and test-line ratchets passed. Full local ClawSweeper
review of `6c07f87ef1c397281053836c97af0968d3e6be01` found no actionable issues.
Hosted CI and landing remain pending.

### Diagnostics OTel content-capture completion proof

At `7814aa8d127a93d136cda3445d109b79c9edb43b`, three capture-disabled rows
accepted missing span attributes as an empty object. One shared outcome
assertion now requires terminal telemetry before checking private-content
absence. It also rejects unfinished run/harness spans exported during shutdown.
Both declarations and all nine cases remain, including multiline redaction;
production and shared helpers are unchanged. One test line is allocated.

The unchanged nine-case file passed in 38.55 seconds wall time, including a cold
compiler preparation. Independently suppressing terminal tracing when capture
was disabled made each original message, run and harness row pass; each repaired
row failed on the absent completed outcome. All three producer mutations were
restored byte for byte. The repaired nine-case file passed in 37.33 seconds wall
time (32.40 seconds Vitest duration; assertions took 27 ms). Independent
preservation review and full local ClawSweeper review found no actionable issues.
Extension-test typecheck, typed lint, formatting, diff and both line-budget checks
passed. Hosted CI and landing remain pending. These are correctness timings,
not a speedup claim; real recorder/SDK export proof retains its existing compiler setup.

### CLI source-helper multiplicity

At `df5a2f36076fe50335487abc806d70d6fbfe3cfc`, removed the repeated-import
multiplicity case: one declaration/case and 16 test lines. The sole consumer,
command secret-resolution coverage, uses membership and regex predicates across
17 cases and never counts occurrences. Keep the re-export/runtime traversal
case, the helper and its visited-module guard unchanged. The retired fixture
contains no cycle and does not prove termination.

The unchanged 19-case baseline passed in 9.28 seconds wall time. Duplicating
nested source failed only the retired case; the keeper and all 17 consumer cases
passed. Omitting runtime traversal failed the keeper on its missing marker.
Both mutations were restored byte for byte. The final 18 cases passed in 6.48
seconds; these single runs do not establish a speedup. Actual routing uses
unit-fast for the consumer and CLI for the helper.

Independent preservation review and full local ClawSweeper review of
`86b364415dd872e4aca25f3ff3a31d46a5eec091` found no actionable issues. Targeted
CLI-test typecheck, typed lint, formatting and diff checks passed. Production
and support line counts are unchanged. Full dead-code scans and hosted/landing
outcomes are tracked in [PR #197639](https://github.com/openclaw/openclaw/pull/197639).

### Tool-result fidelity at each output

At `a41c7111235fdfcb5e4103edba0e5ff711d7e02c`, the single tool-result reuse
case mixed trajectory, callback and terminal values and searched for a secret
also present in metadata. Its persistence check had the same weakness. The
repair keeps both existing completion routes and independently asserts complete
text and metadata at every output. It preserves the distinct stored/display
image contracts, awaits the session append and removes the direct sanitizer
replay plus an unused mock-reset hook. No production or support code changes;
the physical and expanded case counts both remain one.

The original case passed with `sanitizeToolResult`'s text output deliberately
emptied (488.40 seconds). The repaired case rejected the same fault at its first
trajectory assertion (135.74 seconds). Both mutations were restored byte for
byte. Baseline owner/sibling proof passed all 50 cases (555.94 seconds). The
original ran in agents-core; the repaired case routes to unit-fast. These
single runs, with different worker-cache states, do not establish a speedup.

The clean repaired case passed (330.24 seconds). Independent preservation
review and full local ClawSweeper review of
`dbdea04a67b99b9541ea64fba03de9a10a3cfe3f` found no actionable issues. The
agents-root test typecheck, typed lint, formatting and diff checks passed.
Full dead-code scans and hosted/landing outcomes are tracked in
[PR #197771](https://github.com/openclaw/openclaw/pull/197771).

### CLI patch fixture cleanup on write failure

At `9cfa4b5ff744da4e7133c53dfea287abdba1c223`, `readPatch` allocated its
temporary directory and wrote the fixture before entering its cleanup block.
An injected `ENOSPC` write failure preserved the original error but left the
directory behind. Moving the write into the existing `try` gives allocation
one cleanup owner even when fixture setup fails. No production code, test
declarations, inputs or assertions change; all eight declarations and 13
expanded cases remain.

The repaired helper removes the directory under the same injected write
failure and preserves the exact error. Baseline and repaired CLI suites pass
all 13 cases (67.87 and 13.25 seconds respectively; different compiler cache
states, not a measured speedup). Scoped CLI test typecheck, typed lint,
formatting and diff checks pass. Independent preservation review found no
coverage loss. Full local review and hosted outcomes are tracked in
[PR #198020](https://github.com/openclaw/openclaw/pull/198020).

### Plugin install fixture setup cleanup

At `ee854a1d757943482bb6361c7ccd4f560c8fc92e`, four temporary roots in
`plugins-install-config.test.ts` perform fallible setup before entering their
cleanup blocks. They now register with the existing per-test temp directory
tracker before setup. The cwd spy keeps its own restoration. All 20
declarations, 23 expanded cases, inputs and assertions remain; test code shrinks
by 11 lines, with no production or support changes.

The normal suite passes all 23 cases before and after the repair. Under four
injected fixture-write failures, both revisions report the same four errors
and preserve the other 19 cases. An `onTestFinished` observation finds all four
roots still present on the base and none after the repair. The runner already
reclaims its entire namespace at process exit; this repairs per-case retention,
not a permanent host leak. Temporary instrumentation was restored byte for
byte. Independent preservation review found no lost coverage. Focused checks,
full local review and hosted outcomes are tracked in
[PR #198138](https://github.com/openclaw/openclaw/pull/198138).

Adjacent source review retains the existing custody in `dns-cli.test.ts`,
`node-cli/identity.test.ts`, `plugins-control-ui-build.test.ts` and
`secrets-store-input.test.ts`. Their roots are registered before setup, or their
database/FIFO owners settle before removal; no runtime claim is made for them.

### Filesystem capability probe error reporting

At `3ead3dcb1b3a3755197cc7aaaa2fc248b6f0298f`, the install-path symlink
probe suppresses every setup error, and the two safe-bin case-sensitivity
probes return successfully on unexpected filesystem errors. The repair limits
capability exclusions to the relevant operation and expected error codes. Setup
and cleanup errors propagate; case-sensitivity exclusions become explicit skips.
All 24 declarations, 32 expanded cases and boundary assertions remain. No
production or shared support changes; test code grows by 16 lines.

The original suite reports 32 passes. With the repair it reports 31 passes and
one explicit filesystem exclusion previously counted as a pass. The original
stays green under injected allocation, symlink, cleanup and both case-probe
errors; the repair fails on each. Expected unsupported-symlink and
case-sensitivity controls still pass with explicit skips. All temporary
instrumentation was restored byte for byte. Independent preservation review
found no coverage loss. Focused checks, full local review and hosted outcomes
are tracked in [PR #198154](https://github.com/openclaw/openclaw/pull/198154).

### Binary discovery oracle errors

At `da0e0ba8cae139938cba66ff96e1f794c48acf12`, two binary-discovery tests
interpret every `which` error as a missing executable. The repair preserves
real resolver parity while accepting only the expected exit status 1 without a
signal. Fixed fixture outcomes are asserted independently, so two broken
lookups cannot agree on a false negative. All 11 declarations and 19 expanded
cases remain; test code grows by four lines, with no production or support
changes.

Normal baseline and repaired runs pass all 19 cases. Replacing negative lookup
results with real child-process launch errors, exit status 2 or signal
termination leaves the original green; each repaired control fails the two
affected cases. A paired false-negative mutation of `which` and `detectBinary`
also passes the original but fails both repaired positive controls. Temporary
test and production instrumentation was restored byte for byte. Independent
preservation review found no lost coverage. Focused checks, full local review
and hosted outcomes are tracked in
[PR #198168](https://github.com/openclaw/openclaw/pull/198168).

## Pending qualification and proof repairs

- Keep source-only candidates separate from applied removals. Obsolete fixture candidates require current-owner and runtime qualification. Retain Twitch's pre-abort pending check: it protects the passive account lifecycle. Its post-await settled check remains a separate live-test cleanup candidate.
- Transfer rows before consolidating Android loading/blank-auth, persisted outbox keys/epochs, terminal initial projection, and native PCM/decoder/reader cases. Keep typed host-error precedence and active-run settlement.
- Retain the CodeMode worker-leg deadline case: its real warmed worker and interruption path are distinct from the cancellation table's typed host-error precedence. Both suites keep their active-run settlement checks; this is a source-only retention decision.
- Repair Android runtime/model fixture custody through existing guaranteed closers; no measured leak is claimed. Retarget misleading coroutine/authority/streaming assertions. Qualify Android dropdown arithmetic, IPv6 URL, empty SMS defaults and component-state mapping against their stronger keepers.
- Repair swallowed/unrelated setup errors, silent auth/symlink skips, SSRF negative controls, content-absence/privacy results, delayed observer proofs, missing CLI fixture cleanup. Retain CI inventory gaps as route repairs, including PostgreSQL conformance and removed Logbook worker paths.
- Diagnostics OTel: the NodeSDK replay removal remains qualified above; content capture completion proof is recorded separately above.
- SDK removal search was incomplete: public2,115/2,527 complete and bundled169/179 complete. No observed consumer is not proof of no external reliance. The retired target facade was private and excluded from packaging since `780bc791470`.
- Retain duplicate Swift TLS fixtures in separate packages, renderer-discovered Blobster JSON (also production prompt inputs), process-entry helpers referenced extensionlessly, stable borrowed-reference assertions, and independent release/architecture/platform guards.
- CI merge-preparation source/comment candidates remain pending Linux keeper proof; the independent Git-owner admission guard stays. Do not treat a stopped Testbox allocation as a product result.

Remaining: classify unread core/plugin/native/script declarations and shared
fixtures; qualify candidates at their actual boundaries; validate and land owner
batches. Source review alone does not close the repository-wide audit.
