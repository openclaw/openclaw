# Node Agent (`src/octo/node-agent/`)

The Node Agent runs one instance per habitat and is the Head Controller's local delegate on that machine. It accepts leases from the Head, launches and supervises agent processes through the appropriate adapter, streams telemetry and events back, enforces local policy, and reconciles session state after restarts. Unlike the Head (which is a single authoritative process), Node Agents are horizontally distributed across habitats.

Per HLD §"Code layout and module boundaries", this module will house the following components (landing in Milestone 1 and later):

- `launcher.ts` — entry point and top-level Node Agent lifecycle.
- `tmux-manager.ts` — tmux session and pane management for pty-based adapters.
- `process-watcher.ts` — subprocess supervision and exit handling.
- `lease-heartbeat.ts` — periodic heartbeat to the Head to keep leases alive.
- `telemetry.ts` — resource and progress telemetry emission.
- `policy-enforcer.ts` — local enforcement of capability and resource policies.
- `session-reconciler.ts` — post-restart reconciliation of in-flight sessions against the Head's registry.

No runtime code lives here yet. See `docs/octopus-orchestrator/LLD.md` §"Node Agent" for the detailed contracts each file will implement.
