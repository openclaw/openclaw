import { beforeEach, describe, expect, it, vi } from "vitest";

const launchAgentPlistExists = vi.hoisted(() => vi.fn());
const repairLaunchAgentBootstrap = vi.hoisted(() => vi.fn());
const assertNoSystemLaunchDaemonOwnership = vi.hoisted(() => vi.fn());

// mock-isolation: Recovery scenarios must not query or mutate the host's launchd services.
vi.mock("../../daemon/launchd.js", () => ({
  formatLaunchAgentGuiSessionError: (params: {
    detail: string;
    domain: string;
    actionHint: string;
  }) =>
    [
      `launchctl bootstrap failed: ${params.detail}`,
      `LaunchAgent ${params.actionHint} requires a logged-in macOS GUI session for this user (${params.domain}).`,
    ].join("\n"),
  launchAgentPlistExists,
  repairLaunchAgentBootstrap,
  resolveLaunchAgentLabel: (env: Record<string, string | undefined>) =>
    env.OPENCLAW_LAUNCHD_LABEL ?? "ai.openclaw.gateway",
}));

// mock-isolation: System-service ownership is an injected scenario, not the host's state.
vi.mock("../../daemon/launchd-system.js", () => ({
  assertNoSystemLaunchDaemonOwnership,
}));

const { recoverInstalledLaunchAgent } = await import("./launchd-recovery.js");
const recover = (result: "started" | "restarted" = "started") =>
  recoverInstalledLaunchAgent({ result });

describe("recoverInstalledLaunchAgent", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    assertNoSystemLaunchDaemonOwnership.mockReset().mockResolvedValue(undefined);
    launchAgentPlistExists.mockReset().mockResolvedValue(true);
    repairLaunchAgentBootstrap.mockReset().mockResolvedValue({ ok: true, status: "repaired" });
  });

  it("returns null outside macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    await expect(recover()).resolves.toBeNull();
    expect(launchAgentPlistExists).not.toHaveBeenCalled();
    expect(assertNoSystemLaunchDaemonOwnership).not.toHaveBeenCalled();
  });

  it("returns null when the LaunchAgent plist is missing", async () => {
    launchAgentPlistExists.mockResolvedValue(false);

    await expect(recover()).resolves.toBeNull();
    expect(assertNoSystemLaunchDaemonOwnership).toHaveBeenCalledWith("ai.openclaw.gateway");
    expect(repairLaunchAgentBootstrap).not.toHaveBeenCalled();
  });

  it("returns a loaded recovery result when bootstrap repair succeeds", async () => {
    await expect(recover("restarted")).resolves.toEqual({
      result: "restarted",
      loaded: true,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    });
    expect(launchAgentPlistExists).toHaveBeenCalledWith(process.env);
    expect(repairLaunchAgentBootstrap).toHaveBeenCalledWith({ env: process.env });
  });

  it.each([
    { status: "kickstart-failed", error: undefined },
    { status: "gui-session-unavailable", error: "requires a logged-in macOS GUI session" },
    { status: "system-launchdaemon-unverifiable", error: "recovery guidance" },
  ])("handles $status bootstrap failure", async ({ status, error }) => {
    repairLaunchAgentBootstrap.mockResolvedValue({
      ok: false,
      status,
      detail: "recovery guidance",
      ...(status === "gui-session-unavailable" ? { domain: "gui/501" } : {}),
    });
    const result = recover("restarted");
    if (error) {
      await expect(result).rejects.toThrow(error);
    } else {
      await expect(result).resolves.toBeNull();
    }
  });

  it("surfaces system ownership even when no user LaunchAgent plist exists", async () => {
    launchAgentPlistExists.mockResolvedValue(false);
    assertNoSystemLaunchDaemonOwnership.mockRejectedValue(
      new Error("System LaunchDaemon system/ai.openclaw.gateway owns this label"),
    );

    await expect(recover()).rejects.toThrow(
      "System LaunchDaemon system/ai.openclaw.gateway owns this label",
    );
    expect(launchAgentPlistExists).not.toHaveBeenCalled();
  });
});
