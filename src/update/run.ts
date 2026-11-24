// One update, as the running release does it: admit, resolve, preflight, prepare, check with
// the new code, publish a pending trial. Everything after that belongs to the launcher (the
// switch and its trial) and to the new build (migration at boot, `ready`).
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import {
  assertGlobalUpdateOwner,
  assertMacosGitForUnownedCheckout,
  UpdatePreMutationError,
} from "../cli/update-cli/shared.js";
import type { PostCorePluginUpdateResult } from "../cli/update-cli/update-command-plugins-internals.js";
import { resolveStateDir } from "../config/paths.js";
import { isBunRuntime } from "../daemon/runtime-binary.js";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import { gitCommitPrefixesMatch, resolveLoadedCommitHash } from "../infra/git-commit.js";
import { resolveNpmCommand } from "../infra/npm-command.js";
import { compareSemverStrings } from "../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { readBuiltGatewayBuildId } from "../infra/update-git-runtime.js";
import { isPackageTargetAlreadyCurrent } from "../infra/update-global.js";
import { describeUnavailableMacosSystemGit } from "../infra/update-macos-git.js";
import { UPDATE_RUN_TEXT_LIMIT } from "../infra/update-run-limits.js";
import type { UpdateRunStep } from "../infra/update-run-record.js";
import { assertUpdateRecoveryAdmission } from "../infra/update-run-recovery-admission.js";
import {
  finishUpdateRunAsync,
  recordUpdateRunPhaseAsync,
  recordUpdateRunStepAsync,
} from "../infra/update-run-write.async.js";
import { SystemPackageOwnershipError } from "../infra/update-system-package-ownership.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { VERSION } from "../version.js";
import { checkRelease } from "./check-release.js";
import { stageReleaseService } from "./convert-service.js";
import { resolveInstalledPackageFrontend } from "./installation-identity.js";
import { writeLauncher } from "./launcher.js";
import { preflight } from "./preflight.js";
import { prepareGit, type PrepareResult } from "./prepare-git.js";
import { preparePackage } from "./prepare-package.js";
import {
  acquireUpdateLock,
  allocateStaging,
  collectReleases,
  createTrialPending,
  publishStaging,
  readTrial,
  releaseUpdateLock,
  resolvePrefix,
  switchLink,
  type ReleaseKind,
} from "./store.js";
import { gitTargetSupportsReleaseUpdates, resolveTarget } from "./target.js";

/** Covers fetch, dependencies and the release build; a run past it is "interrupted". */
export const PREPARE_DEADLINE_MS = 45 * 60_000;
const CHECK_RELEASE_TIMEOUT_MS = 3 * 60_000;

type InstallKind = { kind: ReleaseKind; checkout?: string };

export type UpdateRunOutcome =
  | { status: "pending"; target: { version: string }; releaseRoot: string }
  | { status: "current"; version: string; pluginsChanged: boolean }
  | { status: "failed"; reason: string; message: string };

/** Where the checkout lives: a Git install runs from a checkout or from a release worktree of one. */
async function detectInstall(runningRoot: string): Promise<InstallKind> {
  const common = await runCommandWithTimeout(
    ["git", "-C", runningRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { timeoutMs: 10_000 },
  ).catch(() => null);
  const dir = common?.code === 0 ? common.stdout.trim() : "";
  if (!dir) {
    return { kind: "package" };
  }
  return { kind: "git", checkout: path.basename(dir) === ".git" ? path.dirname(dir) : runningRoot };
}

/**
 * Prepares and publishes the next release for `runId`. The caller restarts the Gateway when
 * this returns "pending"; the launcher then switches on its next child start.
 */
export async function prepareUpdate(params: {
  runId: string;
  runningRoot: string;
  runningVersion: string;
  channel: UpdateChannel;
  tag?: string;
  sha?: string;
  node?: string;
  env?: NodeJS.ProcessEnv;
  /** The operator's overall budget (`--timeout`); without it, the default preparation deadline. */
  timeoutMs?: number;
  /** `--accept-capabilities`: plugin maintenance may accept widened plugin capabilities. */
  acceptCapabilities?: boolean;
}): Promise<UpdateRunOutcome> {
  const timeoutMs = params.timeoutMs ?? PREPARE_DEADLINE_MS;
  const deadline = Date.now() + timeoutMs;
  const env = params.env ?? process.env;
  const prefix = resolvePrefix(env);
  const node = params.node ?? process.execPath;
  // Already current: plugins are still maintained, by the running core; the caller restarts
  // a running Gateway only when they changed.
  const current = async (version: string): Promise<UpdateRunOutcome> => {
    const { plugins, step } = await runPluginMaintenance({
      root: params.runningRoot,
      node,
      env,
      channel: params.channel,
      timeoutMs: Math.max(1, deadline - Date.now()),
      acceptCapabilities: params.acceptCapabilities,
    });
    await recordUpdateRunStepAsync(params.runId, step, { env });
    await finishUpdateRunAsync(
      params.runId,
      { status: "skipped", reason: "already-current" },
      { env },
    );
    return { status: "current", version, pluginsChanged: plugins?.changed === true };
  };
  const fail = async (
    reason: string,
    message: string,
    output?: string,
  ): Promise<UpdateRunOutcome> => {
    // The ledger bounds detail from the head; preserve the command's final error first.
    const detail = output
      ? sliceUtf16Safe(stripAnsi(output).trim(), -UPDATE_RUN_TEXT_LIMIT)
      : undefined;
    await finishUpdateRunAsync(
      params.runId,
      {
        status: "failed",
        reason,
        nextAction: message,
        ...(detail ? { diagnostics: { failure: { step: "outcome", detail } } } : {}),
      },
      { env },
    );
    return { status: "failed", reason, message };
  };
  const trial = await readTrial(prefix);
  if (trial && ["pending", "trial", "restoring"].includes(trial.phase)) {
    return await fail(
      "update-running",
      "Another update is switching releases. Try again in a few minutes.",
    );
  }
  const lock = await acquireUpdateLock(
    { runId: params.runId, pid: process.pid, deadlineMs: timeoutMs },
    prefix,
  );
  if (!lock.acquired) {
    return await fail("update-running", `Update ${lock.lock.runId} is already running.`);
  }
  let staging: Awaited<ReturnType<typeof allocateStaging>> | undefined;
  try {
    if (lock.previous) {
      await finishUpdateRunAsync(
        lock.previous.runId,
        { status: "failed", reason: "interrupted" },
        { env },
      );
    }
    await assertUpdateRecoveryAdmission({ env });
    const missingGit = await describeUnavailableMacosSystemGit(runCommandWithTimeout, {
      timeoutMs: Math.min(10_000, Math.max(1, deadline - Date.now())),
    });
    const install: InstallKind = missingGit
      ? { kind: "package" }
      : await detectInstall(params.runningRoot);
    try {
      const ownership = {
        root: params.runningRoot,
        installKind: install.kind,
        timeoutMs: Math.max(1, deadline - Date.now()),
      };
      await assertGlobalUpdateOwner(ownership);
      if (missingGit) {
        await assertMacosGitForUnownedCheckout(ownership, { missingGit });
      }
    } catch (error) {
      if (error instanceof SystemPackageOwnershipError || error instanceof UpdatePreMutationError) {
        return await fail(error.reason, error.message);
      }
      throw error;
    }
    // Releases left by an earlier update; never on the critical path.
    void collectReleases(prefix).catch(() => undefined);
    staging = await allocateStaging({ kind: install.kind }, prefix);
    let target;
    try {
      target = await resolveTarget({
        kind: install.kind,
        channel: params.channel,
        checkout: install.checkout,
        tag: params.tag,
        sha: params.sha,
        timeoutMs: Math.max(1, deadline - Date.now()),
        archiveWorkspace: staging.path,
      });
    } catch (error) {
      return await fail("no-target", `No update target: ${formatErrorMessage(error)}`);
    }
    const frontend = params.tag?.startsWith("file:")
      ? await resolveInstalledPackageFrontend(path.resolve(params.tag.slice(5)))
      : undefined;
    await recordUpdateRunPhaseAsync(
      params.runId,
      "staging",
      {
        target: {
          kind: install.kind,
          version: target.version,
          ...(target.kind === "git" ? { sha: target.sha } : {}),
        },
      },
      { env },
    );
    if (
      target.kind === "package" &&
      isPackageTargetAlreadyCurrent({
        currentVersion: params.runningVersion,
        targetVersion: target.version,
        target: target.spec,
      })
    ) {
      return await current(target.version);
    }
    // The serving build decides, not the checkout HEAD: a pull without a rebuild still runs the
    // old code. An unknown build commit prepares a release.
    const loaded = target.kind === "git" ? resolveLoadedCommitHash() : null;
    if (target.kind === "git" && loaded && gitCommitPrefixesMatch(loaded, target.sha)) {
      return await current(target.version);
    }
    // System-level services can keep their definition: both package entry points already
    // forward through this marker. Refuse an unwritable global package before preparing.
    if (
      install.kind === "package" &&
      !params.runningRoot.startsWith(path.join(prefix, "releases") + path.sep)
    ) {
      const marker = path.join(params.runningRoot, ".openclaw-launcher");
      try {
        const exists = await fs.stat(marker).catch((error: unknown) => {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          return null;
        });
        await fs.access(exists ? marker : params.runningRoot, fsConstants.W_OK);
      } catch {
        return await fail(
          "package-not-writable",
          `The global package at ${params.runningRoot} is not writable. Update it as its owning user.`,
        );
      }
    }
    const releaseAwareGit =
      target.kind !== "git" ||
      (await gitTargetSupportsReleaseUpdates(
        target.checkout,
        target.sha,
        Math.max(1, deadline - Date.now()),
      ));
    const checked = await preflight({
      kind: install.kind,
      target,
      prefix,
      stateDir: resolveStateDir(env),
      node,
      env,
    });
    if (!checked.ok) {
      return await fail(checked.reason, checked.message);
    }
    if (target.kind === "git" && !releaseAwareGit) {
      return await fail(
        "release-updates-unsupported",
        `This commit predates release updates. In your OpenClaw Git checkout, run: git checkout ${target.sha} && pnpm install --frozen-lockfile && pnpm build && pnpm ui:build. The current version is still running.`,
      );
    }
    const onStep = async (name: string, status: "in_progress" | "completed") => {
      await recordUpdateRunStepAsync(
        params.runId,
        {
          step: `prepare:${name}`,
          status,
          ...(status === "in_progress" ? { startedAtMs: Date.now() } : { endedAtMs: Date.now() }),
        },
        { env },
      );
    };
    const prepared: PrepareResult =
      target.kind === "git"
        ? await prepareGit({
            checkout: target.checkout,
            sha: target.sha,
            staging: staging.path,
            node,
            timeoutMs: Math.max(1, deadline - Date.now()),
            onStep,
          })
        : await preparePackage({
            spec: target.spec,
            archivePath: target.archivePath,
            staging: staging.path,
            npm:
              isBunRuntime(node) || (node === process.execPath && process.versions.bun)
                ? resolveNpmCommand([])
                : [npmBesideNode(node)],
            node,
            timeoutMs: Math.max(1, deadline - Date.now()),
            env,
            onStep,
          });
    if (!prepared.ok) {
      return await fail(
        prepared.reason,
        "The new version could not be built. The current version is still running.",
        prepared.stderrTail,
      );
    }
    // An explicit artifact can be rebuilt at the same version: only the same known build
    // identity is current. Missing identity is not equality.
    if (
      target.kind === "package" &&
      prepared.buildId &&
      prepared.version === params.runningVersion &&
      prepared.buildId === (await readBuiltGatewayBuildId(params.runningRoot))
    ) {
      return await current(prepared.version);
    }
    await recordUpdateRunPhaseAsync(params.runId, "validating", {}, { env });
    // Missing modules identify an unsupported old target; command failures never bypass checks.
    if (target.kind === "package") {
      const modules = await fs.readdir(path.join(prepared.releaseRoot, "dist"));
      if (
        !["check-release", "gateway-trial"].every((name) =>
          modules.some((file) => new RegExp(`^${name}(?:-[\\w-]+)?\\.m?js$`).test(file)),
        )
      ) {
        return await fail(
          "release-updates-unsupported",
          `This version predates release updates. To install it manually, run: npm i -g ${JSON.stringify(`openclaw@${target.version}`)}. The current version is still running.`,
        );
      }
    }
    const verdict = await runCheckRelease(prepared.releaseRoot, node, env);
    if (!verdict.ok) {
      return await fail(
        "release-check-failed",
        `The new version failed its checks: ${verdict.reason ?? "unknown"}. The current version is still running.`,
        verdict.detail,
      );
    }
    if (verdict.reason) {
      // Existing database diagnostic details are persisted and shown by every
      // shared update report consumer, including while preparation continues.
      await recordUpdateRunStepAsync(
        params.runId,
        {
          step: "diagnostic:database migration writes (preflight)",
          status: "completed",
          detail: verdict.reason,
        },
        { env },
      );
    }
    const releaseRoot = await publishStaging(staging);
    staging = undefined;
    if (target.kind === "git") {
      // The worktree was registered at its staging path; record where it now lives.
      const repaired = await runCommandWithTimeout(
        ["git", "-C", target.checkout, "worktree", "repair", releaseRoot],
        { timeoutMs: 30_000 },
      );
      if (repaired.code !== 0) {
        return await fail(
          "release-registration-failed",
          "The new version could not be registered with Git. The current version is still running.",
          repaired.stderr,
        );
      }
    }
    const launcher = await writeLauncher(prefix);
    // Forwarded commands run `prefix/openclaw` until the launcher switches it, so it must
    // serve the running tree: created on the first conversion, repointed if it is stale.
    const slot = path.join(prefix, "openclaw");
    const served = await fs.realpath(slot).catch(() => null);
    if (served !== (await fs.realpath(params.runningRoot))) {
      await switchLink(path.relative(prefix, params.runningRoot), prefix);
    }
    const previous = await fs.readlink(slot);
    if (
      install.kind === "package" &&
      !params.runningRoot.startsWith(path.join(prefix, "releases") + path.sep)
    ) {
      const warnings: string[] = [];
      await stageReleaseService({
        runningRoot: params.runningRoot,
        launcher,
        env,
        warn: (message) => warnings.push(message),
      });
      if (warnings.length > 0) {
        await recordUpdateRunStepAsync(
          params.runId,
          { step: "service-definition", status: "completed", detail: warnings.join("\n") },
          { env },
        );
      }
    }
    await markForwarding(params.runningRoot, launcher, prefix);
    // Older releases do not have post-ready maintenance. A downgrade does not migrate
    // state forward, so retain their pre-trial maintenance and warning recording.
    if ((compareSemverStrings(VERSION, prepared.version) ?? 0) > 0) {
      const { step } = await runPluginMaintenance({
        root: releaseRoot,
        node,
        env,
        channel: params.channel,
        timeoutMs: Math.max(1, deadline - Date.now()),
        acceptCapabilities: params.acceptCapabilities,
      });
      await recordUpdateRunStepAsync(params.runId, step, { env });
    }
    await createTrialPending(
      {
        runId: params.runId,
        target: path.relative(prefix, releaseRoot),
        previous,
        version: prepared.version,
        buildId: prepared.buildId,
        ...(params.acceptCapabilities !== undefined
          ? { acceptCapabilities: params.acceptCapabilities }
          : {}),
      },
      prefix,
    );
    // Only an admitted global frontend is attached; arbitrary local artifacts stay independent.
    if (frontend) {
      try {
        await markForwarding(frontend.root, launcher, prefix);
      } catch (error) {
        await recordUpdateRunStepAsync(
          params.runId,
          {
            step: "forwarding",
            status: "failed",
            detail: `The npm entry could not be attached to the resident launcher: ${formatErrorMessage(error)}. It remains a separate CLI.`,
          },
          { env },
        );
      }
    }
    await recordUpdateRunPhaseAsync(
      params.runId,
      "activating",
      {
        after: {
          version: prepared.version,
          ...(prepared.buildId ? { buildId: prepared.buildId } : {}),
        },
      },
      { env },
    );
    return { status: "pending", target: { version: prepared.version }, releaseRoot };
  } catch (error) {
    return await fail(
      "update-failed",
      "The update failed before anything changed. The current version is still running.",
      error instanceof Error && error.stack ? error.stack : formatErrorMessage(error),
    );
  } finally {
    if (staging) {
      await fs.rm(staging.path, { recursive: true, force: true }).catch(() => undefined);
    }
    await releaseUpdateLock(prefix).catch(() => undefined);
  }
}

/**
 * Leaves the marker `release-launcher-forward.mjs` reads, so entry points written for the
 * running tree (service definitions, PATH shims) start the launcher. Never inside a release.
 */
export async function markForwarding(runningRoot: string, launcher: string, prefix: string) {
  if (runningRoot.startsWith(path.join(prefix, "releases") + path.sep)) {
    return;
  }
  // A main working tree keeps the marker inside `.git`; a linked worktree's `.git` is a file,
  // so it and package trees use the root-level marker the forwarder also reads.
  const gitDir = await fs.stat(path.join(runningRoot, ".git")).catch(() => null);
  const marker = gitDir?.isDirectory()
    ? path.join(runningRoot, ".git", "openclaw-launcher")
    : path.join(runningRoot, ".openclaw-launcher");
  await fs.writeFile(marker, `${launcher}\n`);
}

function npmBesideNode(node: string): string {
  return path.join(path.dirname(node), process.platform === "win32" ? "npm.cmd" : "npm");
}

/** The new code judges itself, at the path it will serve from. */
async function runCheckRelease(releaseRoot: string, node: string, env: NodeJS.ProcessEnv) {
  const result = await runReleaseCommand(
    releaseRoot,
    node,
    env,
    ["check-release", "--json"],
    CHECK_RELEASE_TIMEOUT_MS,
  );
  // SAFETY: the child is this release's own `update check-release --json`, which writes checkRelease's result.
  const parsed = result.parsed as Awaited<ReturnType<typeof checkRelease>> | undefined;
  if (!parsed) {
    return {
      ok: false,
      reason: result.code === null ? "timed out" : `exited ${result.code}`,
      detail: result.stderr,
    };
  }
  const failed = parsed.surfaces.filter((surface) => surface.error);
  return {
    ok: parsed.ok && result.code === 0,
    reason: parsed.reason,
    detail: failed.map((s) => `${s.plugin}/${s.surface}: ${s.error}`).join("\n") || result.stderr,
  };
}

/**
 * Plugins follow the core that will serve, so that core's own code maintains them. A plugin
 * problem, or a release without `update plugins`, is a recorded warning, never a failed update.
 */
export async function runPluginMaintenance(params: {
  root: string;
  node: string;
  env: NodeJS.ProcessEnv;
  channel: UpdateChannel;
  timeoutMs: number;
  acceptCapabilities?: boolean;
}): Promise<{ plugins: PostCorePluginUpdateResult | undefined; step: UpdateRunStep }> {
  const startedAtMs = Date.now();
  const args = [
    "plugins",
    "--json",
    "--channel",
    params.channel,
    "--timeout",
    String(Math.max(1, Math.ceil(params.timeoutMs / 1000))),
    ...(params.acceptCapabilities ? ["--accept-capabilities"] : []),
  ];
  const result = await runReleaseCommand(
    params.root,
    params.node,
    params.env,
    args,
    params.timeoutMs,
  );
  // SAFETY: the child is this release's own `update plugins --json`, which writes updatePluginsAfterCoreUpdate's result.
  const plugins = result.parsed as PostCorePluginUpdateResult | undefined;
  if (plugins) {
    // A later convergence repair supersedes an earlier failure for the same plugin.
    plugins.npm.outcomes = [
      ...new Map(plugins.npm.outcomes.map((outcome) => [outcome.pluginId, outcome])).values(),
    ];
  }
  const failures = plugins?.npm.outcomes.filter((outcome) => outcome.status === "error") ?? [];
  // Plugin failures are warnings for the core update, but remain failed plugin steps.
  const failed =
    result.code !== 0 ||
    !plugins ||
    plugins.status === "error" ||
    plugins.sync.errors.length > 0 ||
    failures.length > 0;
  const messages = plugins
    ? [
        ...(plugins.warnings ?? []).map((warning) => warning.message),
        ...plugins.sync.warnings,
        ...plugins.sync.errors,
        ...failures.map((outcome) => outcome.message),
        ...(plugins.reason ? [plugins.reason] : []),
      ]
    : [];
  if (failed && messages.length === 0) {
    // The CLI's failure renderer owns this prefix; earlier stderr may be runtime warnings.
    const reasonPrefix = "[openclaw] Reason: ";
    const reason = stripAnsi(result.stderr)
      .split(/\r?\n/u)
      .find((line) => line.startsWith(reasonPrefix))
      ?.slice(reasonPrefix.length);
    messages.push(
      reason ||
        result.stderr.trim() ||
        (result.code === null ? "timed out" : `exited ${result.code}`),
    );
  }
  if (failed && !plugins?.warnings?.some((warning) => warning.guidance.length > 0)) {
    const ids = failures.map((outcome) => outcome.pluginId).join(" ");
    messages.push(`Run \`openclaw plugins update ${ids || "--all"}\` to retry.`);
  }
  return {
    plugins,
    step: {
      step: "plugins",
      status: failed ? "failed" : "completed",
      startedAtMs,
      endedAtMs: Date.now(),
      ...(messages.length > 0 ? { detail: messages.join("\n") } : {}),
    },
  };
}

/** Runs one of the release's own `openclaw update` subcommands; its JSON is the last stdout line. */
async function runReleaseCommand(
  root: string,
  node: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeoutMs: number,
) {
  // The child is not a launcher child, whatever this process is.
  const childEnv = { ...env };
  delete childEnv.OPENCLAW_LAUNCHER_IPC;
  // The process owner ends the whole tree (npm and its children too) and waits for it at timeout.
  const result = await runCommandWithTimeout(
    [node, path.join(root, "openclaw.mjs"), "update", ...args],
    { cwd: root, baseEnv: childEnv, timeoutMs, killProcessTree: true },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    parsed = undefined;
  }
  return {
    code: result.termination === "exit" ? result.code : null,
    parsed,
    stderr: result.stderr.slice(-8192),
  };
}
