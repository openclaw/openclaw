// Octopus Orchestrator -- `openclaw octo arm attach` CLI command (M1-20)
//
// Attaches to an arm's tmux session interactively.
//
// Architecture:
//   resolveArmSession  -- looks up arm, extracts tmux session name
//   execTmuxAttach     -- execs `tmux attach-session -t <name>` with stdio inherit
//   runArmAttach       -- composes resolve + exec, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { spawnSync } from "node:child_process";
import type { ArmRecord, RegistryService } from "../head/registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ArmAttachOptions {
  arm_id: string;
}

export interface ResolvedSession {
  arm: ArmRecord;
  tmux_session_name: string;
}

export interface ArmAttachDeps {
  /** Injected for testing -- wraps the actual tmux exec call. */
  execAttach: (sessionName: string) => { status: number; stderr: string };
}

// ──────────────────────────────────────────────────────────────────────────
// Resolve -- arm lookup + session name extraction
// ──────────────────────────────────────────────────────────────────────────

/**
 * Looks up the arm in the registry and extracts the tmux session name.
 * Returns the resolved session or an error message string.
 */
export function resolveArmSession(
  registry: RegistryService,
  armId: string,
): ResolvedSession | string {
  const arm = registry.getArm(armId);
  if (!arm) {
    return `Error: arm '${armId}' not found.`;
  }

  const sessionRef = arm.session_ref;
  if (!sessionRef) {
    return `Error: arm '${armId}' has no session_ref -- no tmux session to attach to.`;
  }

  const tmuxName = sessionRef["tmux_session_name"];
  if (typeof tmuxName !== "string" || tmuxName.length === 0) {
    return `Error: arm '${armId}' session_ref has no valid tmux_session_name.`;
  }

  return { arm, tmux_session_name: tmuxName };
}

// ──────────────────────────────────────────────────────────────────────────
// Exec -- default tmux attach implementation
// ──────────────────────────────────────────────────────────────────────────

/** Default exec implementation -- spawns tmux with stdio inherited for interactive use. */
export function defaultExecAttach(sessionName: string): { status: number; stderr: string } {
  const result = spawnSync("tmux", ["attach-session", "-t", sessionName], {
    stdio: "inherit",
  });
  const status = result.status ?? 1;
  const stderr =
    result.error instanceof Error
      ? result.error.message
      : result.stderr
        ? result.stderr.toString()
        : "";
  return { status, stderr };
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point called by the CLI dispatcher. Returns exit code (0 = success). */
export function runArmAttach(
  registry: RegistryService,
  opts: ArmAttachOptions,
  out: { write: (s: string) => void } = process.stderr,
  deps: ArmAttachDeps = { execAttach: defaultExecAttach },
): number {
  const resolved = resolveArmSession(registry, opts.arm_id);

  if (typeof resolved === "string") {
    out.write(resolved + "\n");
    return 1;
  }

  const { status, stderr } = deps.execAttach(resolved.tmux_session_name);

  if (status !== 0) {
    const msg = stderr.length > 0 ? stderr : `tmux attach-session exited with code ${status}`;
    out.write(`Error: tmux attach failed: ${msg}\n`);
    return 1;
  }

  return 0;
}
