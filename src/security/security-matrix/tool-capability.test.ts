import { describe, expect, it } from "vitest";
import { resolveSecurityMatrixCapabilityFromTool } from "./tool-capability.js";

describe("resolveSecurityMatrixCapabilityFromTool", () => {
  it.each([
    ["memory.read", "memory_read"],
    ["memory_read", "memory_read"],
    ["memory.get", "memory_read"],
    ["memory_search", "memory_read"],
    ["memory.write", "memory_write"],
    ["memory_write", "memory_write"],
    ["memory.update", "memory_write"],
    ["memory.delete", "memory_write"],
  ] as const)("resolves namespaced memory tool %s", (toolName, capability) => {
    expect(resolveSecurityMatrixCapabilityFromTool(toolName)).toBe(capability);
  });

  it.each([
    "delete_file",
    "file.delete",
    "remove_file",
    "file.remove",
    "create_file",
    "file.create",
    "update_file",
    "file.update",
    "edit_file",
    "patch_file",
    "workspace.apply_patch",
  ])("resolves file-state-changing tool %s as write_file", (toolName) => {
    expect(resolveSecurityMatrixCapabilityFromTool(toolName)).toBe("write_file");
  });

  it.each([
    "gcal.create",
    "gcal.update",
    "gcal.delete",
    "calendar.create",
    "calendar.update",
    "calendar.delete",
    "google_calendar.create",
    "google_calendar.update",
    "google_calendar.delete",
  ])("resolves calendar mutation tool %s as calendar_write", (toolName) => {
    expect(resolveSecurityMatrixCapabilityFromTool(toolName)).toBe("calendar_write");
  });

  it.each(["gmail.send", "gmail.forward", "email.send", "email.forward"])(
    "resolves email delivery tool %s as email_send",
    (toolName) => {
      expect(resolveSecurityMatrixCapabilityFromTool(toolName)).toBe("email_send");
    },
  );

  it.each([
    ["credential.get", "credential_access"],
    ["secret.read", "credential_access"],
    ["config.update", "system_config"],
    ["settings.write", "system_config"],
    ["exec", "exec"],
    ["functions.exec_command", "exec"],
    ["git", "git"],
    ["git.commit", "git"],
    ["browser.open", "browser"],
    ["browser", "browser"],
    ["web_fetch", "network"],
    ["web.search", "network"],
  ] as const)("resolves %s as %s", (toolName, capability) => {
    expect(resolveSecurityMatrixCapabilityFromTool(toolName)).toBe(capability);
  });

  it("leaves unknown tools unknown", () => {
    expect(resolveSecurityMatrixCapabilityFromTool("custom.opaque.tool")).toBe("unknown");
  });
});
