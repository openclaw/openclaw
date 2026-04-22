import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findExtraGatewayServices } from "./inspect.js";

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

describe("findExtraGatewayServices (darwin)", () => {
  const originalPlatform = process.platform;
  let tempHome: string;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-launchd-"));
    fs.mkdirSync(path.join(tempHome, "Library", "LaunchAgents"), { recursive: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function writePlist(fileName: string, label: string, body: string) {
    const plistPath = path.join(tempHome, "Library", "LaunchAgents", fileName);
    fs.writeFileSync(
      plistPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<plist>",
        "<dict>",
        "<key>Label</key>",
        `<string>${label}</string>`,
        body,
        "</dict>",
        "</plist>",
      ].join("\n"),
    );
    return plistPath;
  }

  it("ignores OpenClaw support launch agents while keeping unrelated openclaw services visible", async () => {
    writePlist(
      "ai.openclaw.node.plist",
      "ai.openclaw.node",
      [
        "<key>EnvironmentVariables</key>",
        "<dict>",
        "<key>OPENCLAW_SERVICE_MARKER</key>",
        "<string>openclaw</string>",
        "<key>OPENCLAW_SERVICE_KIND</key>",
        "<string>node</string>",
        "</dict>",
      ].join("\n"),
    );
    writePlist(
      "com.nats.server.plist",
      "com.nats.server",
      "<string>/Users/example/.openclaw/data/nats/server.conf</string>",
    );
    writePlist(
      "com.signal-cli.daemon.plist",
      "com.signal-cli.daemon",
      "<string>/Users/example/.openclaw/logs/signal-cli/default.log</string>",
    );
    const unrelatedPath = writePlist(
      "ai.openclaw.worker.plist",
      "ai.openclaw.worker",
      "<string>openclaw helper worker</string>",
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });

    expect(result).toEqual([
      {
        platform: "darwin",
        label: "ai.openclaw.worker",
        detail: `plist: ${unrelatedPath}`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });
});
