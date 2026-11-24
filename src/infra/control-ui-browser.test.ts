import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveControlUiBrowser } from "./control-ui-browser.js";
import * as windowsPaths from "./windows-install-roots.js";
import * as wsl from "./wsl.js";

const { readOs } = vi.hoisted(() => ({ readOs: vi.fn() }));
const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
// mock-isolation: Native application discovery and opener processes are external I/O fixtures.
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runExec: readOs,
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
const inventory = (value: unknown) =>
  readOs.mockResolvedValue({ stdout: JSON.stringify(value), stderr: "" });

beforeEach(async () => {
  vi.clearAllMocks();
  readOs.mockReset();
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
  // Model the Mac console user independently of the native test host.
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 501 });
  consoleStat.uid = 501;
  vi.spyOn(fs, "stat").mockResolvedValue(consoleStat);
  vi.spyOn(wsl, "isWSL").mockResolvedValue(false);
  vi.spyOn(windowsPaths, "getWindowsPowerShellExePath").mockReturnValue(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  inventory([safari, chrome, firefox]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalGetuid) {
    Object.defineProperty(process, "getuid", originalGetuid);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
});

const keepDefault = { canOpen: true };
const noDesktop = { canOpen: false };
const chromeOpen = {
  canOpen: true,
  openOptions: { browserCommand: ["/usr/bin/open", "-a", chrome.path] },
  notice: expect.stringContaining("Chrome for this session"),
};
const sshConnection = "192.0.2.1 1234 192.0.2.2 22";

it.each(["26.2", ""])("preserves the supported or unknown default (%s)", async (version) => {
  inventory([{ ...safari, version }, chrome]);
  expect(await resolveControlUiBrowser()).toEqual(keepDefault);
});

it("prefers compatible Chrome in ~/Applications regardless of discovery order", async () => {
  inventory([safari, firefox, chrome]);
  expect(await resolveControlUiBrowser()).toEqual(chromeOpen);
});

it("keeps terminal recovery if only Chrome for Testing and an unknown version are available", async () => {
  inventory([
    safari,
    { ...chrome, id: "com.google.Chrome.forTesting" },
    { ...chrome, version: "" },
  ]);
  expect(await resolveControlUiBrowser()).toMatchObject({
    canOpen: false,
    notice: expect.stringContaining("openclaw tui"),
  });
});

it("preserves the default when OS discovery fails", async () => {
  readOs.mockRejectedValue(new Error("fixture native discovery unavailable"));
  expect(await resolveControlUiBrowser()).toEqual(keepDefault);
});

it.each([
  ["win32", "SSH_CONNECTION", sshConnection],
  ["linux", "SSH_CONNECTION", sshConnection],
  ["darwin", "REMOTE_CONTAINERS", "1"],
  ["darwin", "CODESPACES", "1"],
] as const)("blocks %s desktop opening in %s", async (platform, key, value) => {
  mockProcessPlatform(platform);
  vi.stubEnv(key, value);
  expect(await resolveControlUiBrowser()).toEqual(noDesktop);
  expect(readOs).not.toHaveBeenCalled();
});

it.each(["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"])(
  "selects a compatible Mac browser from a GUI shell with inherited %s",
  async (key) => {
    vi.stubEnv(key, key === "SSH_TTY" ? "/dev/ttys002" : sshConnection);
    readOs.mockResolvedValueOnce({ stdout: "Aqua\n", stderr: "" });
    expect(await resolveControlUiBrowser()).toEqual(chromeOpen);
  },
);

it.each(["Background", "", null])(
  "blocks non-GUI or unverifiable Mac SSH (%s)",
  async (manager) => {
    vi.stubEnv("SSH_CONNECTION", sshConnection);
    if (manager === null) {
      readOs.mockRejectedValueOnce(new Error("launch context unavailable"));
    } else {
      readOs.mockResolvedValueOnce({ stdout: manager, stderr: "" });
    }
    expect(await resolveControlUiBrowser()).toEqual(noDesktop);
  },
);

it("does not treat a Mac without a logged-in console as a local desktop", async () => {
  vi.mocked(fs.stat).mockRejectedValue(new Error("no console"));
  expect(await resolveControlUiBrowser()).toEqual(noDesktop);
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
    expect(await resolveControlUiBrowser()).toEqual(keepDefault);
    expect(readOs).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "opens only an interactive Windows desktop (headless=%s)",
  async (headless) => {
    mockProcessPlatform("win32");
    const current = { family: "firefox", path: "C:\\Browsers\\firefox.exe", version: "140.0" };
    const alternate = { family: "chrome", path: "C:\\Browsers\\chrome.exe", version: "156.0" };
    inventory({ headless, defaultPath: current.path, browsers: [current, alternate] });
    expect(await resolveControlUiBrowser()).toMatchObject(
      headless ? noDesktop : { canOpen: true, openOptions: { browserCommand: [alternate.path] } },
    );
  },
);

const oldChrome = {
  family: "chrome",
  path: "C:\\Browsers\\Chrome124\\chrome.exe",
  version: "124.0",
};
const edge = { family: "edge", path: "C:\\Browsers\\msedge.exe", version: "157.0" };
it.each([
  { scenario: "unsupported", defaultPath: oldChrome.path.toUpperCase(), stale: edge },
  { scenario: "supported", defaultPath: edge.path, stale: oldChrome },
  { scenario: "unknown", defaultPath: "", stale: oldChrome },
])(
  "uses the effective $scenario Windows HTML handler, not stale registration flags",
  async (testCase) => {
    mockProcessPlatform("win32");
    inventory({
      headless: false,
      defaultPath: testCase.defaultPath,
      browsers: [
        { ...oldChrome, isDefault: testCase.stale === oldChrome },
        { ...edge, isDefault: testCase.stale === edge },
      ],
    });
    expect(await resolveControlUiBrowser()).toEqual(
      testCase.scenario === "unsupported"
        ? {
            canOpen: true,
            openOptions: { browserCommand: [edge.path] },
            notice: expect.stringContaining("Edge for this session"),
          }
        : keepDefault,
    );
  },
);

it.each(["unknown-html", "unsupported-html"])(
  "uses macOS HTML association instead of a different HTTPS browser (%s)",
  async (scenario) => {
    const developer = {
      id: "org.mozilla.firefoxdeveloperedition",
      path: "/Applications/Firefox Developer Edition.app",
      version: "150.0",
    };
    const html = scenario === "unknown-html" ? developer : safari;
    const https = scenario === "unknown-html" ? safari : chrome;
    const apps = [html, https, chrome];
    const fileUrl = (appPath: string) => ({ path: appPath });
    const bridge = Object.assign((value: unknown) => value, {
      kLSRolesAll: 0xffffffff,
      LSCopyDefaultRoleHandlerForContentType: (type: string, role: number) =>
        type === "public.html" && role === 0xffffffff ? html.id : undefined,
      NSHomeDirectory: () => "/Users/fixture",
      NSURL: { URLWithString: (value: string) => value, fileURLWithPath: fileUrl },
      NSWorkspace: {
        sharedWorkspace: {
          URLForApplicationToOpenURL: () => fileUrl(https.path),
          URLForApplicationWithBundleIdentifier: (id: string) =>
            fileUrl(apps.find((app) => app.id === id)?.path ?? ""),
          URLsForApplicationsWithBundleIdentifier: (id: string) => {
            const matches = apps.filter((app) => app.id === id);
            return {
              count: matches.length,
              objectAtIndex: (index: number) => fileUrl(matches[index]!.path),
            };
          },
        },
      },
      NSBundle: {
        bundleWithURL: (url: { path: string }) => {
          const app = apps.find((entry) => entry.path === url.path);
          return { bundleIdentifier: app?.id, objectForInfoDictionaryKey: () => app?.version };
        },
      },
    });
    readOs.mockImplementation(async (_command: string, args: string[]) => ({
      // Execute the actual JXA program against fixed native-boundary responses.
      stdout: runInNewContext(args.at(-1)!, {
        $: bridge,
        ObjC: { import: () => {}, unwrap: (value: unknown) => value },
      }),
      stderr: "",
    }));
    const selected = await resolveControlUiBrowser();
    expect(selected).toEqual(
      scenario === "unknown-html"
        ? { canOpen: true }
        : {
            canOpen: true,
            openOptions: { browserCommand: ["/usr/bin/open", "-a", chrome.path] },
            notice: expect.stringContaining("Chrome for this session"),
          },
    );
  },
);
