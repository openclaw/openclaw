import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope-config.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../plugins/public-surface-loader.js";
import { shortenHomePath } from "../utils.js";

const CLAUDE_CLI_PROVIDER = "claude-cli";

type ClaudeCliDirHealth = "present" | "missing" | "not_directory" | "unreadable" | "readonly";

type ClaudeCliDiscoveryApi = {
  resolveClaudeTerminalExecutable: (
    env: NodeJS.ProcessEnv,
    options: { pathStrategy: "direct" },
  ) => { executable: string } | undefined;
};

function isClaudeCliAuthenticated(commandPath: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(commandPath, ["auth", "status", "--json"], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024,
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return isRecord(parsed) && parsed.loggedIn === true;
  } catch {
    return false;
  }
}

function usesClaudeCliModelSelection(cfg: OpenClawConfig): boolean {
  return [
    resolvePrimaryStringValue(cfg.agents?.defaults?.model),
    ...Object.keys(cfg.agents?.defaults?.models ?? {}),
  ].some((key) => normalizeOptionalLowercaseString(key)?.startsWith(`${CLAUDE_CLI_PROVIDER}/`));
}

function probeDirectoryHealth(dirPath: string): ClaudeCliDirHealth {
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return "not_directory";
    }
  } catch (error) {
    return hasErrnoCode(error, "ENOENT") ? "missing" : "unreadable";
  }
  for (const mode of [fs.constants.R_OK, fs.constants.W_OK]) {
    try {
      fs.accessSync(dirPath, mode);
    } catch {
      return mode === fs.constants.R_OK ? "unreadable" : "readonly";
    }
  }
  return "present";
}

function formatDirectoryProblemLine(
  dirPath: string,
  health: ClaudeCliDirHealth,
  label: string,
): string | null {
  const display = shortenHomePath(dirPath);
  if (health === "present" || health === "missing") {
    return null;
  }
  const problem =
    health === "not_directory"
      ? "exists but is not a directory."
      : `is not ${health === "unreadable" ? "readable" : "writable"} by this user.`;
  return `- ${label}: ${display} ${problem}`;
}

function resolveClaudeCliAgentIds(cfg: OpenClawConfig): string[] {
  const agentIds = listAgentIds(cfg);
  const runtimeAgentIds = agentIds.filter(
    (agentId) => resolveModelAgentRuntimeMetadata({ cfg, agentId }).id === CLAUDE_CLI_PROVIDER,
  );
  if (runtimeAgentIds.length > 0) {
    return runtimeAgentIds;
  }
  if (usesClaudeCliModelSelection(cfg)) {
    const defaultAgentId = tryResolveDefaultAgentId(cfg);
    return defaultAgentId ? [defaultAgentId] : [];
  }
  return [];
}

function resolveClaudeCliWorkspaceTargets(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
}) {
  const agentIds = resolveClaudeCliAgentIds(params.cfg);
  const defaultAgentId = tryResolveDefaultAgentId(params.cfg);
  return agentIds.map((agentId) => {
    const workspaceDir =
      params.workspaceDir && agentIds.length === 1 && agentId === defaultAgentId
        ? params.workspaceDir
        : resolveAgentWorkspaceDir(params.cfg, agentId, params.env);
    const projectDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir,
    });
    return {
      agentId,
      directories: [
        [workspaceDir, probeDirectoryHealth(workspaceDir), "workspace"],
        [projectDir, probeDirectoryHealth(projectDir), "Claude project dir"],
      ] as const,
    };
  });
}

export function noteClaudeCliHealth(
  cfg: OpenClawConfig,
  deps?: {
    noteFn?: typeof note;
    workspaceDir?: string;
  },
) {
  const env = process.env;
  const workspaceTargets = resolveClaudeCliWorkspaceTargets({
    cfg,
    env,
    workspaceDir: deps?.workspaceDir,
  });
  if (workspaceTargets.length === 0) {
    return;
  }

  const backend = resolveCliBackendConfig(CLAUDE_CLI_PROVIDER, cfg);
  const command = backend?.config.command ?? "claude";
  const commandOnPath = resolveExecutablePath(command, { env });
  // Update workers can skip PATH bootstrap; native-install discovery stays with the plugin.
  const claudeApi =
    command === "claude"
      ? loadBundledPluginPublicArtifactModuleFromCandidatesSync<ClaudeCliDiscoveryApi>({
          dirName: "anthropic",
          artifactCandidates: ["cli-auth-api.js"],
        })
      : null;
  const commandPath = claudeApi
    ? claudeApi.resolveClaudeTerminalExecutable(env, { pathStrategy: "direct" })?.executable
    : commandOnPath;
  const authEnv = { ...env };
  for (const envName of backend?.config.clearEnv ?? []) {
    delete authEnv[envName];
  }
  const authenticated = commandPath ? isClaudeCliAuthenticated(commandPath, authEnv) : false;
  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  const showAgentLabels =
    workspaceTargets.length > 1 ||
    workspaceTargets.some((target) => target.agentId !== defaultAgentId);

  const lines: string[] = [];
  const fixHints: string[] = [];

  if (!commandPath) {
    lines.push(`- Binary: command "${command}" was not found on PATH.`);
    fixHints.push(
      "- Fix: install Claude CLI on PATH for the gateway user; custom executable paths belong in a CLI backend plugin registration.",
    );
  } else if (!commandOnPath) {
    lines.push(`- Binary: found at ${shortenHomePath(commandPath)} (not on service PATH).`);
  }

  if (commandPath && !authenticated) {
    lines.push("- Claude auth: not logged in.");
    fixHints.push(`- Fix: run ${formatCliCommand("claude auth login")}.`);
  }

  for (const target of workspaceTargets) {
    const agentLabel = showAgentLabels ? target.agentId : undefined;
    for (const [dirPath, health, subject] of target.directories) {
      const workspace = subject === "workspace";
      const label = agentLabel
        ? `Agent ${agentLabel} ${subject}`
        : workspace
          ? "Workspace"
          : subject;
      const problem = formatDirectoryProblemLine(dirPath, health, label);
      if (problem) {
        lines.push(problem);
        if (workspace || health !== "readonly") {
          const targetLabel = agentLabel ? `agent ${agentLabel}'s ${subject}` : `the ${subject}`;
          const remedy = workspace
            ? "a readable, writable directory for the gateway user."
            : "readable, or remove the broken path and let Claude recreate it.";
          fixHints.push(`- Fix: make ${targetLabel} ${remedy}`);
        }
      }
    }
  }

  if (lines.length > 0 && workspaceTargets.length > 1) {
    lines.push(
      `- Agents using Claude CLI: ${workspaceTargets
        .map((target) => target.agentId)
        .toSorted((a, b) => a.localeCompare(b))
        .join(", ")}.`,
    );
  }

  if (lines.length === 0 && fixHints.length === 0) {
    return;
  }
  if (fixHints.length > 0) {
    lines.push(...fixHints);
  }

  (deps?.noteFn ?? note)(lines.join("\n"), "Claude CLI");
}
