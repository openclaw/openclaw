import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPLETION_CACHE_WRITE_TIMEOUT_ENV,
  formatCompletionReloadCommand,
  formatCompletionSourceLine,
  installCompletion,
  resolveCompletionCachePath,
  resolveCompletionCacheWriteTimeoutMs,
  resolveCompletionProfilePath,
  resolveShellFromEnv,
} from "./completion-runtime.js";

describe("completion-runtime", () => {
  const originalHome = process.env.HOME;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("formats PowerShell source and reload commands with single-quoted paths", () => {
    expect(
      formatCompletionSourceLine("powershell", "openclaw", "C:\\Users\\Ada\\open'claw.ps1"),
    ).toBe(". 'C:\\Users\\Ada\\open''claw.ps1'");
    expect(formatCompletionReloadCommand("powershell", "C:\\Users\\Ada\\profile.ps1")).toBe(
      ". 'C:\\Users\\Ada\\profile.ps1'",
    );
  });

  it("detects PowerShell shell names from Windows paths", () => {
    expect(resolveShellFromEnv({ SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" })).toBe(
      "powershell",
    );
    expect(
      resolveShellFromEnv({
        SHELL: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      }),
    ).toBe("powershell");
  });

  it("resolves Windows PowerShell and pwsh profile directories", () => {
    expect(
      resolveCompletionProfilePath("powershell", {
        env: {
          SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
          USERPROFILE: "C:\\Users\\Ada",
        },
        homeDir: () => "C:\\Users\\Ada",
        platform: "win32",
      }),
    ).toBe(
      path.win32.join(
        "C:\\Users\\Ada",
        "Documents",
        "PowerShell",
        "Microsoft.PowerShell_profile.ps1",
      ),
    );
    expect(
      resolveCompletionProfilePath("powershell", {
        env: {
          SHELL: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          USERPROFILE: "C:\\Users\\Ada",
        },
        homeDir: () => "C:\\Users\\Ada",
        platform: "win32",
      }),
    ).toBe(
      path.win32.join(
        "C:\\Users\\Ada",
        "Documents",
        "WindowsPowerShell",
        "Microsoft.PowerShell_profile.ps1",
      ),
    );
  });

  it("installs PowerShell completion into the concrete profile path", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));

    process.env.HOME = homeDir;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const cachePath = resolveCompletionCachePath("powershell", "openclaw");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "# powershell completion\n", "utf-8");

      await installCompletion("powershell", true, "openclaw");

      const profilePath = resolveCompletionProfilePath("powershell");
      const profile = await fs.readFile(profilePath, "utf-8");
      expect(profile).toBe(`# OpenClaw Completion\n. '${cachePath}'\n`);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects install when the completion cache is missing", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));

    process.env.HOME = homeDir;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      await expect(installCompletion("zsh", true, "openclaw")).rejects.toThrow(
        "Completion cache not found",
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("resolveCompletionCacheWriteTimeoutMs", () => {
  it("returns the 30000ms default when the env var is unset", () => {
    expect(resolveCompletionCacheWriteTimeoutMs({})).toBe(30_000);
  });

  it("returns the default when the env var is an empty string", () => {
    expect(resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "" })).toBe(
      30_000,
    );
  });

  it("returns the default when the env var is whitespace only", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "   " }),
    ).toBe(30_000);
  });

  it("returns the default when the env var is non-numeric", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "soon" }),
    ).toBe(30_000);
  });

  it("returns the default when the env var is zero", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "0" }),
    ).toBe(30_000);
  });

  it("returns the default when the env var is negative", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "-100" }),
    ).toBe(30_000);
  });

  it("returns the parsed value when the env var is a positive integer", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "60000" }),
    ).toBe(60_000);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({
        [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: "  120000  ",
      }),
    ).toBe(120_000);
  });

  // Strict-parser regression coverage — the env var must accept only positive
  // integer milliseconds. parseInt would silently truncate the inputs below
  // (e.g. "60_000" → 60, "1e5" → 1), which would surprise operators expecting
  // their literal value to be honored.
  it.each([
    ["numeric separator", "60_000"],
    ["exponent notation", "1e5"],
    ["fractional value", "1.5"],
    ["trailing garbage", "30000abc"],
    ["leading whitespace inside number", "30 000"],
    ["leading zero", "030000"],
    ["plus sign prefix", "+60000"],
    ["hex prefix", "0x7530"],
  ])("falls back to the default when the env var has %s (%s)", (_label, value) => {
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: value }),
    ).toBe(30_000);
  });

  it("falls back when the env var exceeds Number.MAX_SAFE_INTEGER", () => {
    const tooLarge = "9007199254740993"; // MAX_SAFE_INTEGER + 2
    expect(
      resolveCompletionCacheWriteTimeoutMs({ [COMPLETION_CACHE_WRITE_TIMEOUT_ENV]: tooLarge }),
    ).toBe(30_000);
  });
});
