import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { cancel, isCancel } from "@clack/prompts";

import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
} from "../agents/workspace.js";
import type { ClawdisConfig } from "../config/config.js";
import { CONFIG_PATH_CLAWDIS } from "../config/config.js";
import { resolveSessionTranscriptsDir } from "../config/sessions.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { CONFIG_DIR } from "../utils.js";
import type { NodeManagerChoice, ResetScope } from "./onboard-types.js";

export function guardCancel<T>(value: T, runtime: RuntimeEnv): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    runtime.exit(0);
  }
  return value;
}

export function summarizeExistingConfig(config: ClawdisConfig): string {
  const rows: string[] = [];
  if (config.agent?.workspace)
    rows.push(`workspace: ${config.agent.workspace}`);
  if (config.agent?.model) rows.push(`model: ${config.agent.model}`);
  if (config.gateway?.mode) rows.push(`gateway.mode: ${config.gateway.mode}`);
  if (config.gateway?.bind) rows.push(`gateway.bind: ${config.gateway.bind}`);
  if (config.skills?.install?.nodeManager) {
    rows.push(`skills.nodeManager: ${config.skills.install.nodeManager}`);
  }
  return rows.length ? rows.join("\n") : "No key settings detected.";
}

export function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export async function openUrl(url: string): Promise<void> {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    await runCommandWithTimeout(command, { timeoutMs: 5_000 });
  } catch {
    // ignore; we still print the URL for manual open
  }
}

export async function ensureWorkspaceAndSessions(
  workspaceDir: string,
  runtime: RuntimeEnv,
) {
  const ws = await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: true,
  });
  runtime.log(`Workspace OK: ${ws.dir}`);
  const sessionsDir = resolveSessionTranscriptsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${sessionsDir}`);
}

export function resolveNodeManagerOptions(): Array<{
  value: NodeManagerChoice;
  label: string;
}> {
  return [
    { value: "npm", label: "npm" },
    { value: "pnpm", label: "pnpm" },
    { value: "bun", label: "bun" },
  ];
}

export async function moveToTrash(
  pathname: string,
  runtime: RuntimeEnv,
): Promise<void> {
  if (!pathname) return;
  try {
    await fs.access(pathname);
  } catch {
    return;
  }
  try {
    await runCommandWithTimeout(["trash", pathname], { timeoutMs: 5000 });
    runtime.log(`Moved to Trash: ${pathname}`);
  } catch {
    runtime.log(`Failed to move to Trash (manual delete): ${pathname}`);
  }
}

export async function handleReset(
  scope: ResetScope,
  workspaceDir: string,
  runtime: RuntimeEnv,
) {
  await moveToTrash(CONFIG_PATH_CLAWDIS, runtime);
  if (scope === "config") return;
  await moveToTrash(path.join(CONFIG_DIR, "credentials"), runtime);
  await moveToTrash(resolveSessionTranscriptsDir(), runtime);
  if (scope === "full") {
    await moveToTrash(workspaceDir, runtime);
  }
}

export async function detectBinary(name: string): Promise<boolean> {
  const command =
    process.platform === "win32"
      ? ["where", name]
      : ["/usr/bin/env", "sh", "-lc", `command -v ${name}`];
  try {
    const result = await runCommandWithTimeout(command, { timeoutMs: 2000 });
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export const DEFAULT_WORKSPACE = DEFAULT_AGENT_WORKSPACE_DIR;
