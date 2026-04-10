# Chaos Tests (`src/octo/test/chaos/`)

This directory holds fault-injection and resilience tests. Chaos tests deliberately kill Node Agents mid-lease, expire leases, partition the Head from its Node Agents, corrupt the event log, and otherwise stress the Octopus recovery paths to verify that the system remains safe (no lost claims, no orphaned arms, no duplicated work) under adverse conditions.

These tests exist because orchestration bugs tend to manifest only under failure: the happy path is usually easy to get right, while reconciliation, idempotency, and lease-expiry logic are where real bugs live. Chaos tests are intentionally slower and more expensive than integration tests and typically run on a separate CI tier.

See `docs/octopus-orchestrator/TEST-STRATEGY.md` §"Chaos" for the catalog of required failure modes and the recovery invariants each test must assert.
