import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { openUrlPrivately } from "./browser-handoff.js";
import { resolveControlUiBrowser } from "./control-ui-browser.js";
import * as windowsPaths from "./windows-install-roots.js";
import * as wsl from "./wsl.js";

const { readOs, launch } = vi.hoisted(() => ({ readOs: vi.fn(), launch: vi.fn() }));
// mock-isolation: Native application discovery and opener processes are external I/O fixtures.
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runExec: readOs,
  runCommandWithTimeout: launch,
}));
const safari = {
  id: "com.apple.Safari",
  path: "/Applications/Safari.app",
  version: "18.5",
  isDefault: true,
};
const chrome = {
  id: "com.google.Chrome",
  path: "/Users/fixture/Applications/Google Chrome.app",
  version: "156.0.1",
};
const firefox = { id: "org.mozilla.firefox", path: "/Applications/Firefox.app", version: "150.0" };
const success: SpawnResult = {
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
};
const inventory = (value: unknown) =>
  readOs.mockResolvedValue({ stdout: JSON.stringify(value), stderr: "" });

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of [
    "SSH_CLIENT",
    "SSH_TTY",
    "SSH_CONNECTION",
    "REMOTE_CONTAINERS",
    "CODESPACES",
    "SESSIONNAME",
    "WSL_DISTRO_NAME",
    "WSL_INTEROP",
    "WSLENV",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.stubEnv("DISPLAY", ":99");
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "development");
  mockProcessPlatform("darwin");
  const consoleStat = await fs.stat(fileURLToPath(import.meta.url));
  consoleStat.uid = process.getuid!();
  vi.spyOn(fs, "stat").mockResolvedValue(consoleStat);
  vi.spyOn(wsl, "isWSL").mockResolvedValue(false);
  vi.spyOn(windowsPaths, "getWindowsPowerShellExePath").mockReturnValue(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  inventory([safari, chrome, firefox]);
  launch.mockResolvedValue(success);
});

afterEach(async () => {
  for (const [argv] of launch.mock.calls) {
    const last = argv.at(-1);
    if (typeof last === "string" && last.startsWith("file:///")) {
      await fs.rm(path.dirname(fileURLToPath(last)), { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("routes a fresh pairing through the selected user-installed Mac browser without exposing credentials", async () => {
  const browser = await resolveControlUiBrowser();
  expect(browser.openOptions?.browserCommand).toEqual(["/usr/bin/open", "-a", chrome.path]);
  expect(browser.notice).toContain("Chrome for this session");
  const target = "http://127.0.0.1:18789/#bootstrapToken=fixture-one-time-secret";
  expect(await openUrlPrivately(target, browser.openOptions)).toBe(true);
  const argv = launch.mock.calls[0]![0];
  expect(argv).toEqual(["/usr/bin/open", "-a", chrome.path, expect.stringMatching(/^file:\/\//)]);
  expect(JSON.stringify([readOs.mock.calls, launch.mock.calls, browser.notice])).not.toContain(
    "fixture-one-time-secret",
  );
  const file = fileURLToPath(argv.at(-1));
  expect(await fs.readFile(file, "utf8")).toContain("bootstrapToken=fixture-one-time-secret");
  const handle = await fs.open(file, "r");
  try {
    expect((await handle.stat()).mode & 0o777).toBe(0o600);
  } finally {
    await handle.close();
  }
});

it("does not fall back to the unsupported default after the selected browser fails to launch", async () => {
  const browser = await resolveControlUiBrowser();
  launch.mockResolvedValue({ ...success, code: 1 });
  expect(
    await openUrlPrivately(
      "http://127.0.0.1:18789/#bootstrapToken=fixture-secret",
      browser.openOptions,
    ),
  ).toBe(false);
  expect(launch).toHaveBeenCalledTimes(1);
  const file = fileURLToPath(launch.mock.calls[0]![0].at(-1));
  await expect(fs.readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["26.2", "", "future", "26.2-preview"])(
  "preserves a supported or unknown default version (%s)",
  async (version) => {
    inventory([{ ...safari, version }, chrome]);
    expect(await resolveControlUiBrowser()).toEqual({ canOpen: true });
  },
);

it("selects deterministically and ignores unrecognized/automation applications", async () => {
  inventory([safari, firefox, { ...chrome, id: "com.google.Chrome.forTesting" }, chrome, chrome]);
  expect((await resolveControlUiBrowser()).openOptions?.browserCommand).toEqual([
    "/usr/bin/open",
    "-a",
    chrome.path,
  ]);
  inventory([{ ...safari, id: "unknown.browser" }, chrome]);
  expect(await resolveControlUiBrowser()).toEqual({ canOpen: true });
});

it("keeps a terminal recovery path when no compatible alternative is identified", async () => {
  inventory([safari, { ...chrome, version: "" }]);
  expect(await resolveControlUiBrowser()).toMatchObject({
    canOpen: false,
    notice: expect.stringContaining("openclaw tui"),
  });
});

it("falls back conservatively when OS discovery fails", async () => {
  readOs.mockRejectedValue(new Error("fixture native discovery unavailable"));
  expect(await resolveControlUiBrowser()).toEqual({ canOpen: true });
});

it.each(["darwin", "win32", "linux"] as const)(
  "does not open another machine's %s browser over SSH",
  async (platform) => {
    mockProcessPlatform(platform);
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 1234 192.0.2.2 22");
    expect(await resolveControlUiBrowser()).toEqual({ canOpen: false });
    expect(readOs).not.toHaveBeenCalled();
  },
);

it("does not treat a Mac without a logged-in console as a local desktop", async () => {
  vi.mocked(fs.stat).mockRejectedValue(new Error("no console"));
  expect(await resolveControlUiBrowser()).toEqual({ canOpen: false });
  expect(readOs).not.toHaveBeenCalled();
});

it.each(["Ubuntu", ""])(
  "keeps env- or kernel-detected WSL (%s) on the Windows opener",
  async (distro) => {
    mockProcessPlatform("linux");
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "");
    vi.stubEnv("WSL_DISTRO_NAME", distro);
    vi.mocked(wsl.isWSL).mockResolvedValue(true);
    expect(await resolveControlUiBrowser()).toEqual({ canOpen: true });
    expect(readOs).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "uses Windows registration/file metadata without opening a service desktop (headless=%s)",
  async (headless) => {
    mockProcessPlatform("win32");
    const exe = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    inventory({
      headless,
      browsers: [
        {
          family: "firefox",
          path: "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
          version: "140.0",
          isDefault: true,
        },
        { family: "chrome", path: exe, version: "156.0" },
        { family: "chrome", path: "\\remote\\chrome.exe", version: "156.0" },
      ],
    });
    expect(await resolveControlUiBrowser()).toMatchObject(
      headless ? { canOpen: false } : { canOpen: true, openOptions: { browserCommand: [exe] } },
    );
  },
);
