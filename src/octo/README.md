# Octopus Orchestrator (`src/octo/`)

Octopus is the multi-agent orchestration subsystem that lives inside the OpenClaw codebase as a set of modules (not a separate repository). It introduces a Head Controller, per-habitat Node Agents, execution adapters, and supporting wire/config/CLI surfaces that together schedule and supervise missions composed of directed grips.

This directory is the top-level home for all Octopus code. The subsystem is gated by the `octo.enabled` feature flag in `openclaw.json` and is disabled by default through Milestone 1. See `docs/octopus-orchestrator/HLD.md` §"Code layout and module boundaries" for the authoritative shape of this tree, `docs/octopus-orchestrator/LLD.md` for module-level contracts, and `docs/octopus-orchestrator/DECISIONS.md` for the decision log that motivates the split.

## Subdirectories

- [`head/`](./head/README.md) — Head Controller services: scheduler, registry, event log, leases, claims, artifacts, policy, progress watchdog.
- [`adapters/`](./adapters/README.md) — Execution adapters that map abstract arm specs onto concrete runtimes (subagent, cli-exec, pty-tmux, acp) plus the upstream-isolation bridge in [`adapters/openclaw/`](./adapters/openclaw/README.md).
- [`node-agent/`](./node-agent/README.md) — Per-habitat Node Agent: launcher, tmux manager, process watcher, lease heartbeat, telemetry, policy enforcer, session reconciler.
- [`wire/`](./wire/README.md) — Shared TypeBox schemas and primitives used by both Head and Node Agent (arm/grip/mission specs, `octo.*` method and event envelopes, feature advertiser).
- [`cli/`](./cli/README.md) — `openclaw octo …` CLI command implementations (status, arm, mission, grip, claims, events, node).
- [`config/`](./config/README.md) — `openclaw.json` `octo:` block loader, schema, and validator.
- [`test/`](./test/README.md) — Unit, integration, and chaos test suites specific to Octopus.

## Task tracking

Active work on this subsystem is tracked in [`../../docs/octopus-orchestrator/TASKS.md`](../../docs/octopus-orchestrator/TASKS.md). Milestone 0 establishes the wire contracts, config schema, and this scaffold; runtime code lands in Milestone 1 and later.
