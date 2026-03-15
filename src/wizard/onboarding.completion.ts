import os from "node:os";
import path from "node:path";
import { resolveCliName } from "../cli/cli-name.js";
import { installCompletion } from "../cli/completion-cli.js";
import type { ShellCompletionStatus } from "../commands/doctor-completion.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../commands/doctor-completion.js";
import { cliT } from "../i18n/cli.js";
import { pathExists } from "../utils.js";
import type { WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

type CompletionDeps = {
  resolveCliName: () => string;
  checkShellCompletionStatus: (binName: string) => Promise<ShellCompletionStatus>;
  ensureCompletionCacheExists: (binName: string) => Promise<boolean>;
  installCompletion: (shell: string, yes: boolean, binName?: string) => Promise<void>;
};

async function resolveProfileHint(shell: ShellCompletionStatus["shell"]): Promise<string> {
  const home = process.env.HOME || os.homedir();
  if (shell === "zsh") {
    return "~/.zshrc";
  }
  if (shell === "bash") {
    const bashrc = path.join(home, ".bashrc");
    return (await pathExists(bashrc)) ? "~/.bashrc" : "~/.bash_profile";
  }
  if (shell === "fish") {
    return "~/.config/fish/config.fish";
  }
  // Best-effort. PowerShell profile path varies; restart hint is still correct.
  return "$PROFILE";
}

function formatReloadHint(
  shell: ShellCompletionStatus["shell"],
  profileHint: string,
  t: (key: Parameters<typeof cliT>[0], vars?: Record<string, string | number>) => string,
): string {
  if (shell === "powershell") {
    return t("wizard.shellCompletionReloadPowerShell");
  }
  return t("wizard.shellCompletionReloadSource", { profileHint });
}

export async function setupOnboardingShellCompletion(params: {
  flow: WizardFlow;
  prompter: Pick<WizardPrompter, "confirm" | "note">;
  deps?: Partial<CompletionDeps>;
}): Promise<void> {
  const deps: CompletionDeps = {
    resolveCliName,
    checkShellCompletionStatus,
    ensureCompletionCacheExists,
    installCompletion,
    ...params.deps,
  };
  const t = (key: Parameters<typeof cliT>[0], vars?: Record<string, string | number>) =>
    cliT(key, process.env, vars);

  const cliName = deps.resolveCliName();
  const completionStatus = await deps.checkShellCompletionStatus(cliName);

  if (completionStatus.usesSlowPattern) {
    // Case 1: Profile uses slow dynamic pattern - silently upgrade to cached version
    const cacheGenerated = await deps.ensureCompletionCacheExists(cliName);
    if (cacheGenerated) {
      await deps.installCompletion(completionStatus.shell, true, cliName);
    }
    return;
  }

  if (completionStatus.profileInstalled && !completionStatus.cacheExists) {
    // Case 2: Profile has completion but no cache - auto-fix silently
    await deps.ensureCompletionCacheExists(cliName);
    return;
  }

  if (!completionStatus.profileInstalled) {
    // Case 3: No completion at all
    const shouldInstall =
      params.flow === "quickstart"
        ? true
        : await params.prompter.confirm({
            message: t("wizard.shellCompletionEnableQuestion", {
              shell: completionStatus.shell,
              cliName,
            }),
            initialValue: true,
          });

    if (!shouldInstall) {
      return;
    }

    // Generate cache first (required for fast shell startup)
    const cacheGenerated = await deps.ensureCompletionCacheExists(cliName);
    if (!cacheGenerated) {
      await params.prompter.note(
        t("wizard.shellCompletionCacheFailedNote", { cliName }),
        t("wizard.shellCompletionTitle"),
      );
      return;
    }

    // Install to shell profile
    await deps.installCompletion(completionStatus.shell, true, cliName);

    const profileHint = await resolveProfileHint(completionStatus.shell);
    const reloadHint = formatReloadHint(completionStatus.shell, profileHint, t);
    await params.prompter.note(
      t("wizard.shellCompletionInstalledNote", { reloadHint }),
      t("wizard.shellCompletionTitle"),
    );
  }
  // Case 4: Both profile and cache exist (using cached version) - all good, nothing to do
}
