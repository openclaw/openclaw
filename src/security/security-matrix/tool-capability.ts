import type { SecurityMatrixToolCapability } from "./types.js";

const exactToolCapabilities = new Map<string, SecurityMatrixToolCapability>([
  ["read", "read_file"],
  ["file_fetch", "read_file"],
  ["file.fetch", "read_file"],
  ["file.read", "read_file"],
  ["file_fetch.read", "read_file"],
  ["dir_fetch", "read_file"],
  ["dir.fetch", "read_file"],
  ["dir_list", "read_file"],
  ["dir.list", "read_file"],
  ["write", "write_file"],
  ["file_write", "write_file"],
  ["file.write", "write_file"],
  ["file_write.write", "write_file"],
  ["create_file", "write_file"],
  ["file.create", "write_file"],
  ["update_file", "write_file"],
  ["file.update", "write_file"],
  ["edit_file", "write_file"],
  ["file.edit", "write_file"],
  ["patch_file", "write_file"],
  ["file.patch", "write_file"],
  ["delete_file", "write_file"],
  ["file.delete", "write_file"],
  ["remove_file", "write_file"],
  ["file.remove", "write_file"],
  ["edit", "write_file"],
  ["apply_patch", "write_file"],
  ["functions.apply_patch", "write_file"],
  ["shell.apply_patch", "write_file"],
  ["workspace.apply_patch", "write_file"],
  ["exec", "exec"],
  ["bash", "exec"],
  ["shell", "exec"],
  ["exec_command", "exec"],
  ["functions.exec_command", "exec"],
  ["terminal.exec", "exec"],
  ["git", "git"],
  ["web_fetch", "network"],
  ["web.fetch", "network"],
  ["web_search", "network"],
  ["web.search", "network"],
  ["fetch", "network"],
  ["browser", "browser"],
  ["browser.open", "browser"],
  ["browser.click", "browser"],
  ["browser.type", "browser"],
  ["browser.screenshot", "browser"],
  ["memory.read", "memory_read"],
  ["memory_read", "memory_read"],
  ["memory.get", "memory_read"],
  ["memory_get", "memory_read"],
  ["memory.search", "memory_read"],
  ["memory_search", "memory_read"],
  ["memory.write", "memory_write"],
  ["memory_write", "memory_write"],
  ["memory.set", "memory_write"],
  ["memory_set", "memory_write"],
  ["memory.create", "memory_write"],
  ["memory.update", "memory_write"],
  ["memory.delete", "memory_write"],
  ["gcal.create", "calendar_write"],
  ["gcal.update", "calendar_write"],
  ["gcal.delete", "calendar_write"],
  ["calendar.create", "calendar_write"],
  ["calendar.update", "calendar_write"],
  ["calendar.delete", "calendar_write"],
  ["google_calendar.create", "calendar_write"],
  ["google_calendar.update", "calendar_write"],
  ["google_calendar.delete", "calendar_write"],
  ["gmail.send", "email_send"],
  ["gmail.forward", "email_send"],
  ["email.send", "email_send"],
  ["email.forward", "email_send"],
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

  if (
    normalized.includes("credential") ||
    normalized.includes("secret") ||
    normalized.includes("token")
  ) {
    return "credential_access";
  }
  if (normalized.includes("config") || normalized.includes("setting")) {
    return "system_config";
  }
  if (normalized.includes("memory") && isWriteOperation(normalized)) {
    return "memory_write";
  }
  if (normalized.includes("memory") && isReadOperation(normalized)) {
    return "memory_read";
  }

  const leaf = toolLeafName(normalized);
  const leafExact = exactToolCapabilities.get(leaf);
  if (leafExact) {
    return leafExact;
  }

  if (
    normalized.includes("exec") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "exec";
  }
  if (normalized.includes("git")) {
    return "git";
  }
  if (
    (normalized.includes("send") || normalized.includes("forward")) &&
    (normalized.includes("email") || normalized.includes("gmail"))
  ) {
    return "email_send";
  }
  if (
    (normalized.includes("calendar") || normalized.includes("gcal")) &&
    (normalized.includes("create") ||
      normalized.includes("update") ||
      normalized.includes("delete"))
  ) {
    return "calendar_write";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("delete_file") ||
    normalized.includes("remove_file") ||
    normalized.includes("create_file") ||
    normalized.includes("update_file") ||
    normalized.includes("file.delete") ||
    normalized.includes("file.remove") ||
    normalized.includes("file.create") ||
    normalized.includes("file.update")
  ) {
    return "write_file";
  }
  if (normalized.includes("read") || normalized.includes("file")) {
    return "read_file";
  }
  if (normalized.includes("browser")) {
    return "browser";
  }
  if (
    normalized.includes("fetch") ||
    normalized.includes("http") ||
    normalized.includes("network")
  ) {
    return "network";
  }
  return "unknown";
}

function isWriteOperation(normalizedToolName: string): boolean {
  return (
    normalizedToolName.includes("write") ||
    normalizedToolName.includes("set") ||
    normalizedToolName.includes("create") ||
    normalizedToolName.includes("update") ||
    normalizedToolName.includes("edit") ||
    normalizedToolName.includes("patch") ||
    normalizedToolName.includes("delete") ||
    normalizedToolName.includes("remove")
  );
}

function isReadOperation(normalizedToolName: string): boolean {
  return (
    normalizedToolName.includes("read") ||
    normalizedToolName.includes("get") ||
    normalizedToolName.includes("search") ||
    normalizedToolName.includes("fetch") ||
    normalizedToolName.includes("list")
  );
}
