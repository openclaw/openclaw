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
  expect(ensurePlaywrightChromium({ ...linuxLane, ...options })).toBe(status);
}

const linuxLane = {
  cwd: "/repo",
  env: { PATH: "/bin" },
  platform: "linux",
  stdio: "pipe",
  systemExecutablePath: "",
  executablePath: "/cache/chromium/chrome",
} as const;

function expectInstall(spawn: ReturnType<typeof vi.fn>, call: number, args: string[]) {
  expect(spawn.mock.calls[call - 1]?.slice(0, 2)).toEqual([
    process.execPath,
    [playwrightCli, "install", ...args],
  ]);
}

function spawnResults(...statuses: number[]) {
  const spawn = vi.fn();
  statuses.forEach((status) => spawn.mockReturnValueOnce({ status }));
  return spawn;
}

function expectProbe(spawn: ReturnType<typeof vi.fn>, executable: string) {
  expect(spawn).toHaveBeenCalledWith(executable, ["--version"], { stdio: "ignore" });
}

function expectAptCalls(spawn: ReturnType<typeof vi.fn>, offset = 0) {
  const calls = [
    ["update", "-qq"],
    ["install", "-y", "chromium-browser"],
  ].map((args) => [
    offset ? "sudo" : "apt-get",
    offset ? ["-n", "apt-get", ...args] : args,
    expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
  ]);
  expect(spawn.mock.calls.slice(offset)).toEqual(offset ? calls : expect.arrayContaining(calls));
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
    [{ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/snap/bin/chromium" }, 1],
    [{ OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM: "1" }, 0],
  ] as const)("does not launch missing browsers: %j", (env, status) => {
    const spawnSync = vi.fn();

    expectStatus(
      {
        env,
        existsSync: () => false,
        spawnSync,
      },
      status,
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("installs the required pinned browser in the caller's relative cache, not a system browser", () => {
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
        if (command === "/usr/bin/chromium-browser") {
          return { status: 0 };
        }
        return { status: command === installedExecutable ? 0 : 127 };
      },
    );

    expectStatus({
      env: {
        INIT_CWD: "/repo",
        PATH: "/bin",
        PLAYWRIGHT_BROWSERS_PATH: ".artifacts/playwright-browsers",
      },
      executablePath,
      existsSync: (candidate: string) => candidate === installedExecutable,
      requirePlaywrightChromium: true,
      systemExecutablePath: "/usr/bin/chromium-browser",
      spawnSync,
    });
    expect(installedExecutable).toBe(executablePath);
    expectInstall(spawnSync, 1, ["chromium"]);
    expect(spawnSync).not.toHaveBeenCalledWith("/usr/bin/chromium-browser", ["--version"], {
      stdio: "ignore",
    });
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
      ensureFfmpeg: true,
      env,
      existsSync: (candidate: string) => candidate === "/cache/chromium/chrome",
      spawnSync,
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
    const spawnSync = vi.fn((candidatePath: string) => ({
      status: candidatePath === "/usr/bin/google-chrome" ? 0 : 127,
    }));

    expectStatus({
      env: {},
      systemExecutablePath: undefined,
      existsSync: (candidatePath: string) =>
        candidatePath === "/snap/bin/chromium" || candidatePath === "/usr/bin/google-chrome",
      spawnSync,
    });
    expectProbe(spawnSync, "/snap/bin/chromium");
    expectProbe(spawnSync, "/usr/bin/google-chrome");
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
      let existsCalls = 0;
      expectStatus(
        {
          env,
          existsSync: () => !ci || ++existsCalls > 1,
          getuid: () => uid,
          spawnSync,
        },
        expected,
      );
      expectInstall(spawnSync, ci ? 1 : 2, ["chromium"]);
      if (expected === 0) {
        expectInstall(spawnSync, ci ? 2 : 4, ["--with-deps", "chromium"]);
      }
      expect(spawnSync).toHaveBeenCalledTimes(statuses.length);
    },
  );

  it("falls back to distro Chromium when Playwright does not support the Linux runner image", () => {
    let installedSystemChromium = false;
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (command === "apt-get" && args.includes("chromium-browser")) {
        installedSystemChromium = true;
      }
      return {
        status:
          (command === "apt-get" &&
            (args.includes("update") || args.includes("chromium-browser"))) ||
          (command === "/usr/bin/chromium-browser" && installedSystemChromium)
            ? 0
            : 1,
      };
    });

    expectStatus({
      env: { CI: "1", PATH: "/bin" },
      existsSync: (candidatePath: string) =>
        installedSystemChromium && candidatePath === "/usr/bin/chromium-browser",
      getuid: () => 0,
      spawnSync,
    });
    expectAptCalls(spawnSync);
  });

  it("returns the installer status when Playwright install fails", () => {
    expectStatus(
      {
        env: {},
        existsSync: () => false,
        platform: "darwin",
        spawnSync: vi.fn(() => ({ status: 23 })),
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
