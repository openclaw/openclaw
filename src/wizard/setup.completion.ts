import os from "node:os";
import { resolveCliName } from "../cli/cli-name.js";
import {
  formatCompletionReloadCommand,
  installCompletion,
  resolveCompletionProfilePath,
} from "../cli/completion-runtime.js";
import type { ShellCompletionStatus } from "../commands/doctor-completion.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../commands/doctor-completion.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import type { WizardFlow } from "./setup.types.js";

type CompletionDeps = {
  resolveCliName: () => string;
  checkShellCompletionStatus: (binName: string) => Promise<ShellCompletionStatus>;
  ensureCompletionCacheExists: (binName: string) => Promise<boolean>;
  installCompletion: (shell: string, yes: boolean, binName?: string) => Promise<void>;
};

// Resolve the actual install target via the shared candidate resolver so the
// hint reflects ZDOTDIR/XDG_CONFIG_HOME redirects instead of hardcoded `~`
// paths the shell may not read (#63069). POSIX shells get the `~`-shortened
// form for readability; PowerShell keeps the absolute path because users paste
// the value verbatim into `. '...'`.
function resolveProfileHint(shell: ShellCompletionStatus["shell"]): string {
  const resolved = resolveCompletionProfilePath(shell);
  if (shell === "powershell") {
    return resolved;
  }
  const home = process.env.HOME || os.homedir();
  if (home && (resolved === home || resolved.startsWith(`${home}/`) || resolved.startsWith(`${home}\\`))) {
    return `~${resolved.slice(home.length)}`;
  }
  return resolved;
}

function formatReloadHint(shell: ShellCompletionStatus["shell"], profileHint: string): string {
  if (shell === "powershell") {
    return t("wizard.completion.reloadPowerShell", {
      command: formatCompletionReloadCommand("powershell", profileHint),
    });
  }
  return t("wizard.completion.reloadShell", { profile: profileHint });
}

export async function setupWizardShellCompletion(params: {
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
            message: t("wizard.completion.enable", {
              shell: completionStatus.shell,
              cli: cliName,
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
        t("wizard.completion.cacheFailed", { command: `${cliName} completion --install` }),
        t("wizard.completion.title"),
      );
      return;
    }

    // Install to shell profile
    await deps.installCompletion(completionStatus.shell, true, cliName);

    const profileHint = resolveProfileHint(completionStatus.shell);
    await params.prompter.note(
      t("wizard.completion.installed", {
        reloadHint: formatReloadHint(completionStatus.shell, profileHint),
      }),
      t("wizard.completion.title"),
    );
  }
  // Case 4: Both profile and cache exist (using cached version) - all good, nothing to do
}
