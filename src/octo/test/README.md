# Octopus Test Suites (`src/octo/test/`)

This directory houses test suites specific to the Octopus subsystem, organized by scope. Module-local unit tests for wire schemas and config validation live beside their subjects (e.g. `wire/schema.test.ts`); this `test/` tree holds cross-module and system-level tests that do not belong next to a single source file.

Subdirectories:

- [`unit/`](./unit/README.md) — cross-module unit tests that exercise interactions between Head services, adapters, or Node Agent components in isolation from real runtimes.
- [`integration/`](./integration/README.md) — end-to-end tests that boot a real Head Controller, one or more Node Agents, and drive missions through the Gateway to verify whole-system behavior.
- [`chaos/`](./chaos/README.md) — fault-injection and resilience tests covering crashes, network partitions, lease expiry, and other failure modes.

See `docs/octopus-orchestrator/TEST-STRATEGY.md` for the overall testing philosophy, coverage expectations, and guidance on which tier a given test belongs in.
