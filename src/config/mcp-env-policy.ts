import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  isDangerousHostEnvVarName,
  isDangerousHostInheritedEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";

const MCP_EXPLICIT_CREDENTIAL_ENV_KEYS = new Set([
  "AMQP_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "DATABASE_URL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "MONGODB_URI",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "REDIS_URL",
]);

export function isBlockedMcpStdioEnvVarName(rawKey: string): boolean {
  if (isDangerousHostEnvVarName(rawKey)) {
    return true;
  }
  const key = normalizeEnvVarKey(rawKey);
  if (!key || MCP_EXPLICIT_CREDENTIAL_ENV_KEYS.has(key.toUpperCase())) {
    return false;
  }
  return isDangerousHostInheritedEnvVarName(key);
}

export function listBlockedMcpStdioEnvKeys(server: Record<string, unknown>): string[] {
  if (typeof server.command !== "string" || server.command.trim().length === 0) {
    return [];
  }
  if (!server.env || typeof server.env !== "object" || Array.isArray(server.env)) {
    return [];
  }
  return Object.keys(server.env)
    .filter((key) => isBlockedMcpStdioEnvVarName(key))
    .toSorted((a, b) => a.localeCompare(b));
}

function formatBlockedMcpStdioEnvKeys(keys: readonly string[]): string {
  return keys.map((key) => `"${sanitizeForLog(key)}"`).join(", ");
}

export function formatBlockedMcpStdioEnvError(keys: readonly string[]): string {
  const formattedKeys = formatBlockedMcpStdioEnvKeys(keys);
  const noun = keys.length === 1 ? `key ${formattedKeys} is` : `keys ${formattedKeys} are`;
  const pronoun = keys.length === 1 ? "it" : "them";
  return `MCP stdio env ${noun} blocked by startup safety policy and cannot be saved. Remove ${pronoun} from the server env config.`;
}

export function formatBlockedMcpStdioEnvDiagnostic(keys: readonly string[]): string {
  const formattedKeys = formatBlockedMcpStdioEnvKeys(keys);
  const noun = keys.length === 1 ? `key ${formattedKeys} is` : `keys ${formattedKeys} are`;
  return `MCP stdio env ${noun} blocked by startup safety policy and ignored at runtime.`;
}
