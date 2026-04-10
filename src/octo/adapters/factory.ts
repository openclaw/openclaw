// Octopus Orchestrator -- Adapter factory / dispatcher (M2-04)
//
// createAdapter(adapterType, deps) returns the correct Adapter implementor
// for the given AdapterType. For M2-04 only pty_tmux is implemented; the
// other three types throw AdapterError("not_supported") until their
// respective milestones land (M2-05, M2-10, M2-11).
//
// The pty_tmux adapter returned here is a TEMPORARY thin wrapper around
// TmuxManager that extracts the inline logic previously in armSpawn
// (gateway-handlers.ts). M2-09 replaces it with the full PtyTmuxAdapter.
//
// See:
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033 (boundary rules)
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-036 (adapter preference)

import type { TmuxManager } from "../node-agent/tmux-manager.ts";
import type { ArmSpec } from "../wire/schema.ts";
import {
  AdapterError,
  type Adapter,
  type AdapterEvent,
  type AdapterType,
  type CheckpointMeta,
  type SessionRef,
} from "./base.ts";

// ──────────────────────────────────────────────────────────────────────────
// AdapterDeps -- injected dependencies for adapter construction
// ──────────────────────────────────────────────────────────────────────────

export interface AdapterDeps {
  tmuxManager: TmuxManager;
}

// ──────────────────────────────────────────────────────────────────────────
// Canonical tmux session-name convention (shared with gateway-handlers.ts
// and session-reconciler.ts)
// ──────────────────────────────────────────────────────────────────────────

const SESSION_NAME_PREFIX = "octo-arm-";

function sessionNameForArm(armId: string): string {
  return `${SESSION_NAME_PREFIX}${armId}`;
}

// ──────────────────────────────────────────────────────────────────────────
// PtyTmuxAdapterStub -- temporary thin wrapper (replaced by M2-09)
// ──────────────────────────────────────────────────────────────────────────

class PtyTmuxAdapterStub implements Adapter {
  readonly type = "pty_tmux";

  constructor(private readonly tmuxManager: TmuxManager) {}

  async spawn(spec: ArmSpec): Promise<SessionRef> {
    const runtimeOptions = spec.runtime_options as {
      command: string;
      args?: readonly string[];
    };
    const baseCommand = runtimeOptions.command;
    const extraArgs = runtimeOptions.args ?? [];
    const cmd = extraArgs.length > 0 ? `${baseCommand} ${extraArgs.join(" ")}` : baseCommand;

    // The arm_id is derived from the idempotency_key's corresponding arm
    // record. For the stub, we use the idempotency_key as the arm handle
    // in the session name. The gateway handler passes spec with arm_id
    // injected as a transient field (see gateway-handlers.ts).
    const armId = (spec as ArmSpec & { _arm_id?: string })._arm_id;
    if (armId === undefined) {
      throw new AdapterError(
        "spawn_failed",
        "pty_tmux stub adapter requires spec._arm_id (set by gateway handler)",
      );
    }

    const sessionName = sessionNameForArm(armId);
    await this.tmuxManager.createSession(sessionName, cmd, spec.cwd);

    return {
      adapter_type: "pty_tmux",
      session_id: sessionName,
      attach_command: `tmux attach -t ${sessionName}`,
      cwd: spec.cwd,
      metadata: { tmux_session_name: sessionName },
    };
  }

  async resume(_ref: SessionRef): Promise<SessionRef> {
    throw new AdapterError("not_supported", "pty_tmux stub: resume not yet implemented");
  }

  async send(_ref: SessionRef, _message: string): Promise<void> {
    throw new AdapterError("not_supported", "pty_tmux stub: send not yet implemented");
  }

  // eslint-disable-next-line require-yield
  async *stream(_ref: SessionRef): AsyncIterable<AdapterEvent> {
    throw new AdapterError("not_supported", "pty_tmux stub: stream not yet implemented");
  }

  async checkpoint(_ref: SessionRef): Promise<CheckpointMeta> {
    throw new AdapterError("not_supported", "pty_tmux stub: checkpoint not yet implemented");
  }

  async terminate(ref: SessionRef): Promise<void> {
    const sessionName = ref.metadata?.tmux_session_name;
    if (typeof sessionName === "string") {
      await this.tmuxManager.killSession(sessionName);
    }
  }

  async health(_ref: SessionRef): Promise<string> {
    throw new AdapterError("not_supported", "pty_tmux stub: health not yet implemented");
  }
}

// ──────────────────────────────────────────────────────────────────────────
// createAdapter -- factory function (the public API)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create an {@link Adapter} for the given adapter type. Only `pty_tmux`
 * is implemented at M2-04; the other three types throw
 * {@link AdapterError} with code `not_supported`.
 */
export function createAdapter(adapterType: AdapterType, deps: AdapterDeps): Adapter {
  switch (adapterType) {
    case "pty_tmux":
      return new PtyTmuxAdapterStub(deps.tmuxManager);
    case "cli_exec":
      throw new AdapterError("not_supported", "adapter not yet implemented: cli_exec");
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
