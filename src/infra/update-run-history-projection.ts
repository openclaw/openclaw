import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunServingIdentity = {
  version?: string | null;
  buildId?: string | null;
};

/** The Inbox needs only the serving identity change, not the detailed report formatter. */
export function resolveUpdateRunServingChange(
  run: Pick<UpdateRunRecord, "status" | "verification">,
  serving?: UpdateRunServingIdentity,
) {
  if (run.status !== "failed" || !serving || run.verification.serviceRunning !== true) {
    return null;
  }
  // The installed package can already be ahead of the process serving requests.
  const version = normalizeOptionalString(serving.version);
  const recordedVersion = normalizeOptionalString(run.verification.runningVersion);
  const build = normalizeOptionalString(serving.buildId);
  const recordedBuild = normalizeOptionalString(run.verification.runningBuildId);
  if (version && recordedVersion && version !== recordedVersion) {
    return { field: "version" as const, version, recordedVersion, build, recordedBuild };
  }
  if (build && recordedBuild && build !== recordedBuild) {
    return { field: "build" as const, version, recordedVersion, build, recordedBuild };
  }
  return null;
}
