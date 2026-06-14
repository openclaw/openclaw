import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isCompletionInstalled,
  resolveCompletionProfilePath,
  resolveCompletionProfilePathCandidates,
} from "./completion-runtime.js";

/**
 * Regression tests for #63069: shell completion profile-path resolution must
 * honor `$ZDOTDIR` (zsh) and `$XDG_CONFIG_HOME` (fish) instead of writing to a
 * `$HOME` fallback the shell never reads, bash must consider `.bashrc` and
 * `.bash_profile` so `isCompletionInstalled`/`installCompletion` agree, and the
 * upstream win32 PowerShell `SHELL`/`USERPROFILE` branch must still resolve
 * correctly.
 */
describe("resolveCompletionProfilePathCandidates (#63069)", () => {
  const homeDir = (): string => "/home/example";

  it("uses $ZDOTDIR/.zshrc exclusively when ZDOTDIR is set", () => {
    const candidates = resolveCompletionProfilePathCandidates("zsh", {
      env: { HOME: "/home/example", ZDOTDIR: "/home/example/.config/zsh" },
      homeDir,
    });
    expect(candidates).toStrictEqual([path.join("/home/example/.config/zsh", ".zshrc")]);
  });

  it("falls back to $HOME/.zshrc when ZDOTDIR is unset", () => {
    const candidates = resolveCompletionProfilePathCandidates("zsh", {
      env: { HOME: "/home/example" },
      homeDir,
    });
    expect(candidates).toStrictEqual([path.join("/home/example", ".zshrc")]);
  });

  it("treats whitespace-only ZDOTDIR as unset", () => {
    const candidates = resolveCompletionProfilePathCandidates("zsh", {
      env: { HOME: "/home/example", ZDOTDIR: "   " },
      homeDir,
    });
    expect(candidates).toStrictEqual([path.join("/home/example", ".zshrc")]);
  });

  it("uses $XDG_CONFIG_HOME/fish/config.fish exclusively when XDG_CONFIG_HOME is set", () => {
    const candidates = resolveCompletionProfilePathCandidates("fish", {
      env: { HOME: "/home/example", XDG_CONFIG_HOME: "/home/example/.alt-config" },
      homeDir,
    });
    expect(candidates).toStrictEqual([
      path.join("/home/example/.alt-config", "fish", "config.fish"),
    ]);
  });

  it("falls back to $HOME/.config/fish/config.fish when XDG_CONFIG_HOME is unset", () => {
    const candidates = resolveCompletionProfilePathCandidates("fish", {
      env: { HOME: "/home/example" },
      homeDir,
    });
    expect(candidates).toStrictEqual([
      path.join("/home/example", ".config", "fish", "config.fish"),
    ]);
  });

  it("returns .bashrc then .bash_profile for bash so macOS-only installs still resolve", () => {
    const candidates = resolveCompletionProfilePathCandidates("bash", {
      env: { HOME: "/home/example" },
      homeDir,
    });
    expect(candidates).toStrictEqual([
      path.join("/home/example", ".bashrc"),
      path.join("/home/example", ".bash_profile"),
    ]);
  });

  it("falls back to os.homedir() when env.HOME is unset", () => {
    const candidates = resolveCompletionProfilePathCandidates("zsh", { env: {}, homeDir });
    expect(candidates).toStrictEqual([path.join("/home/example", ".zshrc")]);
  });

  it("returns the WindowsPowerShell profile on win32 when SHELL basename is powershell", () => {
    const candidates = resolveCompletionProfilePathCandidates("powershell", {
      env: { HOME: "C:/Users/example", USERPROFILE: "C:/Users/example", SHELL: "powershell.exe" },
      homeDir: () => "C:/Users/example",
      platform: "win32",
    });
    expect(candidates).toStrictEqual([
      path.win32.join(
        "C:/Users/example",
        "Documents",
        "WindowsPowerShell",
        "Microsoft.PowerShell_profile.ps1",
      ),
    ]);
  });

  it("returns the PowerShell (Core) profile on win32 when SHELL basename is pwsh or empty", () => {
    const candidates = resolveCompletionProfilePathCandidates("powershell", {
      env: { USERPROFILE: "C:/Users/example", SHELL: "pwsh.exe" },
      homeDir: () => "C:/Users/example",
      platform: "win32",
    });
    expect(candidates).toStrictEqual([
      path.win32.join(
        "C:/Users/example",
        "Documents",
        "PowerShell",
        "Microsoft.PowerShell_profile.ps1",
      ),
    ]);
  });

  it("prefers USERPROFILE over HOME on win32", () => {
    const candidates = resolveCompletionProfilePathCandidates("powershell", {
      env: { HOME: "C:/wsl-home", USERPROFILE: "C:/Users/example" },
      homeDir: () => "C:/Users/example",
      platform: "win32",
    });
    expect(candidates[0]).toContain(path.win32.join("C:/Users/example", "Documents"));
  });

  it("falls back to $HOME/.config/powershell on non-win32 platforms", () => {
    const candidates = resolveCompletionProfilePathCandidates("powershell", {
      env: { HOME: "/home/example" },
      homeDir,
      platform: "linux",
    });
    expect(candidates).toStrictEqual([
      path.join("/home/example", ".config", "powershell", "Microsoft.PowerShell_profile.ps1"),
    ]);
  });

  it("resolveCompletionProfilePath returns the canonical install target (first candidate)", () => {
    const candidatePath = resolveCompletionProfilePath("bash", {
      env: { HOME: "/home/example" },
      homeDir,
    });
    expect(candidatePath).toBe(path.join("/home/example", ".bashrc"));
  });
});

describe("isCompletionInstalled honors $ZDOTDIR / $XDG_CONFIG_HOME / bash fallback (#63069)", () => {
  const originalHome = process.env.HOME;
  const originalZdotdir = process.env.ZDOTDIR;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-profile-"));
    process.env.HOME = tmpDir;
    delete process.env.ZDOTDIR;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalZdotdir === undefined) {
      delete process.env.ZDOTDIR;
    } else {
      process.env.ZDOTDIR = originalZdotdir;
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads $ZDOTDIR/.zshrc when ZDOTDIR is set and $HOME/.zshrc would be ignored by the shell", async () => {
    const zdotdir = path.join(tmpDir, ".config", "zsh");
    await fs.mkdir(zdotdir, { recursive: true });
    const zdotdirZshrc = path.join(zdotdir, ".zshrc");
    await fs.writeFile(zdotdirZshrc, "# OpenClaw Completion\nsource /some/cache\n", "utf-8");
    process.env.ZDOTDIR = zdotdir;
    expect(await isCompletionInstalled("zsh")).toBe(true);
  });

  it("returns true when bash completion is installed in .bash_profile only (macOS)", async () => {
    const bashProfile = path.join(tmpDir, ".bash_profile");
    await fs.writeFile(bashProfile, "# OpenClaw Completion\nsource /some/cache\n", "utf-8");
    // .bashrc deliberately absent
    expect(await isCompletionInstalled("bash")).toBe(true);
  });

  it("returns true when fish completion is in $XDG_CONFIG_HOME/fish/config.fish", async () => {
    const xdg = path.join(tmpDir, "xdg-config");
    const fishDir = path.join(xdg, "fish");
    await fs.mkdir(fishDir, { recursive: true });
    const fishConfig = path.join(fishDir, "config.fish");
    await fs.writeFile(fishConfig, "# OpenClaw Completion\nsource /some/cache\n", "utf-8");
    process.env.XDG_CONFIG_HOME = xdg;
    expect(await isCompletionInstalled("fish")).toBe(true);
  });

  it("returns false when no profile candidate exists", async () => {
    // Empty tmpDir, no .zshrc, no $ZDOTDIR
    expect(await isCompletionInstalled("zsh")).toBe(false);
  });
});
