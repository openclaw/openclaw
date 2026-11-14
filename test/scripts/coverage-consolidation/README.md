# Script test coverage consolidation, tranche 1

Related: https://github.com/openclaw/openclaw/issues/198737

Baseline: `299b36e7429539440214dd63e061e9261a7270b2`.

This manifest records the maintainer-authorized consolidation of script-test
coverage. Each lane records the exact retired file or test case, its surviving
keeper, and the failure detection retained there. A keeper may be an existing
suite or a reduced table introduced by this tranche. Source files, workflow
configuration, and runtime behavior are outside the edit scope.

The tranche target is 80,000–100,000 net test lines. This packet
removes 917 net test/support lines. The target is not achieved. The manifest files are additional review
evidence and are counted separately from executable test/support code.

Scoped test execution stopped before loading tests because the checkout has no
qualified dependencies. The tooling test typecheck stopped on missing
`tsrs/package.json`. Pinned formatting, syntax parsing of all 30 remaining
changed test/helper files, JSON parsing of all 12 lane manifests, and
`git diff --check` passed. Runtime/typecheck proof remains pending exact-head CI.

## Lane manifests

Each JSON file in this directory owns one disjoint set of test basenames.
Ownership uses anchored basename prefixes, in this precedence order:

1. CI and Vitest: `ci-`, `test-project`, `vitest-`, `run-vitest`.
2. Package: `package-`, `npm-`, `publish-`, `plugin-*workflow`, `official-plugin`.
3. Release: `full-release`, `release-`, `frv`.
4. Build: `build-`, `bundled-`, `bun-`, `bundle-`, `setup-pnpm`.
5. Install/update: `install`, `update-`, `upgrade-`, `migrate-`, `patch-`, `doctor-`.
6. Operations: `crabbox`, `testbox`, `blacksmith`, `agent`, `fleet`, `pr-`,
   `clawsweeper`, `retry-`, `run-`.
7. Native: `android`, `ios`, `mac`, `swift`, `apple`, `windows`, `linux`, `xcode`,
   `code-sign`, `sign`.
8. Guards: `check-`, `audit-`, `guard-`, `deadcode`, `lint-`, `ox`, `security-`,
   `validate`, `verify`, `format`, `sync`.
9. Runtime: `bench-`, `perf`, `profile`, `gateway-`, `runtime`, `sqlite`,
   `postgres`, `db`, `database`, `server`, `session`.
10. Remaining basenames: `a`–`i`, `j`–`p`, and `q`–`z`.

## Proof policy

After all edits are frozen, run the scoped `test/scripts` suite and its test
typecheck. When local dependencies are unqualified, record the actual command
failure and use the existing exact-head CI route on the draft PR. A full
Testbox baseline is not a prerequisite. Passing formatting or syntax parsing
does not claim passing runtime tests or typechecking.

## Gateway tranche 2

Baseline: `eacadf5279137c919ce18de71688886fe28eecfe`.

The twelve `tranche-2-*.json` manifests record gateway test consolidation.
This packet removes 1,300 net executable test/support lines across 29 test paths,
including the new shared migration fixture. Production LOC delta is zero.
The 50,000–100,000-line target remains unmet; distinct authority, lifecycle,
persistence, and cancellation checks remain separate.

`node scripts/run-vitest.mjs src/gateway --maxWorkers=1` stopped before loading
tests because this checkout has no qualified dependencies. The scoped gateway
typecheck (`node scripts/run-tsgo.mjs -p
test/tsconfig/tsconfig.core.test.gateway-other.json --incremental`) stopped on
missing `tsrs/package.json`; the other gateway typecheck shards were not run.
Pinned formatting and syntax checks passed for all 28 surviving TypeScript
files. Runtime/typecheck validation remains pending exact-head draft CI.

## Validation restorations

`src/gateway/session-history-cold.benchmark.test.ts` is retained at its original
136 lines from `18892937`. Its real cold-history RPC coverage did not transfer
to the worker fixture: the added historical-session selector was invalid.
The archived worker case is restored from the same revision; no deletion credit
or equivalent-coverage claim remains for the benchmark.
