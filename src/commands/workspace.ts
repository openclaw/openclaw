import fs from "node:fs/promises";
import { cancel, confirm, isCancel } from "@clack/prompts";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import { ensureDevWorkspace, resolveDevWorkspaceDir } from "../cli/gateway-cli/dev.js";
import { readBestEffortConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { moveToTrash } from "./onboard-helpers.js";

export type WorkspaceResetOptions = {
  workspace?: string;
  agent?: string;
  includeSessions?: boolean;
  yes?: boolean;
  dryRun?: boolean;
};

function hasValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function describeResetPlan(params: {
  workspaceDir: string;
  sessionsDir: string;
  includeSessions: boolean;
}): string[] {
  return [
    `Workspace: ${shortenHomePath(params.workspaceDir)}`,
    params.includeSessions ? `Sessions: ${shortenHomePath(params.sessionsDir)}` : undefined,
    "Preserves: config, credentials, channels, and gateway auth.",
  ].filter((line): line is string => Boolean(line));
}

function isActiveDevWorkspaceTarget(workspaceDir: string): boolean {
  return resolveUserPath(workspaceDir) === resolveUserPath(resolveDevWorkspaceDir(process.env));
}

export async function workspaceResetCommand(
  runtime: RuntimeEnv,
  opts: WorkspaceResetOptions,
): Promise<void> {
  const cfg = await readBestEffortConfig();
  const hasExplicitWorkspace = hasValue(opts.workspace);
  const agentId = hasValue(opts.agent) ? opts.agent.trim() : resolveDefaultAgentId(cfg);
  const workspaceDir = hasExplicitWorkspace
    ? resolveUserPath(opts.workspace!.trim())
    : resolveAgentWorkspaceDir(cfg, agentId);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const includeSessions = Boolean(opts.includeSessions);
  const dryRun = Boolean(opts.dryRun);

  if (hasExplicitWorkspace && includeSessions) {
    throw new Error(
      "--include-sessions cannot be combined with --workspace; sessions are resolved from configured agent state only.",
    );
  }

  for (const line of describeResetPlan({ workspaceDir, sessionsDir, includeSessions })) {
    runtime.log(line);
  }

  if (dryRun) {
    runtime.log(`[dry-run] trash ${shortenHomePath(workspaceDir)}`);
    if (includeSessions) {
      runtime.log(`[dry-run] trash ${shortenHomePath(sessionsDir)}`);
    }
    runtime.log(
      `[dry-run] reseed ${shortenHomePath(workspaceDir)} with default workspace files and BOOTSTRAP.md`,
    );
    return;
  }

  if (!opts.yes) {
    const ok = await confirm({
      message: stylePromptMessage(
        `Trash and reseed ${shortenHomePath(workspaceDir)}${includeSessions ? " and clear this agent's sessions" : ""}?`,
      ),
    });
    if (isCancel(ok) || !ok) {
      cancel(stylePromptTitle("Workspace reset cancelled.") ?? "Workspace reset cancelled.");
      runtime.exit(0);
      return;
    }
  }

  await moveToTrash(workspaceDir, runtime);
  if (await pathExists(workspaceDir)) {
    throw new Error(
      `Workspace reset did not remove ${shortenHomePath(workspaceDir)}. Move it manually or retry.`,
    );
  }

  if (includeSessions) {
    await moveToTrash(sessionsDir, runtime);
    if (await pathExists(sessionsDir)) {
      throw new Error(
        `Session reset did not remove ${shortenHomePath(sessionsDir)}. Move it manually or retry.`,
      );
    }
  }

  if (isActiveDevWorkspaceTarget(workspaceDir)) {
    await ensureDevWorkspace(workspaceDir);
  } else {
    await ensureAgentWorkspace({
      dir: workspaceDir,
      ensureBootstrapFiles: true,
    });
  }
  runtime.log(`Workspace reseeded: ${shortenHomePath(workspaceDir)}`);

  if (includeSessions) {
    await fs.mkdir(sessionsDir, { recursive: true });
    runtime.log(`Sessions reset: ${shortenHomePath(sessionsDir)}`);
  }

  runtime.log("Workspace reset complete.");
  runtime.log("Recommended next steps:");
  runtime.log(`- ${formatCliCommand("openclaw onboard")}`);
  runtime.log(`- ${formatCliCommand("openclaw gateway run")}`);
}
