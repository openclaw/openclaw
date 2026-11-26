# Dictation refinement: implementation and qualification

Tracking issue: [openclaw/openclaw#205845](https://github.com/openclaw/openclaw/issues/205845).
Base: `openclaw/openclaw`, `main`, `d11cb0518f095ac0eef7d232510e8783a209754f`.

This is a private, in-memory coordinator and an opt-in review flow in the main
Chat composer. M11 is **not fully qualified**. The browser uses the conservative
local text processor; the selected-model adapter is private and has no browser
RPC. The missing maintainer acceptance, provider and device evidence, and local
check failures below keep this change a draft. The issue must remain open.

## Supported behavior

The main composer's **Dictation text options** control enables review for that
composer instance. It defaults off and writes no configuration or history. During
capture, provisional captions remain outside the editable draft. Stop releases
the existing microphone owner immediately. A separate finishing state waits for
a bounded, typed final transcription snapshot. A clean close with finalized text
and no unfinished trailing caption is required for an eligible final transcript.
Timeout, disconnect, error, and partial-only text do not manufacture finality.

The preview exposes the original and candidate as read-only text. **Use reviewed
text** and **Keep raw transcript** explicitly insert into the owned draft. Neither
action sends a message. New capture, edit, draft replacement, connection/account
replacement, capability withdrawal, and cancellation invalidate the old result.
Late completion cannot restore a retired generation. Oversized captions are
rejected with visible recovery copy instead of clipped into a draft.

New Session and Side chat do not advertise refinement. Their existing insertion
and submit contracts differ; Side chat also has a destination length limit.
They retain baseline dictation. The optional capability must remain absent until
each destination can accept the complete reviewed insertion without truncation
or an automatic submit. The main composer also snapshots its authoritative draft
text so programmatic draft replacements invalidate review.

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

| Boundary                              | Implemented ceiling                       |
| ------------------------------------- | ----------------------------------------- |
| Final transcript / candidate output   | 32 KiB UTF-8 each                         |
| Context / vocabulary text             | 8 KiB UTF-8 each                          |
| Serialized request and model payload  | 64 KiB UTF-8                              |
| Combined processor model instructions | 4 KiB UTF-8                               |
| Context or vocabulary snapshots       | 32 per collection                         |
| Protected spans / edits               | 256 each                                  |
| Registered processors                 | 32                                        |
| Stop/finality/refinement deadline     | 2,500 ms, shared by the browser flow      |
| Selected model invocations            | At most one per admitted final generation |

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

## Acceptance matrix

The result column distinguishes implemented checks from full-issue qualification.
Source links describe the code at this change; planned procedures are not passes.

| Criterion                              | Production owner / verification                                                                                                                                                              | Observed result and remaining qualification                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC01 — neutral typed contract          | [Types](types.ts), [validator](validation.ts), [core tests](coordinator.test.ts)                                                                                                             | Focused tests pass for schema, revisions, bounded snapshots, exact-base candidates, UTF-16/grapheme ranges and malformed output. Public schema is deliberately not exposed.                                                                                            |
| AC02 — one ordered plan/pass           | [Plan](plan.ts), [coordinator](coordinator.ts), [model adapter](../../talk/dictation-refinement-model.ts), core and [provider-boundary tests](../../talk/dictation-refinement-model.test.ts) | Core fixtures pass for absent/disabled/missing adapters, precedence and one invocation. Real browser model wiring awaits accepted RPC/policy ownership. Provider-boundary suite is blocked before cases by compiled subprocess exit 137.                               |
| AC03 — meaning and protection          | [Validator](validation.ts), core literal/reference and meaning cases                                                                                                                         | Protected bytes/identity and conservative review cases pass, including interior indentation, negation, quantities, units, names and added claims. Human semantic adjudication is NOT RUN.                                                                              |
| AC04 — cancellation/stale ownership    | [Coordinator](coordinator.ts), [composer owner](../../../ui/src/pages/chat/composer-dictation.ts), [preview tests](../../../ui/src/pages/chat/composer-dictation-refinement.test.ts)         | Focused tests pass for cancel, edit, generation/target/account/connection/authority/locale replacement, capability withdrawal and late results. Actual browser and native journeys have separate proof below.                                                          |
| AC05 — Stop releases capture           | [Capture owner](../../../ui/src/pages/chat/composer-dictation-session.ts), [finality tests](../../../ui/src/pages/chat/composer-dictation-session.finality.test.ts)                          | Eight external-media-fixture cases pass, including immediate track release and hung close. Physical microphone/device proof is NOT RUN.                                                                                                                                |
| AC06 — eligible recovery               | Capture owner, coordinator, finality/preview/core tests                                                                                                                                      | Final-only fallback, incomplete manual recovery, exhausted budget and revoked/expired STT-hint cases pass. No independent re-transcription route is fabricated. Live shared-hint provider proof is NOT RUN.                                                            |
| AC07 — one preview, separate delivery  | [Preview owner](../../../ui/src/pages/chat/composer-dictation-refinement.ts), [controls](../../../ui/src/pages/chat/components/chat-composer-controls.tsx), preview tests                    | Explicit accept commits once; actual send-control fixture does not send after review-required Stop. No agent/tool/send implementation is called by core. Main browser journey remains separately qualified.                                                            |
| AC08 — authoritative locality / egress | Model adapter route-policy callbacks; browser local processor                                                                                                                                | BLOCKED: accepted speech/refinement locality owner is absent. Real attempted-egress matrix, offline failure and retry evidence are NOT RUN. Synthetic local adapters do not establish offline processing.                                                              |
| AC09 — bounded resources               | Limits, validator, coordinator, model adapter, oversized caption UI                                                                                                                          | Core/UI bound and deadline tests pass; model-boundary suite remains blocked. Total SDK memory, noncooperative callback termination and real-provider resource behavior are unqualified.                                                                                |
| AC10 — privacy / authorization         | Immutable plan, dispatch/publication/fallback callbacks, projected model input                                                                                                               | Core tests pass for immutable admission, revoked authorization and content-free failure metrics. Model transport projection suite is blocked before cases; live logging/egress observation is NOT RUN.                                                                 |
| AC11 — accessible full journey         | [View](../../../ui/src/pages/chat/components/composer-dictation-refinement-view.tsx), [browser scenario](../../../ui/src/e2e/browser-dictation-refinement.e2e.test.ts)                       | Component tests pass for accessible opt-in, stable polite status, quiet provisional caption, read-only RTL/literal inspection and cancellation. Browser capture and real screen-reader/zoom journey are not yet qualified.                                             |
| AC12 — complete latency claim          | [Measurement driver](../../../scripts/perf/dictation-refinement-measure.mts)                                                                                                                 | Synthetic text-only comparison is separate evidence below. W1 audio/Stop/STT/provider/preview/insertion p50/p95/p99, network impairment, CPU load and phone qualification are NOT RUN. No 1,500/750/75 ms product latency claim is made.                               |
| AC13 — disable/compatibility           | Ephemeral opt-in, capability gate, existing baseline owner API; core/UI regression suites                                                                                                    | Disabled, absent processor, unsupported locale and capability withdrawal cases pass. Baseline dictation/direct-composer/split-Talk regressions pass. No schema migration or feature-store deletion is added. Actual same-state installed upgrade/downgrade is NOT RUN. |

## Verification receipts

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

Targeted UI and script lint, the shared-core typecheck, the existing native
controller census, English-copy baseline, and the CI browser-owner planner's 18
tests pass. UI lint reports three nonfatal reactive-use warnings. The final
targeted core/model lint attempt exited 137 without a successful receipt.
The UI bundle builds, but its three budget warnings and an additional existing
attachment-progress test failure require an actual-base comparison before being
classified. The full UI/model type and build graphs remain CI qualification
work; a passing focused graph does not replace them.

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
