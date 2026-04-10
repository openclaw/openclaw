# Integration Tests (`src/octo/test/integration/`)

This directory holds end-to-end integration tests that boot a real Head Controller, one or more real Node Agents, and a real Gateway, then drive missions through the full `octo.*` surface. These tests verify whole-system behaviors: mission graph scheduling, lease handoff, event log replay, claim arbitration, and CLI-to-Gateway-to-Head round trips.

Integration tests are slower than unit tests and typically allocate temporary SQLite databases, JSONL event logs, and tmux sessions; they should be tagged so they can be excluded from fast inner-loop runs. Fixtures that set up and tear down these environments should be shared across tests where possible to keep runtime manageable.

See `docs/octopus-orchestrator/TEST-STRATEGY.md` for the full matrix of integration scenarios expected by each milestone.
