import fs from "node:fs/promises";
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

describe("findExtraGatewayServices (linux)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    vi.restoreAllMocks();
  });

  it("does not treat non-ExecStart remote debugging flags as browser/CDP services", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue(["rogue.service"] as unknown as Awaited<
      ReturnType<typeof fs.readdir>
    >);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Unit]",
        "Description=OpenClaw Helper --remote-debugging-port=18800",
        "[Service]",
        "Environment=CDP=--remote-debugging-port=18800",
        "ExecStart=/usr/local/bin/helper --mode openclaw",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([
      {
        platform: "linux",
        label: "rogue.service",
        detail: `unit: ${path.join("/home/test", ".config", "systemd", "user", "rogue.service")}`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });

  it("skips browser/CDP services when ExecStart contains remote debugging port", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue(["chromium-browser.service"] as unknown as Awaited<
      ReturnType<typeof fs.readdir>
    >);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=/snap/bin/chromium --headless --remote-debugging-port=18800 --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser/CDP services when ExecStart arguments are single-quoted", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "chromium-single-quoted.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart='/snap/bin/chromium' '--headless' '--remote-debugging-port=18800' '--user-data-dir=/home/test/snap/chromium/common/openclaw/user-data'",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser/CDP services when ExecStart uses spaced assignment syntax", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue(["chromium-spaced.service"] as unknown as Awaited<
      ReturnType<typeof fs.readdir>
    >);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart = /snap/bin/chromium --headless --remote-debugging-port=18800 --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser/CDP services when ExecStart uses multiline continuation", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue(["chromium-multiline.service"] as unknown as Awaited<
      ReturnType<typeof fs.readdir>
    >);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=/usr/bin/env CHROME_USER_DATA=/home/test/snap/chromium/common/openclaw/user-data \\",
        "  /snap/bin/chromium --headless --remote-debugging-port=18800",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("does not treat non-browser commands as browser services when path contains chrome", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue(["openclaw-helper.service"] as unknown as Awaited<
      ReturnType<typeof fs.readdir>
    >);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      ["[Service]", "ExecStart=/home/chrome/.local/bin/openclaw gateway run"].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([
      {
        platform: "linux",
        label: "openclaw-helper.service",
        detail: `unit: ${path.join("/home/test", ".config", "systemd", "user", "openclaw-helper.service")}`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });

  it("skips browser services when ExecStart uses prefixed executable token", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue(["chromium-prefixed.service"] as unknown as Awaited<
      ReturnType<typeof fs.readdir>
    >);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=-/snap/bin/chromium --headless --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser services when env options consume argument values", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue(["chromium-env-u.service"] as unknown as Awaited<
      ReturnType<typeof fs.readdir>
    >);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=/usr/bin/env -u LD_PRELOAD /snap/bin/chromium --headless --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser services when single-quoted env wraps chromium without remote-debugging-port", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "chromium-env-single-quoted.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart='env' CHROME_USER_DATA=/home/test/snap/chromium/common/openclaw/user-data '/snap/bin/chromium' --headless --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser services when single-quoted env value with spaces wraps chromium", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "chromium-env-quoted-space.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=/usr/bin/env 'CHROME_USER_DATA=/home/user/My Data/openclaw' /snap/bin/chromium --headless",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser services when env uses clustered short options", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "chromium-env-clustered.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=/usr/bin/env -iu LD_PRELOAD /snap/bin/chromium --headless --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser services when env option value is single-quoted with spaces", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "chromium-env-chdir-quoted.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=/usr/bin/env -C '/home/user/My Data' /snap/bin/chromium --headless --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser services when env --chdir= inline value is single-quoted with spaces", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "chromium-env-chdir-inline.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=/usr/bin/env --chdir='/home/user/My Data' /snap/bin/chromium --headless --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser services when env uses optional signal options", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "chromium-default-signal.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=/usr/bin/env --default-signal /snap/bin/chromium --headless --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("does not treat env assignment text as remote debugging flag argument", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "openclaw-env-cdp-assignment.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=/usr/bin/env CDP=--remote-debugging-port=18800 /usr/local/bin/helper --mode openclaw",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([
      {
        platform: "linux",
        label: "openclaw-env-cdp-assignment.service",
        detail: `unit: ${path.join("/home/test", ".config", "systemd", "user", "openclaw-env-cdp-assignment.service")}`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });

  it("does not expand split-string flags for non-env executables", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "openclaw-python-split-string.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        'ExecStart=/usr/bin/python -S "/opt/openclaw/helper.py --remote-debugging-port=18800"',
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([
      {
        platform: "linux",
        label: "openclaw-python-split-string.service",
        detail: `unit: ${path.join("/home/test", ".config", "systemd", "user", "openclaw-python-split-string.service")}`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });

  it("skips browser services when env uses split-string payload", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "chromium-env-split-string.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        'ExecStart=/usr/bin/env -S "/snap/bin/chromium --headless --remote-debugging-port=18800 --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data"',
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips services when env split-string payload includes remote-debugging-port", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "openclaw-env-split-remote-port.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        'ExecStart=/usr/bin/env -S "/usr/local/bin/helper --mode openclaw --remote-debugging-port=18800"',
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser services when env uses split-string inline assignment", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "chromium-env-split-inline.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        'ExecStart=/usr/bin/env --split-string="/snap/bin/chromium --headless --remote-debugging-port=18800 --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data"',
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("skips browser services when env uses single-quoted split-string inline assignment", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "chromium-env-split-inline-single-quoted.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Service]",
        "ExecStart=/usr/bin/env --split-string='/snap/bin/chromium --headless --user-data-dir=/home/test/snap/chromium/common/openclaw/user-data'",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([]);
  });

  it("does not treat [Unit] ExecStart text as browser/CDP service signal", async () => {
    vi.spyOn(fs, "readdir").mockResolvedValue([
      "openclaw-unit-section-execstart.service",
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      [
        "[Unit]",
        "ExecStart=/snap/bin/chromium --headless --remote-debugging-port=18800",
        "[Service]",
        "ExecStart=/usr/local/bin/helper --mode openclaw",
      ].join("\n"),
    );

    const result = await findExtraGatewayServices({ HOME: "/home/test" });

    expect(result).toEqual([
      {
        platform: "linux",
        label: "openclaw-unit-section-execstart.service",
        detail: `unit: ${path.join("/home/test", ".config", "systemd", "user", "openclaw-unit-section-execstart.service")}`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });
});
