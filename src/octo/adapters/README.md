# Execution Adapters (`src/octo/adapters/`)

Adapters translate abstract `ArmSpec` definitions into concrete execution on a Node Agent. Each adapter implements the shared contract defined in `base.ts` and is selected by the Head Controller based on the arm's declared runtime and capabilities. The adapter boundary is what lets Octopus supervise heterogeneous tools (native subagents, external CLI coders, interactive TUI agents, ACP-speaking processes) through a single scheduler and event log.

Per HLD §"Code layout and module boundaries", OCTO-DEC-036, and OCTO-DEC-037, the following adapter modules are planned:

- `base.ts` — Adapter contract expressed with TypeBox; every adapter must satisfy this interface.
- `subagent.ts` — `SubagentAdapter`, wrapping the native `sessions_spawn` path.
- `cli-exec.ts` — `CliExecAdapter`, the primary path for external coding tools that expose a structured CLI mode (OCTO-DEC-037).
- `pty-tmux.ts` — `PtyTmuxAdapter`, the primary path for interactive TUI tools and the universal fallback.
- `acp.ts` — `AcpAdapter`, wrapping `sessions_spawn({runtime:"acp"})`; opt-in only per OCTO-DEC-036.

None of these `.ts` files exist yet — Milestone 0 only reserves the directory structure. Runtime adapter implementations land in Milestone 1 and later. The [`openclaw/`](./openclaw/README.md) subdirectory holds the upstream-isolation bridge (see OCTO-DEC-033) that keeps adapters decoupled from internal OpenClaw module paths.
