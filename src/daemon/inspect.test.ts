import fs from "node:fs/promises";
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

// Helper: build a minimal gateway service file with OPENCLAW_SERVICE_MARKER declared
function gatewayServiceContent(extras: string[] = []): string {
  return [
    "[Unit]",
    "Description=OpenClaw Gateway",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "ExecStart=/usr/bin/node /home/user/workspace/openclaw/dist/index.js gateway --port 18790",
    "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
    "Environment=OPENCLAW_SERVICE_KIND=gateway",
    ...extras,
    "",
    "[Install]",
    "WantedBy=default.target",
  ].join("\n");
}

// Helper: build a companion service that references the gateway via After=/Requires=
function companionServiceContent(name: string): string {
  return [
    "[Unit]",
    `Description=OpenClaw ${name}`,
    "After=openclaw-gateway.service",
    "Requires=openclaw-gateway.service",
    "",
    "[Service]",
    `ExecStart=/usr/local/bin/${name.toLowerCase()}`,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
  ].join("\n");
}

describe("findExtraGatewayServices (linux)", () => {
  const originalPlatform = process.platform;
  let tempHome: string;

  beforeEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inspect-test-"));
    await fs.mkdir(path.join(tempHome, ".config", "systemd", "user"), { recursive: true });
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("does not flag companion services that reference openclaw via After= or Requires=", async () => {
    const unitDir = path.join(tempHome, ".config", "systemd", "user");
    // voice service depends on the gateway but is not itself a gateway
    await fs.writeFile(
      path.join(unitDir, "openclaw-voice.service"),
      companionServiceContent("Voice Assistant"),
    );
    // update service mentions openclaw in its name and description
    await fs.writeFile(
      path.join(unitDir, "openclaw-update.service"),
      companionServiceContent("Auto-Update"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toEqual([]);
  });

  it("does not flag profiled or secondary openclaw gateways (openclaw-gateway-* naming or OPENCLAW_SERVICE_MARKER)", async () => {
    // A gateway installed by openclaw for a named profile (or a second install on the same
    // host) is either named openclaw-gateway-* or carries OPENCLAW_SERVICE_MARKER.
    // Neither should show up as an "extra" service — they are covered by isOpenClawGatewaySystemdService.
    const unitDir = path.join(tempHome, ".config", "systemd", "user");
    await fs.writeFile(path.join(unitDir, "openclaw-gateway-dev.service"), gatewayServiceContent());

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toEqual([]);
  });

  it("still flags legacy clawdbot/moltbot services", async () => {
    const unitDir = path.join(tempHome, ".config", "systemd", "user");
    await fs.writeFile(
      path.join(unitDir, "clawdbot-gateway.service"),
      [
        "[Unit]",
        "Description=Clawdbot Legacy Gateway",
        "[Service]",
        "ExecStart=/usr/local/bin/clawdbot gateway",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      platform: "linux",
      label: "clawdbot-gateway.service",
      scope: "user",
      legacy: true,
    });
  });
});

describe("findExtraGatewayServices (darwin)", () => {
  const originalPlatform = process.platform;
  let tempHome: string;

  beforeEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inspect-darwin-test-"));
    await fs.mkdir(path.join(tempHome, "Library", "LaunchAgents"), { recursive: true });
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("does not flag plists that reference openclaw only in string values (e.g. a dependency label)", async () => {
    const agentsDir = path.join(tempHome, "Library", "LaunchAgents");
    // A LaunchAgent that mentions "openclaw" only in a comment or string value —
    // not as OPENCLAW_SERVICE_MARKER — should not be flagged.
    await fs.writeFile(
      path.join(agentsDir, "com.example.openclaw-companion.plist"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "  <key>Label</key>",
        "  <string>com.example.openclaw-companion</string>",
        "  <key>ProgramArguments</key>",
        "  <array>",
        "    <string>/usr/local/bin/companion</string>",
        "  </array>",
        "  <key>RunAtLoad</key>",
        "  <true/>",
        "</dict>",
        "</plist>",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toEqual([]);
  });
});
