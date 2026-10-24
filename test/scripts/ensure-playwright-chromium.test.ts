import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensurePlaywrightChromium,
  installLinuxSystemChromiumPackage,
  shouldEnsureFfmpegFromArgv,
  shouldRequirePlaywrightChromiumFromArgv,
} from "../../scripts/ensure-playwright-chromium.mts";

const playwrightCli = path.join(
  path.dirname(createRequire(path.resolve("ui/package.json")).resolve("playwright/package.json")),
  "cli.js",
);

function expectStatus(options: Parameters<typeof ensurePlaywrightChromium>[0], status = 0) {
  expect(ensurePlaywrightChromium({ executablePath: "/cache/chromium/chrome", ...options })).toBe(
    status,
  );
}

const linuxLane = {
  cwd: "/repo",
  env: { PATH: "/bin" },
  platform: "linux",
  stdio: "pipe",
  systemExecutablePath: "",
} as const;

function expectInstall(
  spawn: ReturnType<typeof vi.fn>,
  call: number,
  args: string[],
  env: NodeJS.ProcessEnv = linuxLane.env,
) {
  expect(spawn).toHaveBeenNthCalledWith(
    call,
    process.execPath,
    [playwrightCli, "install", ...args],
    {
      cwd: path.resolve("/repo", "ui"),
      env,
      shell: false,
      stdio: "pipe",
    },
  );
}

function spawnResults(...statuses: number[]) {
  const spawn = vi.fn();
  statuses.forEach((status) => spawn.mockReturnValueOnce({ status }));
  return spawn;
}

function expectProbe(spawn: ReturnType<typeof vi.fn>, executable: string) {
  expect(spawn).toHaveBeenCalledWith(executable, ["--version"], { stdio: "ignore" });
}

function expectLog(log: ReturnType<typeof vi.fn>, message: string) {
  expect(log).toHaveBeenCalledWith(expect.stringContaining(message));
}

function expectAptCalls(spawn: ReturnType<typeof vi.fn>, offset = 0) {
  const options = expect.objectContaining({ cwd: "/repo", stdio: "pipe" });
  const aptCalls = [
    ["update", "-qq"],
    ["install", "-y", "chromium-browser"],
  ];
  if (offset) {
    expect(spawn.mock.calls.slice(offset)).toEqual(
      aptCalls.map((args) => ["sudo", ["-n", "apt-get", ...args], options]),
    );
  } else {
    expect(spawn.mock.calls).toEqual(
      expect.arrayContaining(aptCalls.map((args) => ["apt-get", args, options])),
    );
  }
}

describe("ensurePlaywrightChromium", () => {
  it("uses an explicit Chromium executable override", () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expectStatus({
      env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: " /snap/bin/chromium " },
      existsSync: (candidatePath: string) => candidatePath === "/snap/bin/chromium",
      spawnSync,
    });
    expectProbe(spawnSync, "/snap/bin/chromium");
  });

  it.each([
    [
      { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/snap/bin/chromium" },
      1,
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points to /snap/bin/chromium",
    ],
    [{ OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM: "1" }, 0, "leaves the lane skipped"],
  ] as const)("does not launch missing browsers: %j", (env, status, message) => {
    const log = vi.fn();
    const spawnSync = vi.fn();

    expectStatus(
      {
        env,
        existsSync: () => false,
        log,
        spawnSync,
      },
      status,
    );
    expect(spawnSync).not.toHaveBeenCalled();
    expectLog(log, message);
  });

  it("installs Playwright Chromium when the lane requires its pinned browser", () => {
    let managedChromiumInstalled = false;
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (command === process.execPath && args.includes("chromium")) {
        managedChromiumInstalled = true;
        return { status: 0 };
      }
      if (command === "/cache/chromium/chrome") {
        return { status: managedChromiumInstalled ? 0 : 127 };
      }
      if (command === "/usr/bin/chromium-browser") {
        return { status: 0 };
      }
      return { status: 1 };
    });

    expectStatus({
      ...linuxLane,
      existsSync: (candidatePath: string) =>
        candidatePath === "/usr/bin/chromium-browser" ||
        (managedChromiumInstalled && candidatePath === "/cache/chromium/chrome"),
      requirePlaywrightChromium: true,
      spawnSync,
      systemExecutablePath: "/usr/bin/chromium-browser",
    });
    expectInstall(spawnSync, 1, ["chromium"]);
    expect(spawnSync).not.toHaveBeenCalledWith("/usr/bin/chromium-browser", ["--version"], {
      stdio: "ignore",
    });
  });

  it("installs a relative pinned browser cache in the caller's directory, not the UI package", () => {
    const executableSuffix = "chromium-1234/chrome-linux64/chrome";
    const executablePath = path.resolve("/repo/.artifacts/playwright-browsers", executableSuffix);
    let installedExecutable: string | undefined;
    const spawnSync = vi.fn(
      (command: string, args: string[], options?: Record<string, unknown>) => {
        if (command === process.execPath && args.includes("chromium")) {
          const installerEnv = options?.env as NodeJS.ProcessEnv;
          // The installer resolves relative caches from the UI package, not the caller.
          installedExecutable = path.resolve(
            String(options?.cwd),
            installerEnv.PLAYWRIGHT_BROWSERS_PATH ?? "",
            executableSuffix,
          );
          return { status: 0 };
        }
        return { status: command === installedExecutable ? 0 : 127 };
      },
    );

    expectStatus({
      ...linuxLane,
      env: {
        INIT_CWD: "/repo",
        OPENCLAW_TESTBOX: "1",
        PATH: "/bin",
        PLAYWRIGHT_BROWSERS_PATH: ".artifacts/playwright-browsers",
      },
      executablePath,
      existsSync: (candidate: string) => candidate === installedExecutable,
      getuid: () => 501,
      log: vi.fn(),
      requirePlaywrightChromium: true,
      spawnSync,
    });

    expect(installedExecutable).toBe(executablePath);
  });

  it.each([
    { configuredPath: undefined, label: "an unset cache path" },
    { configuredPath: "/shared/playwright", label: "an absolute cache path" },
    { configuredPath: "0", label: "Playwright's package-local cache sentinel" },
  ])("preserves $label for sibling browser dependency installs", ({ configuredPath }) => {
    const env: NodeJS.ProcessEnv = { INIT_CWD: "/repo", PATH: "/bin" };
    if (configuredPath !== undefined) {
      env.PLAYWRIGHT_BROWSERS_PATH = configuredPath;
    }
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expectStatus({
      cwd: "/repo",
      ensureFfmpeg: true,
      env,
      existsSync: (candidate: string) => candidate === "/cache/chromium/chrome",
      spawnSync,
      stdio: "pipe",
    });
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [playwrightCli, "install", "ffmpeg"],
      expect.objectContaining({ env }),
    );
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(configuredPath);
  });

  it("installs Playwright ffmpeg when recorded UI tests request it", () => {
    const logs: string[] = [];
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expect(
      ensurePlaywrightChromium({
        cwd: "/repo",
        ensureFfmpeg: true,
        env: { PATH: "/bin" },
        executablePath: "/cache/chromium/chrome",
        existsSync: (candidatePath: string) => candidatePath === "/usr/bin/chromium-browser",
        log: (line: string) => logs.push(line),
        spawnSync,
        stdio: "pipe",
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith("/usr/bin/chromium-browser", ["--version"], {
      stdio: "ignore",
    });
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, [playwrightCli, "install", "ffmpeg"], {
      cwd: path.resolve("/repo", "ui"),
      env: { PATH: "/bin" },
      shell: false,
      stdio: "pipe",
    });
    expect(logs.join("\n")).toContain("Using system Chromium at /usr/bin/chromium-browser");
  });

  it("skips a broken system Chromium binary and uses the first runnable candidate", () => {
    const log = vi.fn();
    const spawnSync = vi.fn((candidatePath: string) => ({
      status: candidatePath === "/usr/bin/google-chrome" ? 0 : 127,
    }));

    expectStatus({
      env: {},
      existsSync: (candidatePath: string) =>
        candidatePath === "/snap/bin/chromium" || candidatePath === "/usr/bin/google-chrome",
      log,
      spawnSync,
    });
    expectProbe(spawnSync, "/snap/bin/chromium");
    expectProbe(spawnSync, "/usr/bin/google-chrome");
    expectLog(log, "Using system Chromium at /usr/bin/google-chrome");
  });

  it.each([
    { lane: "root", uid: 0, statuses: [127, 0, 127, 0, 0], expected: 0, ci: false },
    { lane: "local", uid: 501, statuses: [127, 0, 127], expected: 1, ci: false },
    { lane: "CI missing host deps", uid: 501, statuses: [23, 0, 0], expected: 0, ci: true },
  ])(
    "repairs unstartable Linux Chromium only when permitted: $lane",
    ({ uid, statuses, expected, ci }) => {
      const spawnSync = spawnResults(...statuses);
      const env = ci ? { ...linuxLane.env, CI: "1" } : linuxLane.env;
      const log = vi.fn();
      let existsCalls = 0;
      expectStatus(
        {
          ...linuxLane,
          env,
          existsSync: () => !ci || ++existsCalls > 1,
          getuid: () => uid,
          spawnSync,
          log,
        },
        expected,
      );
      expectInstall(spawnSync, ci ? 1 : 2, ["chromium"], env);
      if (expected === 0) {
        expectInstall(spawnSync, ci ? 2 : 4, ["--with-deps", "chromium"], env);
      }
      if (ci) {
        expectLog(log, "installing Linux system dependencies");
      }
      expect(spawnSync).toHaveBeenCalledTimes(statuses.length);
    },
  );

  it("falls back to distro Chromium when Playwright does not support the Linux runner image", () => {
    const log = vi.fn();
    let installedSystemChromium = false;
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (command === "apt-get" && args.includes("update")) {
        return { status: 0 };
      }
      if (command === "apt-get" && args.includes("chromium-browser")) {
        installedSystemChromium = true;
        return { status: 0 };
      }
      if (command === "/usr/bin/chromium-browser") {
        return { status: installedSystemChromium ? 0 : 127 };
      }
      return { status: 1 };
    });

    expectStatus({
      ...linuxLane,
      env: { CI: "1", PATH: "/bin" },
      existsSync: (candidatePath: string) =>
        installedSystemChromium && candidatePath === "/usr/bin/chromium-browser",
      getuid: () => 0,
      log,
      spawnSync,
    });
    expectAptCalls(spawnSync);
    expectLog(log, "installing a system Chromium package");
    expectLog(log, "Using system Chromium at /usr/bin/chromium-browser");
  });

  it("returns the installer status when Playwright install fails", () => {
    expectStatus(
      {
        env: {},
        existsSync: () => false,
        platform: "darwin",
        spawnSync: vi.fn(() => ({ status: 23 })),
        stdio: "pipe",
        systemExecutablePath: "",
      },
      23,
    );
  });

  it("installs Linux system Chromium packages with sudo for non-root lanes", () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expect(
      installLinuxSystemChromiumPackage({
        ...linuxLane,
        getuid: () => 501,
        spawnSync,
      }),
    ).toBe(0);
    expect(spawnSync).toHaveBeenNthCalledWith(1, "sudo", ["-n", "true"], { stdio: "ignore" });
    expectAptCalls(spawnSync, 1);
  });

  it.each([
    ["--skip-ffmpeg", shouldEnsureFfmpegFromArgv, true],
    ["--require-playwright-chromium", shouldRequirePlaywrightChromiumFromArgv, false],
  ] as const)("parses %s", (flag, parse, defaultValue) => {
    const argv = ["node", "scripts/ensure-playwright-chromium.mts"];
    expect([parse(argv), parse([...argv, flag])]).toEqual([defaultValue, !defaultValue]);
  });
});
