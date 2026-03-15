import os from "node:os";
import path from "node:path";
import { resolveCliName } from "../cli/cli-name.js";
import { installCompletion } from "../cli/completion-cli.js";
import type { ShellCompletionStatus } from "../commands/doctor-completion.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../commands/doctor-completion.js";
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
  // Resolve PowerShell profile path from known default locations.
  // Note: PowerShell's $PROFILE is an automatic variable, not an env var,
  // so we cannot read it from process.env.
  if (shell === "powershell") {
    // On macOS/Linux (pwsh), the profile lives under ~/.config/powershell.
    if (process.platform !== "win32") {
      const xdgProfile = path.join(
        home,
        ".config",
        "powershell",
        "Microsoft.PowerShell_profile.ps1",
      );
      return xdgProfile;
    }
    const docsDir = process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "Documents")
      : path.join(home, "Documents");
    // Prefer PowerShell 7+ path, fall back to Windows PowerShell 5.x path.
    const ps7Profile = path.join(docsDir, "PowerShell", "Microsoft.PowerShell_profile.ps1");
    if (await pathExists(ps7Profile)) {
      return ps7Profile;
    }
    const ps5Profile = path.join(docsDir, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
    if (await pathExists(ps5Profile)) {
      return ps5Profile;
    }
    return ps7Profile;
  }
  return "$PROFILE";
}

function formatReloadHint(
  shell: ShellCompletionStatus["shell"],
  profileHint: string,
  profileExists: boolean,
): string {
  if (shell === "powershell") {
    if (!profileExists) {
      return "Restart your shell to activate completions.";
    }
    return `Restart your shell or run: . "${profileHint}"`;
  }
  return `Restart your shell or run: source ${profileHint}`;
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
            message: `Enable ${completionStatus.shell} shell completion for ${cliName}?`,
            initialValue: true,
          });

    if (!shouldInstall) {
      return;
    }

    // Generate cache first (required for fast shell startup)
    const cacheGenerated = await deps.ensureCompletionCacheExists(cliName);
    if (!cacheGenerated) {
      await params.prompter.note(
        `Failed to generate completion cache. Run \`${cliName} completion --install\` later.`,
        "Shell completion",
      );
      return;
    }

    // Install to shell profile
    await deps.installCompletion(completionStatus.shell, true, cliName);

    const profileHint = await resolveProfileHint(completionStatus.shell);
    const profileExists = await pathExists(profileHint);
    await params.prompter.note(
      `Shell completion installed. ${formatReloadHint(completionStatus.shell, profileHint, profileExists)}`,
      "Shell completion",
    );
  }
  // Case 4: Both profile and cache exist (using cached version) - all good, nothing to do
}
