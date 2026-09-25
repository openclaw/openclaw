// Narrow only rendered fields and tolerate additive fields across Gateway restarts.
// Schema-parity tests enforce required strings without loading TypeBox at startup.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isNonEmptyProtocolString } from "../../../packages/gateway-protocol/src/protocol-value-normalization.js";
import type { GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";

function isBoundedInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

// Match the protocol's commit cap even when a producer sends excess entries.
const MAX_COMMITS = 5;

export function readUpdateAvailable(hello: GatewayHelloOk | null): UpdateAvailable | null {
  const snapshot = hello?.snapshot;
  if (!isRecord(snapshot)) {
    return null;
  }
  return readUpdateAvailableValue(snapshot.updateAvailable);
}

export function readUpdateAvailableValue(update: unknown): UpdateAvailable | null {
  if (
    !isRecord(update) ||
    !isNonEmptyProtocolString(update.currentVersion) ||
    !isNonEmptyProtocolString(update.latestVersion) ||
    !isNonEmptyProtocolString(update.channel)
  ) {
    return null;
  }
  // Drop malformed entries individually. String.length cannot enforce the
  // protocol's grapheme limit for subjects containing emoji or combining marks.
  const rawCommits = update.commits;
  const commits = Array.isArray(rawCommits)
    ? rawCommits
        .filter(
          (commit): commit is { sha: string; subject: string } =>
            isRecord(commit) &&
            isNonEmptyProtocolString(commit.sha) &&
            typeof commit.subject === "string",
        )
        .map((commit) => ({ sha: commit.sha, subject: commit.subject }))
        .slice(0, MAX_COMMITS)
    : undefined;
  return {
    currentVersion: update.currentVersion,
    latestVersion: update.latestVersion,
    channel: update.channel,
    ...(isNonEmptyProtocolString(update.currentSha) ? { currentSha: update.currentSha } : {}),
    ...(isNonEmptyProtocolString(update.upstreamRef) ? { upstreamRef: update.upstreamRef } : {}),
    ...(isNonEmptyProtocolString(update.upstreamSha) ? { upstreamSha: update.upstreamSha } : {}),
    ...(isNonEmptyProtocolString(update.repositoryUrl)
      ? { repositoryUrl: update.repositoryUrl }
      : {}),
    ...(isBoundedInteger(update.commitsBehind, 0) ? { commitsBehind: update.commitsBehind } : {}),
    ...(commits?.length ? { commits } : {}),
  };
}

function readScheduleTarget(value: unknown): UpdateScheduleState["target"] | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "package") {
    return isNonEmptyProtocolString(value.version)
      ? { kind: "package", version: value.version }
      : null;
  }
  if (value.kind === "git") {
    return isNonEmptyProtocolString(value.upstreamRef) &&
      isNonEmptyProtocolString(value.upstreamSha) &&
      isBoundedInteger(value.commitsBehind, 0)
      ? {
          kind: "git",
          upstreamRef: value.upstreamRef,
          upstreamSha: value.upstreamSha,
          commitsBehind: value.commitsBehind,
        }
      : null;
  }
  return null;
}

/** Optional install metadata: a malformed entry is dropped, never fatal to the status. */
function readGitInstallMetadata(value: Record<string, unknown>): {
  currentSha?: string;
  upstreamSha?: string;
  repositoryUrl?: string;
  commitAtMs?: number;
  installedAtMs?: number;
} {
  return {
    ...(isNonEmptyProtocolString(value.currentSha) ? { currentSha: value.currentSha } : {}),
    ...(isNonEmptyProtocolString(value.upstreamSha) ? { upstreamSha: value.upstreamSha } : {}),
    ...(isNonEmptyProtocolString(value.repositoryUrl)
      ? { repositoryUrl: value.repositoryUrl }
      : {}),
    ...(isBoundedInteger(value.commitAtMs, 0) ? { commitAtMs: value.commitAtMs } : {}),
    ...(isBoundedInteger(value.installedAtMs, 0) ? { installedAtMs: value.installedAtMs } : {}),
  };
}

function readGitUpdateStatus(
  value: unknown,
): NonNullable<NonNullable<UpdateScheduleState["install"]>["git"]> | null {
  if (!isRecord(value)) {
    return null;
  }
  const metadata = readGitInstallMetadata(value);
  if (value.status === "current") {
    return { ...metadata, status: "current" };
  }
  if (value.status === "behind" && isBoundedInteger(value.commitsBehind, 1)) {
    return { ...metadata, status: "behind", commitsBehind: value.commitsBehind };
  }
  if (value.status === "ahead" && isBoundedInteger(value.commitsAhead, 1)) {
    return { ...metadata, status: "ahead", commitsAhead: value.commitsAhead };
  }
  if (
    value.status === "diverged" &&
    isBoundedInteger(value.commitsAhead, 1) &&
    isBoundedInteger(value.commitsBehind, 1)
  ) {
    return {
      ...metadata,
      status: "diverged",
      commitsAhead: value.commitsAhead,
      commitsBehind: value.commitsBehind,
    };
  }
  if (
    value.status === "unavailable" &&
    (value.reason === "fetch-failed" ||
      value.reason === "no-upstream" ||
      value.reason === "no-upstream-sha" ||
      value.reason === "comparison-failed" ||
      value.reason === "git-unavailable")
  ) {
    return { ...metadata, status: "unavailable", reason: value.reason };
  }
  return null;
}

function readScheduleCampaign(value: unknown): UpdateScheduleState["campaign"] | null {
  if (
    !isRecord(value) ||
    !isNonEmptyProtocolString(value.id) ||
    (value.state !== "waiting-for-idle" &&
      value.state !== "countdown" &&
      value.state !== "applying") ||
    !isBoundedInteger(value.announcedAtMs, 0) ||
    !isBoundedInteger(value.forceAtMs, 0) ||
    !isBoundedInteger(value.updatedAtMs, 0)
  ) {
    return null;
  }
  return {
    id: value.id,
    state: value.state,
    announcedAtMs: value.announcedAtMs,
    ...(isBoundedInteger(value.applyAtMs, 0) ? { applyAtMs: value.applyAtMs } : {}),
    ...(isBoundedInteger(value.holdUntilMs, 0) ? { holdUntilMs: value.holdUntilMs } : {}),
    forceAtMs: value.forceAtMs,
    updatedAtMs: value.updatedAtMs,
  };
}

export function readUpdateScheduleValue(value: unknown): UpdateScheduleState | null {
  if (
    !isRecord(value) ||
    !isNonEmptyProtocolString(value.channel) ||
    typeof value.autoEnabled !== "boolean"
  ) {
    return null;
  }
  const rawInstall = isRecord(value.install) ? value.install : null;
  const rawInstallKind = rawInstall?.kind;
  const installKind =
    rawInstallKind === "package" || rawInstallKind === "git" || rawInstallKind === "unknown"
      ? rawInstallKind
      : undefined;
  if (value.install !== undefined && installKind === undefined) {
    return null;
  }
  const gitStatus = rawInstall?.git === undefined ? undefined : readGitUpdateStatus(rawInstall.git);
  if (rawInstall?.git !== undefined && !gitStatus) {
    return null;
  }
  const target = value.target === undefined ? undefined : readScheduleTarget(value.target);
  const campaign = value.campaign === undefined ? undefined : readScheduleCampaign(value.campaign);
  if ((value.target !== undefined && !target) || (value.campaign !== undefined && !campaign)) {
    return null;
  }
  return {
    channel: value.channel,
    autoEnabled: value.autoEnabled,
    ...(installKind
      ? { install: { kind: installKind, ...(gitStatus ? { git: gitStatus } : {}) } }
      : {}),
    ...(target ? { target } : {}),
    ...(campaign ? { campaign } : {}),
  };
}

export function readUpdateSchedule(hello: GatewayHelloOk | null): UpdateScheduleState | null {
  const snapshot = hello?.snapshot;
  if (!isRecord(snapshot)) {
    return null;
  }
  return readUpdateScheduleValue(snapshot.updateSchedule);
}
