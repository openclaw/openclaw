# Test audit ledger

Repository-wide audit started at `96e05f7ca44`. Status: in progress.
Inventory: 21,443 JS/TS test files, plus native test suites; 860 fixture-named paths.
Inventory and automated candidate scans are discovery, not completed coverage review.
Source tables are historical checkpoints; the closing paragraphs give the latest
completed counts. Retained source review does not claim runtime validation.

| Batch                   | Decision                                                                                                        | Evidence and remaining proof                                                                                                                                                                                                                                                                                         | Validation / landing                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI hosted admission     | Remove two source-literal assertions from `ci-workflow-planning.test.ts`, `bounds hosted rows with Android=%s`. | The same test executes `ci-build-manifest.mjs` at 40, 41, 45, and 46 base rows with Android enabled and disabled. It checks admission at 40, emitted row totals, and the 45-row warning. The test dates to `920bc99908b`; the source checks came with extraction in `9d75a8fe87a`. No production or support removal. | Planning: 662 passed on macOS and Linux; focused keeper and type-aware lint/format passed. Removal-check and landing results: [PR #189083](https://github.com/openclaw/openclaw/pull/189083). |
| CI merge preparation    | Retain six possible duplicate source/comment checks pending Linux proof.                                        | `ci-linux-git.test.ts` executes the workflow shell and observes merge acquisition, retries, checkout, and base publication. Retain the independent Git-owner checkout assertion: its fake checkout does not prove owner admission.                                                                                   | Testbox queued and was stopped; this PR's CI did not run the Linux keeper. Candidate not applied.                                                                                             |
| Plugin package contract | Retain all five declarations in one suite.                                                                      | Active taxonomy order, legacy category acceptance/deduplication, explicit compatibility fields, version fallbacks, and stable missing-field diagnostics. Callers include manifest validation and publication checks; prior redundant constant tests were removed in `53b95fd0bef`.                                   | Read-only audit; no runtime baseline claimed.                                                                                                                                                 |

Retained candidates:

- Identical `GatewayTLSStoreFixture.swift` files belong to separate Swift test packages.
- `placement-read-cache.worker.test.ts` repeats a getter in an identity assertion:
  it protects stable borrowed references across reads, rather than comparing a local value to itself.
- Sampled apparently orphaned CLI/state/infra/QA helpers are compiled-child entrypoints
  registered through extensionless names. Keep their process and lifecycle proof.
- Blobster JSON examples are discovered by the renderer suite; two also supply production prompt examples.
- Short script guards for release, architecture, and platform contracts remain independent proof.

All 471 package suites have been read. Completed read-only package lanes
(no runtime baseline claimed for retained areas):

| Packages                                              | Suites retained | Independent contracts                                                                                                                 |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `normalization-core`                                  | 26              | Unicode/grapheme, normalization, format, and public export contracts; all support remains used.                                       |
| `retry`, `tool-call-repair`                           | 8               | Retry policy; parser bounds, fences, protection, and stream-terminal invalidation.                                                    |
| `media-understanding-common`, `media-generation-core` | 5               | Caption/order, size admission, catalog/model references, dimensions, duration, and override precedence.                               |
| `net-policy`                                          | 4               | IP/URL parsing, custom-bind validation, SSRF vectors, and redaction secrecy with byte preservation.                                   |
| `plugin-sdk`, `workboard-contract`                    | 2               | Public package resolution/redaction and canonical persisted/type representations.                                                     |
| `session-url-contract`                                | 3               | Exact URL bytes, routing/escaping, opaque tokens, focus targets, and base-path isolation; prior parser replays already consolidated.  |
| `acp-core`, `worker-runtime`                          | 11              | Redacted diagnostics, metadata/session identity, cancellation, async context, worker capacity, and retirement ordering.               |
| `media-core`, `llm-core`                              | 15              | Framing/MIME/allocations, stream ordering/retention, iterator language semantics, and dynamic/AOT validation.                         |
| `model-catalog-core`, `terminal-core`                 | 21              | Wire sanitation, billing/identity/aliases, streaming ANSI, actual CLI stack, terminal cleanup, and broken-pipe handling.              |
| `markdown-core`                                       | 11              | Exact bytes/offsets, independent parser parity, metadata isolation, rendered budgets, and avoided parse work.                         |
| `gateway-client`                                      | 20              | Node/browser transport boundaries, credential persistence, FIFO/retry identity, projection, subscription, and retirement contracts.   |
| `agent-core`                                          | 25              | Actual tool execution, FIFO/cancellation, exact prompt bytes, retention, and separate transcript/request/persisted-summary bounds.    |
| `gateway-protocol`                                    | 88              | Wire/schema, generated-language, diagnostic, type, and native fixture contracts; deeper domain-owner closure remains partial.         |
| `ai`                                                  | 172             | Provider request bytes, schema publication, authentication, replay, billing, cancellation, compaction, and stream-terminal integrity. |

Routing and pairing: all 19 suites retained after reading the tests, local support,
owners, relevant callers, history, and CI routing. Inbound routing, outbound
account selection, diagnostics, read-worker refusal, and write settlement remain distinct.
Utility/support areas: all declarations in 35 active suites retained; one unreachable
71-line target-resolution helper and its private SDK facade are retired in [PR #189230](https://github.com/openclaw/openclaw/pull/189230).
Poll/startup/model-picker: eight suites retained for public input, TLS/compiler,
durable selection, authority, conflict, and publication-order contracts.
LLM host: 22 suites read; retain 126 declarations and repair one SSRF proof that
currently accepts unrelated setup errors. The causal-proof repair remains pending.
Logging: all 465 declarations in 64 suites retained; raw-hook absence, egress
redaction, recovery, and profile custody remain separate contracts. No orphan support.

Package batch starting at `a63bba630e2`: the memory host's 48 suites have been read.
Remove the repeated surrogate-pair block covered by `chunk-budget.test.ts`'s
identical-input matrix; retain the distinct coarse-boundary regression and require
complete mixed-text reconstruction. Require FTS admission before large-delete proof.
A real SQLite view-collision control passed the old test and failed the strengthened
assertion. The temporary fault was restored. No production or support change.

SDK: all 11 suites and support read. Remove the replay-only superseded-writer case
in `index.test.ts`; `terminal-outcome.e2e.test.ts` proves actual writer takeover,
persisted ownership, SDK events, and waits through an isolated Gateway.
Independent preservation reviews supported both reductions. Untouched baselines:
105 tests passed across five suites, including the real Gateway keeper.
Final candidate checks and landing: [PR #189143](https://github.com/openclaw/openclaw/pull/189143).

The full CI planning suite and its manifest/workflow/Git-owner support were read.
Other routing, admission, frozen-target, and gate layers retain distinct contracts.

Completed core source review (runtime proof only where a landing row says so):

| Owner scope                                   | Suites read                        | Decision                                                                                                                                        |
| --------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing / pairing                             | 19                                 | Retain independent routing, identity, authorization, and compatibility contracts.                                                               |
| Utilities / test utilities / test helpers     | 35                                 | Retain active suites; retire unreachable private channel-target support with its build, alias, and documentation registrations.                 |
| Boards / projects / decisions                 | 23                                 | Retain durable ownership, ordering, and public projections.                                                                                     |
| Logging                                       | 64                                 | Retain 465 declarations, including content-absence and privacy guards.                                                                          |
| Shared                                        | 111                                | Retain 490 declarations; streaming, borrowed identity, work counts, and native process contracts differ.                                        |
| Transcripts / snapshot                        | 28                                 | Retain actual storage, archive, retention, native permissions, and constrained-heap proof.                                                      |
| Channels root / direct plugin directory       | 103                                | Retain independent dispatch, registry, Doctor, and compatibility proof; nested directories remain open.                                         |
| Hooks                                         | 41                                 | Two export-helper replays are absorbed by actual module import and dispatch; fallback selection remains distinct.                               |
| Templates                                     | 31                                 | Retain 230 declarations and all live support/golden fixtures.                                                                                   |
| Worker                                        | 36 entry files + 7 imported suites | Retain 259 declarations; native bundle execution remains an explicit runtime gap.                                                               |
| Meeting bot                                   | 30                                 | Retain 179 direct and four inherited cleanup declarations.                                                                                      |
| TTS                                           | 23                                 | Move mocked capability assertions to the existing real-registry SDK fixture; retain public helper exports.                                      |
| LLM                                           | 22                                 | Retain 126 declarations; strengthen one SSRF negative control in a later qualified batch.                                                       |
| Audit                                         | 16                                 | Retain 118 declarations; repair one discarded privacy result and three stale SQL-count titles later.                                            |
| Media understanding                           | 43                                 | Retain 241 declarations; two obsolete outbound mocks have a live canonical message-runtime replacement.                                         |
| Context engine / chat / Canvas                | 19                                 | Retain 139 declarations; one unused mock engine class and one overclaimed title remain candidates.                                              |
| Process                                       | 118                                | Retain 577 declarations; repair one observer-timing proof that marks settlement too late.                                                       |
| MCP / proxy capture                           | 26                                 | Retain 130 declarations; strengthen the real CA-lock waiting assertion later.                                                                   |
| Image / music / video / media generation      | 19                                 | Retain 103 declarations and all live support.                                                                                                   |
| Web / fetch / search / link understanding     | 8                                  | Retain 69 declarations; preparation, cancellation, decoding, and transport contracts differ.                                                    |
| Status / trajectory / session cards / storage | 25                                 | Retain 207 declarations; preparation, worker settlement, retention, export, and filesystem identity differ.                                     |
| Root src suites                               | 25                                 | Retain independent entrypoint, package-export, and adapter contracts; strengthen logger absence proof later. Deep framework closure is partial. |
| Realtime transcription                        | 1                                  | Retain 13 actual WebSocket, retry, buffer, cancellation, and admission declarations; external provider caller closure is bounded.               |

Bootstrap / provider runtime / interactive / plugin state: all 21 suites read;
retain 179 declarations. One PostgreSQL worker declaration lacks registration in
the default conformance CI targets; repair its route rather than delete its proof.

Core batch starting at `be86cd32eba`: remove two hook helper replays covered by
actual module import/dispatch, two obsolete echo mocks, and the mocked TTS capability
case plus its unused channel inventory. The existing real-registry delivery rows
now exercise the public SDK helper. A wrong audio-file capability result passed the
old mocked declaration and failed the new assertion; the fault was restored exactly.
Untouched baseline: 76 tests across seven suites; retained candidate: 73 passed.
Focused lint and changed test-graph type checks passed. Complete removal-check
results and landing: [PR #189180](https://github.com/openclaw/openclaw/pull/189180).

Private target-resolution support retirement starts at `187b16c7855`.
The four-case registrar has no invocation; its SDK facade has been private and
excluded from packaging since `780bc791470`. Untouched baseline: 146 passed and one
Windows-only skip across eight suites. Candidate validation and landing:
[PR #189230](https://github.com/openclaw/openclaw/pull/189230).
The module and four named-export queries observed zero references at 08:44 UTC:
public coverage 2,115 complete of 2,527; frozen bundled source `7c99ae1dd41`
169 complete of 179. Incomplete coverage leaves external reliance unknown.

Further source-only review: 18 reply delivery/lifecycle suites retain 336 declarations
and need one ordinary tool-output deny proof repair; 24 CLI config/setup suites retain
209 and need one swallowed-error assertion repaired. Eight provider/search plugins
(Alibaba, Arcee, Cerebras, GMI, Qianfan, StepFun, Voyage, DuckDuckGo) retain all
41 declarations after local owner/support/history/routing review. Shared framework
closure is bounded; no runtime proof claimed for these areas.

Reply session preparation: 23 suites plus the initialization registrar retain
130 declarations for reset/fork/worktree state, authority, route custody,
persistence settlement and prompt preparation. CLI plugin lifecycle: 25 suites
retain 176 declarations and need one contention-proof repair; retired synthetic
local-state scaffolding remains a later support-only candidate. Source review only.

Further completed source review: reply run/model selection retains 104 declarations
across 23 suites and three invoked registrars; reply tools/directives retain 161
across 25 suites and one invoked registrar. Remaining CLI plugin validation retains
106 across 22 suites and native-artifact support. Fireworks, NVIDIA, Together, and
Novita retain 45 across 13 suites and one invoked deadline registrar. Catalog,
onboarding, payload, polling, live-provider, authority, and lifecycle contracts
remain independent. Local owners/support, relevant history, and static CI routes
were traced; broader framework closure is bounded. No runtime proof claimed.
Additional completed source review at the original audit revision (no runtime proof):

| Owner scope                              | Suites    | Decision                                                                                                                                                                              |
| ---------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon                                   | 127       | Retain 920 declarations; native process, custody, and platform contracts differ. Windows registered-task proof is conditional on successful fixture creation.                         |
| Talk                                     | 39        | Retain 250 direct declarations and one inherited database table; measured replacement-work bound remains a regression contract.                                                       |
| Wizard                                   | 30        | Retain 239 declarations, including the actual PTY child, migration lock, and installed-service state.                                                                                 |
| Security                                 | 46        | Retain 181 declarations; repair one legacy-auth remediation assertion that assumes POSIX chmod on Windows.                                                                            |
| Model commands                           | 35        | Retain 215 direct/inherited declarations; credential owners, live authority, RPC settlement, catalog policy, and physical persistence differ.                                         |
| Model catalog / memory / memory-host SDK | 7         | Retain 71 declarations; host policy, physical storage, provenance, and child snapshots have no absorbing package keeper.                                                              |
| Docs / remaining root scripts            | 21        | Retain 63 declarations; quoting policy, publication guards, parser contracts, and actual CLI checks differ.                                                                           |
| Shared OpenClawKit                       | 209 files | Retain 2,523 declarations; three proof repairs and two possible consolidations await qualified native execution.                                                                      |
| Shared NativeState / MLX protocol        | 5         | Retain 46 declarations; retarget one missing-table test that now stops at credential-cutover refusal. MLX protocol's standalone test CI route remains unverified.                     |
| Swabble                                  | 6         | Retain 12 declarations; real CLI, parser, cooldown, config, resampling, and wake extraction differ. Explicit package-test CI route inspected.                                         |
| macOS MLX helper                         | 1         | Retain five declarations; one PCM helper replay is absorbed by actual streaming bytes, pending native keeper proof. Packaging builds do not establish test execution.                 |
| Advisor / agent guidance                 | 2         | Retain 14 declarations; actual scheduling, run admission, cancellation, instruction snapshots, filesystem boundaries, and atomic registration differ. Host caller closure is bounded. |
| Auto-reply media / root                  | 39        | Retain 319 direct/inherited declarations; repair one block-streaming case whose mocked runner overstates policy coverage.                                                             |
| Tokenjuice / MCP Events                  | 2         | Retain 16 declarations: adapter contracts and real HTTP/SQLite lifecycle proof differ; external transport/reducer internals are not claimed.                                          |
| Doctor                                   | 118       | Retain 673 declarations; make two symlink capability refusals visible as skips instead of silently passing. All local support remains reachable.                                      |
| Auto-reply reply commands                | 67        | Retain 506 declarations; repair three TTS fixtures that bypass the existing temporary-directory cleanup owner.                                                                        |
| Auto-reply Stop / cancellation           | 11        | Retain 93 declarations; one test-only reset-entry proof needs replacement at the real reset owner. Five invoked case modules included; no absorbing keeper established.               |
| Gateway CLI                              | 31        | Retain 246 declarations, including 57 invoked support cases; admission, real process signals, native deadlines, durable log settlement and package staging protect different effects. |
| Admin HTTP / session share / Bonjour     | 8         | Retain 41 declarations: actual socket cleanup, durable disclosure authority, cancellation, lazy loading and real discovery-library lifecycle differ.                                  |
| Geolocation / Talk Voice / language pack | 6         | Retain 29 declarations: physical MMDB cache, outage handling, voice destination/config authority and actual asset HTTP responses differ.                                              |
| QuickJS / oMLX                           | 3         | Retain 41 declarations; narrow one pre-aborted execution title that overclaims worker-construction proof. Actual VM, credential persistence and transport contracts remain distinct.  |
| Readability / PDF / Auto Review          | 4         | Retain 28 declarations: actual DOM extraction, PDF worker cancellation/render budgets and admitted review-exchange contracts differ. External host/framework closure is bounded.      |

Next support batch starts at `7eec88c07c3`, after the reviewed core batch.
Remove the mock context engine whose only factory is never invoked during registration,
and the unused CLI-history entry builder whose last consumer was removed in `cd3e054c9a4`.
Retain the actual registration supersession cases, passthrough engine methods, and
all remaining history fixtures. Untouched native baseline: 182 passed and three skipped
across ten suites. Candidate `9236b5b7e11`: the same 182 passed and three Linux-only cases skipped.
Its full-tree export findings drop from three to two by removing `boundEntry`;
the four production findings are unchanged. Final removal-check results,
integrated-head proof, and landing: [PR #189212](https://github.com/openclaw/openclaw/pull/189212).
No test declarations or production code change.

Additional source review (no runtime result claimed):

| Owner scope                                                                     | Suites read     | Decision                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS app                                                                       | 304 Swift files | 2,653 declaration sites: retain 2,635, repair eight proofs, qualify nine consolidations and one decoding-order deletion. Local owners/support read; native execution remains pending.                      |
| CLI channel/root, message/device, skills/templates, session/storage             | 98              | Retain 542 declarations; remove one absorbed workshop mock and three unreachable fixture branches, with qualification below.                                                                               |
| Auto-reply execution, CLI execution, settlement/presentation, remaining helpers | 52              | Retain 322 declarations; repair one account-isolation case whose differing text hides a broken account discriminator. Queue and other reply scopes remain open.                                            |
| Cohere, Featherless, Groq, LongCat, SGLang, SubQ                                | 12              | Retain all 33 declarations: real payload/replay, discovery, config, credential rotation and cancellation contracts differ. Live suites were read, not executed.                                            |
| Auto-reply queue policy/state/admission/drain                                   | 20              | Retain 92 declarations; repair one per-case cleanup key that leaves an unrelated source pending until file cleanup. Exact inventories now cover 235 of 429 reply suites; 194 remain unread.                |
| Voice-call media/config/CLI/delivery                                            | 20              | Retain 165 declarations; repair one monotonic-deadline pending-state oracle whose resolved-promise race cannot detect early settlement. No absorbing layer or orphan support established.                  |
| Auto-reply collector/followup                                                   | 11              | Retain 124 declarations; repair two mislabeled abort/abandonment rows and collapse one redundant source-kind axis while preserving three real failure branches. Exact reply coverage is 246 of 429 suites. |
| Voice-call manager/store/recovery                                               | 14              | Retain all 98 declarations: real persistence, timers, FIFO replay, lost ownership, playback settlement and teardown differ. Full plugin inventory is 64 suites; 30 remain outside these two passes.        |

The CLI fixture batch starts at `64daa25640d`. Retire unused config routing in
`argv-invocation.test.ts`, unused Tailscale setup in `qr-cli.test.ts`, and unused
preview/rollback/bootstrap controls in `plugin-local-state-owner.test.ts`.
Keep every active declaration in these suites, including actual lease revocation,
owner-loss and Tailscale fallback proof. Their removed consumers are evidenced by
`d331fd73241`, `fb9545ca685`, and `7758bb9cdd7`.

Remove the workshop mock replay in favor of the unchanged persisted keeper in
`skills-cli.workshop-contract.test.ts:505`. Untouched baseline `34512f4a29d`:
55 passed across five suites. A temporary fault reacquired custody, replayed the
committed restore locally and preserved the original transport error. The keeper
failed on three persisted change rows instead of two. Production source was restored
byte for byte before test removal. Candidate `081185dc134`: 54 passed across the same
five suites. Core lint, the affected config/CLI compiler graph, formatting and docs
lint passed; fresh independent review found no correctness or security findings.
The first direct run hit an unchanged text assertion under forced color; the failed
and unfinished scopes passed with the native wrapper's `NO_COLOR=1 FORCE_COLOR=0`.
Final removal checks and landing: [PR #189259](https://github.com/openclaw/openclaw/pull/189259).

Additional source-only closure (runtime remains pending unless stated):

| Owner scope                                    | Completed reading                                | Decision                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS                                            | 135 Swift/support files, 1,416 declaration sites | Retain 1,370; qualify 39 proof repairs, six consolidations, one obsolete typography-scanner declaration and one shipping migration-test helper. No native removal applied.                                                        |
| Android                                        | 81 suites, 766 declaration sites                 | Retain 746; qualify 16 proof repairs and four consolidations. Preserve TLS admission, camera transfer identity, notification burst timing and initial Wear tap positions. The remaining 243 declaration files are inventory only. |
| Voice-call, complete plugin                    | 64 suites, 523 declaration sites                 | Retain 522; repair the pending-state oracle separately. All nine local supports remain live. Three fixture-only assertions can go while preserving actual streamed error and signed webhook results.                              |
| Nostr                                          | 14 suites, 112 direct/registered declarations    | Retain all declarations and four live supports. Inline the sole used sanitizer fixture row; four other rows and all row labels are obsolete since `07c8b8dda4d`.                                                                  |
| Diagnostics Prometheus                         | Seven suites, 55 declarations                    | Retain all declarations, three supports and two documented benchmark workloads; host admission, exporter authorization and store contracts differ.                                                                                |
| Reply admission/payload and memory/readmission | 40 suites, 220 declaration sites                 | Retain 219; qualify one setup-failure declaration absorbed by the existing shared null-context row. Exact cumulative reply coverage: 286 of 429 suites, with 143 unread.                                                          |

IMAP and A2A: all 13 suites retain 103 declarations; protocol fixtures, controlled
storage and packaged-service/Gateway proof protect different boundaries. All local
support remains live. Source/history/static CI review only; no runtime claim.

The CLI batch merged in [PR #189259](https://github.com/openclaw/openclaw/pull/189259):
exact published-head native proof passed 54 tests across five suites. Unused-file
checks were clean; four production/two full-tree export findings remain attributed
to unchanged base source/reference locations and earlier baseline scans, not hidden.

The next private plugin-fixture batch starts at `31af5fa987e`. Preserve Nostr's
registered outbound sanitizer case with the exact input and empty output while
retiring the unused shared table. Remove three voice-call assertions on fixed
surrogate setup and Node-generated JWK shape; retain the exact fragmented-error
and real signed-request verification assertions. All active declarations and
production code remain. Untouched baseline `074b6248dd4`: 124 tests passed across
eight suites, including all six Nostr fixture consumers and the two voice-call
suites. The patch removes 34 test/support lines and no production code or test
declarations. Candidate `dda997e9cd5`: the same 124 tests passed across eight
suites. Focused extension-test typecheck, typed lint, formatting and ledger lint
passed. Fresh independent review found no correctness or security findings.
Every removal-check phase ran on baseline and candidate: unused files and script
exports were clean; the same four production/two full-tree export findings remain
in unchanged core source. No suppression or baseline exception was added.
Final native proof and landing: [PR #189268](https://github.com/openclaw/openclaw/pull/189268).

Additional source-only closure (no new runtime proof):

| Owner scope                                      | Suites / declaration sites | Decision                                                                                                                                                                                                                |
| ------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reply ACP, control ownership and inbound context | 49 / 373                   | Retain 367; qualify four proof repairs and two control-owner row consolidations. Exact cumulative reply coverage is 375 of 429 suites; 54 remain unread. Active-goal replacement needs fragment-boundary qualification. |
| MXC                                              | 13 / 64                    | Retain 61; expose three silent symlink setup refusals. All local support and shipped launcher assets remain live.                                                                                                       |
| DeepInfra                                        | 17 / 78                    | Retain 77; qualify one mocked request-policy declaration against the existing real POST, CONNECT proxy and blocked-I/O keepers. All local support remains live.                                                         |
| MiniMax                                          | 13 / 75                    | Retain 74; isolate Token Plan live-test auth state so saved portal credentials cannot hide broken environment fallback. No supported removal.                                                                           |
| Perplexity, DeepSeek, Mistral, Hugging Face      | 17 / 69                    | Retain all declarations: real transport, cache identity, discovery, onboarding, transcript framing and live-wire contracts differ. Local owners/support and static routes read; transitive frameworks remain bounded.   |

DeepInfra request-policy batch starts at `c6646642e6c`. Qualify removal of the
mock-call replay against unchanged real HTTP, CONNECT proxy and blocked-I/O
keepers. The instant-completion mock protects no separate polling policy.
Untouched baseline `2fd90e38bf9`: 35 tests passed across two suites. Temporarily
dropping configured request policy made three real POST/CONNECT cases fail at
the private-network guard; the two blocked-I/O controls still passed. Production
source was restored byte for byte. Candidate `2cb825b43a8`: 34 tests passed across
the same two suites. The patch removes 55 test lines and one declaration, with
no production change. Focused extension-test compilation, typed lint, formatting
and ledger lint passed. Every removal-check phase ran on baseline and candidate:
unused files and script exports are clean; both retain the same one production
and one full-tree export finding in unchanged core source. Review and landing:
[PR #189289](https://github.com/openclaw/openclaw/pull/189289).

Further provider source review: Bedrock, OpenCode, GitHub Copilot, LM Studio, Kimi
Coding, Moonshot, ClawRouter, OpenRouter, Qwen, Venice, Microsoft, Microsoft Foundry
and Azure Speech total 128 suites / 848 declarations. Retain 847; repair one
Moonshot live auth-drift path that currently returns success before assertions.
No runtime proof or additional removal is claimed for these source-only lanes.

Reply source review is complete: all 429 unique suites, their invoked registrars
and direct local supports/owners are classified. The final 54 suites add 498
declarations: retain 495, qualify two proof repairs and one 17-line dispatch
consolidation. Preserve ordinary-channel persistence in the misleading model-run
case; its mock supplies the reply. Deeper framework dependencies remain bounded.
The separate 43 upstream suites are also closed; no additional removal is qualified.

Android source coverage is now 184 suites / 2,006 declarations: retain 1,965,
qualify 27 proof repairs, 13 consolidations and one dependency-arithmetic deletion;
140 declaration files remain.
Wear is fully classified. Rich-content and recap candidates retain stronger
streaming-fence and actual transcript-publication keepers; native proof is pending.
Control UI Devices, its node library, browser Gateway and Gateway state add 36 suites / 246
declarations, all retained. Connection authority, token rotation, pairing controls,
heartbeat recovery, event projection and early subscription handoff protect
distinct failures. No native or UI runtime result is claimed by this source closure.

Agent prompt/cache, run/lane ownership, tool results, tool policy and assembly:
80 suites / 653 declarations; retain 652 and qualify one unregistered temporary session-store
fixture for cleanup through the existing owner. This is separate from reply429
and its 43 upstream suites. No deletion or runtime result is claimed.

Further plugin source closure: File Transfer 21 suites / 162 declarations,
active-memory 11 / 122, Synology Chat 10 / 91 and OpenShell 11 / 88. All local
supports and shipped assets remain live. Only File Transfer's helper-level command
metadata replay has a supported removal candidate; its registered entry already
checks the exact commands and rejects eager runtime imports. Anthropic Vertex
and Mantle add 11 provider suites / 62 retained declarations. Broader framework
dependencies remain bounded; runtime removal qualification is still pending.

Diagnostics OTel adds 12 suites / 86 declarations: retain 83, qualify one content
capture proof repair and two consolidations. Only the obsolete NodeSDK replay
layer is a removal candidate; every private-provider sampler and span-limit
assertion remains. Both local supports and shipped assets remain reachable.
AgentsAPI adds ten suites / 96 retained declarations. Wire bytes, attachment
custody, SQLite bindings and native continuation protect separate boundaries;
the binding test facade has dynamic shared consumers and remains live.
Cua Computer adds 12 suites / 83 retained declarations. Its lone redundant numeric
enum assertion is absorbed by installed-SDK equality and actual scroll dispatch;
runtime qualification remains pending.

Reply duplicate batch starts at `9c4ee988283`. Retire only the setup-failure cleanup
declaration in `reply-agent-turn-preparation.test.ts` and the DM tool-result replay
in `dispatch-from-config.progress.test-utils.ts`. The shared preparation table
checks the identical failure plus exact failure recording and no preflight; the
routing keeper requires the callback, checks its delivered payload and preserves
final delivery. Both DM rows predate the split of their original common suite.
Keep all abort, group/native routing, progress suppression and persistence cases.
Untouched baseline: 178 tests passed across all three registering suites. Skipping
presentation settlement made all three shared keeper rows fail; dropping the DM
tool handoff made the retained routing keeper fail its delivered-payload assertion.
Both production files were restored byte for byte. The candidate removes 33 test
lines and two declarations, with no production change. The candidate passes 176
tests across the same three suites. Targeted compilation, typed lint and formatting
pass. Every removal-check phase matched baseline: zero unused files and script
exports; the same three production and three full-tree export findings remain.
No suppression was added. Review and landing:
[PR #189313](https://github.com/openclaw/openclaw/pull/189313).

Remaining: declaration-level review across remaining core, plugins, UI, native apps,
root/script suites and shared fixtures; close owner-reading gaps and land subsequent batches.
