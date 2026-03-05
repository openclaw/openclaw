import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let findExtraGatewayServices: typeof import("./inspect.js").findExtraGatewayServices;

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

beforeAll(async () => {
  ({ findExtraGatewayServices } = await import("./inspect.js"));
});

describe("findExtraGatewayServices (linux)", () => {
  const originalPlatform = process.platform;
  const originalHome = process.env.HOME;
  let tempHome: string;

  beforeEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-home-"));
    process.env.HOME = tempHome;
    await fs.mkdir(path.join(tempHome, ".config", "systemd", "user"), { recursive: true });
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    process.env.HOME = originalHome;
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("ignores markers that only appear inside the HOME path", async () => {
    const servicePath = path.join(
      tempHome,
      ".config",
      "systemd",
      "user",
      "wishlist-staging.service",
    );
    await fs.writeFile(
      servicePath,
      [
        "[Service]",
        `WorkingDirectory=${tempHome}/projects/wishlist`,
        `ExecStart=${tempHome}/projects/wishlist/dev-cargo.sh`,
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toEqual([]);
  });

  it("still detects markers outside the HOME path", async () => {
    const servicePath = path.join(tempHome, ".config", "systemd", "user", "legacy-moltbot.service");
    await fs.writeFile(
      servicePath,
      ["[Service]", "ExecStart=/opt/moltbot/bin/moltbot run"].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toEqual([
      {
        platform: "linux",
        label: "legacy-moltbot.service",
        detail: `unit: ${path.join(tempHome, ".config", "systemd", "user", "legacy-moltbot.service")}`,
        scope: "user",
        marker: "moltbot",
        legacy: true,
      },
    ]);
  });

  it("does not scrub HOME when it appears mid-path", async () => {
    const servicePath = path.join(tempHome, ".config", "systemd", "user", "openclaw.service");
    await fs.writeFile(
      servicePath,
      ["[Service]", `ExecStart=${tempHome}openclaw/bin/openclaw gateway run`].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toEqual([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: `unit: ${path.join(tempHome, ".config", "systemd", "user", "openclaw.service")}`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });
  it("handles windows HOME paths", async () => {
    const windowsHome = "C:\\Users\\MoltBot";
    const userDir = path.join(windowsHome, ".config", "systemd", "user");
    const servicePath = path.join(userDir, "legacy-moltbot.service");
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(
      servicePath,
      ["[Service]", "ExecStart=C:\\Users\\MoltBot\\tools\\helper.exe"].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: windowsHome });
    expect(result).toEqual([]);
  });
});

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
