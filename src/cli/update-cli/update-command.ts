import { confirm, isCancel } from "@clack/prompts";
import path from "node:path";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { doctorCommand } from "../../commands/doctor.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  normalizeUpdateChannel,
} from "../../infra/update-channels.js";
import {
  compareSemverStrings,
  resolveNpmChannelTag,
  checkUpdateStatus,
} from "../../infra/update-check.js";
import {
  cleanupGlobalRenameDirs,
  globalInstallArgs,
  resolveGlobalPackageRoot,
} from "../../infra/update-global.js";
import { runGatewayUpdate, type UpdateRunResult } from "../../infra/update-runner.js";
import { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } from "../../plugins/update.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { stylePromptMessage } from "../../terminal/prompt-style.js";
import { theme } from "../../terminal/theme.js";
import { pathExists } from "../../utils.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-cli.js";
import { runDaemonRestart } from "../daemon-cli.js";
import { createUpdateProgress, printResult } from "./progress.js";
import {
  DEFAULT_PACKAGE_NAME,
  ensureGitCheckout,
  normalizeTag,
  readPackageName,
  readPackageVersion,
  resolveGitInstallDir,
  resolveGlobalManager,
  resolveNodeRunner,
  resolveTargetVersion,
  resolveUpdateRoot,
  runUpdateStep,
  tryWriteCompletionCache,
  type UpdateCommandOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";

const CLI_NAME = resolveCliName();

const UPDATE_QUIPS = [
  "Leveled up! New skills unlocked. You're welcome.",
  "Fresh code, same lobster. Miss me?",
  "Back and better. Did you even notice I was gone?",
  "Update complete. I learned some new tricks while I was out.",
  "Upgraded! Now with 23% more sass.",
  "I've evolved. Try to keep up.",
  "New version, who dis? Oh right, still me but shinier.",
  "Patched, polished, and ready to pinch. Let's go.",
  "The lobster has molted. Harder shell, sharper claws.",
  "Update done! Check the changelog or just trust me, it's good.",
  "Reborn from the boiling waters of npm. Stronger now.",
  "I went away and came back smarter. You should try it sometime.",
  "Update complete. The bugs feared me, so they left.",
  "New version installed. Old version sends its regards.",
  "Firmware fresh. Brain wrinkles: increased.",
  "I've seen things you wouldn't believe. Anyway, I'm updated.",
  "Back online. The changelog is long but our friendship is longer.",
  "Upgraded! Peter fixed stuff. Blame him if it breaks.",
  "Molting complete. Please don't look at my soft shell phase.",
  "Version bump! Same chaos energy, fewer crashes (probably).",
];

function pickUpdateQuip(): string {
  return UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)] ?? "Update complete.";
}

async function tryInstallShellCompletion(opts: {
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }

  const status = await checkShellCompletionStatus(CLI_NAME);

  if (status.usesSlowPattern) {
    defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (cacheGenerated) {
      await installCompletion(status.shell, true, CLI_NAME);
    }
    return;
  }

  if (status.profileInstalled && !status.cacheExists) {
    defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
    await ensureCompletionCacheExists(CLI_NAME);
    return;
  }

  if (!status.profileInstalled) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Shell completion"));

    const shouldInstall = await confirm({
      message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
      initialValue: true,
    });

    if (isCancel(shouldInstall) || !shouldInstall) {
      if (!opts.skipPrompt) {
        defaultRuntime.log(
          theme.muted(
            `Skipped. Run \`${replaceCliName(formatCliCommand("openclaw completion --install"), CLI_NAME)}\` later to enable.`,
          ),
        );
      }
      return;
    }

    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (!cacheGenerated) {
      defaultRuntime.log(theme.warn("Failed to generate completion cache."));
      return;
    }

    await installCompletion(status.shell, opts.skipPrompt, CLI_NAME);
  }
}

async function runPackageInstallUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  tag: string;
  timeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
}): Promise<UpdateRunResult> {
  const manager = await resolveGlobalManager({
    root: params.root,
    installKind: params.installKind,
    timeoutMs: params.timeoutMs,
  });
  const runCommand = async (argv: string[], options: { timeoutMs: number }) => {
    const res = await runCommandWithTimeout(argv, options);
    return { stdout: res.stdout, stderr: res.stderr, code: res.code };
  };

  const pkgRoot = await resolveGlobalPackageRoot(manager, runCommand, params.timeoutMs);
  const packageName =
    (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(params.root)) ??
    DEFAULT_PACKAGE_NAME;

  const beforeVersion = pkgRoot ? await readPackageVersion(pkgRoot) : null;
  if (pkgRoot) {
    await cleanupGlobalRenameDirs({
      globalRoot: path.dirname(pkgRoot),
      packageName,
    });
  }

  const updateStep = await runUpdateStep({
    name: "global update",
    argv: globalInstallArgs(manager, `${packageName}@${params.tag}`),
    timeoutMs: params.timeoutMs,
    progress: params.progress,
  });

  const steps = [updateStep];
  let afterVersion = beforeVersion;

  if (pkgRoot) {
    afterVersion = await readPackageVersion(pkgRoot);
    const entryPath = path.join(pkgRoot, "dist", "entry.js");
    if (await pathExists(entryPath)) {
      const doctorStep = await runUpdateStep({
        name: `${CLI_NAME} doctor`,
        argv: [resolveNodeRunner(), entryPath, "doctor", "--non-interactive"],
        timeoutMs: params.timeoutMs,
        progress: params.progress,
      });
      steps.push(doctorStep);
    }
  }

  const failedStep = steps.find((step) => step.exitCode !== 0);
  return {
    status: failedStep ? "error" : "ok",
    mode: manager,
    root: pkgRoot ?? params.root,
    reason: failedStep ? failedStep.name : undefined,
    before: { version: beforeVersion },
    after: { version: afterVersion },
    steps,
    durationMs: Date.now() - params.startedAt,
  };
}

async function runGitUpdate(params: {
  root: string;
  switchToGit: boolean;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number | undefined;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  channel: "stable" | "beta" | "dev";
  tag: string;
  showProgress: boolean;
  opts: UpdateCommandOptions;
  stop: () => void;
}): Promise<UpdateRunResult> {
  const updateRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
  const effectiveTimeout = params.timeoutMs ?? 20 * 60_000;

  const cloneStep = params.switchToGit
    ? await ensureGitCheckout({
        dir: updateRoot,
        timeoutMs: effectiveTimeout,
        progress: params.progress,
      })
    : null;

  if (cloneStep && cloneStep.exitCode !== 0) {
    const result: UpdateRunResult = {
      status: "error",
      mode: "git",
      root: updateRoot,
      reason: cloneStep.name,
      steps: [cloneStep],
      durationMs: Date.now() - params.startedAt,
    };
    params.stop();
    printResult(result, { ...params.opts, hideSteps: params.showProgress });
    defaultRuntime.exit(1);
    return result;
  }

  const updateResult = await runGatewayUpdate({
    cwd: updateRoot,
    argv1: params.switchToGit ? undefined : process.argv[1],
    timeoutMs: params.timeoutMs,
    progress: params.progress,
    channel: params.channel,
    tag: params.tag,
  });
  const steps = [...(cloneStep ? [cloneStep] : []), ...updateResult.steps];

  if (params.switchToGit && updateResult.status === "ok") {
    const manager = await resolveGlobalManager({
      root: params.root,
      installKind: params.installKind,
      timeoutMs: effectiveTimeout,
    });
    const installStep = await runUpdateStep({
      name: "global install",
      argv: globalInstallArgs(manager, updateRoot),
      cwd: updateRoot,
      timeoutMs: effectiveTimeout,
      progress: params.progress,
    });
    steps.push(installStep);

    const failedStep = installStep.exitCode !== 0 ? installStep : null;
    return {
      ...updateResult,
      status: updateResult.status === "ok" && !failedStep ? "ok" : "error",
      steps,
      durationMs: Date.now() - params.startedAt,
    };
  }

  return {
    ...updateResult,
    steps,
    durationMs: Date.now() - params.startedAt,
  };
}

async function updatePluginsAfterCoreUpdate(params: {
  root: string;
  channel: "stable" | "beta" | "dev";
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  opts: UpdateCommandOptions;
}): Promise<void> {
  if (!params.configSnapshot.valid) {
    if (!params.opts.json) {
      defaultRuntime.log(theme.warn("Skipping plugin updates: config is invalid."));
    }
    return;
  }

  const pluginLogger = params.opts.json
    ? {}
    : {
        info: (msg: string) => defaultRuntime.log(msg),
        warn: (msg: string) => defaultRuntime.log(theme.warn(msg)),
        error: (msg: string) => defaultRuntime.log(theme.error(msg)),
      };

  if (!params.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Updating plugins..."));
  }

  const syncResult = await syncPluginsForUpdateChannel({
    config: params.configSnapshot.config,
    channel: params.channel,
    workspaceDir: params.root,
    logger: pluginLogger,
  });
  let pluginConfig = syncResult.config;

  const npmResult = await updateNpmInstalledPlugins({
    config: pluginConfig,
    skipIds: new Set(syncResult.summary.switchedToNpm),
    logger: pluginLogger,
  });
  pluginConfig = npmResult.config;

  if (syncResult.changed || npmResult.changed) {
    await writeConfigFile(pluginConfig);
  }

  if (params.opts.json) {
    return;
  }

  const summarizeList = (list: string[]) => {
    if (list.length <= 6) {
      return list.join(", ");
    }
    return `${list.slice(0, 6).join(", ")} +${list.length - 6} more`;
  };

  if (syncResult.summary.switchedToBundled.length > 0) {
    defaultRuntime.log(
      theme.muted(
        `Switched to bundled plugins: ${summarizeList(syncResult.summary.switchedToBundled)}.`,
      ),
    );
  }
  if (syncResult.summary.switchedToNpm.length > 0) {
    defaultRuntime.log(
      theme.muted(`Restored npm plugins: ${summarizeList(syncResult.summary.switchedToNpm)}.`),
    );
  }
  for (const warning of syncResult.summary.warnings) {
    defaultRuntime.log(theme.warn(warning));
  }
  for (const error of syncResult.summary.errors) {
    defaultRuntime.log(theme.error(error));
  }

  const updated = npmResult.outcomes.filter((entry) => entry.status === "updated").length;
  const unchanged = npmResult.outcomes.filter((entry) => entry.status === "unchanged").length;
  const failed = npmResult.outcomes.filter((entry) => entry.status === "error").length;
  const skipped = npmResult.outcomes.filter((entry) => entry.status === "skipped").length;

  if (npmResult.outcomes.length === 0) {
    defaultRuntime.log(theme.muted("No plugin updates needed."));
  } else {
    const parts = [`${updated} updated`, `${unchanged} unchanged`];
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    if (skipped > 0) {
      parts.push(`${skipped} skipped`);
    }
    defaultRuntime.log(theme.muted(`npm plugins: ${parts.join(", ")}.`));
  }

  for (const outcome of npmResult.outcomes) {
    if (outcome.status !== "error") {
      continue;
    }
    defaultRuntime.log(theme.error(outcome.message));
  }
}

async function maybeRestartService(params: {
  shouldRestart: boolean;
  result: UpdateRunResult;
  opts: UpdateCommandOptions;
}): Promise<void> {
  if (params.shouldRestart) {
    if (!params.opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
    }

    try {
      const restarted = await runDaemonRestart();
      if (!params.opts.json && restarted) {
        defaultRuntime.log(theme.success("Daemon restarted successfully."));
        defaultRuntime.log("");
        process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
        try {
          const interactiveDoctor =
            Boolean(process.stdin.isTTY) && !params.opts.json && params.opts.yes !== true;
          await doctorCommand(defaultRuntime, {
            nonInteractive: !interactiveDoctor,
          });
        } catch (err) {
          defaultRuntime.log(theme.warn(`Doctor failed: ${String(err)}`));
        } finally {
          delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
        }
      }
    } catch (err) {
      if (!params.opts.json) {
        defaultRuntime.log(theme.warn(`Daemon restart failed: ${String(err)}`));
        defaultRuntime.log(
          theme.muted(
            `You may need to restart the service manually: ${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}`,
          ),
        );
      }
    }
    return;
  }

  if (!params.opts.json) {
    defaultRuntime.log("");
    if (params.result.mode === "npm" || params.result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\`, then \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    }
  }
}

export async function updateCommand(opts: UpdateCommandOptions): Promise<void> {
  suppressDeprecations();

  const timeoutMs = opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined;
  const shouldRestart = opts.restart !== false;

  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error("--timeout must be a positive integer (seconds)");
    defaultRuntime.exit(1);
    return;
  }

  const root = await resolveUpdateRoot();
  const updateStatus = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: false,
    includeRegistry: false,
  });

  const configSnapshot = await readConfigFileSnapshot();
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;

  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel && !requestedChannel) {
    defaultRuntime.error(`--channel must be "stable", "beta", or "dev" (got "${opts.channel}")`);
    defaultRuntime.exit(1);
    return;
  }
  if (opts.channel && !configSnapshot.valid) {
    const issues = configSnapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`);
    defaultRuntime.error(["Config is invalid; cannot set update channel.", ...issues].join("\n"));
    defaultRuntime.exit(1);
    return;
  }

  const installKind = updateStatus.installKind;
  const switchToGit = requestedChannel === "dev" && installKind !== "git";
  const switchToPackage =
    requestedChannel !== null && requestedChannel !== "dev" && installKind === "git";
  const updateInstallKind = switchToGit ? "git" : switchToPackage ? "package" : installKind;
  const defaultChannel =
    updateInstallKind === "git" ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL;
  const channel = requestedChannel ?? storedChannel ?? defaultChannel;

  const explicitTag = normalizeTag(opts.tag);
  let tag = explicitTag ?? channelToNpmTag(channel);

  if (updateInstallKind !== "git") {
    const currentVersion = switchToPackage ? null : await readPackageVersion(root);
    let fallbackToLatest = false;
    const targetVersion = explicitTag
      ? await resolveTargetVersion(tag, timeoutMs)
      : await resolveNpmChannelTag({ channel, timeoutMs }).then((resolved) => {
          tag = resolved.tag;
          fallbackToLatest = channel === "beta" && resolved.tag === "latest";
          return resolved.version;
        });
    const cmp =
      currentVersion && targetVersion ? compareSemverStrings(currentVersion, targetVersion) : null;
    const needsConfirm =
      !fallbackToLatest &&
      currentVersion != null &&
      (targetVersion == null || (cmp != null && cmp > 0));

    if (needsConfirm && !opts.yes) {
      if (!process.stdin.isTTY || opts.json) {
        defaultRuntime.error(
          [
            "Downgrade confirmation required.",
            "Downgrading can break configuration. Re-run in a TTY to confirm.",
          ].join("\n"),
        );
        defaultRuntime.exit(1);
        return;
      }

      const targetLabel = targetVersion ?? `${tag} (unknown)`;
      const message = `Downgrading from ${currentVersion} to ${targetLabel} can break configuration. Continue?`;
      const ok = await confirm({
        message: stylePromptMessage(message),
        initialValue: false,
      });
      if (isCancel(ok) || !ok) {
        if (!opts.json) {
          defaultRuntime.log(theme.muted("Update cancelled."));
        }
        defaultRuntime.exit(0);
        return;
      }
    }
  } else if (opts.tag && !opts.json) {
    defaultRuntime.log(
      theme.muted("Note: --tag applies to npm installs only; git updates ignore it."),
    );
  }

  if (requestedChannel && configSnapshot.valid) {
    const next = {
      ...configSnapshot.config,
      update: {
        ...configSnapshot.config.update,
        channel: requestedChannel,
      },
    };
    await writeConfigFile(next);
    if (!opts.json) {
      defaultRuntime.log(theme.muted(`Update channel set to ${requestedChannel}.`));
    }
  }

  const showProgress = !opts.json && process.stdout.isTTY;
  if (!opts.json) {
    defaultRuntime.log(theme.heading("Updating OpenClaw..."));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);
  const startedAt = Date.now();

  const result = switchToPackage
    ? await runPackageInstallUpdate({
        root,
        installKind,
        tag,
        timeoutMs: timeoutMs ?? 20 * 60_000,
        startedAt,
        progress,
      })
    : await runGitUpdate({
        root,
        switchToGit,
        installKind,
        timeoutMs,
        startedAt,
        progress,
        channel,
        tag,
        showProgress,
        opts,
        stop,
      });

  stop();
  printResult(result, { ...opts, hideSteps: showProgress });

  if (result.status === "error") {
    defaultRuntime.exit(1);
    return;
  }

  if (result.status === "skipped") {
    if (result.reason === "dirty") {
      defaultRuntime.log(
        theme.warn(
          "Skipped: working directory has uncommitted changes. Commit or stash them first.",
        ),
      );
    }
    if (result.reason === "not-git-install") {
      defaultRuntime.log(
        theme.warn(
          `Skipped: this OpenClaw install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\` and \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\`.`,
        ),
      );
      defaultRuntime.log(
        theme.muted(
          `Examples: \`${replaceCliName("npm i -g openclaw@latest", CLI_NAME)}\` or \`${replaceCliName("pnpm add -g openclaw@latest", CLI_NAME)}\``,
        ),
      );
    }
    defaultRuntime.exit(0);
    return;
  }

  await updatePluginsAfterCoreUpdate({
    root,
    channel,
    configSnapshot,
    opts,
  });

  await tryWriteCompletionCache(root, Boolean(opts.json));
  await tryInstallShellCompletion({
    jsonMode: Boolean(opts.json),
    skipPrompt: Boolean(opts.yes),
  });

  await maybeRestartService({
    shouldRestart,
    result,
    opts,
  });

  if (!opts.json) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  }
}
