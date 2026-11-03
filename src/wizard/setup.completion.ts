import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { CLI_NAME } from "../cli/cli-name.js";
import {
  findOptionalCompletionInstallFailure,
  formatCompletionReloadCommand,
  installCompletion,
  resolveCompletionProfileHint,
  resolveCompletionProfilePath,
} from "../cli/completion-runtime.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../commands/doctor-completion.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import type { WizardFlow } from "./setup.types.js";

export async function setupWizardShellCompletion(params: {
  flow: WizardFlow;
  prompter: Pick<WizardPrompter, "confirm" | "note">;
}): Promise<void> {
  const completionStatus = await checkShellCompletionStatus(CLI_NAME);
  const installCompletionForSetup = async (): Promise<boolean> => {
    try {
      await installCompletion(completionStatus.shell, true, CLI_NAME);
      return true;
    } catch (error) {
      const failure = findOptionalCompletionInstallFailure(error);
      if (!failure) {
        throw error;
      }
      const command = terminalText`${formatCompletionReloadCommand(
        completionStatus.shell,
        completionStatus.cachePath,
      )}`;
      if (failure.kind === "write") {
        await params.prompter.note(
          t("wizard.completion.profileNotWritable", {
            profile: terminalText`${failure.error.path ?? resolveCompletionProfilePath(completionStatus.shell)}`,
            shell: completionStatus.shell,
            command,
          }),
          t("wizard.completion.title"),
        );
      } else {
        await params.prompter.note(
          [
            terminalText`Automatic shell completion installation failed (profile is not valid UTF-8 at ${failure.profilePath}).`,
            "The file was left untouched.",
            `For this ${completionStatus.shell} session only, run:`,
            command,
          ].join(" "),
          t("wizard.completion.title"),
        );
      }
      return false;
    }
  };
  const ensureCompletionCache = async (): Promise<boolean> => {
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME, { generationMode: "full" });
    if (!cacheGenerated) {
      await params.prompter.note(
        t("wizard.completion.cacheFailed", {
          command: `${CLI_NAME} completion --write-state --install`,
        }),
        t("wizard.completion.title"),
      );
    }
    return cacheGenerated;
  };

  if (completionStatus.usesSlowPattern) {
    if (await ensureCompletionCache()) {
      await installCompletionForSetup();
    }
    return;
  }

  if (completionStatus.profileInstalled && !completionStatus.cacheExists) {
    await ensureCompletionCache();
    return;
  }

  if (!completionStatus.profileInstalled) {
    const shouldInstall =
      params.flow === "quickstart"
        ? true
        : await params.prompter.confirm({
            message: t("wizard.completion.enable", {
              shell: completionStatus.shell,
              cli: CLI_NAME,
            }),
            initialValue: true,
          });

    if (!shouldInstall) {
      return;
    }

    if (!(await ensureCompletionCache()) || !(await installCompletionForSetup())) {
      return;
    }

    const shell = completionStatus.shell;
    const command = terminalText`${formatCompletionReloadCommand(shell, resolveCompletionProfileHint(shell))}`;
    const reloadHint =
      shell === "powershell"
        ? t("wizard.completion.reloadPowerShell", { command })
        : t("wizard.completion.reloadShell", { profile: command.slice("source ".length) });
    await params.prompter.note(
      t("wizard.completion.installed", { reloadHint }),
      t("wizard.completion.title"),
    );
  }
}
