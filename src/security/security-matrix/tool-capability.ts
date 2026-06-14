import type { SecurityMatrixToolCapability } from "./types.js";

const exactToolCapabilities = new Map<string, SecurityMatrixToolCapability>([
  ["read", "read_file"],
  ["file.read", "read_file"],
  ["write", "write_file"],
  ["edit", "write_file"],
  ["apply_patch", "write_file"],
  ["exec", "exec"],
  ["bash", "exec"],
  ["shell", "exec"],
  ["git", "git"],
  ["web_fetch", "network"],
  ["fetch", "network"],
  ["browser", "browser"],
  ["memory.read", "memory_read"],
  ["memory.write", "memory_write"],
]);

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function toolLeafName(normalizedToolName: string): string {
  const parts = normalizedToolName.split(/[.:/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalizedToolName;
}

/**
 * Resolve a concrete runtime tool id into the Security Matrix capability model.
 * Unknown tools stay unknown until a real runtime integration supplies metadata.
 */
export function resolveSecurityMatrixCapabilityFromTool(
  toolName: string,
): SecurityMatrixToolCapability {
  const normalized = normalizeToolName(toolName);
  const exact = exactToolCapabilities.get(normalized);
  if (exact) {
    return exact;
  }

  const leaf = toolLeafName(normalized);
  const leafExact = exactToolCapabilities.get(leaf);
  if (leafExact) {
    return leafExact;
  }

  if (normalized.includes("credential") || normalized.includes("secret") || normalized.includes("token")) {
    return "credential_access";
  }
  if (normalized.includes("config") || normalized.includes("setting")) {
    return "system_config";
  }
  if (normalized.includes("exec") || normalized.includes("shell") || normalized.includes("terminal")) {
    return "exec";
  }
  if (normalized.includes("git")) {
    return "git";
  }
  if (normalized.includes("send") && (normalized.includes("email") || normalized.includes("gmail"))) {
    return "email_send";
  }
  if (normalized.includes("calendar") && (normalized.includes("create") || normalized.includes("update") || normalized.includes("delete"))) {
    return "calendar_write";
  }
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) {
    return "write_file";
  }
  if (normalized.includes("read") || normalized.includes("file")) {
    return "read_file";
  }
  if (normalized.includes("browser")) {
    return "browser";
  }
  if (normalized.includes("fetch") || normalized.includes("http") || normalized.includes("network")) {
    return "network";
  }
  if (normalized.includes("memory") && normalized.includes("write")) {
    return "memory_write";
  }
  if (normalized.includes("memory") && normalized.includes("read")) {
    return "memory_read";
  }
  return "unknown";
}
