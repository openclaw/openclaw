// Octopus Orchestrator -- Adapter factory / dispatcher (M2-04)
//
// createAdapter(adapterType, deps) returns the correct Adapter implementor
// for the given AdapterType. All four adapter types are wired:
//   - pty_tmux (M2-09): PtyTmuxAdapter — tmux-based interactive sessions
//   - cli_exec (M2-05/06/07): CliExecAdapter — raw subprocess execution
//   - structured_subagent (M2-10): SubagentAdapter — OpenClaw native runtime
//   - structured_acp (M2-11): AcpAdapter — ACP harness via acpx
//
// structured_subagent and structured_acp require bridge dependencies
// (SessionsSpawnBridge, AcpxBridge) injected via AdapterDeps. When the
// bridges are not provided, requesting those adapter types throws
// AdapterError("not_supported") with a descriptive message.
//
// See:
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033 (boundary rules)
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-036 (adapter preference)

import type { TmuxManager } from "../node-agent/tmux-manager.ts";
import { AcpAdapter } from "./acp.ts";
import { AdapterError, type Adapter, type AdapterType } from "./base.ts";
import { CliExecAdapter } from "./cli-exec.ts";
import type { AcpxBridge } from "./openclaw/acpx-bridge.ts";
import type { SessionsSpawnBridge } from "./openclaw/sessions-spawn.ts";
import { PtyTmuxAdapter } from "./pty-tmux.ts";
import { SubagentAdapter } from "./subagent.ts";

// ──────────────────────────────────────────────────────────────────────────
// AdapterDeps -- injected dependencies for adapter construction
// ──────────────────────────────────────────────────────────────────────────

export interface AdapterDeps {
  tmuxManager: TmuxManager;
  /** Bridge to OpenClaw's sessions_spawn API. Required for structured_subagent. */
  sessionsSpawnBridge?: SessionsSpawnBridge;
  /** Bridge to acpx harness. Required for structured_acp. */
  acpxBridge?: AcpxBridge;
}

// ──────────────────────────────────────────────────────────────────────────
// createAdapter -- factory function (the public API)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create an {@link Adapter} for the given adapter type. All four types
 * are implemented; `structured_subagent` and `structured_acp` require
 * their respective bridge deps to be provided.
 */
export function createAdapter(adapterType: AdapterType, deps: AdapterDeps): Adapter {
  switch (adapterType) {
    case "pty_tmux":
      return new PtyTmuxAdapter(deps.tmuxManager);
    case "cli_exec":
      return new CliExecAdapter();
    case "structured_subagent": {
      if (!deps.sessionsSpawnBridge) {
        throw new AdapterError(
          "not_supported",
          "structured_subagent adapter requires sessionsSpawnBridge in AdapterDeps",
        );
      }
      return new SubagentAdapter(deps.sessionsSpawnBridge);
    }
    case "structured_acp": {
      if (!deps.acpxBridge) {
        throw new AdapterError(
          "not_supported",
          "structured_acp adapter requires acpxBridge in AdapterDeps",
        );
      }
      return new AcpAdapter(deps.acpxBridge);
    }
    default: {
      // Exhaustive check -- if AdapterType grows, TS will flag this.
      const _exhaustive: never = adapterType;
      throw new AdapterError("not_supported", `unknown adapter type: ${String(_exhaustive)}`);
    }
  }
}
