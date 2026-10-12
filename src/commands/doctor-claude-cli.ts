import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
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

type ClaudeCliMemoryApi = {
  excludesClaudeNativeMemoryByDefault: (cfg: OpenClawConfig) => boolean;
};

// The Claude memory import stops scanning a directory tree at the same number of entries.
const CLAUDE_MEMORY_SCAN_LIMIT = 20_000;

/** Describes the Markdown files the Claude memory import would find, subfolders included. */
function describeMarkdownFiles(dirPath: string): string | undefined {
  const pending = [dirPath];
  let count = 0;
  let visited = 0;
  let capped = false;
  scan: while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > CLAUDE_MEMORY_SCAN_LIMIT) {
        capped = true;
        break scan;
      }
      if (entry.isDirectory()) {
        pending.push(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        count += 1;
      }
    }
  }
  return count > 0 ? `${count}${capped ? "+" : ""} file(s)` : undefined;
}

/** Claude Code inherits CLAUDE_CONFIG_DIR, which relocates its settings and project memory. */
function resolveClaudeHomeDir(env: NodeJS.ProcessEnv, defaultProjectDir: string): string {
  const relocated = env.CLAUDE_CONFIG_DIR?.trim();
  return relocated ? path.resolve(relocated) : path.resolve(defaultProjectDir, "..", "..");
}

/** Claude Code keeps auto memory in the user setting `autoMemoryDirectory` when one is set. */
function resolveConfiguredAutoMemoryDir(
  claudeHomeDir: string,
  userHomeDir: string,
): string | undefined {
  let settings: unknown;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(claudeHomeDir, "settings.json"), "utf8"));
  } catch {
    return undefined;
  }
  const configured = isRecord(settings) ? settings.autoMemoryDirectory : undefined;
  const dir = typeof configured === "string" ? configured.trim() : "";
  if (path.isAbsolute(dir)) {
    return dir;
  }
  // Claude Code accepts only absolute paths or `~/`.
  return dir.startsWith("~/") ? path.join(userHomeDir, dir.slice(2)) : undefined;
}

// The Control UI import runs inside the Gateway; `openclaw migrate` needs the Gateway stopped.
const EXCLUDED_NATIVE_MEMORY_IMPORT =
  "are no longer loaded into agent turns. Import them into OpenClaw memory from Control UI Settings → Import Memory";
const EXCLUDED_NATIVE_MEMORY_OPTION =
  "plugins.entries.anthropic.config.claudeCli.excludeNativeMemory";

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
  // The Anthropic plugin owns the exclusion. Doctor reminds about memory left in Claude Code
  // only while the exclusion applies by default; an explicit value is the operator's decision.
  const remindsNativeMemory =
    loadBundledPluginPublicArtifactModuleFromCandidatesSync<ClaudeCliMemoryApi>({
      dirName: "anthropic",
      artifactCandidates: ["cli-memory-api.js"],
    })?.excludesClaudeNativeMemoryByDefault(cfg) === true;
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

  // Excluded Claude auto memory stays on disk. Its advisories carry no "- Fix:" so lint keeps
  // them informational; they clear once the agent's workspace holds a Claude import.
  const firstProjectDir = workspaceTargets[0]?.directories[1][0];
  const configuredMemoryDir =
    remindsNativeMemory && firstProjectDir
      ? resolveConfiguredAutoMemoryDir(
          resolveClaudeHomeDir(env, firstProjectDir),
          path.resolve(firstProjectDir, "..", "..", ".."),
        )
      : undefined;
  const hasClaudeImport = (workspaceDir: string) =>
    probeDirectoryHealth(path.join(workspaceDir, "memory", "imports", "claude-code")) !== "missing";
  const quoteArg = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
  const nativeMemoryChoice = `To keep loading them, set ${EXCLUDED_NATIVE_MEMORY_OPTION} to false. To leave them out and stop this note, run ${formatCliCommand(
    `openclaw config set ${EXCLUDED_NATIVE_MEMORY_OPTION} true`,
  )}.`;

  for (const target of workspaceTargets) {
    const agentLabel = showAgentLabels ? target.agentId : undefined;
    for (const [dirPath, health, subject] of target.directories) {
      const workspace = subject === "workspace";
      const label = agentLabel
        ? `Agent ${agentLabel} ${subject}`
        : workspace
          ? "Workspace"
          : subject;
      const display = shortenHomePath(dirPath);
      if (health === "present" || health === "missing") {
        continue;
      }
      const problem =
        health === "not_directory"
          ? "exists but is not a directory."
          : `is not ${health === "unreadable" ? "readable" : "writable"} by this user.`;
      lines.push(`- ${label}: ${display} ${problem}`);
      if (workspace || health !== "readonly") {
        const targetLabel = agentLabel ? `agent ${agentLabel}'s ${subject}` : `the ${subject}`;
        const remedy = workspace
          ? "a readable, writable directory for the gateway user."
          : "readable, or remove the broken path and let Claude recreate it.";
        fixHints.push(`- Fix: make ${targetLabel} ${remedy}`);
      }
    }

    const [[workspaceDir], [projectDir]] = target.directories;
    const nativeMemoryDir = path.join(
      resolveClaudeHomeDir(env, projectDir),
      "projects",
      path.basename(projectDir),
      "memory",
    );
    const nativeMemoryFiles =
      remindsNativeMemory && !configuredMemoryDir
        ? describeMarkdownFiles(nativeMemoryDir)
        : undefined;
    if (nativeMemoryFiles && !hasClaudeImport(workspaceDir)) {
      lines.push(
        `- ${agentLabel ? `Agent ${agentLabel} ` : ""}Claude Code memory: ${nativeMemoryFiles} in ${shortenHomePath(nativeMemoryDir)} ${EXCLUDED_NATIVE_MEMORY_IMPORT}, or stop the Gateway and run ${formatCliCommand(
          `openclaw migrate claude --agent ${quoteArg(target.agentId)} --from ${quoteArg(nativeMemoryDir)}`,
        )}. ${nativeMemoryChoice}`,
      );
    }
  }

  // autoMemoryDirectory replaces every project's memory folder. `migrate --from` scopes only a
  // project `memory` folder, so this location has no scoped command. An import lands in one
  // agent's workspace, so the note stays until every agent has one.
  const configuredMemoryFiles = configuredMemoryDir
    ? describeMarkdownFiles(configuredMemoryDir)
    : undefined;
  const agentsWithoutImport = workspaceTargets
    .filter((target) => !hasClaudeImport(target.directories[0][0]))
    .map((target) => target.agentId)
    .toSorted((a, b) => a.localeCompare(b));
  if (configuredMemoryDir && configuredMemoryFiles && agentsWithoutImport.length > 0) {
    const forAgents = showAgentLabels
      ? ` for ${agentsWithoutImport.length > 1 ? "agents" : "agent"} ${agentsWithoutImport.join(", ")}`
      : "";
    lines.push(
      `- Claude Code memory: ${configuredMemoryFiles} in ${shortenHomePath(configuredMemoryDir)} (Claude Code autoMemoryDirectory) ${EXCLUDED_NATIVE_MEMORY_IMPORT}${forAgents}. ${nativeMemoryChoice}`,
    );
  }

  if (lines.length > 0 && workspaceTargets.length > 1) {
    lines.push(
      `- Agents using Claude CLI: ${workspaceTargets
        .map((target) => target.agentId)
        .toSorted((a, b) => a.localeCompare(b))
        .join(", ")}.`,
    );
  }

  if (lines.length === 0) {
    return;
  }

  (deps?.noteFn ?? note)([...lines, ...fixHints].join("\n"), "Claude CLI");
}
