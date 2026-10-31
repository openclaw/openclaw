# Test audit ledger

Repository-wide audit started at `96e05f7ca44`. Status: in progress.
Inventory: 21,443 JS/TS test files, plus native test suites; 860 fixture-named paths.
Inventory and automated candidate scans are discovery, not completed coverage review.

| Batch               | Decision                                                                                                    | Evidence and remaining proof                                                                                                                                                                                                                                                                                    | Validation / landing                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| CI hosted admission | Remove source-literal assertions from `ci-workflow-planning.test.ts`, `bounds hosted rows with Android=%s`. | The same test executes `ci-build-manifest.mjs` at 40, 41, 45, and 46 base rows with Android enabled and disabled. It checks admission at 40, emitted row totals, and the 45-row warning. Exact constant declarations add spelling coupling only. Introduced in `920bc99908b`. No production or support removal. | Pending focused test, removal checks, review, and merge. |

Retained candidates:

- Identical `GatewayTLSStoreFixture.swift` files belong to separate Swift test packages.
- `placement-read-cache.worker.test.ts` repeats a getter in an identity assertion:
  it protects stable borrowed references across reads, rather than comparing a local value to itself.
- Sampled apparently orphaned CLI/state/infra/QA helpers are compiled-child entrypoints
  registered through extensionless names. Keep their process and lifecycle proof.
- Blobster JSON examples are discovered by the renderer suite; two also supply production prompt examples.
- Short script guards for release, architecture, and platform contracts remain independent proof.

Remaining: declaration-level review across core, plugins, packages, UI, native apps,
root/script suites, and their shared fixtures; validate and land subsequent owner batches.
