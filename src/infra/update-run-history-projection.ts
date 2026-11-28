import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunServingIdentity = {
  version?: string | null;
  buildId?: string | null;
};

type ServingDrift = {
  current: string;
  recorded: string;
};

function resolveServingDrift(
  recordedIdentity: UpdateRunServingIdentity,
  serving?: UpdateRunServingIdentity,
): ServingDrift | null {
  if (!serving) {
    return null;
  }
  const version = normalizeOptionalString(serving.version);
  const recordedVersion = normalizeOptionalString(recordedIdentity.version);
  const build = normalizeOptionalString(serving.buildId);
  const recordedBuild = normalizeOptionalString(recordedIdentity.buildId);
  const label = (value: string) => sanitizeTerminalText(value).slice(0, 240);
  if (version && recordedVersion && version !== recordedVersion) {
    return {
      current: label(version),
      recorded: `version was ${label(recordedVersion)}`,
    };
  }
  if (build && recordedBuild && build !== recordedBuild) {
    return {
      current: `build ${label(build)}`,
      recorded: `build was ${label(recordedBuild)}`,
    };
  }
  return null;
}

/** Project saved failures against the serving process, without rewriting history. */
export function projectUpdateRunHistory(
  run: Pick<UpdateRunRecord, "status" | "reason" | "verification">,
  serving?: UpdateRunServingIdentity,
): string | null {
  if (run.status !== "failed" || !serving || run.verification.serviceRunning !== true) {
    return null;
  }
  const drift = resolveServingDrift(
    {
      version: run.verification.runningVersion,
      buildId: run.verification.runningBuildId,
    },
    serving,
  );
  if (!drift) {
    return null;
  }
  const label = (value: string) => sanitizeTerminalText(value).slice(0, 240);
  return `Last update run failed (${label(run.reason?.trim() || "unknown reason")}) — Gateway is serving ${drift.current}; recorded serving ${drift.recorded}.`;
}

/**
 * Project a saved succeeded run as historical when the Gateway is now serving a
 * different version/build (for example, after an external container image redeploy).
 */
export function projectHistoricalSucceededUpdateRun(
  run: Pick<UpdateRunRecord, "status" | "after" | "verification">,
  serving?: UpdateRunServingIdentity,
): string | null {
  if (run.status !== "succeeded" || !serving) {
    return null;
  }
  const drift = resolveServingDrift(
    {
      version: run.verification.runningVersion ?? run.after.version,
      buildId: run.verification.runningBuildId ?? run.after.buildId,
    },
    serving,
  );
  if (!drift) {
    return null;
  }
  return `Historical update run (${drift.recorded}) — Gateway is now serving ${drift.current}.`;
}
