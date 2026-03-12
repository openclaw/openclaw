import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { getRuntimeConfigSnapshot, loadConfig } from "../config/config.js";

function isInvalidConfigError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "INVALID_CONFIG"
  );
}

export function resolveOperatorReferenceWorkspaceDir(params?: { workspaceDir?: string }): string {
  if (params?.workspaceDir?.trim()) {
    return path.resolve(params.workspaceDir);
  }

  const runtimeConfig = getRuntimeConfigSnapshot();
  if (runtimeConfig) {
    return resolveAgentWorkspaceDir(runtimeConfig, resolveDefaultAgentId(runtimeConfig));
  }

  try {
    const config = loadConfig();
    return resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  } catch (error) {
    if (!isInvalidConfigError(error)) {
      throw error;
    }
    return path.resolve(resolveDefaultAgentWorkspaceDir(process.env));
  }
}

export function resolveOperatorReferenceSourcePath(
  filename: string,
  params?: {
    workspaceDir?: string;
    sourcePath?: string;
  },
): string {
  if (params?.sourcePath?.trim()) {
    return path.resolve(params.sourcePath);
  }
  const workspaceDir = resolveOperatorReferenceWorkspaceDir({
    workspaceDir: params?.workspaceDir,
  });
  return path.join(workspaceDir, "memory", "reference", filename);
}
