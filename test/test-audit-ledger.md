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

All landed batches completed focused checks, independent review and every removal
scan phase. Existing Knip findings were attributed, never suppressed; unused-file
and script-export scans were clean. PR189313 used the native inherited-failure
route: tested main introduced three unawaited SDK-host closes; the PR's original
file passes typed lint and the identical tested-main file reproduces all three.
Its failed CI remains failed; no current-head CI success is claimed.

## Current qualification

Pinned main `c94084ca253`; [189405](https://github.com/openclaw/openclaw/pull/189405)
removes five assertion-only repetitions: Copilot's
fingerprint self-comparison, ClickClack's mock identity, SMS's repeated partial
send count and implied retry exclusion, and TypeSafe's implied serialized-token
absence. Exact fingerprint, captured constructor arguments, shared partial-send
receipt/order/count proof, exact retry list and exact public failure result stay.
Full source/history and independent preservation review found no assertions to
carry or production seams to remove. Baseline and candidate both pass180 tests/7
suites. Wrong fingerprint prefix, wrong handshake deadline, a third partial SMS
send, extra4xx retry and bypassed reflection guard fail ten keeper cases;
production was restored byte for byte. Typed lint, scoped compilation and format
pass. Every removal-scan phase is clean before and after: production/full-tree
exports and unused files, plus script exports. Six test LOC removed, including
one unused import; no declarations, production or support removed. The PR tracks
fresh review and CI.

## Completed source review

These are local owner/support/caller/history/static-route closures at the original
audit revision, with bounded transitive framework dependencies. Counts are scoped,
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
- Agent internals: 353 unique suites/2,452 physical sites/91,479 test LOC: R2438/F11/C1/D2. Latest hooks8/44, maintenance3/12 and runtime plan14/77 all retained; separate reply/upstream scopes below. Preserve transport, requester isolation, authority, cancellation and work-count contracts.
- Auto-reply: All429 suites plus43 separate upstream suites and invoked local registrars/support classified. Latest54/498: R495/F2/C1; qualified two duplicates landed above. Keep channel persistence, group/native routing, progress suppression and abort cases.
- CLI: Config/setup24/209; plugin lifecycle25/176; validation22/106; channel/root/message/device/skills/session98/542; execution/reply presentation overlaps the reply aggregate. Only qualified fixture reduction landed above.
- Control UI: 145 unique suites/944 physical sites: R941/F3. Includes the original45/336, plus formatting, browser, cron, agents, board, chat, catalog, reactive/projection, app Gateway, motion, secrets, channels, skills and worktrees groups. Shared `page-request.node.test.ts` counted once. Repair locale restoration, shadow-style asset coverage and bulk-secret canonical-refresh ordering; other UI remains open.
- Shared native: OpenClawKit209 files/2,528 sites: R2523/F3/C2. NativeState/MLX protocol5/46: R45/F1. Swabble6/12 R; MLX helper1/5 with one pending PCM consolidation.
- macOS: 304 Swift files/2,653 sites: R2635/F8/C9/D1. Native runtime qualification pending.
- iOS: 135 files/1,416 sites: R1370/F39/C6/D1; obsolete typography metadata scanner and a migration helper remain candidates. Native qualification pending.
- Android: Source classification complete: 324 declaration files/4,160 sites/143,748 test LOC: R4029/F107/C20/D4. All15 original support/assets read, another2,138 LOC. No unread declarations remain; native runtime/fault qualification remains pending.
- Provider plugins: Alibaba/Arcee/Cerebras/GMI/Qianfan/StepFun/Voyage/DuckDuckGo8/41; Fireworks/NVIDIA/Together/Novita13/45; Cohere/Featherless/Groq/LongCat/SGLang/SubQ12/33 retained.
- Further providers: Bedrock/OpenCode/Copilot/LM Studio/Kimi/Moonshot/ClawRouter/OpenRouter/Qwen/Venice/Microsoft/Foundry/Azure128/848: R847/F1; Vertex/Mantle11/62 R; Perplexity/DeepSeek/Mistral/Hugging Face17/69 R.
- Other audited plugins: Voice-call64/523 R522/F1; Nostr14/112 R; Prometheus7/55 R; IMAP/A2A13/103 R; MXC13/64 R61/F3; DeepInfra17/78 qualified above; MiniMax13/75 R74/F1.
- Plugin service owners: File Transfer21/162 R161/D1; active-memory11/122 R; Synology10/91 R; OpenShell11/88 R; Diagnostics OTel12/86 R83/F1/C2; AgentsAPI10/96 R; Cua12/83 R. All local support/assets live.
- Later plugin closures: LanceDB22/109 R; Logbook13/55 R; IRC15/99 R97/F2; Diffs14/58 R56/F1/C1; policy15/301 physical R298/F3; SMS16/158 R; team-reports21/138 R; Twitch15/86 R; TypeSafe10/50 R; X24/149 R148/C1; Zalo25/89 local R87/F2 plus9 inherited R and one duplicate row. Assertion-only candidates below do not remove their declarations.
- Plugin lane progress: Leaf924 suites/53 owners; including known root exclusions995 suites/86 owners. Remaining3,309 directory suites/92 owners plus3 root suites. Latest OC Path34/231: R229/F1/C1, plus one assertion-only consolidation. Source-only; no runtime verdict.

## Pending qualification and proof repairs

- Keep source-only candidates separate from applied removals. Five plugin assertions are active above. Pending: X midnight-spend replay; Cua enum and Twitch settled flag; Nextcloud upload-table unreachable branch; unused xAI request-header label; 49 unselected failover corpus rows; OC Path malformed-line replay and repeated round-trip assertion. Each needs current-source and runtime keeper qualification.
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
