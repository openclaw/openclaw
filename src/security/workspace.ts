/**
 * Security features workspace directory management.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";

/**
 * Ensure security workspace directories exist.
 */
export async function ensureSecurityWorkspaces(config: OpenClawConfig): Promise<void> {
  const security = config.security;
  if (!security) {
    return;
  }

  const stateDir = resolveStateDir();

  // LLM Security workspace
  if (security.llmSecurity?.enabled) {
    const workspace = security.llmSecurity.workspace ?? "~/.openclaw/security/llm-security/";
    const resolved = resolveUserPath(workspace);
    await fs.mkdir(resolved, { recursive: true });
  }

  // Cognitive Security workspace
  if (security.cognitiveSecurity?.enabled) {
    const workspace = security.cognitiveSecurity.workspace ?? "~/.openclaw/security/cognitive/";
    const resolved = resolveUserPath(workspace);
    await fs.mkdir(resolved, { recursive: true });
  }

  // ARR workspace
  if (security.adversaryRecommender?.enabled) {
    const workspace = security.adversaryRecommender.workspace ?? "~/.openclaw/security/arr/";
    const resolved = resolveUserPath(workspace);
    await fs.mkdir(resolved, { recursive: true });
  }

  // Swarm Agents workspace
  if (security.swarmAgents?.enabled) {
    const workspace = security.swarmAgents.workspace ?? "~/.openclaw/security/swarm/";
    const resolved = resolveUserPath(workspace);
    await fs.mkdir(resolved, { recursive: true });
  }
}

/**
 * Get security workspace directory for a feature.
 */
export function getSecurityWorkspace(
  config: OpenClawConfig,
  feature: "llmSecurity" | "cognitiveSecurity" | "adversaryRecommender" | "swarmAgents",
): string | null {
  const security = config.security;
  if (!security) {
    return null;
  }

  let workspace: string | undefined;
  switch (feature) {
    case "llmSecurity":
      workspace = security.llmSecurity?.workspace;
      break;
    case "cognitiveSecurity":
      workspace = security.cognitiveSecurity?.workspace;
      break;
    case "adversaryRecommender":
      workspace = security.adversaryRecommender?.workspace;
      break;
    case "swarmAgents":
      workspace = security.swarmAgents?.workspace;
      break;
  }

  if (!workspace) {
    const defaults: Record<typeof feature, string> = {
      llmSecurity: "~/.openclaw/security/llm-security/",
      cognitiveSecurity: "~/.openclaw/security/cognitive/",
      adversaryRecommender: "~/.openclaw/security/arr/",
      swarmAgents: "~/.openclaw/security/swarm/",
    };
    workspace = defaults[feature];
  }

  return resolveUserPath(workspace);
}
