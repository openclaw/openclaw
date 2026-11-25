import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunServingIdentity = {
  version?: string | null;
  buildId?: string | null;
};

/** Project saved failures against the serving process, without rewriting history. */
export function projectUpdateRunHistory(
  run: Pick<UpdateRunRecord, "status" | "reason" | "verification">,
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
  return `Last update run failed (${label(run.reason?.trim() || "unknown reason")}) — Gateway is serving ${current}; recorded serving ${recorded}.`;
}
