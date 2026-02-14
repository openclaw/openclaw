import { confirm, isCancel, select } from "@clack/prompts";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  formatUpdateChannelLabel,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import { checkUpdateStatus } from "../../infra/update-check.js";
import { defaultRuntime } from "../../runtime.js";
import { stylePromptHint, stylePromptMessage } from "../../terminal/prompt-style.js";
import { theme } from "../../terminal/theme.js";
import { pathExists } from "../../utils.js";
import {
  isEmptyDir,
  isGitCheckout,
  resolveGitInstallDir,
  resolveUpdateRoot,
  type UpdateWizardOptions,
} from "./shared.js";
import { updateCommand } from "./update-command.js";

const selectStyled = <T>(params: Parameters<typeof select<T>>[0]) =>
  select({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

export async function updateWizardCommand(opts: UpdateWizardOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    defaultRuntime.error(
      "Update wizard requires a TTY. Use `openclaw update --channel <stable|beta|dev>` instead.",
    );
    defaultRuntime.exit(1);
    return;
  }

  const timeoutMs = opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined;
  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error("--timeout must be a positive integer (seconds)");
    defaultRuntime.exit(1);
    return;
  }

  const root = await resolveUpdateRoot();
  const [updateStatus, configSnapshot] = await Promise.all([
    checkUpdateStatus({
      root,
      timeoutMs: timeoutMs ?? 3500,
      fetchGit: false,
      includeRegistry: false,
    }),
    readConfigFileSnapshot(),
  ]);

  const configChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;
  const channelInfo = resolveEffectiveUpdateChannel({
    configChannel,
    installKind: updateStatus.installKind,
    git: updateStatus.git
      ? { tag: updateStatus.git.tag, branch: updateStatus.git.branch }
      : undefined,
  });
  const channelLabel = formatUpdateChannelLabel({
    channel: channelInfo.channel,
    source: channelInfo.source,
    gitTag: updateStatus.git?.tag ?? null,
    gitBranch: updateStatus.git?.branch ?? null,
  });

  const pickedChannel = await selectStyled({
    message: "Update channel",
    options: [
      {
        value: "keep",
        label: `Keep current (${channelInfo.channel})`,
        hint: channelLabel,
      },
      {
        value: "stable",
        label: "Stable",
        hint: "Tagged releases (npm latest)",
      },
      {
        value: "beta",
        label: "Beta",
        hint: "Prereleases (npm beta)",
      },
      {
        value: "dev",
        label: "Dev",
        hint: "Git main",
      },
    ],
    initialValue: "keep",
  });

  if (isCancel(pickedChannel)) {
    defaultRuntime.log(theme.muted("Update cancelled."));
    defaultRuntime.exit(0);
    return;
  }

  const requestedChannel = pickedChannel === "keep" ? null : pickedChannel;

  if (requestedChannel === "dev" && updateStatus.installKind !== "git") {
    const gitDir = resolveGitInstallDir();
    const hasGit = await isGitCheckout(gitDir);
    if (!hasGit) {
      const dirExists = await pathExists(gitDir);
      if (dirExists) {
        const empty = await isEmptyDir(gitDir);
        if (!empty) {
          defaultRuntime.error(
            `OPENCLAW_GIT_DIR points at a non-git directory: ${gitDir}. Set OPENCLAW_GIT_DIR to an empty folder or an openclaw checkout.`,
          );
          defaultRuntime.exit(1);
          return;
        }
      }

      const ok = await confirm({
        message: stylePromptMessage(
          `Create a git checkout at ${gitDir}? (override via OPENCLAW_GIT_DIR)`,
        ),
        initialValue: true,
      });
      if (isCancel(ok) || !ok) {
        defaultRuntime.log(theme.muted("Update cancelled."));
        defaultRuntime.exit(0);
        return;
      }
    }
  }

  const restart = await confirm({
    message: stylePromptMessage("Restart the gateway service after update?"),
    initialValue: true,
  });
  if (isCancel(restart)) {
    defaultRuntime.log(theme.muted("Update cancelled."));
    defaultRuntime.exit(0);
    return;
  }

  try {
    await updateCommand({
      channel: requestedChannel ?? undefined,
      restart: Boolean(restart),
      timeout: opts.timeout,
    });
  } catch (err) {
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}
