import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope-config.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isTerminalConfigEnabled } from "./enabled.js";

type TerminalLaunchBlock =
  | { kind: "disabled" }
  | { kind: "owner-required"; message: string }
  | { kind: "unknown-agent"; agentId: string }
  | { kind: "sandboxed"; agentId: string; mode: "all" };

export type TerminalLaunchPlan = {
  agentId: string;
  cwd: string;
  shell: string;
  args: string[];
  initialCommand?: string[];
  cwdOverride?: string;
};

export type TerminalSpawnPlan = Pick<TerminalLaunchPlan, "agentId" | "shell" | "args" | "cwd">;

export type TerminalLaunchResolution =
  | { ok: true; plan: TerminalLaunchPlan }
  | { ok: false; block: TerminalLaunchBlock };

type TerminalLaunchPolicy = {
  resolve: (agentId?: string) => TerminalLaunchResolution;
  isEnabled: () => boolean;
  prepareConfig: (config: OpenClawConfig, options: { restartPending: boolean }) => void;
  commitConfig: () => void;
  acceptConfig: (options: { retireRejectedRestart: boolean }) => void;
};

function resolveTerminalShell(params: {
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
    // Load the operator's login profile, including its PATH and prompt.
    return { shell: loginShell, args: ["-l"] };
  }
  return { shell: "/bin/bash", args: ["-l"] };
}

function resolveTerminalLaunch(params: {
  config: OpenClawConfig;
  agentId?: string;
  configuredShell?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): TerminalLaunchResolution {
  const env = params.env ?? process.env;
  const requested = params.agentId?.trim();
  let agentId: string;
  try {
    agentId = requested ? normalizeAgentId(requested) : resolveDefaultAgentId(params.config);
  } catch (error) {
    if (!(error instanceof AgentSelectionRequiredError)) {
      throw error;
    }
    return { ok: false, block: { kind: "owner-required", message: error.message } };
  }
  // Unknown IDs would bypass per-agent isolation through the global defaults.
  if (requested && !listAgentIds(params.config).includes(agentId)) {
    return { ok: false, block: { kind: "unknown-agent", agentId } };
  }
  const sandbox = resolveSandboxConfigForAgent(params.config, agentId);
  // "non-main" already permits host execution; "all" must not gain a host shell.
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

/** Maintains fail-closed terminal admission across deferred config restarts. */
export function createTerminalLaunchPolicy(initialConfig: OpenClawConfig): TerminalLaunchPolicy {
  let activeConfig = initialConfig;
  let hasPendingRestart = false;
  let preparedConfig: OpenClawConfig | null = null;
  let appliedConfigWhileRestartPending: OpenClawConfig | null = null;
  const createRestrictions = () => ({
    disabled: false,
    blockedAgents: new Map<string, TerminalLaunchBlock>(),
  });
  const restartRestrictions = createRestrictions();
  const commitRestrictions = createRestrictions();
  const committedTerminalConfig = () => appliedConfigWhileRestartPending ?? activeConfig;
  const resolveForConfig = (config: OpenClawConfig, agentId?: string, shellConfig = config) => {
    return resolveTerminalLaunch({
      config,
      agentId,
      configuredShell: shellConfig.gateway?.terminal?.shell,
    });
  };
  const accumulateRestrictions = (
    config: OpenClawConfig,
    restrictions: ReturnType<typeof createRestrictions>,
  ) => {
    if (!isTerminalConfigEnabled(config)) {
      // Preserve new revocations, not an unchanged disabled baseline that a
      // later hot commit can enable. Agent restrictions remain independent.
      restrictions.disabled ||= isTerminalConfigEnabled(committedTerminalConfig());
    }
    const activeAgentIds = new Set(listAgentIds(activeConfig));
    for (const agentId of activeAgentIds) {
      const candidate = resolveForConfig(config, agentId);
      if (!candidate.ok) {
        restrictions.blockedAgents.set(agentId, candidate.block);
      }
    }
  };
  const clearRestrictions = (restrictions: ReturnType<typeof createRestrictions>) => {
    restrictions.disabled = false;
    restrictions.blockedAgents.clear();
  };
  const isEnabled = () =>
    isTerminalConfigEnabled(committedTerminalConfig()) &&
    !restartRestrictions.disabled &&
    !commitRestrictions.disabled &&
    (preparedConfig === null || isTerminalConfigEnabled(preparedConfig));

  return {
    resolve: (agentId) => {
      if (!isEnabled()) {
        return { ok: false, block: { kind: "disabled" } };
      }
      // Committed terminal settings apply while restart debt preserves the
      // active agent/workspace ownership and any pending revocations.
      const active = resolveForConfig(activeConfig, agentId, committedTerminalConfig());
      if (!active.ok) {
        return active;
      }
      const pendingBlock = restartRestrictions.blockedAgents.get(active.plan.agentId);
      if (pendingBlock) {
        return { ok: false, block: pendingBlock };
      }
      const preparedBlock = commitRestrictions.blockedAgents.get(active.plan.agentId);
      if (preparedBlock) {
        return { ok: false, block: preparedBlock };
      }
      const candidateConfig = preparedConfig ?? appliedConfigWhileRestartPending;
      if (candidateConfig) {
        const prepared = resolveForConfig(candidateConfig, active.plan.agentId);
        if (!prepared.ok) {
          return prepared;
        }
      }
      return active;
    },
    isEnabled,
    prepareConfig: (config, options) => {
      if (options.restartPending) {
        hasPendingRestart = true;
        // Keep an older candidate fail-closed only until this transaction is
        // accepted; do not mix its restrictions into the restart-owned bucket.
        preparedConfig = null;
        accumulateRestrictions(config, restartRestrictions);
        return;
      }
      preparedConfig = config;
      accumulateRestrictions(preparedConfig, commitRestrictions);
    },
    commitConfig: () => {
      if (hasPendingRestart) {
        // The applied marker separates runtime truth from a later candidate
        // that may fail before publication while this restart remains pending.
        if (preparedConfig) {
          appliedConfigWhileRestartPending = preparedConfig;
        }
        preparedConfig = null;
        clearRestrictions(commitRestrictions);
        if (appliedConfigWhileRestartPending) {
          accumulateRestrictions(appliedConfigWhileRestartPending, commitRestrictions);
        }
        return;
      }
      if (preparedConfig) {
        activeConfig = preparedConfig;
      }
      preparedConfig = null;
      clearRestrictions(commitRestrictions);
    },
    acceptConfig: (options) => {
      // Baseline acceptance retires an un-published candidate, including config
      // intentionally skipped by reload policy. Only committed publication stages
      // runtime truth for promotion after a rejected restart.
      preparedConfig = null;
      clearRestrictions(commitRestrictions);
      if (options.retireRejectedRestart) {
        hasPendingRestart = false;
        clearRestrictions(restartRestrictions);
        if (appliedConfigWhileRestartPending) {
          activeConfig = appliedConfigWhileRestartPending;
        }
        appliedConfigWhileRestartPending = null;
        return;
      }
      if (appliedConfigWhileRestartPending) {
        accumulateRestrictions(appliedConfigWhileRestartPending, commitRestrictions);
      }
    },
  };
}

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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Converts a policy-approved plan into the exact local PTY spawn. */
export function resolveTerminalSpawnPlan(
  plan: TerminalLaunchPlan,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): TerminalSpawnPlan {
  const env = options.env ?? process.env;
  const cwd = existingDirOrHome(plan.cwdOverride ?? plan.cwd, env);
  const command = plan.initialCommand;
  if (!command || command.length === 0) {
    return { agentId: plan.agentId, shell: plan.shell, args: plan.args, cwd };
  }
  if ((options.platform ?? process.platform) === "win32") {
    return {
      agentId: plan.agentId,
      shell: command[0] ?? plan.shell,
      args: command.slice(1),
      cwd,
    };
  }
  return {
    agentId: plan.agentId,
    shell: plan.shell,
    args: ["-il", "-c", command.map(shellQuote).join(" ")],
    cwd,
  };
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
    if (statSync(trimmed).isDirectory()) {
      return trimmed;
    }
  } catch {
    // Unreadable path: fall through to home rather than fail the spawn.
  }
  return home;
}
