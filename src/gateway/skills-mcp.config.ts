// Skills MCP bridge configuration.
// Resolves the env-driven runtime config for the optional `/mcp` skills bridge.
// The bridge is a network entry point, so it stays disabled unless a bearer
// token is configured; an empty token can never expose an unauthenticated route.
import { isTruthyEnvValue } from "../infra/env.js";

const DEFAULT_SKILLS_MCP_PATH = "/mcp";

/** Resolved runtime config for the skills MCP bridge. */
export type SkillsMcpRuntimeConfig = {
  enabled: boolean;
  path: string;
  token: string;
  /** Agent whose workspace skills are exposed; defaults to the default agent. */
  agentId?: string;
  /** Allow-list of skill names; empty means every eligible skill is exposed. */
  allow: string[];
  /** Deny-list of skill names; takes precedence over the allow-list. */
  deny: string[];
};

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function normalizePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_SKILLS_MCP_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Resolves the skills MCP bridge config from the environment. Returns
 * `enabled: false` whenever the toggle is off or no bearer token is set so
 * callers can cheaply skip the route without exposing an open endpoint.
 */
export function resolveSkillsMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): SkillsMcpRuntimeConfig {
  const token = env.OPENCLAW_SKILLS_MCP_TOKEN?.trim() ?? "";
  const agentId = env.OPENCLAW_SKILLS_MCP_AGENT?.trim();
  const enabled = isTruthyEnvValue(env.OPENCLAW_SKILLS_MCP_ENABLED) && token.length > 0;
  return {
    enabled,
    path: normalizePath(env.OPENCLAW_SKILLS_MCP_PATH),
    token,
    agentId: agentId && agentId.length > 0 ? agentId : undefined,
    allow: parseCsvEnv(env.OPENCLAW_SKILLS_MCP_SKILLS),
    deny: parseCsvEnv(env.OPENCLAW_SKILLS_MCP_DENY),
  };
}
