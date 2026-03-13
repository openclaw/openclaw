/**
 * Project-scoped memory directory helpers.
 *
 * All project memory lives under ~/.openclaw/workspace/projects/{id}/memory/
 * regardless of project type (internal workspace projects or external repos).
 * This avoids polluting external repos with operator1 memory files.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";

/**
 * Returns the base project directory under the agent workspace.
 * e.g. ~/.openclaw/workspace/projects/{projectId}/
 */
export function resolveProjectDir(projectId: string, env?: NodeJS.ProcessEnv): string {
  const workspaceDir = resolveDefaultAgentWorkspaceDir(env);
  return path.join(workspaceDir, "projects", projectId);
}

/**
 * Returns the project memory directory path.
 * e.g. ~/.openclaw/workspace/projects/{projectId}/memory/
 */
export function resolveProjectMemoryDir(projectId: string, env?: NodeJS.ProcessEnv): string {
  return path.join(resolveProjectDir(projectId, env), "memory");
}

/**
 * Ensures the project memory directory exists, creating it if needed.
 * Returns the memory directory path (suitable for use as a memory extraPath).
 */
export function ensureProjectMemoryDir(projectId: string, env?: NodeJS.ProcessEnv): string {
  const memoryDir = resolveProjectMemoryDir(projectId, env);
  fs.mkdirSync(memoryDir, { recursive: true });
  return memoryDir;
}
