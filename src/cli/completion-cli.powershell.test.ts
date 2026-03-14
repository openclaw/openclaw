import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveShellFromEnv,
} from "./completion-cli.js";

// Stub path functions that rely on process.env / os.homedir
vi.mock("../config/paths.js", () => ({
  resolveStateDir: (_env: unknown, _homedir: unknown) =>
    path.join(os.tmpdir(), "openclaw-completion-test-state"),
}));

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-ps-"));
}

describe("resolveShellFromEnv - PowerShell detection", () => {
  it("detects pwsh from SHELL env", () => {
    const shell = resolveShellFromEnv({ SHELL: "/usr/bin/pwsh" });
    expect(shell).toBe("powershell");
  });

  it("detects powershell from SHELL env basename", () => {
    // On cross-platform test runners, SHELL uses posix paths.
    // The source trims the .exe via path.basename on the native platform.
    const shell = resolveShellFromEnv({ SHELL: "/usr/bin/powershell" });
    expect(shell).toBe("powershell");
  });

  it("returns zsh as default when SHELL is unset", () => {
    const shell = resolveShellFromEnv({});
    expect(shell).toBe("zsh");
  });
});

describe("formatCompletionSourceLine - PowerShell uses dot-source syntax", () => {
  it("cache path for powershell uses .ps1 extension", () => {
    const cachePath = resolveCompletionCachePath("powershell", "openclaw");
    expect(cachePath).toMatch(/\.ps1$/);
  });
});

describe("installCompletion - PowerShell", () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    originalEnv = { ...process.env };
    // Point HOME/USERPROFILE to temp dir so profile writes don't touch the real system
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(async () => {
    Object.assign(process.env, originalEnv);
    // Restore keys that were deleted
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("installs PowerShell completion with dot-source syntax", async () => {
    // Pre-create the cache file (installCompletion checks for it)
    const cachePath = resolveCompletionCachePath("powershell", "openclaw");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "# ps1 completion stub", "utf-8");

    // Determine where the profile will be written (platform-dependent)
    const profileDir =
      process.platform === "win32"
        ? path.join(tempDir, "Documents", "PowerShell")
        : path.join(tempDir, ".config", "powershell");
    await fs.mkdir(profileDir, { recursive: true });

    await installCompletion("powershell", true, "openclaw");

    const profilePath = path.join(profileDir, "Microsoft.PowerShell_profile.ps1");
    const exists = await fs
      .access(profilePath)
      .then(() => true)
      .catch(() => false);
    expect(exists, "PS profile should have been created").toBe(true);

    const content = await fs.readFile(profilePath, "utf-8");
    // Must use dot-source (`. `) not bash `source`
    expect(content).toMatch(/^\. "/m);
    expect(content).not.toMatch(/^source "/m);
  });

  it("detects completion as installed after writing profile", async () => {
    const cachePath = resolveCompletionCachePath("powershell", "openclaw");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "# ps1 completion stub", "utf-8");

    const profileDir =
      process.platform === "win32"
        ? path.join(tempDir, "Documents", "PowerShell")
        : path.join(tempDir, ".config", "powershell");
    await fs.mkdir(profileDir, { recursive: true });

    await installCompletion("powershell", true, "openclaw");

    const installed = await isCompletionInstalled("powershell", "openclaw");
    expect(installed).toBe(true);
  });

  it("does not use bash source keyword in PowerShell profile", async () => {
    const cachePath = resolveCompletionCachePath("powershell", "openclaw");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "# ps1 completion stub", "utf-8");

    const profileDir =
      process.platform === "win32"
        ? path.join(tempDir, "Documents", "PowerShell")
        : path.join(tempDir, ".config", "powershell");
    await fs.mkdir(profileDir, { recursive: true });

    await installCompletion("powershell", true, "openclaw");

    const profilePath = path.join(profileDir, "Microsoft.PowerShell_profile.ps1");
    const content = await fs.readFile(profilePath, "utf-8");
    // Ensure the bash `source` keyword is NOT present
    const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    for (const line of lines) {
      expect(line).not.toMatch(/^source\s/);
    }
  });
});
