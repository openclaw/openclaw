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

## Current qualification

Pinned main 3f678742aaf7: compare Matrix account defaults with independent
original literals instead of the post-call input object.
All five declarations, seven cases, inputs and named-account assertions remain.
Only the two expected-value expressions change; no production change.

The untouched official baseline passes all seven cases: command wall 163.26s,
Vitest 2.55s. Actual DM and room-default overwrites each pass the original
comparison and fail the repaired expectation. Each control selects the existing
named-account case; the other six cases are skipped.
Both production and original test bytes are restored exactly after the controls.
The clean repaired candidate passes all seven cases in 2.38s.

Typed lint, scoped types, format, ledger MDX and whitespace checks pass.
Every other selected test byte and the test-line baseline remain unchanged.
Zero net test lines; no new test, helper or production change.
Fresh review, final published proof and native CI remain pending.
No new input-immutability, migration, public API or state contract.
No live Gateway, provider, browser or PostgreSQL runtime claim.

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
- Agent internals: 1,800 unique suites/12,540 physical sites: R12458/F77/C1/D4. All83 registry and 58 sandbox suites are source-closed; tool display/schema and process custody retain their contracts. Separate reply/upstream scopes below. Preserve transport, requester isolation, authority, cancellation, durability and work-count contracts.
- Auto-reply: All429 suites plus43 separate upstream suites and invoked local registrars/support classified. Latest54/498: R495/F2/C1; qualified two duplicates landed above. Keep channel persistence, group/native routing, progress suppression and abort cases.
- CLI: Config/setup24/209; plugin lifecycle25/176; validation22/106; channel/root/message/device/skills/session98/542; execution/reply presentation overlaps the reply aggregate. Only qualified fixture reduction landed above.
- Control UI: 1,620 unique suites/10,333 physical sites: R7716/F2609/C1/D7. Agents Memory, Memory Import, Workshop, Systems, About and Worktrees retain their contracts; shared `page-request.node.test.ts` counted once. Preserve native geometry, owner replacement, GC retention and conflict/authority contracts. Proof/custody repairs remain pending; other UI remains open.
- Shared native: OpenClawKit209 files/2,528 sites: R2523/F3/C2. NativeState/MLX protocol5/46: R45/F1. Swabble6/12 R; MLX helper1/5 with one pending PCM consolidation.
- macOS: 304 Swift files/2,653 sites: R2635/F8/C9/D1. Native runtime qualification pending.
- iOS: 135 files/1,416 sites: R1370/F39/C6/D1; obsolete typography metadata scanner and a migration helper remain candidates. Native qualification pending.
- Android: Source classification complete: 324 declaration files/4,160 sites/143,748 test LOC: R4029/F107/C20/D4. All15 original support/assets read, another2,138 LOC. No unread declarations remain; native runtime/fault qualification remains pending.
- Provider plugins: Alibaba/Arcee/Cerebras/GMI/Qianfan/StepFun/Voyage/DuckDuckGo8/41; Fireworks/NVIDIA/Together/Novita13/45; Cohere/Featherless/Groq/LongCat/SGLang/SubQ12/33 retained.
- Further providers: Bedrock/OpenCode/Copilot/LM Studio/Kimi/Moonshot/ClawRouter/OpenRouter/Qwen/Venice/Microsoft/Foundry/Azure128/848: R847/F1; Vertex/Mantle11/62 R; Perplexity/DeepSeek/Mistral/Hugging Face17/69 R.
- Other audited plugins: Voice-call64/523 R522/F1; Nostr14/112 R; Prometheus7/55 R; IMAP/A2A13/103 R; MXC13/64 R61/F3; DeepInfra17/78 qualified above; MiniMax13/75 R74/F1.
- Plugin service owners: File Transfer21/162 R161/D1; active-memory11/122 R; Synology10/91 R; OpenShell11/88 R; Diagnostics OTel12/86 R83/F1/C2; AgentsAPI10/96 R; Cua12/83 R. All local support/assets live.
- Later plugin closures: LanceDB22/109 R; Logbook13/55 R; IRC15/99 R97/F2; Diffs14/58 R56/F1/C1; policy15/301 physical R298/F3; SMS16/158 R; team-reports21/138 R; Twitch15/86 R; TypeSafe10/50 R; X24/149 R148/C1; Zalo25/89 local R87/F2 plus9 inherited R and one duplicate row. Assertion-only candidates below do not remove their declarations.
- Plugin lane progress: Leaf3,119 suites/141 closed owners; combined3,193 suites/174 directory owners plus the closed root boundary. Memory Core201/201 is source-closed:1,282 normalized physical sites R1159/F123 and1,900 expanded cases R1738/F160/C2, including inherited registrations once; all9 PostgreSQL suites are source-only, with no runtime claim. Matrix156/156 is source-closed:1,063 physical sites R945/F117/C1 and1,578 expanded cases R1427/F150/C1; all30 local support surfaces remain live. PostgreSQL proof remains source-only. 15 support-custody findings and support-removal nominations are separate. QA Lab87/329 is source-closed:525 physical sites R502/F23/C0/D0 and865 expanded cases R835/F30; all14 local support files remain live; 3 support-custody findings are separate; no runtime claim. Remaining1,114 suites/4 owners; runtime qualification remains separate. Browser280/280 is source-closed:2,006 physical sites R1764/F242 and3,243 expanded cases R2909/F334; actual runtime qualification remains separate. Slack155/155 is source-closed:1,268 direct sites R1258/F10 and1,828 static invocations R1813/F15; all21 auxiliaries and seven live traces remain. MS Teams107/107 is source-closed. WhatsApp103/103 and Feishu104/104 are source-closed; their authority, timing and custody proof repairs remain follow-ups. OpenAI99/99 is closed:744 direct/support sites R737/F5/C2,1,238 static invocations R1228/F8/C2. Its18 supports and packaged icons remain live. Knowledge59, iMessage60, Workboard65, LINE61, Mattermost56, Signal44, memory-wiki50 and Crabbox53 are closed. Keep identity, transport, cache, compiler, storage, interaction and mutation contracts. Source-only; no runtime verdict.

## Pending qualification and proof repairs

- Keep source-only candidates separate from applied removals. Obsolete fixture candidates require current-owner and runtime qualification. Pending: X midnight-spend replay; Cua enum and Twitch settled flag; OC Path malformed-line replay and repeated round-trip assertion. Each needs current-source and runtime keeper qualification.
- Transfer rows before consolidating core failed-tool classification, CodeMode deadline duplication, Android loading/blank-auth, persisted outbox keys/epochs, terminal initial projection, and native PCM/decoder/reader cases. Keep typed host-error precedence and active-run settlement.
- Repair Android runtime/model fixture custody through existing guaranteed closers; no measured leak is claimed. Retarget misleading coroutine/authority/streaming assertions. Qualify Android dropdown arithmetic, IPv6 URL, empty SMS defaults and component-state mapping against their stronger keepers.
- Repair swallowed/unrelated setup errors, silent auth/symlink skips, SSRF negative controls, content-absence/privacy results, delayed observer proofs, missing CLI fixture cleanup and aggregate-only tool-result fidelity. Retain CI inventory gaps as route repairs, including PostgreSQL conformance and removed Logbook worker paths.
- Diagnostics OTel: obsolete NodeSDK replay only; preserve every private-provider sampler row and six span-limit probes. Content capture proof is a separate repair.
- SDK removal search was incomplete: public2,115/2,527 complete and bundled169/179 complete. No observed consumer is not proof of no external reliance. The retired target facade was private and excluded from packaging since `780bc791470`.
- Retain duplicate Swift TLS fixtures in separate packages, renderer-discovered Blobster JSON (also production prompt inputs), process-entry helpers referenced extensionlessly, stable borrowed-reference assertions, and independent release/architecture/platform guards.
- CI merge-preparation source/comment candidates remain pending Linux keeper proof; the independent Git-owner admission guard stays. Do not treat a stopped Testbox allocation as a product result.

Remaining: classify unread core/plugin/UI/native/script declarations and shared
fixtures; qualify candidates at their actual boundaries; validate and land owner
batches. Source review alone does not close the repository-wide audit.
