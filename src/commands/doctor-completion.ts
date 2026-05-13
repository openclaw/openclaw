import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCliName } from "../cli/cli-name.js";
import {
  installCompletion,
  isCompletionInstalled,
  resolveShellFromEnv,
} from "../cli/completion-runtime.js";
import { resolveStateDir } from "../config/paths.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { pathExists } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type CompletionShell = "zsh" | "bash" | "fish" | "powershell";

export type ShellCompletionStatus = {
  shell: CompletionShell;
  profileInstalled: boolean;
  /** True if profile points at the retired state-dir completion cache. */
  usesRetiredCache: boolean;
  retiredCachePath: string | null;
};

function sanitizeCompletionBasename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "openclaw";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function resolveRetiredCompletionCachePath(
  shell: CompletionShell,
  binName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const basename = sanitizeCompletionBasename(binName);
  const extension =
    shell === "powershell" ? "ps1" : shell === "fish" ? "fish" : shell === "bash" ? "bash" : "zsh";
  return path.join(resolveStateDir(env, os.homedir), "completions", `${basename}.${extension}`);
}

/** Doctor-only check for retired state-dir completion cache profile lines. */
export async function usesRetiredCompletionCache(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<string | null> {
  const home = process.env.HOME || os.homedir();
  const profilePath =
    shell === "zsh"
      ? path.join(home, ".zshrc")
      : shell === "bash"
        ? path.join(home, ".bashrc")
        : shell === "fish"
          ? path.join(home, ".config", "fish", "config.fish")
          : process.platform === "win32"
            ? path.join(
                process.env.USERPROFILE || home,
                "Documents",
                "PowerShell",
                "Microsoft.PowerShell_profile.ps1",
              )
            : path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");

  if (!(await pathExists(profilePath))) {
    return null;
  }

  const cachePath = resolveRetiredCompletionCachePath(shell, binName);
  const content = await fs.readFile(profilePath, "utf-8");
  return content.split("\n").some((line) => line.includes(cachePath)) ? cachePath : null;
}

/** Check the status of shell completion for the current shell. */
export async function checkShellCompletionStatus(
  binName = "openclaw",
): Promise<ShellCompletionStatus> {
  const shell = resolveShellFromEnv() as CompletionShell;
  const profileInstalled = await isCompletionInstalled(shell, binName);
  const retiredCachePath = await usesRetiredCompletionCache(shell, binName);

  return {
    shell,
    profileInstalled,
    usesRetiredCache: retiredCachePath !== null,
    retiredCachePath,
  };
}

export type DoctorCompletionOptions = {
  nonInteractive?: boolean;
};

/**
 * Doctor check for shell completion.
 * - If profile points at the retired cache file: rewrite it to dynamic sourcing
 * - If no completion at all: prompt to install (with user confirmation)
 */
export async function doctorShellCompletion(
  _runtime: RuntimeEnv,
  prompter: DoctorPrompter,
  options: DoctorCompletionOptions = {},
): Promise<void> {
  const cliName = resolveCliName();
  const status = await checkShellCompletionStatus(cliName);

  if (status.usesRetiredCache) {
    note(
      `Your ${status.shell} profile points at the retired completion cache.\nRewriting it to generate completions directly from ${cliName}.`,
      "Shell completion",
    );

    await installCompletion(status.shell, true, cliName, {
      retiredCachePath: status.retiredCachePath,
    });
    note(
      `Shell completion upgraded. Restart your shell or run: source ~/.${status.shell === "zsh" ? "zshrc" : status.shell === "bash" ? "bashrc" : "config/fish/config.fish"}`,
      "Shell completion",
    );
    return;
  }

  // No completion at all - prompt to install
  if (!status.profileInstalled) {
    if (options.nonInteractive) {
      // In non-interactive mode, just note that completion is not installed
      return;
    }

    const shouldInstall = await prompter.confirm({
      message: `Enable ${status.shell} shell completion for ${cliName}?`,
      initialValue: true,
    });

    if (shouldInstall) {
      await installCompletion(status.shell, true, cliName);
      note(
        `Shell completion installed. Restart your shell or run: source ~/.${status.shell === "zsh" ? "zshrc" : status.shell === "bash" ? "bashrc" : "config/fish/config.fish"}`,
        "Shell completion",
      );
    }
  }
}
