import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

function resolvePortableDefaultAgentWorkspacePath(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && normalizeOptionalLowercaseString(profile) !== "default") {
    return `~/.openclaw/workspace-${profile}`;
  }
  return "~/.openclaw/workspace";
}

export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveRequiredHomeDir(env, homedir);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && normalizeOptionalLowercaseString(profile) !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

export function canonicalizeDefaultAgentWorkspacePath(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const trimmed = workspaceDir.trim();
  if (!trimmed.startsWith("~")) {
    const resolvedInput = path.resolve(trimmed);
    const resolvedDefault = resolveDefaultAgentWorkspaceDir(env, homedir);
    if (resolvedInput === resolvedDefault) {
      return resolvePortableDefaultAgentWorkspacePath(env);
    }
  }
  return trimmed;
}

export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
