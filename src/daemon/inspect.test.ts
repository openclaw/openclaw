import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findExtraGatewayServices, renderCleanupHintsForService } from "./inspect.js";

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    execSchtasksMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("skips schtasks queries unless deep mode is enabled", async () => {
    const result = await findExtraGatewayServices({});
    expect(result).toEqual([]);
    expect(execSchtasksMock).not.toHaveBeenCalled();
  });

  it("returns empty results when schtasks query fails", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([]);
  });

  it("collects only non-openclaw marker tasks from schtasks output", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName: OpenClaw Gateway",
        "Task To Run: C:\\Program Files\\OpenClaw\\openclaw.exe gateway run",
        "",
        "TaskName: Clawdbot Legacy",
        "Task To Run: C:\\clawdbot\\clawdbot.exe run",
        "",
        "TaskName: Other Task",
        "Task To Run: C:\\tools\\helper.exe",
        "",
        "TaskName: MoltBot Legacy",
        "Task To Run: C:\\moltbot\\moltbot.exe run",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([
      {
        platform: "win32",
        label: "Clawdbot Legacy",
        detail: "task: Clawdbot Legacy, run: C:\\clawdbot\\clawdbot.exe run",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
      {
        platform: "win32",
        label: "MoltBot Legacy",
        detail: "task: MoltBot Legacy, run: C:\\moltbot\\moltbot.exe run",
        scope: "system",
        marker: "moltbot",
        legacy: true,
      },
    ]);
  });
});

describe("renderCleanupHintsForService", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("generates macOS hints using the service's own label", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const hints = renderCleanupHintsForService({
      platform: "darwin",
      label: "ai.openclaw.gateway-backup",
      detail: "plist: /Library/LaunchAgents/ai.openclaw.gateway-backup.plist",
      scope: "user",
    });
    expect(hints).toEqual([
      "launchctl bootout gui/$UID/ai.openclaw.gateway-backup",
      "rm ~/Library/LaunchAgents/ai.openclaw.gateway-backup.plist",
    ]);
  });

  it("generates Linux hints using the service's label, stripping .service suffix", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    const hints = renderCleanupHintsForService({
      platform: "linux",
      label: "moltbot-gateway.service",
      detail: "unit: /home/user/.config/systemd/user/moltbot-gateway.service",
      scope: "user",
    });
    expect(hints).toEqual([
      "systemctl --user disable --now moltbot-gateway.service",
      "rm ~/.config/systemd/user/moltbot-gateway.service",
    ]);
  });

  it("generates Windows hints using the service's task name", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const hints = renderCleanupHintsForService({
      platform: "win32",
      label: "Clawdbot Legacy",
      detail: "task: Clawdbot Legacy",
      scope: "system",
    });
    expect(hints).toEqual(['schtasks /Delete /TN "Clawdbot Legacy" /F']);
  });
});
