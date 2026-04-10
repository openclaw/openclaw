// Octopus Orchestrator -- Adapter factory / dispatcher (M2-04)
//
// createAdapter(adapterType, deps) returns the correct Adapter implementor
// for the given AdapterType. Currently implemented: pty_tmux (M2-09) and
// cli_exec (M2-05/06/07). structured_subagent and structured_acp throw
// AdapterError("not_supported") until their milestones land.
//
// See:
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033 (boundary rules)
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-036 (adapter preference)

import type { TmuxManager } from "../node-agent/tmux-manager.ts";
import { AdapterError, type Adapter, type AdapterType } from "./base.ts";
import { CliExecAdapter } from "./cli-exec.ts";
import { PtyTmuxAdapter } from "./pty-tmux.ts";

// ──────────────────────────────────────────────────────────────────────────
// AdapterDeps -- injected dependencies for adapter construction
// ──────────────────────────────────────────────────────────────────────────

export interface AdapterDeps {
  tmuxManager: TmuxManager;
}

// ──────────────────────────────────────────────────────────────────────────
// createAdapter -- factory function (the public API)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create an {@link Adapter} for the given adapter type. Implemented:
 * `pty_tmux` (full PtyTmuxAdapter) and `cli_exec` (CliExecAdapter).
 * `structured_subagent` and `structured_acp` throw
 * {@link AdapterError} with code `not_supported`.
 */
export function createAdapter(adapterType: AdapterType, deps: AdapterDeps): Adapter {
  switch (adapterType) {
    case "pty_tmux":
      return new PtyTmuxAdapter(deps.tmuxManager);
    case "cli_exec":
      return new CliExecAdapter();
    case "structured_subagent":
      throw new AdapterError("not_supported", "adapter not yet implemented: structured_subagent");
    case "structured_acp":
      throw new AdapterError("not_supported", "adapter not yet implemented: structured_acp");
    default: {
      // Exhaustive check -- if AdapterType grows, TS will flag this.
      const _exhaustive: never = adapterType;
      throw new AdapterError("not_supported", `unknown adapter type: ${String(_exhaustive)}`);
    }
  }
}
