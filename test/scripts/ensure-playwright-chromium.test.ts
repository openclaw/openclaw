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

describe("ensurePlaywrightChromium", () => {
  it("uses an explicit Chromium executable override", () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expectStatus({
      env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: " /snap/bin/chromium " },
      existsSync: (candidatePath: string) => candidatePath === "/snap/bin/chromium",
      spawnSync,
    });
    expect(spawnSync).toHaveBeenCalledWith("/snap/bin/chromium", ["--version"], {
      stdio: "ignore",
    });
  });

  it("fails when the explicit Chromium executable override is missing", () => {
    const logs: string[] = [];
    const spawnSync = vi.fn();

    expectStatus(
      {
        env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/snap/bin/chromium" },
        existsSync: () => false,
        log: (line: string) => logs.push(line),
        spawnSync,
      },
      1,
    );
    expect(spawnSync).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points to /snap/bin/chromium",
    );
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
      cwd: "/repo",
      env: { PATH: "/bin" },
      existsSync: (candidatePath: string) =>
        candidatePath === "/usr/bin/chromium-browser" ||
        (managedChromiumInstalled && candidatePath === "/cache/chromium/chrome"),
      requirePlaywrightChromium: true,
      spawnSync,
      stdio: "pipe",
      systemExecutablePath: "/usr/bin/chromium-browser",
    });
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [playwrightCli, "install", "chromium"],
      expect.objectContaining({ cwd: path.resolve("/repo", "ui"), stdio: "pipe" }),
    );
    expect(spawnSync).not.toHaveBeenCalledWith("/usr/bin/chromium-browser", ["--version"], {
      stdio: "ignore",
    });
  });

  it("installs a relative pinned browser cache in the caller's directory, not the UI package", () => {
    const callerDirectory = "/repo";
    const browserCache = path.join(callerDirectory, ".artifacts", "playwright-browsers");
    const executablePath = path.join(browserCache, "chromium-1234", "chrome-linux64", "chrome");
    const installedCaches: string[] = [];
    let installedExecutable: string | undefined;
    const spawnSync = vi.fn(
      (command: string, args: string[], options?: Record<string, unknown>) => {
        if (command === process.execPath && args.includes("chromium")) {
          const installerEnv = options?.env as NodeJS.ProcessEnv;
          const configuredCache = installerEnv.PLAYWRIGHT_BROWSERS_PATH ?? "";
          const installerDirectory = String(options?.cwd);
          // The installer resolves relative caches from the UI package, not the caller.
          const installedCache = path.isAbsolute(configuredCache)
            ? configuredCache
            : path.resolve(installerDirectory, configuredCache);
          installedCaches.push(installedCache);
          installedExecutable = path.join(
            installedCache,
            "chromium-1234",
            "chrome-linux64",
            "chrome",
          );
          return { status: 0 };
        }
        return { status: command === installedExecutable ? 0 : 127 };
      },
    );

    const status = ensurePlaywrightChromium({
      cwd: callerDirectory,
      env: {
        INIT_CWD: callerDirectory,
        OPENCLAW_TESTBOX: "1",
        PATH: "/bin",
        PLAYWRIGHT_BROWSERS_PATH: ".artifacts/playwright-browsers",
      },
      executablePath,
      existsSync: (candidate: string) => candidate === installedExecutable,
      getuid: () => 501,
      log: vi.fn(),
      platform: "linux",
      requirePlaywrightChromium: true,
      spawnSync,
      stdio: "pipe",
    });

    expect({ browserCache: installedCaches[0], status }).toEqual({
      browserCache,
      status: 0,
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
    const logs: string[] = [];
    const spawnSync = vi.fn((candidatePath: string) => ({
      status: candidatePath === "/usr/bin/google-chrome" ? 0 : 127,
    }));

    expectStatus({
      env: {},
      existsSync: (candidatePath: string) =>
        candidatePath === "/snap/bin/chromium" || candidatePath === "/usr/bin/google-chrome",
      log: (line: string) => logs.push(line),
      spawnSync,
    });
    expect(spawnSync).toHaveBeenCalledWith("/snap/bin/chromium", ["--version"], {
      stdio: "ignore",
    });
    expect(spawnSync).toHaveBeenCalledWith("/usr/bin/google-chrome", ["--version"], {
      stdio: "ignore",
    });
    expect(logs.join("\n")).toContain("Using system Chromium at /usr/bin/google-chrome");
  });

  it("preserves the intentional missing-browser skip mode", () => {
    const logs: string[] = [];
    const spawnSync = vi.fn();

    expectStatus({
      env: { OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM: "1" },
      existsSync: () => false,
      log: (line: string) => logs.push(line),
      spawnSync,
    });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("leaves the lane skipped");
  });

  it("installs Linux system dependencies when Chromium still cannot start in a root lane", () => {
    const spawnSync = spawnResults(127, 0, 127, 0, 0);

    expectStatus({
      ...linuxLane,
      existsSync: () => true,
      getuid: () => 0,
      spawnSync,
    });
    expectInstall(spawnSync, 2, ["chromium"]);
    expectInstall(spawnSync, 4, ["--with-deps", "chromium"]);
  });

  it("retries with Linux system dependencies when the Chromium install reports missing host deps", () => {
    const logs: string[] = [];
    const spawnSync = spawnResults(23, 0, 0);
    let existsCalls = 0;

    expectStatus({
      ...linuxLane,
      env: { CI: "1", PATH: "/bin" },
      existsSync: () => ++existsCalls > 1,
      getuid: () => 501,
      log: (line: string) => logs.push(line),
      spawnSync,
    });
    expectInstall(spawnSync, 1, ["chromium"], { CI: "1", PATH: "/bin" });
    expectInstall(spawnSync, 2, ["--with-deps", "chromium"], { CI: "1", PATH: "/bin" });
    expect(logs.join("\n")).toContain("installing Linux system dependencies");
  });

  it("falls back to distro Chromium when Playwright does not support the Linux runner image", () => {
    const logs: string[] = [];
    let installedSystemChromium = false;
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (command === process.execPath && args.includes("chromium")) {
        return { status: 1 };
      }
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
      log: (line: string) => logs.push(line),
      spawnSync,
    });
    expect(spawnSync).toHaveBeenCalledWith(
      "apt-get",
      ["update", "-qq"],
      expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "apt-get",
      ["install", "-y", "chromium-browser"],
      expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
    );
    expect(logs.join("\n")).toContain("installing a system Chromium package");
    expect(logs.join("\n")).toContain("Using system Chromium at /usr/bin/chromium-browser");
  });

  it("does not install Linux system dependencies for an unprivileged local lane", () => {
    const spawnSync = spawnResults(127, 0, 127);

    expectStatus(
      {
        ...linuxLane,
        existsSync: () => true,
        getuid: () => 501,
        spawnSync,
      },
      1,
    );
    expect(spawnSync).toHaveBeenCalledTimes(3);
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
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      "sudo",
      ["-n", "apt-get", "update", "-qq"],
      expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      3,
      "sudo",
      ["-n", "apt-get", "install", "-y", "chromium-browser"],
      expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
    );
  });

  it("allows QA scenario runners to skip optional Playwright ffmpeg", () => {
    const argv = ["node", "scripts/ensure-playwright-chromium.mts"];
    expect(shouldEnsureFfmpegFromArgv(argv)).toBe(true);
    expect(shouldEnsureFfmpegFromArgv([...argv, "--skip-ffmpeg"])).toBe(false);
  });

  it("parses the pinned Playwright Chromium requirement", () => {
    const argv = ["node", "scripts/ensure-playwright-chromium.mts"];
    expect(
      shouldRequirePlaywrightChromiumFromArgv([...argv, "--require-playwright-chromium"]),
    ).toBe(true);
    expect(shouldRequirePlaywrightChromiumFromArgv(argv)).toBe(false);
  });
});
