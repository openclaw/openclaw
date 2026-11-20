import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunServingIdentity = {
  version?: string | null;
  buildId?: string | null;
};

/** Project saved failures against the serving process, without rewriting history. */
export function projectUpdateRunHistory(
  run: Pick<UpdateRunRecord, "status" | "reason" | "verification" | "before" | "after"> &
    Partial<Pick<UpdateRunRecord, "target">>,
  serving?: UpdateRunServingIdentity,
): string | null {
  if (run.status !== "failed" || !serving || run.verification.serviceRunning !== true) {
    return null;
  }
  // The installed package can already be ahead of the process serving requests.
  const version = normalizeOptionalString(serving.version);
  const recordedVersion = normalizeOptionalString(run.verification.runningVersion);
  const build = normalizeOptionalString(serving.buildId);
  const recordedBuild = normalizeOptionalString(run.verification.runningBuildId);
  const label = (value: string) => sanitizeTerminalText(value).slice(0, 240);
  let current: string;
  let recorded: string;
  if (version && recordedVersion && version !== recordedVersion) {
    current = label(version);
    recorded = `version was ${label(recordedVersion)}`;
  } else if (build && recordedBuild && build !== recordedBuild) {
    current = `build ${label(build)}`;
    recorded = `build was ${label(recordedBuild)}`;
  } else {
    return null;
  }
  const outcome = `Last update run failed (${label(run.reason?.trim() || "unknown reason")})`;
  // `after` can describe a restored installation. A changed serving process alone
  // makes the observation historical; only a matching candidate identifies the target.
  const rollback = run.verification.rollbackOutcome?.status;
  if (
    (run.reason === "post-update-failed" ||
      run.reason === "version-mismatch" ||
      run.reason === "build-id-mismatch") &&
    !run.verification.recovery?.packageRollbackVerified &&
    rollback !== "succeeded" &&
    rollback !== "failed" &&
    (!run.after.version || run.after.version === version) &&
    (!run.target?.version || run.target.version === version) &&
    (!run.target?.sha || run.target.sha === run.after.sha)
  ) {
    const target = run.after.buildId
      ? build === run.after.buildId &&
        build !== run.before.buildId &&
        build !== recordedBuild &&
        `build ${label(build)}`
      : run.reason !== "build-id-mismatch" &&
        run.target?.kind === "package" &&
        version &&
        run.target.version === version &&
        recordedVersion &&
        recordedVersion !== version &&
        `version ${label(version)}`;
    if (target) {
      return `Gateway is now serving the target ${target}. ${outcome}; recorded serving ${recorded}.`;
    }
  }
  return `${outcome} — Gateway is serving ${current}; recorded serving ${recorded}.`;
}
