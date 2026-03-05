import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let findExtraGatewayServices: typeof import("./inspect.js").findExtraGatewayServices;
let inspectTestUtils: typeof import("./inspect.js").__test__;

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

beforeAll(async () => {
  ({ findExtraGatewayServices, __test__: inspectTestUtils } = await import("./inspect.js"));
});

describe("detectMarker", () => {
  it("ignores markers that only appear in a POSIX HOME path", () => {
    const marker = inspectTestUtils.detectMarker("ExecStart=/home/moltbot/.local/bin/helper", {
      HOME: "/home/moltbot",
    });
    expect(marker).toBeNull();
  });

  it("ignores markers that only appear in a Windows HOME path", () => {
    const marker = inspectTestUtils.detectMarker(
      "ExecStart=C:\\Users\\MoltBot\\tools\\helper.exe",
      { HOME: "C:\\Users\\MoltBot" },
    );
    expect(marker).toBeNull();
  });

  it("scrubs markers when Windows HOME separators use slash variants", () => {
    const marker = inspectTestUtils.detectMarker("ExecStart=C:/Users/MoltBot/tools/helper.exe", {
      HOME: "C:\\Users\\MoltBot",
    });
    expect(marker).toBeNull();
  });

  it("scrubs HOME paths inside XML string boundaries", () => {
    const marker = inspectTestUtils.detectMarker("<string>/Users/MoltBot/tools/helper</string>", {
      HOME: "/Users/MoltBot",
    });
    expect(marker).toBeNull();
  });

  it("scrubs HOME paths at CRLF line endings", () => {
    const marker = inspectTestUtils.detectMarker("Environment=HOME=/home/moltbot\r\n", {
      HOME: "/home/moltbot",
    });
    expect(marker).toBeNull();
  });

  it("scrubs XML HOME paths before CRLF line endings", () => {
    const marker = inspectTestUtils.detectMarker(
      "<string>/Users/MoltBot/tools/helper</string>\r\n",
      {
        HOME: "/Users/MoltBot",
      },
    );
    expect(marker).toBeNull();
  });

  it("scrubs POSIX HOME paths when HOME has a trailing slash", () => {
    const marker = inspectTestUtils.detectMarker("ExecStart=/home/moltbot/.local/bin/helper", {
      HOME: "/home/moltbot/",
    });
    expect(marker).toBeNull();
  });

  it("scrubs Windows task paths when HOME uses POSIX drive syntax", () => {
    const marker = inspectTestUtils.detectMarker("Task To Run: C:\\Users\\MoltBot\\helper.exe", {
      HOME: "/c/Users/MoltBot",
    });
    expect(marker).toBeNull();
  });

  it("scrubs Windows HOME paths when USERPROFILE has a trailing slash", () => {
    const marker = inspectTestUtils.detectMarker("Task To Run: C:\\Users\\MoltBot\\helper.exe", {
      USERPROFILE: "C:\\Users\\MoltBot\\",
    });
    expect(marker).toBeNull();
  });

  it("still detects markers that appear outside HOME", () => {
    const marker = inspectTestUtils.detectMarker("ExecStart=/opt/clawdbot/bin/clawdbot run", {
      HOME: "/home/openclaw",
    });
    expect(marker).toBe("clawdbot");
  });

  it("does not scrub HOME when it appears mid-path", () => {
    const marker = inspectTestUtils.detectMarker(
      "ExecStart=/home/useropenclaw/bin/openclaw gateway run",
      { HOME: "/home/user" },
    );
    expect(marker).toBe("openclaw");
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
    ]);
  });
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

  it("keeps legacy systemd units when only the unit name carries the marker", async () => {
    const servicePath = path.join(
      tempHome,
      ".config",
      "systemd",
      "user",
      "clawdbot-gateway.service",
    );
    await fs.writeFile(
      servicePath,
      ["[Service]", `ExecStart=${tempHome}/bin/gateway run`].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit: ${servicePath}`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it("does not report non-gateway openclaw helper units", async () => {
    const servicePath = path.join(tempHome, ".config", "systemd", "user", "openclaw-node.service");
    await fs.writeFile(
      servicePath,
      ["[Service]", "ExecStart=/opt/openclaw/bin/helper run"].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toEqual([]);
  });

  it("does not report legacy-prefixed units that are not gateway services", async () => {
    const servicePath = path.join(tempHome, ".config", "systemd", "user", "moltbot-backup.service");
    await fs.writeFile(
      servicePath,
      ["[Service]", `ExecStart=${tempHome}/bin/backup run`].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toEqual([]);
  });

  it("does not report legacy gateway near-matches that are not exact legacy unit names", async () => {
    const servicePath = path.join(
      tempHome,
      ".config",
      "systemd",
      "user",
      "moltbot-gateway-helper.service",
    );
    await fs.writeFile(
      servicePath,
      ["[Service]", `ExecStart=${tempHome}/bin/helper run`].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: tempHome });
    expect(result).toEqual([]);
  });
});
