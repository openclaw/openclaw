import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findExtraGatewayServices } from "./inspect.js";

const { execSchtasksMock, readdirMock, readFileMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
  readdirMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: (...args: unknown[]) => readdirMock(...args),
    readFile: (...args: unknown[]) => readFileMock(...args),
  },
  readdir: (...args: unknown[]) => readdirMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
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

describe("findExtraGatewayServices (darwin)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    readdirMock.mockReset();
    readFileMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("ignores the mac app launch agent while reporting other openclaw services", async () => {
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === "/Users/test/Library/LaunchAgents") {
        return ["ai.openclaw.mac.plist", "ai.openclaw.helper.plist"];
      }
      return [];
    });
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("ai.openclaw.mac.plist")) {
        return [
          "<plist>",
          "  <dict>",
          "    <key>Label</key>",
          "    <string>ai.openclaw.mac</string>",
          "    <key>ProgramArguments</key>",
          "    <array>",
          "      <string>OpenClaw.app</string>",
          "    </array>",
          "  </dict>",
          "</plist>",
        ].join("\n");
      }
      if (filePath.endsWith("ai.openclaw.helper.plist")) {
        return [
          "<plist>",
          "  <dict>",
          "    <key>Label</key>",
          "    <string>ai.openclaw.helper</string>",
          "    <key>ProgramArguments</key>",
          "    <array>",
          "      <string>openclaw helper</string>",
          "    </array>",
          "  </dict>",
          "</plist>",
        ].join("\n");
      }
      return null;
    });

    const result = await findExtraGatewayServices({
      HOME: "/Users/test",
    });

    expect(result).toEqual([
      {
        platform: "darwin",
        label: "ai.openclaw.helper",
        detail: "plist: /Users/test/Library/LaunchAgents/ai.openclaw.helper.plist",
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });

  it("filters by parsed plist label instead of ignored filename", async () => {
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === "/Users/test/Library/LaunchAgents") {
        return ["ai.openclaw.mac.plist"];
      }
      return [];
    });
    readFileMock.mockImplementation(async (filePath: string) => {
      if (!filePath.endsWith("ai.openclaw.mac.plist")) {
        return null;
      }
      return [
        "<plist>",
        "  <dict>",
        "    <key>Label</key>",
        "    <string>ai.openclaw.helper</string>",
        "    <key>ProgramArguments</key>",
        "    <array>",
        "      <string>openclaw helper</string>",
        "    </array>",
        "  </dict>",
        "</plist>",
      ].join("\n");
    });

    const result = await findExtraGatewayServices({
      HOME: "/Users/test",
    });

    expect(result).toEqual([
      {
        platform: "darwin",
        label: "ai.openclaw.helper",
        detail: "plist: /Users/test/Library/LaunchAgents/ai.openclaw.mac.plist",
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });

  it("reports default-profile gateway services as extra when a custom profile is active", async () => {
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === "/Users/test/Library/LaunchAgents") {
        return ["ai.openclaw.gateway.plist"];
      }
      return [];
    });
    readFileMock.mockImplementation(async (filePath: string) => {
      if (!filePath.endsWith("ai.openclaw.gateway.plist")) {
        return null;
      }
      return [
        "<plist>",
        "  <dict>",
        "    <key>Label</key>",
        "    <string>ai.openclaw.gateway</string>",
        "    <key>ProgramArguments</key>",
        "    <array>",
        "      <string>openclaw gateway run</string>",
        "    </array>",
        "  </dict>",
        "</plist>",
      ].join("\n");
    });

    const result = await findExtraGatewayServices({
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "mac",
    });

    expect(result).toEqual([
      {
        platform: "darwin",
        label: "ai.openclaw.gateway",
        detail: "plist: /Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist",
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });

  it("ignores the node host launch agent", async () => {
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir === "/Users/test/Library/LaunchAgents") {
        return ["ai.openclaw.node.plist"];
      }
      return [];
    });
    readFileMock.mockImplementation(async (filePath: string) => {
      if (!filePath.endsWith("ai.openclaw.node.plist")) {
        return null;
      }
      return [
        "<plist>",
        "  <dict>",
        "    <key>Label</key>",
        "    <string>ai.openclaw.node</string>",
        "    <key>ProgramArguments</key>",
        "    <array>",
        "      <string>openclaw node run</string>",
        "    </array>",
        "  </dict>",
        "</plist>",
      ].join("\n");
    });

    const result = await findExtraGatewayServices({
      HOME: "/Users/test",
    });

    expect(result).toEqual([]);
  });
});
