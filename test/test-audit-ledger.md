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

All landed batches completed focused checks, independent review and every removal
scan phase. Existing Knip findings were attributed, never suppressed; unused-file
and script-export scans were clean. PR189313 used the native inherited-failure
route: tested main introduced three unawaited SDK-host closes; the PR's original
file passes typed lint and the identical tested-main file reproduces all three.
Its failed CI remains failed; no current-head CI success is claimed.

## Current qualification

Pinned main `3a9578d82d5`; [draft PR189333](https://github.com/openclaw/openclaw/pull/189333).
File Transfer's helper metadata/no-load case repeats its registered-entry exact
commands and eager-import refusal. Diffs' three loopback-address rows repeat the
same inputs and registered handler in its access matrix. Untouched baseline:
33 tests pass across four suites, including actual HTTP HEAD responses. The registered-entry keeper catches wrong metadata and eager loading;
all three retained loopback rows catch rejected local access (404 instead of 200).
Faulted production files were restored byte for byte. Independent preservation
review approves both deletions. Remove two declarations/four expanded cases and
25 test lines; production/support delta is zero. Delegate caching/failure, proxy
and security rows stay. Candidate: 29 tests pass across four suites; focused typed
lint, compilation, formatting and Markdown lint pass. Every removal-scan phase
ran on baseline and candidate: the same three production and three full-tree
unused exports remain; unused-file and script-export scans report zero entries.

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
- Agent internals: 190 unique suites/1,509 physical sites/55,269 test LOC: R1504/F2/C1/D2. Latest MCP materialization10/66 R65/D1; separate reply/upstream scopes below. Preserve transport, requester isolation, authority, cancellation and work-count contracts.
- Auto-reply: All429 suites plus43 separate upstream suites and invoked local registrars/support classified. Latest54/498: R495/F2/C1; qualified two duplicates landed above. Keep channel persistence, group/native routing, progress suppression and abort cases.
- CLI: Config/setup24/209; plugin lifecycle25/176; validation22/106; channel/root/message/device/skills/session98/542; execution/reply presentation overlaps the reply aggregate. Only qualified fixture reduction landed above.
- Control UI: Devices11/80, nodes5/38, browser Gateway10/88, Gateway state10/40: 36 suites/246 retained sites. Authority, token rotation, heartbeat, event projection and early subscription handoff differ. Other UI remains open.
- Shared native: OpenClawKit209 files/2,528 sites: R2523/F3/C2. NativeState/MLX protocol5/46: R45/F1. Swabble6/12 R; MLX helper1/5 with one pending PCM consolidation.
- macOS: 304 Swift files/2,653 sites: R2635/F8/C9/D1. Native runtime qualification pending.
- iOS: 135 files/1,416 sites: R1370/F39/C6/D1; obsolete typography metadata scanner and a migration helper remain candidates. Native qualification pending.
- Android: 262 declaration files/3,441 sites/122,410 test LOC: R3384/F36/C20/D1. Remaining62 declaration files/719 sites, including two benchmarks. Wear is fully classified; native qualification pending.
- Provider plugins: Alibaba/Arcee/Cerebras/GMI/Qianfan/StepFun/Voyage/DuckDuckGo8/41; Fireworks/NVIDIA/Together/Novita13/45; Cohere/Featherless/Groq/LongCat/SGLang/SubQ12/33 retained.
- Further providers: Bedrock/OpenCode/Copilot/LM Studio/Kimi/Moonshot/ClawRouter/OpenRouter/Qwen/Venice/Microsoft/Foundry/Azure128/848: R847/F1; Vertex/Mantle11/62 R; Perplexity/DeepSeek/Mistral/Hugging Face17/69 R.
- Other audited plugins: Voice-call64/523 R522/F1; Nostr14/112 R; Prometheus7/55 R; IMAP/A2A13/103 R; MXC13/64 R61/F3; DeepInfra17/78 qualified above; MiniMax13/75 R74/F1.
- Plugin service owners: File Transfer21/162 R161/D1; active-memory11/122 R; Synology10/91 R; OpenShell11/88 R; Diagnostics OTel12/86 R83/F1/C2; AgentsAPI10/96 R; Cua12/83 R. All local support/assets live.
- Later plugin closures: LanceDB22/109 R; Logbook13/55 R; IRC15/99 R97/F2; Diffs14/58 R56/F1/C1; policy15/301 physical R298/F3; SMS16/158 R; team-reports21/138 R; Twitch15/86 R; TypeSafe10/50 R; X24/149 R148/C1; Zalo25/89 local R87/F2 plus9 inherited R and one duplicate row. Assertion-only candidates below do not remove their declarations.
- Plugin lane progress: Leaf557 suites/41 owners; including known root exclusions628 suites/74 owners. Remaining3,676 directory suites/104 owners plus3 root suites. No wholly unread 10–25-suite owner remains at this checkpoint.

## Pending qualification and proof repairs

- Keep source-only candidates separate from applied removals. FileTransfer/Diffs are active above; X midnight-spend replay has an identical table keeper and needs runtime qualification; Cua enum, TypeSafe reflected-token, SMS call-count/retry-list, and Twitch settled-flag assertions need runtime keeper qualification.
- Transfer rows before consolidating core failed-tool classification, CodeMode deadline duplication, Android loading/blank-auth, persisted outbox keys/epochs, terminal initial projection, and native PCM/decoder/reader cases. Keep typed host-error precedence and active-run settlement.
- Repair Android pairing runtime custody through the existing guaranteed fixture closer; no measured leak is claimed. Retarget misleading coroutine/authority/streaming assertions rather than deleting their contracts.
- Repair swallowed/unrelated setup errors, silent auth/symlink skips, SSRF negative controls, content-absence/privacy results, delayed observer-state proofs, and unregistered temporary fixtures at their existing owners. Retain CI inventory gaps as route repairs, including PostgreSQL conformance and removed Logbook worker paths.
- Diagnostics OTel: obsolete NodeSDK replay only; preserve every private-provider sampler row and six span-limit probes. Content capture proof is a separate repair.
- SDK removal search was incomplete: public2,115/2,527 complete and bundled169/179 complete. No observed consumer is not proof of no external reliance. The retired target facade was private and excluded from packaging since `780bc791470`.
- Retain duplicate Swift TLS fixtures in separate packages, renderer-discovered Blobster JSON (also production prompt inputs), process-entry helpers referenced extensionlessly, stable borrowed-reference assertions, and independent release/architecture/platform guards.
- CI merge-preparation source/comment candidates remain pending Linux keeper proof; the independent Git-owner admission guard stays. Do not treat a stopped Testbox allocation as a product result.

Remaining: classify unread core/plugin/UI/native/script declarations and shared
fixtures; qualify candidates at their actual boundaries; validate and land owner
batches. Source review alone does not close the repository-wide audit.
