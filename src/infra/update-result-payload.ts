import type { UpdateRunRecord } from "./update-run-record.js";

// Deliberately excludes arbitrary SemVer prereleases, metadata, refs, and build IDs.
const PUBLIC_VERSION =
  /^202[0-9]\.(?:[1-9]|1[0-2])\.(?:0|[1-9][0-9]{0,5})(?:-[1-9][0-9]{0,2})?(?:-beta\.[1-9][0-9]{0,2})?$/;
function publicVersion(value: string | null | undefined): string {
  return value && PUBLIC_VERSION.exec(value)?.[0] === value ? value : "unknown";
}
function allowed<T extends string>(value: unknown, values: readonly T[]): T | "unknown" {
  return values.find((entry) => entry === value) ?? "unknown";
}

/** Closed projection: never spread ledger metadata or inspect diagnostic prose. */
export function buildUpdateResultPayload(
  run: UpdateRunRecord,
  platform: string = process.platform,
  arch: string = process.arch,
) {
  if (run.status === "running" || run.status === "skipped") {
    return undefined;
  }
  const failed = run.status !== "succeeded";
  const step = failed ? run.steps.findLast((entry) => entry.status === "failed") : undefined;
  const code = failed
    ? allowed(step?.failureFacts?.[0]?.code, [
        "EACCES",
        "EPERM",
        "ENOSPC",
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
      ] as const)
    : "none";
  const verification = run.verification;
  const checks = [
    verification.serviceRunning,
    verification.versionMatch,
    verification.readyz,
    verification.channelsReady,
    verification.settled,
  ];
  const duration = run.finishedAtMs === null ? -1 : run.finishedAtMs - run.createdAtMs;
  return {
    schema: 2 as const,
    event: "update_result" as const,
    outcome: run.status,
    fromVersion: publicVersion(run.before.version),
    targetVersion: publicVersion(run.target.version),
    resultingVersion: publicVersion(run.after.version),
    runningVersion: publicVersion(verification.runningVersion),
    platform: allowed(platform, ["linux", "darwin", "win32", "freebsd", "openbsd"] as const),
    arch: allowed(arch, ["x64", "arm64", "arm", "ia32"] as const),
    installMethod: allowed(run.target.installationMethod, [
      "git-checkout",
      "npm-global",
      "pnpm-global",
      "bun-global",
      "managed-service",
    ] as const),
    channel: allowed(run.target.channel, ["stable", "beta", "dev", "extended-stable"] as const),
    duration:
      duration < 0 || !Number.isFinite(duration)
        ? "unknown"
        : duration < 10_000
          ? "under-10s"
          : duration < 60_000
            ? "under-1m"
            : duration < 300_000
              ? "under-5m"
              : duration < 1_800_000
                ? "under-30m"
                : "over-30m",
    postCheck:
      checks.includes(false) || (verification.pluginErrors?.length ?? 0) > 0
        ? "failed"
        : checks.every((check) => check === true) && verification.pluginErrors?.length === 0
          ? "passed"
          : "unknown",
    failedStage: failed
      ? allowed(step?.step, [
          "requested",
          "staging",
          "validating",
          "repairing",
          "activating",
          "restarting",
          "verifying",
        ] as const)
      : "none",
    errorCategory: !failed
      ? "none"
      : code === "EACCES" || code === "EPERM"
        ? "permission"
        : code === "ENOSPC"
          ? "storage"
          : code === "ETIMEDOUT"
            ? "timeout"
            : code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ENOTFOUND"
              ? "network"
              : "other",
    errorCode: code,
    rollback: allowed(verification.rollbackOutcome?.status, [
      "not-needed",
      "not-attempted",
      "succeeded",
      "failed",
    ] as const),
    recovery:
      verification.recovery?.serviceRestartSafe === true
        ? "safe"
        : verification.recovery?.serviceRestartSafe === false
          ? "unsafe"
          : "unknown",
  };
}

export type UpdateResultPayload = NonNullable<ReturnType<typeof buildUpdateResultPayload>>;
