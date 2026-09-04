import fs from "node:fs/promises";
import path from "node:path";
import { runGlobalPackageUpdateSteps } from "../../infra/package-update-steps.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import {
  DEV_BRANCH,
  resolveDevUpstreamRefs,
  type UpdateChannel,
} from "../../infra/update-channels.js";
import {
  resolveDevUpdateTargetRevision,
  type DevUpdateTarget,
} from "../../infra/update-dev-target.js";
import {
  createGlobalInstallEnv,
  verifyPackageUpdateRecovery,
  resolveGlobalInstallTarget,
  resolveNpmLifecyclePolicyGate,
} from "../../infra/update-global.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import {
  readBranchName,
  readGitTargetSchemaVersions,
  selectChannelTag,
} from "../../infra/update-runner-git-target.js";
import type { CommandRunner as UpdateRunnerCommandRunner } from "../../infra/update-runner-types.js";
import { runGatewayUpdate, type UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { splitShellArgs } from "../../utils/shell-argv.js";
import { createUpdateProgress } from "./progress.js";
import {
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
  type TargetDatabaseSchemaContext,
} from "./schema-preflight.js";
import {
  createGlobalCommandRunner,
  DEFAULT_PACKAGE_NAME,
  ensureGitCheckout,
  readPackageName,
  resolveGitInstallDir,
  resolveGlobalManager,
  runUpdateStep,
  UpdatePreMutationError,
} from "./shared.js";
import {
  resolvePreparedGatewayUpdatePolicy,
  type PreManagedServiceStop,
} from "./update-command-service.js";

const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;

export async function retireStandaloneGitWrapper(params: {
  previousRoot: string;
  platform?: NodeJS.Platform;
  searchDirs?: readonly string[];
}): Promise<{ error?: string }> {
  const platform = params.platform ?? process.platform;
  const wrapperName = platform === "win32" ? "openclaw.cmd" : "openclaw";
  const searchDirs = params.searchDirs ?? (process.env.PATH ?? "").split(path.delimiter);
  const expectedEntry =
    platform === "win32"
      ? path.win32.join(params.previousRoot, "dist", "entry.js")
      : path.join(params.previousRoot, "dist", "entry.js");
  const seen = new Set<string>();

  for (const directory of searchDirs) {
    if (!directory) {
      continue;
    }
    const wrapperPath = path.resolve(directory, wrapperName);
    if (seen.has(wrapperPath)) {
      continue;
    }
    seen.add(wrapperPath);

    let stat;
    try {
      stat = await fs.lstat(wrapperPath);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      return { error: `Could not inspect ${wrapperPath}: ${String(error)}` };
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (platform !== "win32" && (stat.mode & 0o111) === 0)
    ) {
      continue;
    }

    let contents: string;
    try {
      contents = await fs.readFile(wrapperPath, "utf8");
    } catch (error) {
      return { error: `Could not inspect ${wrapperPath}: ${String(error)}` };
    }
    const lines = contents.trimEnd().split(/\r?\n/u);
    const matchesWindows =
      platform === "win32" &&
      lines.length === 2 &&
      lines[0] === "@echo off" &&
      lines[1] === `node "${expectedEntry}" %*`;
    const execArgs =
      platform === "win32" || lines.length !== 3 ? null : splitShellArgs(lines[2] ?? "");
    const matchesPosix =
      platform !== "win32" &&
      lines[0] === "#!/usr/bin/env bash" &&
      lines[1] === "set -euo pipefail" &&
      execArgs?.length === 4 &&
      execArgs[0] === "exec" &&
      execArgs[2] === expectedEntry &&
      execArgs[3] === "$@";
    if (!matchesWindows && !matchesPosix) {
      continue;
    }
    try {
      await fs.unlink(wrapperPath);
    } catch (error) {
      return { error: `Could not retire ${wrapperPath}: ${String(error)}` };
    }
  }
  return {};
}

type BeforeGitMutation = (target: {
  schemaVersions?: OpenClawSchemaVersions;
  metadataUnreadable?: string;
}) => Promise<{
  allowGatewayServiceRepair?: boolean;
  allowGatewayActivation?: boolean;
} | void>;

async function runReadOnlyGitCommand(params: {
  runCommand: ReturnType<typeof createGlobalCommandRunner>;
  root: string;
  timeoutMs: number;
  args: string[];
}) {
  return params
    .runCommand(["git", "-C", params.root, ...params.args], {
      cwd: params.root,
      timeoutMs: params.timeoutMs,
    })
    .catch(() => null);
}

type RemoteRevisionResolution =
  | { status: "ok"; revision: string }
  | { status: "missing" }
  | { status: "unreadable"; reason: string };

async function listGitRemotes(params: {
  runCommand: ReturnType<typeof createGlobalCommandRunner>;
  root: string;
  timeoutMs: number;
}): Promise<{ remotes?: string[]; metadataUnreadable?: string }> {
  const result = await runReadOnlyGitCommand({ ...params, args: ["remote"] });
  if (result?.code !== 0) {
    return { metadataUnreadable: "could not inspect configured Git remotes" };
  }
  return {
    remotes: result.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

async function resolveCurrentRemoteBranchRevision(params: {
  runCommand: ReturnType<typeof createGlobalCommandRunner>;
  root: string;
  timeoutMs: number;
  candidate: string;
}): Promise<RemoteRevisionResolution> {
  const tracking = await runReadOnlyGitCommand({
    ...params,
    args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", params.candidate],
  });
  const trackingRef = tracking?.code === 0 ? tracking.stdout.trim() : "";
  if (!trackingRef) {
    return { status: "missing" };
  }
  const remoteList = await listGitRemotes(params);
  if (remoteList.metadataUnreadable) {
    return { status: "unreadable", reason: remoteList.metadataUnreadable };
  }
  const remote = (remoteList.remotes ?? [])
    .toSorted((left, right) => right.length - left.length)
    .find((value) => trackingRef.startsWith(`${value}/`));
  if (!remote) {
    return {
      status: "unreadable",
      reason: `could not resolve remote ownership for ${params.candidate}`,
    };
  }
  const branch = trackingRef.slice(remote.length + 1);
  const remoteRef = `refs/heads/${branch}`;
  const remoteResult = await runReadOnlyGitCommand({
    ...params,
    args: ["ls-remote", "--exit-code", remote, remoteRef],
  });
  const remoteRevision =
    remoteResult?.code === 0 ? readExactRemoteRevision(remoteResult.stdout, remoteRef) : null;
  if (!remoteRevision) {
    return {
      status: "unreadable",
      reason: `could not inspect current remote target ${remote}/${branch}`,
    };
  }
  const local = await runReadOnlyGitCommand({
    ...params,
    args: ["rev-parse", params.candidate],
  });
  const localRevision = local?.code === 0 ? local.stdout.trim() : "";
  return localRevision === remoteRevision
    ? { status: "ok", revision: remoteRevision }
    : {
        status: "unreadable",
        reason: `current remote target ${remote}/${branch} is not available in the local checkout`,
      };
}

function readExactRemoteRevision(stdout: string, ref: string): string | null {
  const matches = stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts.length === 2 && parts[1] === ref)
    .map((parts) => parts[0] ?? "")
    .filter((sha) => /^[0-9a-f]{40,64}$/iu.test(sha));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function readRemoteTagRevisions(stdout: string): Map<string, string> | null {
  const direct = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [sha = "", ref = "", extra] = line.trim().split(/\s+/u);
    if (extra || !/^[0-9a-f]{40,64}$/iu.test(sha)) {
      if (line.trim()) {
        return null;
      }
      continue;
    }
    const match = /^refs\/tags\/(v.+?)(\^\{\})?$/u.exec(ref);
    if (!match) {
      if (line.trim()) {
        return null;
      }
      continue;
    }
    const tag = match[1];
    if (!tag) {
      return null;
    }
    (match[2] ? peeled : direct).set(tag, sha);
  }
  return new Map(
    [...new Set([...direct.keys(), ...peeled.keys()])].map((tag) => [
      tag,
      peeled.get(tag) ?? direct.get(tag)!,
    ]),
  );
}

async function resolveCurrentRemoteTagRevision(params: {
  runCommand: ReturnType<typeof createGlobalCommandRunner>;
  root: string;
  timeoutMs: number;
  channel: Exclude<UpdateChannel, "dev" | "extended-stable">;
}): Promise<{ revision?: string; metadataUnreadable?: string }> {
  const remoteList = await listGitRemotes(params);
  if (remoteList.metadataUnreadable) {
    return { metadataUnreadable: remoteList.metadataUnreadable };
  }
  const remotes = remoteList.remotes ?? [];
  if (remotes.length === 0) {
    return { metadataUnreadable: "could not resolve a remote for the selected Git release" };
  }
  const tagRevisions = new Map<string, string>();
  for (const remote of remotes) {
    const result = await runReadOnlyGitCommand({
      ...params,
      args: ["ls-remote", "--tags", remote, "refs/tags/v*"],
    });
    const remoteTags = result?.code === 0 ? readRemoteTagRevisions(result.stdout) : null;
    if (!remoteTags) {
      return { metadataUnreadable: `could not inspect current release tags from ${remote}` };
    }
    for (const [tag, revision] of remoteTags) {
      const existing = tagRevisions.get(tag);
      if (existing && existing !== revision) {
        return { metadataUnreadable: `release tag ${tag} resolves differently across remotes` };
      }
      tagRevisions.set(tag, revision);
    }
  }
  const tag = selectChannelTag([...tagRevisions.keys()], params.channel);
  return tag
    ? { revision: tagRevisions.get(tag) }
    : { metadataUnreadable: "could not resolve the selected Git release tag" };
}

export async function inspectGitDryRunTargetSchemaVersions(params: {
  root: string;
  timeoutMs: number;
  channel: UpdateChannel;
  devTarget?: DevUpdateTarget;
}): Promise<{ schemaVersions?: OpenClawSchemaVersions; metadataUnreadable?: string }> {
  const runCommand = createGlobalCommandRunner();
  const runTargetCommand: UpdateRunnerCommandRunner = (argv, options) =>
    runCommand(argv, { ...options, timeoutMs: options.timeoutMs ?? params.timeoutMs });
  let revision: string | null = null;
  if (params.channel === "extended-stable") {
    return { metadataUnreadable: "extended-stable is unavailable for Git updates" };
  }
  if (params.channel !== "dev") {
    const resolved = await resolveCurrentRemoteTagRevision({
      runCommand,
      root: params.root,
      timeoutMs: params.timeoutMs,
      channel: params.channel,
    });
    if (resolved.metadataUnreadable) {
      return { metadataUnreadable: resolved.metadataUnreadable };
    }
    revision = resolved.revision ?? null;
  } else if (params.devTarget) {
    const selected = resolveDevUpdateTargetRevision(params.devTarget);
    if (!/^[0-9a-f]{40,64}$/iu.test(selected)) {
      return { metadataUnreadable: "the explicit symbolic Git target requires a fetch to verify" };
    }
    revision = selected;
  } else {
    const branch = await readBranchName(runTargetCommand, params.root, params.timeoutMs);
    const needsCheckoutMain = branch !== DEV_BRANCH;
    let remoteBranchRefs: string[] = [];
    if (needsCheckoutMain) {
      const remoteResult = await runCommand(["git", "-C", params.root, "remote"], {
        cwd: params.root,
        timeoutMs: params.timeoutMs,
      }).catch(() => null);
      if (remoteResult?.code === 0) {
        remoteBranchRefs = remoteResult.stdout
          .split("\n")
          .map((remote) => remote.trim())
          .filter(Boolean)
          .map((remote) => `refs/remotes/${remote}/${DEV_BRANCH}`);
      }
    }
    for (const candidate of resolveDevUpstreamRefs(needsCheckoutMain, remoteBranchRefs)) {
      const resolved = await resolveCurrentRemoteBranchRevision({
        runCommand,
        root: params.root,
        timeoutMs: params.timeoutMs,
        candidate,
      });
      if (resolved.status === "ok") {
        revision = resolved.revision;
        break;
      }
      if (resolved.status === "unreadable") {
        return { metadataUnreadable: resolved.reason };
      }
    }
  }
  if (!revision) {
    return { metadataUnreadable: "could not resolve the selected Git target" };
  }
  const target = await readGitTargetSchemaVersions({
    runCommand: runTargetCommand,
    root: params.root,
    revision,
    timeoutMs: params.timeoutMs,
  });
  return target.status === "ok"
    ? target.schemaVersions
      ? { schemaVersions: target.schemaVersions }
      : {}
    : { metadataUnreadable: target.reason };
}

export function createBeforeGitMutation(params: {
  roots: readonly string[];
  shouldRestart: boolean;
  stopManagedService: (roots: readonly string[]) => Promise<void>;
  getPreManagedServiceStop: () => PreManagedServiceStop | undefined;
  getDatabaseSchemaContexts: () => readonly TargetDatabaseSchemaContext[];
  recaptureFinalDatabaseSchemaContexts: () => Promise<void>;
  prepareMutableUpdate: () => Promise<void>;
  switchToGit: boolean;
}): BeforeGitMutation {
  return async (target) => {
    if (target?.metadataUnreadable) {
      throw new UpdatePreMutationError(
        "target-metadata-preflight",
        `Update refused: could not inspect the target's schema support (${target.metadataUnreadable}). Retry, or see ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
      );
    }
    const preStopSchemas = checkTargetDatabaseSchemasForContexts(
      target?.schemaVersions,
      params.getDatabaseSchemaContexts(),
    );
    if (hasSchemaRefusal(preStopSchemas)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        formatSchemaRefusalLines(preStopSchemas).join("\n"),
      );
    }
    await params.stopManagedService(params.roots);
    await params.recaptureFinalDatabaseSchemaContexts();
    const preManagedServiceStop = params.getPreManagedServiceStop();
    const postStopSchemas = checkTargetDatabaseSchemasForContexts(
      target?.schemaVersions,
      params.getDatabaseSchemaContexts(),
    );
    if (hasSchemaRefusal(postStopSchemas)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        formatSchemaRefusalLines(postStopSchemas).join("\n"),
      );
    }
    await params.prepareMutableUpdate();
    // Git's deferred prepare phase owns the task suspension. Once mutation
    // starts, only a verified recovery may re-enable persistent autostart.
    preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
    // A candidate checkout cannot own the service until its global exposure
    // succeeds. Finalization refreshes and activates the verified installation.
    return params.switchToGit
      ? { allowGatewayServiceRepair: false, allowGatewayActivation: false }
      : resolvePreparedGatewayUpdatePolicy(preManagedServiceStop, params.shouldRestart);
  };
}

export async function updateGitInstall(params: {
  root: string;
  switchToGit: boolean;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number | undefined;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  channel: UpdateChannel;
  tag: string;
  devTarget?: DevUpdateTarget;
  beforeGitMutation?: BeforeGitMutation;
  allowGatewayServiceRepair: boolean;
  allowGatewayActivation: boolean;
}): Promise<UpdateRunResult> {
  let updateRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
  const effectiveTimeout = params.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
  const installEnv = await createGlobalInstallEnv();
  const runCommand = createGlobalCommandRunner();
  const installTarget = params.switchToGit
    ? await resolveGlobalInstallTarget({
        manager: await resolveGlobalManager({
          root: params.root,
          installKind: params.installKind,
          timeoutMs: effectiveTimeout,
        }),
        runCommand,
        timeoutMs: effectiveTimeout,
        pkgRoot: params.root,
      })
    : null;
  const npmLifecycleGate = installTarget
    ? resolveNpmLifecyclePolicyGate(installTarget)
    : { policy: null, error: null };

  // Package-to-Git updates must settle package-manager policy before cloning or
  // updating the checkout; carry this exact decision into the later install.
  if (npmLifecycleGate.error) {
    defaultRuntime.error(npmLifecycleGate.error);
    return {
      status: "error",
      mode: "git",
      root: params.root,
      reason: "npm lifecycle policy preflight",
      recovery: await (params.installKind === "git"
        ? readCurrentGitUpdateRecovery(params.root)
        : verifyPackageUpdateRecovery(params.root)),
      steps: [],
      durationMs: Date.now() - params.startedAt,
    };
  }

  const checkout = params.switchToGit
    ? await ensureGitCheckout({
        dir: updateRoot,
        env: installEnv,
        timeoutMs: effectiveTimeout,
        progress: params.progress,
      })
    : null;
  const cloneStep = checkout?.step ?? null;
  updateRoot = checkout?.checkoutDir ?? updateRoot;

  if (cloneStep && cloneStep.exitCode !== 0) {
    return {
      status: "error",
      mode: "git",
      root: params.root,
      reason: cloneStep.name,
      recovery: await (params.installKind === "git"
        ? readCurrentGitUpdateRecovery(params.root)
        : verifyPackageUpdateRecovery(params.root)),
      steps: [cloneStep],
      durationMs: Date.now() - params.startedAt,
    };
  }

  const updateResult = await runGatewayUpdate({
    cwd: updateRoot,
    argv1: params.switchToGit ? undefined : process.argv[1],
    timeoutMs: params.timeoutMs,
    progress: params.progress,
    channel: params.channel,
    tag: params.tag,
    devTarget: params.devTarget,
    deferConfiguredPluginInstallRepair: true,
    allowGatewayServiceRepair: params.allowGatewayServiceRepair,
    allowGatewayActivation: params.allowGatewayActivation,
    beforeGitMutation: params.beforeGitMutation,
  });
  const steps = [...(cloneStep ? [cloneStep] : []), ...updateResult.steps];

  if (params.switchToGit && updateResult.status === "ok") {
    if (!installTarget) {
      throw new Error("global install target missing after package-to-Git preflight");
    }
    const packageName =
      (await readPackageName(installTarget.packageRoot ?? params.root)) ?? DEFAULT_PACKAGE_NAME;
    const packageUpdate = await runGlobalPackageUpdateSteps({
      installTarget,
      installSpec: updateRoot,
      packageName,
      packageRoot: installTarget.packageRoot,
      runCommand,
      runStep: (stepParams) => runUpdateStep({ ...stepParams, progress: params.progress }),
      timeoutMs: effectiveTimeout,
      env: installEnv,
      installCwd: updateRoot,
      // ensureGitCheckout already resolved the root; only the successful Git
      // build/doctor flow can authorize exposing that exact checkout globally.
      expectedGitCheckout: { root: updateRoot, sha: updateResult.after?.sha ?? null },
    });
    steps.push(...packageUpdate.steps);

    return {
      ...updateResult,
      status: packageUpdate.failedStep ? "error" : "ok",
      reason: packageUpdate.failedStep?.name,
      recovery: packageUpdate.recovery,
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
