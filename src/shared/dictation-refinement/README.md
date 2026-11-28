# Dictation refinement: implementation and qualification

Tracking issue: [openclaw/openclaw#205845](https://github.com/openclaw/openclaw/issues/205845).
Initial-publication base: `openclaw/openclaw`, `main`, `d11cb0518f095ac0eef7d232510e8783a209754f`.

This is a private, in-memory coordinator and an opt-in review flow in the main
Chat composer. M11 is **not fully qualified**. The browser uses the conservative
local text processor; the selected-model adapter is private and has no browser
RPC. Missing maintainer acceptance, real-Gateway/provider and device evidence,
public PR media, and full qualification keep this change a draft. The issue must
remain open.

## Supported behavior

The main composer's **Dictation text options** control enables review for that
composer instance. It defaults off and writes no configuration or history. During
capture, provisional captions remain outside the editable draft. Stop releases
the existing microphone owner immediately. A separate finishing state waits for
a bounded, typed final transcription snapshot. A clean close with finalized text
and no unfinished trailing caption is required for an eligible final transcript.
Timeout, disconnect, error, and partial-only text do not manufacture finality.
The review preference is locked during capture, finalization, and pending review;
accept or cancel the pending result before changing that preference.

The preview exposes the original and candidate as read-only text. **Use reviewed
text** and **Keep raw transcript** explicitly insert into the owned draft. Neither
action sends a message. New capture, edit, draft replacement, connection/account
replacement, capability withdrawal, and cancellation invalidate the old result.
Late completion cannot restore a retired generation. Oversized captions are
rejected with visible recovery copy instead of clipped into a draft.
Final text within the byte ceiling that exceeds the literal-span limit remains
available for explicit raw acceptance, with processing disabled.

New Session and Side chat do not advertise refinement. Their existing insertion
and submit contracts differ; Side chat also has a destination length limit.
They retain baseline dictation. The optional capability must remain absent until
each destination can accept the complete reviewed insertion without truncation
or an automatic submit. The main composer also snapshots its authoritative draft
text so programmatic draft replacements invalidate review.
Baseline direct-textarea insertion honors the destination's `maxLength` without
splitting a UTF-16 surrogate pair; main Chat review still inserts the complete text.

The built-in processor only trims outer whitespace. The transcription owner
already trims ordinary finalized transcripts, so the visible benefit of this
build is the review/finality lifecycle, not a claim of punctuation, correction,
formatting, dictionary, snippet, or reference-resolution features. Optional
feature examples in tests are explicitly conformance fixtures.

## Contract and ownership

- [types.ts](types.ts) defines schema version 1, capture/generation, finality,
  transcript revision, explicit mode and locale provenance, draft/target scope,
  authorization/policy revisions, authorized snapshots and STT hint provenance,
  feature/route policy, and the absolute deadline.
- [validation.ts](validation.ts) owns admission and candidate validation. Edits
  use half-open UTF-16 code-unit offsets at grapheme boundaries. Complete text or
  nonoverlapping edits must echo the exact effective base revision, which advances
  after a preceding transform. Unknown schemas, wrong bases, malformed Unicode,
  overlapping ranges, altered protected bytes, and excessive payloads fail closed.
- [plan.ts](plan.ts) snapshots optional registrations, orders intent before
  deterministic/prose processors, applies owner-authorized edits first, protects
  approved expansions/reference identities, and combines model instructions into
  one pass. A model-only instruction without a selected route is unavailable.
- [coordinator.ts](coordinator.ts) owns one current operation and one monotonic
  generation watermark. It has no transcript queue, provider catalog, credential
  store, agent turn, tool dispatch, delivery receipt, or durable feature store.
  Owner callbacks retain actual authorization and draft authority.
- [composer-dictation-session.ts](../../../ui/src/pages/chat/composer-dictation-session.ts)
  owns microphone release, transcription event ordering, and typed finality. Its
  existing string-returning baseline API retains its prior recovery behavior.
- [composer-dictation-refinement.ts](../../../ui/src/pages/chat/composer-dictation-refinement.ts)
  owns the main composer's ephemeral preview and final acceptance fence.

Only outer whitespace changes are eligible for automatic semantic acceptance by
the core. Interior whitespace, case, punctuation, names, quantities, units,
dates, negation, deletion, or expansion changes require review unless an exact
edit was already authorized by its owner. Protected bytes and opaque reference
identities remain mandatory. This conservative rule is not a proof of semantic
equivalence; the browser requires review even for a core `refined` result.

Raw fallback is allowed only for current, final, authorized source text. The
authorization owner must check all STT hint provenance and current consent.
Expired or revoked shared hints can make raw text unavailable. This code never
silently replays audio or invents a consent grant. The shipped browser path adds
no optional context or vocabulary hints to speech recognition.

## Limits and selected-model boundary

| Boundary                              | Implemented ceiling                        |
| ------------------------------------- | ------------------------------------------ |
| Final transcript / candidate output   | 32 KiB UTF-8 each                          |
| Context / vocabulary text             | 8 KiB UTF-8 each                           |
| Serialized request and model payload  | 64 KiB UTF-8                               |
| Combined processor model instructions | 4 KiB UTF-8                                |
| Context or vocabulary snapshots       | 32 per collection                          |
| Protected spans / edits               | 256 each                                   |
| Registered processors                 | 32                                         |
| Review finalization                   | 10,000 ms total, including remote close    |
| Text refinement                       | 2,500 ms from the snapshot's `finalizedAt` |
| Selected model invocations            | At most one per admitted final generation  |

The review snapshot's total finalization bound includes the realtime relay's
five-second provider drain. Final text is eligible only after a clean close;
arrival of an individual final segment does not shorten that drain. The snapshot
records `finalizedAt` when it settles, and the text deadline is anchored to that
timestamp. Delay after terminal finalization consumes the text budget even if
the asynchronous consumer resumes later. Ordinary dictation retains its existing
`finish()` timing: file transcription can use
the media owner's close timeout before the late-event grace resumes. Review's
10-second total bound is stricter for slow file transcription and yields manual
recovery when exceeded; it is not full timing parity with baseline dictation.

The [selected-model adapter](../../talk/dictation-refinement-model.ts) acquires the
explicit provider/model/profile from the existing simple-completion owner with
profile failover disabled. It preserves the prepared runtime, transport, and
credential owner, and uses one streaming completion. No larger/different provider
retry, agent, history collection, or tools are introduced. Assembled payloads
must remain streaming, tool-free, within the byte ceiling, and within the selected
output-token limit. The stream and final text are byte bounded; cancellation also
disposes a lease that finishes acquisition late.

Only the inspected Chat Completions source API is admitted. Its built-in transport
sets SDK retries to zero; custom wrappers require trusted owner attestation of a
one-request contract. The adapter does not establish an authoritative locality
policy by accepting a hostname or a `local` label. Strict-local requires an actual
route owner's attestation. The browser copy explicitly distinguishes local text
cleanup from its separately selected speech-recognition provider.

`metrics.providerRequests` counts logical adapter invocations, including attempts
that fail during preparation. It is **not an observed HTTP request count**.
Processor candidate validation is included in deterministic phase time; the
separate validation phase does not measure all validation work. Diagnostics
contain fixed failure codes, phases, coarse size buckets, counts, and durations.
Private text, context, vocabulary, identity, and provider error messages are not
copied into the coordinator's diagnostic callback.

Limits here cannot forcibly terminate arbitrary noncooperative third-party
callbacks or prevent an SDK from allocating an oversized SSE chunk before it
emits an event. Those are transport qualification requirements, not guarantees
provided by a Promise race or post-event byte check.

## Latest integrated verification

This integration preserves published commit
[`291c5b5`](https://github.com/CompleteDotTech/openclaw/commit/291c5b5aede953fdbf78ef00e90119f40d5552ce)
and its main refresh through `2fda93cf03a882cd080e7984392d50b95c4737aa`. The
finalization timestamp, preference lock, literal-span fallback, direct-textarea
length handling, and latest preview assertions remain intact. One explicit
Solid `flush()` repairs an inherited test's premature DOM query after its
synchronous owner assertion; no assertion or product timing was weakened.
The relay/browser coverage, layout, pointer and type repairs are layered on top.

The worktree has its own physical frozen-lockfile install. Current verification
used the repository wrappers with one Rayon worker and one test worker. The
browser source snapshot is parent `291c5b5` plus staged tree
`a7e24b14706773838b1f00ade4d8469c7eab0f7e`; subsequent changes to this report add
receipts only. Runtime and test fingerprints are checked against publication.

| Check                                                      | Current result                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Shared-core contracts                                      | 37 passed                                                                                                                   |
| Six capture, preview, dictation and composer suites        | 167 distinct cases passed across the combined run and focused fixture repair                                                |
| Actual production-relay drain/cancellation                 | 2 passed; 91.74 seconds through the native wrapper, 86.55 seconds in Vitest                                                 |
| Selected-model adapter boundary                            | 21 passed; 94.74 seconds through the wrapper, 90.56 seconds in Vitest                                                       |
| CI browser ownership                                       | 18 passed; 25.53 seconds through the wrapper                                                                                |
| Actual Chromium / production-config UI                     | 5 selected cases passed; 56.33 seconds in Vitest, 23.16-second Vite bundle                                                  |
| Production UI types (`tsconfig.ui.json`)                   | Passed in 136.93 seconds with the supported bounded Go checker                                                              |
| Changed UI, script inventory and Vitest configuration lint | Passed through native targeted wrappers; UI lint included fresh declaration preparation                                     |
| Canonical `pnpm ui:build`                                  | Exit 0 in 74.73 seconds; 38.05-second Vite build, 5,730 modules, 1,124 verified finalized sidecars; budget violations below |
| Test-line ratchet                                          | Passed: 2,888 net lines, 400 ordinary allowance and 2,488 allocated against merged main `2fda93cf0`                         |

These are **250 distinct passing cases**, without counting repeated cases twice.
The first combined invocation remains a failed command: 37 core and 166 UI
cases passed, but the accessible opt-in fixture queried a reactive status node
before Solid applied its update. The one-line flush repair subsequently passed
all 24 preview cases. The other five UI files and their runtime inputs were
unchanged, so their successful results remain valid.

The browser selection covers three refinement cases and two inherited native
background-capture cases; 17 unrelated status cases were excluded by the explicit
filter. HEAD, the staged patch, worktree/index state, and 29 source-file hashes
were identical before and after execution. Inspected clean and same-frame
annotated captures show the five-second wait, ready review, explicit insertion
without sending, cancellation, incomplete recovery and full-width mobile options.
The ready preview/status spans 366 pixels within a 368-pixel composer; empty
mobile options span 350 pixels. The native background cases use actual Chromium
`getUserMedia` and `AudioContext` with generated audio and synthetic
blur/visibility events. Gateway messages remain fixtures. This is not physical
microphone, actual OS window switching, real-Gateway or live-provider proof.

The canonical build reports three budget violations: largest CSS 58,659 B gzip
against 58,315 B; Chat boot 21 requests against 20; and Chat boot JavaScript
1,337,626 B gzip against 1,336,272 B. No threshold changed. The violation classes
also occurred before this iteration, but exact attribution against merged main
or the original fork point remains unqualified; this is not a clean performance
budget pass.

Real-Gateway realtime/file execution remains blocked by native isolated-runtime
preparation receiving SIGKILL before cases. Public inline PR screenshot upload
is unavailable through the authenticated transports. The broader UI editor/test
and tooling-test type graphs remain unqualified after their earlier exit-137
resource failures; the production UI type pass does not replace them. Owner
scope/admission decisions, live/provider/device evidence and full M11 performance
qualification remain outstanding. Earlier receipts and synthetic measurements
below stay pinned to their recorded source.

## Acceptance matrix

The result column pairs the focused verification above with the remaining
full-issue qualification. Source links describe the integrated code. The separate
historical receipts and synthetic benchmark below are not substituted for the
current-source checks or the outstanding native procedures.

| Criterion                              | Production owner / verification                                                                                                                                                              | Observed result and remaining qualification                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC01 — neutral typed contract          | [Types](types.ts), [validator](validation.ts), [core tests](coordinator.test.ts)                                                                                                             | Focused tests passed for schema, revisions, bounded snapshots, exact-base candidates, UTF-16/grapheme ranges and malformed output. Public schema is deliberately not exposed.                                                                                                                                                                  |
| AC02 — one ordered plan/pass           | [Plan](plan.ts), [coordinator](coordinator.ts), [model adapter](../../talk/dictation-refinement-model.ts), core and [provider-boundary tests](../../talk/dictation-refinement-model.test.ts) | Core fixtures passed for absent/disabled/missing adapters, precedence and one invocation. Real browser model wiring awaits accepted RPC/policy ownership. All 21 selected-model provider-boundary fixtures passed; live transport and the browser route remain unqualified.                                                                    |
| AC03 — meaning and protection          | [Validator](validation.ts), core literal/reference and meaning cases                                                                                                                         | Protected bytes/identity and conservative review cases pass, including interior indentation, negation, quantities, units, names and added claims. Human semantic adjudication is NOT RUN.                                                                                                                                                      |
| AC04 — cancellation/stale ownership    | [Coordinator](coordinator.ts), [composer owner](../../../ui/src/pages/chat/composer-dictation.ts), [preview tests](../../../ui/src/pages/chat/composer-dictation-refinement.test.ts)         | Focused tests passed for cancel, edit, generation/target/account/connection/authority/locale replacement, capability withdrawal and late results. Actual Chromium cancellation passed with synthetic Gateway/media; real-Gateway and physical-device journeys remain unqualified.                                                              |
| AC05 — Stop releases capture           | [Capture owner](../../../ui/src/pages/chat/composer-dictation-session.ts), [finality tests](../../../ui/src/pages/chat/composer-dictation-session.finality.test.ts)                          | Eight capture cases and two production-relay cases pass, including immediate track release, the real five-second drain and cancellation. Physical microphone/device proof is NOT RUN.                                                                                                                                                          |
| AC06 — eligible recovery               | Capture owner, coordinator, finality/preview/core tests                                                                                                                                      | Final-only fallback, incomplete manual recovery, exhausted budget and revoked/expired STT-hint cases pass. No independent re-transcription route is fabricated. Live shared-hint provider proof is NOT RUN.                                                                                                                                    |
| AC07 — one preview, separate delivery  | [Preview owner](../../../ui/src/pages/chat/composer-dictation-refinement.ts), [controls](../../../ui/src/pages/chat/components/chat-composer-controls.tsx), preview tests                    | Explicit accept commits once; actual send-control fixture does not send after review-required Stop. No agent/tool/send implementation is called by core. Actual Chromium verified review, explicit insertion and zero chat.send calls with synthetic Gateway/media; real-Gateway proof is still blocked.                                       |
| AC08 — authoritative locality / egress | Model adapter route-policy callbacks; browser local processor                                                                                                                                | BLOCKED: accepted speech/refinement locality owner is absent. Real attempted-egress matrix, offline failure and retry evidence are NOT RUN. Synthetic local adapters do not establish offline processing.                                                                                                                                      |
| AC09 — bounded resources               | Limits, validator, coordinator, model adapter, oversized caption UI                                                                                                                          | Core/UI bounds and deadlines and all 21 selected-model boundary fixtures pass. Total SDK memory, noncooperative callback termination and real-provider resource behavior are unqualified.                                                                                                                                                      |
| AC10 — privacy / authorization         | Immutable plan, dispatch/publication/fallback callbacks, projected model input                                                                                                               | Core tests passed for immutable admission, revoked authorization and content-free failure metrics. Selected-model transport projection and cancellation fixtures pass; live logging/egress observation is NOT RUN.                                                                                                                             |
| AC11 — accessible full journey         | [View](../../../ui/src/pages/chat/components/composer-dictation-refinement-view.tsx), [browser scenario](../../../ui/src/e2e/browser-dictation-refinement.e2e.test.ts)                       | Component tests passed for accessible opt-in, stable polite status, quiet provisional caption, read-only RTL/literal inspection and cancellation. Three review and two native-background Chromium cases and inspected 400-pixel captures passed with synthetic Gateway/media. Real screen-reader, zoom and device journeys remain unqualified. |
| AC12 — complete latency claim          | [Measurement driver](../../../scripts/perf/dictation-refinement-measure.mts)                                                                                                                 | Synthetic text-only comparison is separate evidence below. W1 audio/Stop/STT/provider/preview/insertion p50/p95/p99, network impairment, CPU load and phone qualification are NOT RUN. No 1,500/750/75 ms product latency claim is made.                                                                                                       |
| AC13 — disable/compatibility           | Ephemeral opt-in, capability gate, existing baseline owner API; core/UI regression suites                                                                                                    | Disabled, absent processor, unsupported locale and capability withdrawal cases pass. Baseline dictation/direct-composer/split-Talk regressions pass. No schema migration or feature-store deletion is added. Actual same-state installed upgrade/downgrade is NOT RUN.                                                                         |

## Historical ClawSweeper final-drain repair

The [review of published head `7dab77e`](https://github.com/openclaw/openclaw/pull/205973#issuecomment-7193928672)
identified a real mismatch: the browser allowed only 2,500 ms for a transcription
session whose production relay normally drains for 5,000 ms. Starting the text
deadline before that wait would also leave no refinement budget after a longer
successful drain. This repair reuses the capture owner's 10-second timeout
constant for review's total bound and starts the separate text deadline after
finalization. It does not change the
relay, add a production owner, or enable model/context/vocabulary orchestration.

The new [production-relay regression](../../../ui/src/pages/chat/composer-dictation-refinement.relay.node.test.ts)
reproduced the defect on `7dab77e`: after nonempty audio and finalized text,
advancing the fake clock to 2,501 ms made the preview `unavailable` instead of
remaining `finishing` until the relay closed at 5,000 ms. Its cancellation case
passed on that same source.
The regression also supplies another final segment at 4,500 ms and requires
explicit acceptance before insertion, covering both deadline boundaries.

The [real-Gateway browser scenarios](../../../ui/src/e2e/browser-dictation-refinement.real-gateway.e2e.test.ts)
are designed to exercise realtime and file transcription through the production UI, Gateway,
speech adapters, audio processing and transport. Chromium's fake microphone and
loopback external-provider I/O are explicit fixtures; they do not establish
physical microphone or live speech-provider qualification. These scenarios are
registered in the native real-Gateway/private-server and Chat CI owner lists.

Actual Chromium verification also exposed two presentation defects: the options
button used a picker-only class that hid it from pointer input, and the review
panel inherited the footer's narrow inline column. The button now uses an existing
visible control style, and review renders in the existing full-width composer
lede through the same lazy module. Inline capture status remains with the
original owner. This adds no CSS, timers, listeners or state owner.

Production UI typechecking then reached six diagnostics in two existing
integration points. The shared options producer now normalizes a null account
ID to `undefined`, preserving the owner's connection-scoped nullish fallback.
All four preview/caption textareas now use Solid's typed `readonly` attribute.
Existing component and browser assertions verify their DOM `readOnly` property;
no casts, widened contracts or duplicate tests were added.

Before the latest refresh, the branch advanced to
[`28781e0`](https://github.com/CompleteDotTech/openclaw/commit/28781e05fca4cda4b7b689ec1930c00a42b5844d)
with the same deadline repair and a delayed-close preview case. The prior
integration adopted its simpler private snapshot API without an unused timeout
override and retained its five-second preview case. That published commit remains
in the ancestry of the latest refresh.

### Historical repair verification receipts

These receipts describe the repair based on `28781e0`, with final tested tree
`9c349570d2f46e80c99d69d8b933ea31681fac60`. They remain valid for that source;
the subsequent `291c5b5` refresh changed capture, composer and shared-core inputs.
The totals, browser captures, typechecks and build below are not current-tree passes.

The previously blocked selected-model suite passed all 21 fixtures through
the canonical wrapper with one Rayon worker. Its 104.53-second wrapper time
includes 77.257 seconds of compiled preparation; Vitest reports 98.06 seconds.
This qualifies bounded dispatch, request projection, route-policy and
cancellation fixtures, not a live provider, browser model route or observed HTTP
request count. The earlier exit-137 attempts remain historical failures.

| Check                                                 | Observed outcome                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regression on published UI/capture source             | One intended failure at 2,501 ms; cancellation passed                                                                                             |
| Core, capture, preview and composer suites            | 37 unchanged core cases plus 160 post-reconciliation UI cases passed, including 22 preview, eight finality and 57 main-composer cases             |
| Isolated production-relay regression after the repair | Both cases passed with `RAYON_NUM_THREADS=1` and one worker                                                                                       |
| CI browser-owner planner                              | All 18 cases passed                                                                                                                               |
| Actual Chromium on published timing owners            | One intended failure at 2,501 ms; rendered manual recovery instead of the expected finishing state                                                |
| Actual Chromium after the repair                      | All three mocked-Gateway cases passed, including delayed close, explicit acceptance without send, cancellation and mobile pointer/layout checks   |
| Combined three-file invocation                        | 30 cases passed, but relay preparation exited 137 before its cases; the combined command failed                                                   |
| Real-Gateway browser preparation                      | Blocked before Gateway/browser launch: unified runtime build received SIGKILL, including the native documented 4,352 MB heap and one Rayon worker |

After branch reconciliation, all 160 cases in the six affected UI suites passed
in 14.12 seconds through the native wrapper (16.07 seconds for the command).
The two actual-relay cases then passed in 85.06 seconds in Vitest / 89.61 seconds
through the wrapper (90.60 seconds for the command), including compiled-worker
preparation. The earlier 37 core, 21 selected-model and 18 planner receipts
were reused for inputs unchanged at that reconciliation. With its three browser
cases, these are **241 distinct historical passing cases**; repeated runs are not
counted again. The failed combined invocation remains failed.
No production assertion, relay timeout, build policy, or gate was weakened.

The browser reproduction built the production UI with the two timing owners
temporarily restored from `7dab77e`, then restored and verified the exact fixed
bytes. At 2,501 ms it showed incomplete manual recovery despite finalized text.
The repaired run stayed in finishing, became ready after the synthetic close at
5,000 ms, and inserted only after acceptance, with zero `chat.send` calls. It
also passed the keyboard journey, mixed RTL/literal inspection, cancellation,
incomplete recovery, ordinary pointer access and empty, unfocused mobile layout.
The final three-case run took 51.01 seconds, including a 25.56-second Vite build.
Its source fingerprints and staged patch remained unchanged through execution.
The reconciled run includes the numeric-parser lint cleanup and the published
snapshot simplification; its production-source and test hashes matched the
prior tested tree. The separate real-Gateway fixture remains unexecuted.

The native production UI typecheck passed on that prior tree with
`OPENCLAW_TYPECHECKER=tsgo GOMAXPROCS=1 GOMEMLIMIT=2GiB` through
`scripts/run-tsgo.mjs -p tsconfig.ui.json --incremental`; the reconciled run
completed in 143.67 seconds. The broader
`ui/tsconfig.json` editor/test graph still exited 137 without diagnostics.
Production UI typechecking was green on that source; the refreshed-source pass
is recorded above, while full UI test types remain unqualified. The failed six-diagnostic
run is retained as the reproduction for the five-line integration repair,
not relabeled as a passing attempt.

The required `test/tsconfig/tsconfig.test.root.tooling.json` typecheck also exited
137 without diagnostics under the same bounded Go runtime. Its CI ownership
test callers remain type-unqualified. Targeted lint passed for all then-changed
UI files, the CI inventory and the Vitest configurations. The initial UI lint
run reported three fixture diagnostics; the corrected decoder and numeric
parser passed both the affected-file and complete changed-UI lint runs.

Clean and same-frame annotated captures were inspected at 400 by 1,000 pixels.
The ready review panel spans 366 pixels, compared with 158.90625 before; empty
resting options span the full 350-pixel inner surface. These captures use real
Chromium and the production UI with synthetic Gateway messages and browser
microphone transport. They are not real-Gateway, live-provider or physical-device
proof. The public PR screenshot delivery gate is still open: the available
authenticated GitHub transport cannot upload attachments, and private/local
captures do not satisfy inline public PR delivery.

Canonical `pnpm ui:build` passed on the published `7dab77e` source and the prior repair,
including 5,726 modules and 1,124 finalized sidecars. The repaired build took
37.11 seconds in Vite (75.21 seconds through the full command). Both report the same three budget violations: largest CSS
58,659 B gzip against 58,315 B, Chat boot 21 requests against 20, and Chat boot
JavaScript 1,337,090 B gzip in both before and final builds against 1,336,272 B.
These violations were
present before this repair, but their attribution against the original fork
point remains unqualified. No budget was raised.

That prior tree's test-line ratchet passed with 2,868 net added lines, the ordinary
400-line allowance, and a 2,468-line allocation. The increase covers the actual
relay boundary, separate realtime/file external-provider fixtures, and rendered
deadline, pointer and mobile-layout proof.

The initial browser setup also exposed unavailable cgroup-limit discovery and
disk exhaustion. The task checkout was relocated with its own physical frozen
dependency install; native script and plugin-asset preparation subsequently
passed. The final 4,352 MB / single-worker runtime attempt still received
SIGKILL after 57.4 seconds in its unified invocation (80.5 seconds of total
preparation). It produced no real-Gateway cases or screenshots. The complete
pre-fix UI assets were preserved and verified byte-for-byte before and after
these attempts.

The scope recommendation remains a maintainer decision alongside
[#205845](https://github.com/openclaw/openclaw/issues/205845) and overlapping draft
[#205788](https://github.com/openclaw/openclaw/pull/205788). This repair does not
claim acceptance of the broader coordinator or stronger admission/revocation
semantics. Keep this PR draft and the tracking issue open.

## Initial-publication verification receipts

The following receipts describe the initial publication, before the final-drain
repair above. They remain historical evidence, not replacement receipts for the
new regression and browser scenarios.

The focused command below passed **141 tests in 6 files**: 37 shared-core cases
and 104 UI/capture/baseline cases. It includes the independent-review fixes for
cancelled provisional generations, missing selected-model instructions, interior
whitespace review, capability withdrawal, oversized manual captions, synchronous
draft-edit/undo invalidation, and the actual recording Cancel control.

```sh
pnpm test src/shared/dictation-refinement/coordinator.test.ts \
  ui/src/pages/chat/composer-dictation-refinement.test.ts \
  ui/src/pages/chat/composer-dictation-session.finality.test.ts \
  ui/src/pages/chat/composer-dictation.test.ts \
  ui/src/pages/chat/talk/split.test.ts \
  ui/src/pages/chat/composer-direct-dictation.test.tsx --maxWorkers=1
```

The selected-model suite was attempted through the canonical wrapper, both in
the initial mixed run and alone. Both stopped before any case with `Compiled
subprocess build failed with exit code 137`. Full UI type checking also exited
137 under both the default checker and the documented Go fallback with bounded
parallelism/memory. These are failures to obtain proof, not passing checks or
diagnosed product failures. No assertions or runner gates were weakened.

The browser attempt could not launch its required Chromium revision
(`chromium-1248` was absent), so neither scenario ran. The subsequent supported
`pnpm exec playwright install chromium` failed with a download HTTP 403. The
system Chromium launcher also has no executable behind it. No screenshot,
screen-reader, zoom or physical-browser proof is claimed.

Targeted UI, script, shared-core and selected-model lint, the shared-core typecheck, the existing native
controller census, English-copy baseline, and the CI browser-owner planner's 18
tests pass. UI lint reports three nonfatal reactive-use warnings. An aggregate
core/model lint attempt exited 137; separate shared-core and selected-model
commands later passed on the same source. The final command-registration lint
also passes.

The existing main-composer suite passes **57/57** both on the exact base and on
implementation commit `8cea5c4fcd73a4464b6b0d9da49cf80972c900c9`. The combined
head run with the new preview cases passes **80/80**. An earlier combined run
failed while waiting for an attachment thumbnail; that failure was not reproduced,
and its cause is undetermined. No assertion or production code was changed to
obtain these passes. Together with the focused and planner suites, these are
**216 distinct passing cases in eight files**, not a sum of repeated runs.

The earlier `pnpm ui:build` completed successfully, with three reported budget
violations: largest CSS 58,659 B gzip against 58,315 B, chat boot 21 requests
against 20, and chat boot JS 1,337,077 B gzip against 1,336,272 B. No budget was
raised. An actual-base build terminated with exit 137 during chunk rendering.
A final-head build with `NODE_OPTIONS=--max-old-space-size=1536`,
`RAYON_NUM_THREADS=2`, and `UV_THREADPOOL_SIZE=2` also terminated with exit 137.
The three budget violations therefore remain **unclassified**, and a successful
final-head build is pending. The optional view already uses the existing lazy
dictation-status boundary; the boot manifest was not hand-edited.

The tooling-test typecheck, required by the CI ownership inventory change, also
exited 137. The canonical unused-file gate started both Knip scans concurrently;
the production scan was killed with SIGKILL and the outer harness stopped at
180 seconds without a full-tree receipt. A serial retry found one owned path,
`src/talk/dictation-refinement-model.ts`, because the documented measurement CLI
had been registered without Knip's production-entry marker. The exact CLI root
was corrected; its selected-model arm is the actual dynamic consumer. No adapter
root, ignore or wildcard was added. Both corrected production and full-tree scans
pass with **zero unused files**, using the same repository runner and result
validator serially to reduce peak resource use. They ran on source commit
`0cd76547856ea8e732dd6f116fa1edeca1fbb565` in 130.83 and 175.79 seconds. The final
model lint and command-registration lint pass in 10.81 and 6.39 seconds. The
canonical concurrent invocation remains a failed historical attempt; the
successful receipts are the serial constituent scans.

The serial scans use `runKnipScans` from `scripts/deadcode-knip-runner.mts` with
one scan per invocation and the unmodified
`checkKnipUnusedFileScanResult` validator. Their CLI inputs are:

```sh
pnpm dlx --package knip@6.40.0 knip --config config/knip.config.ts \
  --production --no-progress --reporter compact --files --no-config-hints
pnpm dlx --package knip@6.40.0 knip --config config/knip.all-exports.config.ts \
  --no-progress --reporter compact --files --no-config-hints
```

Script erasability passes for 2,024 implementation files. The test-line
ratchet passes with 2,062 net new lines, the ordinary 400-line allowance, and a
1,662-line allocation for independent schema, capture, composer, provider and
browser boundaries. Assertions are not duplicated simply to inflate coverage.

The package-wide root build and complete suite are not qualified by these focused
receipts. Remote build/type/model-test proof remains required. No Crabbox
client was available, and automatic PR CI skips drafts under the current proof
policy. Publishing this draft does not claim CI approval or request a merge.

## Initial-publication source identity

The local shell had no GitHub write credential, so its Git push did not publish
the branch. The authenticated GitHub connection published the verified Git
trees through the Git data API. That API assigns commit metadata and therefore
new commit SHAs. The source tree identities below were checked for exact
equality before publication; the original local commits are retained.

| Locally verified commit                    | Published commit                                                                                                                        | Identical Git tree                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `8cea5c4fcd73a4464b6b0d9da49cf80972c900c9` | [736e6741517dc9a2301493fd3954c395bf02e301](https://github.com/CompleteDotTech/openclaw/commit/736e6741517dc9a2301493fd3954c395bf02e301) | `cdcff8270ebee40ac12423f5e09e46c7d412eacb` |
| `0cd76547856ea8e732dd6f116fa1edeca1fbb565` | [e0827788b6935f9c441755fa708855852c502573](https://github.com/CompleteDotTech/openclaw/commit/e0827788b6935f9c441755fa708855852c502573) | `27e6e633f4752b5a53f8a5cc1953d18efb551a6b` |

The initial publication added the qualification document and measurement JSON to
that source. Those documentation changes do not change the tested runtime or
Knip graph. A local merge-tree comparison of the implementation with fetched
upstream `main` at `3ba1361bcf398856b8954f699362a2c663885063` completed without
conflicts. The tested fork point remains the base recorded at the top; this
comparison is not a test run on a merged checkout.

## Historical synthetic text measurement

The complete [measurement JSON](text-path-measurement.json) records the actual
clean implementation commit `8cea5c4fcd73a4464b6b0d9da49cf80972c900c9` and source
SHA-256 `e19496f2deaa8cfe693fd0d405a3073227949f0dfd1f809d03372975306e3f46`.
The fingerprint covers the core, selected-model adapter and measurement driver.
The `291c5b5` refresh changed the core files, so this unchanged JSON and its timings
describe the recorded historical source, not the integrated implementation.
The command used for that receipt was:

```sh
node --expose-gc --import ./scripts/tsx.mjs \
  scripts/perf/dictation-refinement-measure.mts \
  --samples 200 --warmup 20 --cold-samples 5 \
  --baseline-ref d11cb0518f095ac0eef7d232510e8783a209754f
```

That run alternated raw-disabled and whitespace-deterministic arms on the
**same recorded source**, with synthetic finalized `en-US` text and 1,520 bytes of
context. `baselineRevision` records source provenance; no separate historical
baseline checkout was measured. No model, configuration or credential module is imported in
this mode. The host was Linux 6.18.57 x64, Node 24.22.3 / V8 13.6, with an AMD EPYC
9V74, nine exposed logical CPUs and 10,451,427,328 bytes of RAM. Host load at the
receipt was 2.62 / 3.37 / 2.99. GPU, provider/model, quantization, network RTT/loss,
and physical-device behavior were not measured.

The times below are the driver's elapsed text-call measurement in milliseconds.
Warm rows use 200 samples per arm after 20 warmups; cold rows use five separate
Node processes per arm. Cold p95 and p99 are therefore small-sample maxima, not
reliable tail estimates. Import and child-process wall time are reported
separately in the JSON and are excluded from these elapsed-call columns.

| Words | State | Arm           | p50 ms | p95 ms | p99 ms |
| ----- | ----- | ------------- | -----: | -----: | -----: |
| 30    | Warm  | Raw disabled  |  0.281 |  4.171 | 30.123 |
| 30    | Warm  | Deterministic |  0.563 |  9.260 | 87.503 |
| 80    | Warm  | Raw disabled  |  0.299 |  1.857 |  2.385 |
| 80    | Warm  | Deterministic |  0.714 |  2.725 |  3.312 |
| 500   | Warm  | Raw disabled  |  1.442 |  2.582 |  7.541 |
| 500   | Warm  | Deterministic |  3.622 |  5.397 | 13.185 |
| 30    | Cold  | Raw disabled  |  2.565 |  6.796 |  6.796 |
| 30    | Cold  | Deterministic |  3.768 |  5.407 |  5.407 |
| 80    | Cold  | Raw disabled  |  2.662 |  2.911 |  2.911 |
| 80    | Cold  | Deterministic |  3.506 |  3.968 |  3.968 |
| 500   | Cold  | Raw disabled  |  6.478 |  8.625 |  8.625 |
| 500   | Cold  | Deterministic | 11.395 | 13.213 | 13.213 |

Across these fixtures, all 615 measured deterministic calls returned `refined`
and all 615 measured disabled calls returned the expected `raw-fallback`/`disabled` result. There
were zero logical model-adapter attempts and no deterministic timeout/fallback.
The harness checks expected output for every sample; this does not substitute
for human semantic adjudication. Maximum sampled RSS was 135,626,752 bytes and
maximum sampled heap used was 31,466,264 bytes, including runtime and observer
allocation. These samples are not a retained-heap or leak proof. Per-workload CPU
time, allocation deltas, phase distributions, outcomes and counts are preserved
in the full JSON.

The 30-word warm p99 of 87.503 ms is retained, rather than discarded as an outlier.
This shared-host text benchmark establishes neither the proposed 75 ms
deterministic product budget nor 750 ms added-model or 1,500 ms Stop-to-preview
budgets. Capture, final STT, browser paint, explicit insertion, real provider
requests, impaired networks, offline failures, CPU-load experiments and phone
qualification remain NOT RUN.

## Remaining native qualification procedure

The mocked-Gateway browser baseline, review journey and delayed-close scenarios
passed on the integrated tree with retained before/after proof through
`OPENCLAW_CAPTURE_UI_PROOF`. Run the separately registered realtime/file
real-Gateway scenarios on a host
that can prepare the required runtime. Publish the inspected clean and annotated
comparison images inline in the PR through a supported attachment transport.
Then repeat the supported journey with a real microphone, keyboard-only
navigation, a screen reader and 200% zoom. These remaining procedures are not
completed receipts.

With an accepted locality/admission owner and explicit selected route, observe
actual speech and refinement connections under local success, model absence,
failure, cancellation and configured remote fallback. Record attempted egress
separately from unrelated authentication, updates and Gateway activity. Do not
infer this result from the synthetic route-policy tests. Collect W1 audio and
all end-to-end phase timestamps with a human-adjudicated semantic/literal corpus,
including negation, quantities/units, names/dates, approved expansions, protected
code/paths and opaque references. Finally test the same retained user state
through installed upgrade, disabling refinement and downgrade; verify that
drafts and unrelated feature stores survive.

## Independent review and unresolved gates

Independent review inspected the actual diff and found actionable issues:
capture notifications invalidated the main composer's own draft revision;
cancelled provisional generations could revive; model-only instructions without
a route could report success; programmatic draft changes needed an authoritative
text snapshot; and Side chat's separate submit/truncation contract could not
support this opt-in safely. The implementation addresses those paths. Review also
caught and corrected the new browser test's CI ownership entry, synchronous
draft-edit/undo race, controller census growth and repeated Cancel status. Final
independent source review found no remaining actionable P1/P2 within the private
main-composer scope. That review did not run the checks and is not full M11
qualification.

The selected specification and PR draft were supplied, but their referenced
workflow/architecture/stacking/validation/coverage/dependency-summary package
masters were not available. They are not claimed as read or implemented. Existing
sibling feature drafts and historical PR #187371 are not accepted dependencies.

Maintainer acceptance is requested in #205845 for the new public request/RPC
surface, the owning authorization/locality boundary, and the eventual selected
browser model route. No accepted P04-equivalent policy was found. The private
implementation and local review remain reviewable without exposing that surface.
The issue's automated review recommends evaluating a bounded private path and
leaves owner placement and the admission/revocation policy to maintainers; it is
not design acceptance. In particular, this draft's current-authorization checks
must be reconciled with the repository's admission-once policy before a public
contract is established.
No new public RPC/config/SDK export is introduced. No merge is authorized by this
assignment, and the umbrella issue must not be closed by this draft.
