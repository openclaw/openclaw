// Computes git, dependency, and registry update status for OpenClaw installs.
import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { createGitCommandError, executeGitCommand } from "./git-exec.js";
import { compareOpenClawReleaseVersions } from "./npm-registry-spec.js";
import { readPackageName } from "./package-json.js";
import { compareValidSemver, normalizeLegacyDotBetaVersion } from "./semver.js";
import {
  channelToNpmTag,
  DEV_BRANCH,
  resolveDevUpstreamRefs,
  selectNpmChannelVersion,
  type UpdateChannel,
} from "./update-channels.js";
import {
  fetchNpmPackageTargetStatus,
  type NpmMetadataCommandRunner,
} from "./update-check-package-target.js";
import { resolveGitRepositoryMetadata, type GitTrackingTarget } from "./update-git-metadata.js";
import { readBuiltRuntimeCommit } from "./update-git-runtime.js";
import { detectGlobalInstallManagerForRoot } from "./update-global.js";
import { updateInstallRootsMatch } from "./update-install-root.js";
import { UPDATE_NETWORK_TIMEOUT_MS } from "./update-network-budget.js";
import { createUpdatePreflightFailure } from "./update-preflight-details.js";
import type { UpdateFetchFailure } from "./update-run-record.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";
import { describeUpdateInstallRoot } from "./update-runner-install-surface.js";

type PackageManager = "pnpm" | "bun" | "npm" | "unknown";
type GitUpdateOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Reports settled local probes without changing updater failure or process-join semantics. */
  onGitProbeTimeout?: (timeoutMs: number) => void;
};

type GitUpdateStatus = {
  root: string;
  sha: string | null;
  tag: string | null;
  branch: string | null;
  upstream: string | null;
  upstreamSource?: "tracking" | "receipt";
  upstreamSha?: string | null;
  repositoryUrl?: string;
  commitAtMs?: number | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  fetchOk: boolean | null;
  builtSha?: string | null;
  countsCached?: true;
  stale?: UpdateFetchFailure;
  error?: string;
};

export type UpdateInstallIdentity = {
  installKind: "git" | "package" | "unknown";
  git?: Pick<GitUpdateStatus, "branch" | "tag" | "error">;
};

type DepsStatus = {
  manager: PackageManager;
  status: "ok" | "missing" | "unknown";
  lockfilePath: string | null;
  markerPath: string | null;
  reason?: string;
};

type RegistryStatus = {
  latestVersion: string | null;
  tag?: string;
  error?: string;
  reason?: ExtendedStableFailureReason;
};

export type ExtendedStableFailureReason =
  | "selector_missing"
  | "selector_query_failed"
  | "exact_package_mismatch"
  | "unsupported_git_channel";

type ExtendedStableResolutionResult =
  | {
      status: "resolved";
      selector: "extended-stable";
      version: string;
      packageSpec: string;
    }
  | {
      status: "failed";
      reason: ExtendedStableFailureReason;
    };

type NpmTagStatus = {
  tag: string;
  version: string | null;
  error?: string;
};

export type UpdateCheckResult = {
  root: string | null;
  installKind: "git" | "package" | "unknown";
  packageManager: PackageManager;
  git?: GitUpdateStatus;
  deps?: DepsStatus;
  registry?: RegistryStatus;
  error?: {
    status: "unknown" | "failed";
    message: string;
    timeoutMs?: number;
    code?: "installation-unclassified";
  };
};

const PUBLIC_NPM_REGISTRY_URL = "https://registry.npmjs.org/";
const PUBLIC_NPM_PACKAGE_NAME = "openclaw";

function isLoopbackNpmRegistry(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function resolveExtendedStableRegistryTarget(params: {
  packageName?: string;
  env?: NodeJS.ProcessEnv;
}): { registryUrl: string; packageName: string } {
  const env = params.env ?? process.env;
  const packageName = params.packageName?.trim() || PUBLIC_NPM_PACKAGE_NAME;
  const packageSpecOverride = env.OPENCLAW_UPDATE_PACKAGE_SPEC?.trim();
  const registryOverride = env.NPM_CONFIG_REGISTRY?.trim() || env.npm_config_registry?.trim() || "";

  // A matching package override plus a loopback registry is the explicit local
  // integration-test seam. Production resolution remains pinned to public npm.
  if (packageSpecOverride === packageName && isLoopbackNpmRegistry(registryOverride)) {
    return { registryUrl: registryOverride, packageName };
  }
  return {
    registryUrl: PUBLIC_NPM_REGISTRY_URL,
    packageName: PUBLIC_NPM_PACKAGE_NAME,
  };
}

/** Resolves the extended-stable selector and verifies its exact package manifest. */
export async function resolveExtendedStablePackage(params: {
  installKind: "git" | "package" | "unknown";
  timeoutMs?: number;
  packageName?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ExtendedStableResolutionResult> {
  if (params.installKind === "git") {
    return { status: "failed", reason: "unsupported_git_channel" };
  }

  const timeoutMs = params.timeoutMs ?? UPDATE_NETWORK_TIMEOUT_MS;
  const registryTarget = resolveExtendedStableRegistryTarget(params);
  const selector = await fetchNpmPackageTargetStatus({
    target: "extended-stable",
    timeoutMs,
    ...registryTarget,
  });
  if (!selector.version) {
    return {
      status: "failed",
      reason: selector.error === "HTTP 404" ? "selector_missing" : "selector_query_failed",
    };
  }

  const exact = await fetchNpmPackageTargetStatus({
    target: selector.version,
    timeoutMs,
    ...registryTarget,
  });
  if (exact.version !== selector.version) {
    return { status: "failed", reason: "exact_package_mismatch" };
  }

  return {
    status: "resolved",
    selector: "extended-stable",
    version: selector.version,
    packageSpec: `${registryTarget.packageName}@${selector.version}`,
  };
}

export function formatGitInstallLabel(update: UpdateCheckResult): string | null {
  if (update.installKind !== "git") {
    return null;
  }
  const shortSha = update.git?.sha ? update.git.sha.slice(0, 8) : null;
  const branch = update.git?.branch && update.git.branch !== "HEAD" ? update.git.branch : null;
  const tag = update.git?.tag ?? null;
  const parts = [
    branch ?? (tag ? "detached" : "git"),
    tag ? `tag ${tag}` : null,
    shortSha ? `@ ${shortSha}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  return (await detectPackageManagerImpl(root)) ?? "unknown";
}

/** Classify installation ownership without reading Git history or dependency state. */
export async function resolveUpdateInstallKind(
  root: string | null,
  options: GitUpdateOptions = {},
): Promise<"git" | "package" | "unknown"> {
  options.signal?.throwIfAborted();
  if (!root) {
    return "unknown";
  }
  const result = await runUpdateGitCommand(root, ["rev-parse", "--show-toplevel"], {
    ...options,
    timeoutMs: options.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS,
  });
  options.signal?.throwIfAborted();
  if (result?.termination === "timeout") {
    // An expired probe does not establish that this root is a package installation.
    throw createGitCommandError("git rev-parse --show-toplevel", result);
  }
  const gitRoot = result?.code === 0 ? result.stdout.trim() : "";
  if (gitRoot && updateInstallRootsMatch(gitRoot, root)) {
    return "git";
  }
  const packageName = await readPackageName(root);
  options.signal?.throwIfAborted();
  return packageName === PUBLIC_NPM_PACKAGE_NAME ? "package" : "unknown";
}

/** Read the install and local Git identity needed to select an update channel. */
export async function resolveUpdateInstallIdentity(params: {
  root: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<UpdateInstallIdentity> {
  const { root, ...options } = params;
  const installKind = await resolveUpdateInstallKind(root, options);
  const git =
    installKind === "git" && root ? await readGitUpdateIdentity(root, options) : undefined;
  options.signal?.throwIfAborted();
  return { installKind, git };
}

async function runUpdateGitCommand(root: string, args: string[], options: GitUpdateOptions) {
  // Keep cancellation non-throwing until parallel probes join. Public discovery
  // boundaries then raise the owner signal without leaving sibling Git processes behind.
  if (options.signal?.aborted) {
    return null;
  }
  const { onGitProbeTimeout, ...commandOptions } = options;
  const result = await executeGitCommand(root, args, {
    ...commandOptions,
    killProcessTree: true,
  }).catch(() => null);
  if (result?.termination === "timeout" && args[0] !== "fetch") {
    onGitProbeTimeout?.(result.timeoutMs);
  }
  return result;
}

async function readGitUpdateIdentity(
  root: string,
  options: GitUpdateOptions = {},
): Promise<NonNullable<UpdateInstallIdentity["git"]>> {
  const [branch, tag] = await Promise.all(
    [
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["describe", "--tags", "--exact-match"],
    ].map((args) =>
      runUpdateGitCommand(root, args, { ...options, timeoutMs: options.timeoutMs ?? 6000 }),
    ),
  );
  return branch?.code === 0
    ? {
        branch: branch.stdout.trim() || null,
        tag: tag?.code === 0 ? tag.stdout.trim() || null : null,
      }
    : { branch: null, tag: null, error: branch?.stderr?.trim() || "git unavailable" };
}

async function checkGitUpdateStatus(params: {
  root: string;
  identity: Promise<NonNullable<UpdateInstallIdentity["git"]>>;
  timeoutMs: number | undefined;
  signal?: AbortSignal;
  onGitProbeTimeout?: GitUpdateOptions["onGitProbeTimeout"];
  fetch?: boolean;
  useDetachedDevUpstream?: boolean;
  upstreamFallback?: { currentSha: string; upstreamRef: string };
}): Promise<GitUpdateStatus> {
  const timeoutMs = params.timeoutMs ?? (params.fetch ? UPDATE_NETWORK_TIMEOUT_MS : 6000);
  const root = path.resolve(params.root);
  const runGit = (...args: string[]) =>
    runUpdateGitCommand(root, args, {
      timeoutMs,
      signal: params.signal,
      onGitProbeTimeout: params.onGitProbeTimeout,
    });
  const readGit = async (...args: string[]) => {
    const result = await runGit(...args);
    return result?.code === 0 ? result.stdout.trim() || null : null;
  };

  const base: GitUpdateStatus = {
    root,
    sha: null,
    tag: null,
    branch: null,
    upstream: null,
    upstreamSha: null,
    commitAtMs: null,
    dirty: null,
    ahead: null,
    behind: null,
    fetchOk: null,
  };
  const [{ branch, tag, error }, sha, commitAtRaw, dirtyRes] = await Promise.all([
    params.identity,
    readGit("rev-parse", "HEAD"),
    readGit("show", "-s", "--format=%ct", "HEAD"),
    runGit("status", "--porcelain", "--", ":!dist/control-ui/"),
  ]);
  if (error) {
    return { ...base, error };
  }
  const trackingRevisions =
    branch === "HEAD"
      ? params.useDetachedDevUpstream
        ? resolveDevUpstreamRefs(true, [`refs/remotes/origin/${DEV_BRANCH}`])
        : []
      : resolveDevUpstreamRefs(false);
  let tracking: GitTrackingTarget | null = null;
  for (const revision of trackingRevisions) {
    const display = await readGit("rev-parse", "--abbrev-ref", "--symbolic-full-name", revision);
    if (!display) {
      continue;
    }
    let fetch: GitTrackingTarget["fetch"] = "prune";
    if (branch === "HEAD") {
      if (revision === `${DEV_BRANCH}@{upstream}`) {
        const [remote, mergeRef] = await Promise.all([
          readGit("config", "--get", `branch.${DEV_BRANCH}.remote`),
          readGit("config", "--get", `branch.${DEV_BRANCH}.merge`),
        ]);
        if (!remote || !mergeRef) {
          continue;
        }
        fetch = { remote, mergeRef };
      } else {
        fetch = { remote: "origin", mergeRef: `refs/heads/${DEV_BRANCH}` };
      }
    }
    tracking = { revision, display, fetch };
    break;
  }

  const commitAtSeconds = Number.parseInt(commitAtRaw ?? "", 10);
  const commitAtMs = Number.isSafeInteger(commitAtSeconds) ? commitAtSeconds * 1000 : null;

  const receiptUpstream =
    !tracking &&
    branch === "HEAD" &&
    sha &&
    params.upstreamFallback?.currentSha.trim().toLowerCase() === sha.toLowerCase()
      ? params.upstreamFallback.upstreamRef.trim() || null
      : null;
  const upstream = tracking?.display ?? receiptUpstream;
  const upstreamSource = tracking
    ? ("tracking" as const)
    : receiptUpstream
      ? ("receipt" as const)
      : undefined;

  const dirty = dirtyRes && dirtyRes.code === 0 ? dirtyRes.stdout.trim().length > 0 : null;

  const fetchTarget =
    tracking?.fetch && tracking.fetch !== "prune"
      ? [
          "--",
          tracking.fetch.remote,
          `+${tracking.fetch.mergeRef}:refs/remotes/${tracking.display}`,
        ]
      : ["--prune"];
  const fetchOk = params.fetch
    ? (await runGit("fetch", "--quiet", ...fetchTarget))?.code === 0
    : null;

  // Freeze the post-fetch upstream for both graph queries. Active tracking wins;
  // a matching successful update receipt keeps intentional detached installs comparable.
  const upstreamRevision = `${upstreamSource === "tracking" ? tracking?.revision : upstream}^{commit}`;
  const upstreamCommit =
    (!params.fetch || fetchOk === true) && upstream && sha
      ? await readGit("rev-parse", "--verify", upstreamRevision)
      : null;
  const mergeBase = sha && upstreamCommit ? await readGit("merge-base", sha, upstreamCommit) : null;
  const counts =
    sha && upstreamCommit && mergeBase
      ? await readGit("rev-list", "--left-right", "--count", `${sha}...${upstreamCommit}`)
      : null;

  const parsed = counts?.match(/^(\d+)\s+(\d+)$/u);

  return {
    root,
    sha,
    tag,
    branch,
    upstream,
    ...(upstreamSource ? { upstreamSource } : {}),
    upstreamSha: upstreamCommit,
    ...(await resolveGitRepositoryMetadata(readGit, tracking, branch)),
    commitAtMs,
    dirty,
    ahead: parsed ? Number(parsed[1]) : null,
    behind: parsed ? Number(parsed[2]) : null,
    fetchOk,
    builtSha: await readBuiltRuntimeCommit(root),
  };
}

async function resolveDepsMarker(params: { root: string; manager: PackageManager }): Promise<{
  lockfilePath: string | null;
  markerPath: string | null;
}> {
  const root = params.root;
  if (params.manager === "pnpm") {
    return {
      lockfilePath: path.join(root, "pnpm-lock.yaml"),
      markerPath: path.join(root, "node_modules", ".modules.yaml"),
    };
  }
  if (params.manager === "bun") {
    const textLockfilePath = path.join(root, "bun.lock");
    return {
      lockfilePath: (await exists(textLockfilePath))
        ? textLockfilePath
        : path.join(root, "bun.lockb"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  if (params.manager === "npm") {
    return {
      lockfilePath: path.join(root, "package-lock.json"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  return { lockfilePath: null, markerPath: null };
}

async function checkDepsStatus(params: {
  root: string;
  manager: PackageManager;
}): Promise<DepsStatus> {
  const root = path.resolve(params.root);
  const { lockfilePath, markerPath } = await resolveDepsMarker({
    root,
    manager: params.manager,
  });
  const paths = { manager: params.manager, lockfilePath, markerPath };

  if (!lockfilePath || !markerPath) {
    return {
      ...paths,
      status: "unknown",
      reason: "unknown package manager",
    };
  }

  const lockExists = await exists(lockfilePath);
  const markerExists = await exists(markerPath);
  if (!lockExists) {
    return {
      ...paths,
      status: "unknown",
      reason: "lockfile missing",
    };
  }
  if (!markerExists) {
    return {
      ...paths,
      status: "missing",
      reason: "node_modules marker missing",
    };
  }

  return {
    ...paths,
    status: "ok",
  };
}

async function fetchNpmLatestVersion(params?: {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
}): Promise<RegistryStatus> {
  const res = await fetchNpmTagVersion({
    ...params,
    tag: "latest",
  });
  return {
    latestVersion: res.version,
    error: res.error,
  };
}

async function fetchNpmRegistryVersionForChannel(params: {
  channel: UpdateChannel;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
}): Promise<RegistryStatus> {
  const res = await resolveNpmChannelTag(params);
  return {
    latestVersion: res.version,
    tag: res.tag,
    error: res.error,
    ...(res.reason ? { error: res.reason, reason: res.reason } : {}),
  };
}

export async function fetchNpmTagVersion(params: {
  tag: string;
  timeoutMs?: number;
  spec?: string;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
}): Promise<NpmTagStatus> {
  const { tag, ...options } = params;
  const res = await fetchNpmPackageTargetStatus({
    ...options,
    target: tag,
  });
  return {
    tag,
    version: res.version,
    error: res.error,
  };
}

export async function resolveNpmChannelTag(params: {
  channel: UpdateChannel;
  timeoutMs?: number;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
}): Promise<NpmTagStatus & { reason?: ExtendedStableFailureReason }> {
  const { channel, ...options } = params;
  const channelTag = channelToNpmTag(channel);
  if (channel === "extended-stable") {
    const resolved = await resolveExtendedStablePackage({
      installKind: "package",
      timeoutMs: params.timeoutMs,
    });
    return resolved.status === "resolved"
      ? { tag: resolved.selector, version: resolved.version }
      : { tag: channelTag, version: null, reason: resolved.reason };
  }
  const fetchTag = (tag: string) =>
    fetchNpmTagVersion({
      ...options,
      tag,
    });
  if (channel !== "beta") {
    return await fetchTag(channelTag);
  }

  const [channelStatus, latestStatus] = await Promise.all([
    fetchTag(channelTag),
    fetchTag("latest"),
  ]);
  return selectNpmChannelVersion(channelStatus, latestStatus);
}

export function compareSemverStrings(a: string | null, b: string | null): number | null {
  if (a && b) {
    const openClawReleaseCmp = compareOpenClawReleaseVersions(a, b);
    if (openClawReleaseCmp != null) {
      return openClawReleaseCmp;
    }
  }
  const normalizedA = a ? normalizeLegacyDotBetaVersion(a) : null;
  const normalizedB = b ? normalizeLegacyDotBetaVersion(b) : null;
  return normalizedA && normalizedB ? compareValidSemver(normalizedA, normalizedB) : null;
}

export async function checkUpdateStatus(params: {
  root: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  onGitProbeTimeout?: GitUpdateOptions["onGitProbeTimeout"];
  fetchGit?: boolean;
  useDetachedDevUpstream?: boolean;
  gitUpstreamFallback?: { currentSha: string; upstreamRef: string };
  includeRegistry?: boolean;
  registryChannel?: UpdateChannel;
  resolveRegistryChannel?: (status: UpdateInstallIdentity) => UpdateChannel;
}): Promise<UpdateCheckResult> {
  params.signal?.throwIfAborted();
  const timeoutMs = params.timeoutMs ?? UPDATE_NETWORK_TIMEOUT_MS;
  const resolveRegistryChannel = (status: UpdateInstallIdentity) =>
    params.registryChannel ?? params.resolveRegistryChannel?.(status);
  const fetchRegistry = (registryChannel: UpdateChannel | undefined) =>
    registryChannel
      ? fetchNpmRegistryVersionForChannel({
          channel: registryChannel,
          timeoutMs,
        })
      : fetchNpmLatestVersion({ timeoutMs });
  const root = params.root ? path.resolve(params.root) : null;
  if (!root) {
    const registryChannel = resolveRegistryChannel({ installKind: "unknown" });
    const registry = params.includeRegistry ? await fetchRegistry(registryChannel) : undefined;
    params.signal?.throwIfAborted();
    return {
      root: null,
      installKind: "unknown",
      packageManager: "unknown",
      registry,
    };
  }

  const installKind = await resolveUpdateInstallKind(root, {
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    onGitProbeTimeout: params.onGitProbeTimeout,
  });
  const isGit = installKind === "git";
  if (installKind === "unknown") {
    const failure = createUpdatePreflightFailure(
      "installation-unclassified",
      `${await describeUpdateInstallRoot(root)} Service unit target: not inspected by update status installation checks; run openclaw gateway status --deep.`,
    );
    params.signal?.throwIfAborted();
    return {
      root,
      installKind,
      packageManager: "unknown",
      error: { status: "unknown", code: "installation-unclassified", message: failure.message },
    };
  }
  const packageManager = isGit
    ? await detectPackageManager(root)
    : ((await detectGlobalInstallManagerForRoot(
        async (argv, options) => {
          params.signal?.throwIfAborted();
          return runCommandWithTimeout(argv, {
            ...options,
            signal: params.signal,
            killProcessTree: true,
          });
        },
        root,
        timeoutMs,
      )) ?? "unknown");
  params.signal?.throwIfAborted();

  // Start all local Git reads together; only registry selection needs to wait
  // for branch/tag identity, independently of worktree and remote freshness.
  const identity = isGit
    ? readGitUpdateIdentity(root, {
        timeoutMs: params.timeoutMs ?? (params.fetchGit ? UPDATE_NETWORK_TIMEOUT_MS : 6000),
        signal: params.signal,
        onGitProbeTimeout: params.onGitProbeTimeout,
      })
    : undefined;
  const registryPromise = Promise.resolve(identity).then((git) => {
    if (params.signal?.aborted) {
      return undefined;
    }
    const registryChannel = resolveRegistryChannel({ installKind, git });
    return params.includeRegistry
      ? registryChannel === "extended-stable" && isGit
        ? {
            latestVersion: null,
            tag: "extended-stable",
            error: "unsupported_git_channel",
            reason: "unsupported_git_channel" as const,
          }
        : fetchRegistry(registryChannel)
      : undefined;
  });
  const [git, deps, registry] = await Promise.all([
    identity
      ? checkGitUpdateStatus({
          root,
          identity,
          timeoutMs: params.timeoutMs,
          signal: params.signal,
          onGitProbeTimeout: params.onGitProbeTimeout,
          fetch: Boolean(params.fetchGit),
          useDetachedDevUpstream: params.useDetachedDevUpstream,
          upstreamFallback: params.gitUpstreamFallback,
        })
      : Promise.resolve(undefined),
    checkDepsStatus({ root, manager: packageManager }),
    registryPromise,
  ]);

  params.signal?.throwIfAborted();

  return {
    root,
    installKind,
    packageManager,
    git,
    deps,
    registry,
  };
}
