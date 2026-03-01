import { describe, expect, it, vi } from "vitest";
import { noteMacAutomationPermissionContext } from "./doctor-platform-notes.js";

describe("noteMacAutomationPermissionContext", () => {
  it("prints context guidance when gateway LaunchAgent plist is present", () => {
    const noteFn = vi.fn();
    const hasGatewayLaunchAgentPlist = vi.fn(() => true);

    noteMacAutomationPermissionContext({
      platform: "darwin",
      homeDir: "/Users/tester",
      hasGatewayLaunchAgentPlist,
      noteFn,
    });

    expect(hasGatewayLaunchAgentPlist).toHaveBeenCalledWith("/Users/tester");
    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message, title] = noteFn.mock.calls[0] ?? [];
    expect(title).toBe("Gateway (macOS)");
    expect(message).toContain("Automation permissions are scoped per process context");
    expect(message).toContain("LaunchAgent-run OpenClaw");
    expect(message).toContain("Notes writes");
  });

  it("does nothing when no gateway LaunchAgent plist exists", () => {
    const noteFn = vi.fn();
    const hasGatewayLaunchAgentPlist = vi.fn(() => false);

    noteMacAutomationPermissionContext({
      platform: "darwin",
      homeDir: "/Users/tester",
      hasGatewayLaunchAgentPlist,
      noteFn,
    });

    expect(hasGatewayLaunchAgentPlist).toHaveBeenCalledWith("/Users/tester");
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("does nothing on non-darwin platforms", () => {
    const noteFn = vi.fn();
    const hasGatewayLaunchAgentPlist = vi.fn(() => true);

    noteMacAutomationPermissionContext({
      platform: "linux",
      homeDir: "/Users/tester",
      hasGatewayLaunchAgentPlist,
      noteFn,
    });

    expect(hasGatewayLaunchAgentPlist).not.toHaveBeenCalled();
    expect(noteFn).not.toHaveBeenCalled();
  });
});
