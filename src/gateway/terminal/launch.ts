// Resolves where an operator terminal session should start and whether the
// target agent's workspace isolation permits a host shell.
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope-config.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";

/** Why a terminal cannot open, or `null` when it can. */
export type TerminalLaunchBlock =
  | { kind: "disabled" }
  | { kind: "unknown-agent"; agentId: string }
  | { kind: "sandboxed"; agentId: string; mode: "all" };

/** Resolved plan for a host terminal session. */
export type TerminalLaunchPlan = {
  agentId: string;
  cwd: string;
  shell: string;
  args: string[];
};

/** Terminal launch resolution result: either a runnable plan or a block reason. */
export type TerminalLaunchResolution =
  | { ok: true; plan: TerminalLaunchPlan }
  | { ok: false; block: TerminalLaunchBlock };

/** Picks the interactive shell: explicit config, then the host login shell. */
export function resolveTerminalShell(params: {
  configuredShell?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): { shell: string; args: string[] } {
  const configured = params.configuredShell?.trim();
  if (configured) {
    return { shell: configured, args: [] };
  }
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  if (platform === "win32") {
    return { shell: env.ComSpec?.trim() || "cmd.exe", args: [] };
  }
  const loginShell = env.SHELL?.trim();
  if (loginShell) {
    // Login flag so the operator lands in the same environment their terminal
    // app would give them (profile-sourced PATH, aliases, prompt).
    return { shell: loginShell, args: ["-l"] };
  }
  return { shell: "/bin/bash", args: ["-l"] };
}

/**
 * Resolves the terminal launch plan for one agent.
 *
 * The terminal always starts in the agent workspace. When the agent runs fully
 * sandboxed (`sandbox.mode: "all"`), a host shell would escape the isolation the
 * agent itself is under, so this returns a `sandboxed` block rather than silently
 * handing back an unconfined shell — fail-closed. `"non-main"` keeps the agent's
 * main session on the host, so a host terminal is allowed there.
 */
export function resolveTerminalLaunch(params: {
  config: OpenClawConfig;
  enabled: boolean;
  agentId?: string;
  configuredShell?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): TerminalLaunchResolution {
  if (!params.enabled) {
    return { ok: false, block: { kind: "disabled" } };
  }
  const env = params.env ?? process.env;
  const requested = params.agentId?.trim();
  const agentId = requested ? normalizeAgentId(requested) : resolveDefaultAgentId(params.config);
  // Fail closed on unknown ids: they would resolve against the *global*
  // sandbox defaults and an invented workspace, sidestepping a per-agent
  // `sandbox.mode: "all"` refusal below.
  if (requested && !listAgentIds(params.config).includes(agentId)) {
    return { ok: false, block: { kind: "unknown-agent", agentId } };
  }
  const sandbox = resolveSandboxConfigForAgent(params.config, agentId);
  // Only "all" sandboxes every session. Under "non-main" the agent's main
  // session still runs on the host, so a host terminal there is consistent with
  // how the agent already runs (and an admin already has that host access via
  // the main session). Block only the fully-sandboxed case; in-sandbox terminals
  // are a tracked follow-up.
  if (sandbox.mode === "all") {
    return { ok: false, block: { kind: "sandboxed", agentId, mode: "all" } };
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.config, agentId, env);
  const cwd = existingDirOrHome(workspaceDir, env);
  const { shell, args } = resolveTerminalShell({
    configuredShell: params.configuredShell,
    platform: params.platform,
    env,
  });
  return { ok: true, plan: { agentId, cwd, shell, args } };
}

/** Builds the child environment for a host terminal from the gateway env. */
export function buildTerminalEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.TERM = env.TERM ?? "xterm-256color";
  // Lets shells and prompts detect that they are inside an OpenClaw terminal.
  env.OPENCLAW_TERMINAL = "1";
  return env;
}

// A workspace dir that has not been created yet would make the PTY spawn fail;
// fall back to the home directory so the terminal still opens.
function existingDirOrHome(dir: string, env: NodeJS.ProcessEnv): string {
  const trimmed = dir.trim();
  const home = env.HOME?.trim() || os.homedir();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return home;
  }
  try {
    if (existsSync(trimmed) && statSync(trimmed).isDirectory()) {
      return trimmed;
    }
  } catch {
    // Unreadable path: fall through to home rather than fail the spawn.
  }
  return home;
}
