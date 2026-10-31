# Test audit ledger

Repository-wide audit started at `96e05f7ca44`. Status: in progress.
Inventory: 21,443 JS/TS test files, plus native test suites; 860 fixture-named paths.
Inventory and automated candidate scans are discovery, not completed coverage review.

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
71-line target-resolution helper and its private SDK facade await coherent retirement.
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

Remaining: declaration-level review across remaining core, plugins, UI, native apps,
root/script suites and shared fixtures; close owner-reading gaps and land subsequent batches.
