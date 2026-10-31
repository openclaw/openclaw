# Test audit ledger

Repository-wide audit started at `96e05f7ca44`. Status: in progress.
Inventory: 21,443 JS/TS test files, plus native test suites; 860 fixture-named paths.
Inventory and automated candidate scans are discovery, not completed coverage review.

| Batch                   | Decision                                                                                                        | Evidence and remaining proof                                                                                                                                                                                                                                                                                                                                                 | Validation / landing                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CI hosted admission     | Remove two source-literal assertions from `ci-workflow-planning.test.ts`, `bounds hosted rows with Android=%s`. | The same test executes `ci-build-manifest.mjs` at 40, 41, 45, and 46 base rows with Android enabled and disabled. It checks admission at 40, emitted row totals, and the 45-row warning. The test dates to `920bc99908b`; the source checks came with extraction in `9d75a8fe87a`. No production or support removal.                                                         | Boundary cases passed on macOS; full suite and removal checks pending in [PR #189083](https://github.com/openclaw/openclaw/pull/189083). |
| CI merge preparation    | Remove six source/comment assertions from the same planning suite.                                              | `ci-linux-git.test.ts` executes the actual workflow shell, checking merge ref/depth, stale-parent retry order, selected checkout, and exact base publication. Keep PR rejection, exhaustion, moving-base, and Git-owner checkout guards: the fake checkout does not prove owner admission. Executable coverage dates to `4b8a2a7d932`; source checks moved in `be0ee80928b`. | Preservation review caught and retained the owner guard; Linux keeper proof and updated review pending in the same PR.                   |
| Plugin package contract | Retain all five declarations in one suite.                                                                      | Active taxonomy order, legacy category acceptance/deduplication, explicit compatibility fields, version fallbacks, and stable missing-field diagnostics. Callers include manifest validation and publication checks; prior redundant constant tests were removed in `53b95fd0bef`.                                                                                           | Read-only audit; no runtime baseline claimed.                                                                                            |

Retained candidates:

- Identical `GatewayTLSStoreFixture.swift` files belong to separate Swift test packages.
- `placement-read-cache.worker.test.ts` repeats a getter in an identity assertion:
  it protects stable borrowed references across reads, rather than comparing a local value to itself.
- Sampled apparently orphaned CLI/state/infra/QA helpers are compiled-child entrypoints
  registered through extensionless names. Keep their process and lifecycle proof.
- Blobster JSON examples are discovered by the renderer suite; two also supply production prompt examples.
- Short script guards for release, architecture, and platform contracts remain independent proof.

Completed read-only package lanes (no runtime baseline claimed):

| Packages                                              | Suites retained | Independent contracts                                                                                   |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `normalization-core`                                  | 26              | Unicode/grapheme, normalization, format, and public export contracts; all support remains used.         |
| `retry`, `tool-call-repair`                           | 8               | Retry policy; parser bounds, fences, protection, and stream-terminal invalidation.                      |
| `media-understanding-common`, `media-generation-core` | 5               | Caption/order, size admission, catalog/model references, dimensions, duration, and override precedence. |
| `net-policy`                                          | 4               | IP/URL parsing, custom-bind validation, SSRF vectors, and redaction secrecy with byte preservation.     |

The full CI planning suite and its manifest/workflow/Git-owner support were read.
Other routing, admission, frozen-target, and gate layers retain distinct contracts.

Remaining: declaration-level review across core, plugins, packages, UI, native apps,
root/script suites, and their shared fixtures; validate and land subsequent owner batches.
