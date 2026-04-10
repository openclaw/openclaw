# Cross-Module Unit Tests (`src/octo/test/unit/`)

This directory holds unit tests that span more than one Octopus module but still run in isolation from real runtimes. Examples include tests that wire a fake adapter into a real `SchedulerService`, tests that drive the `EventLogService` from a synthetic registry, and tests that exercise the Node Agent launcher against a mocked process watcher.

Module-local unit tests (a single file testing a single file) should stay next to their subject — for example, `src/octo/wire/schema.test.ts` sits beside `schema.ts`. Only tests that meaningfully cross module boundaries belong here.

See `docs/octopus-orchestrator/TEST-STRATEGY.md` for coverage expectations and naming conventions.
