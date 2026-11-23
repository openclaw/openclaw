import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunServingIdentity = {
  version?: string | null;
  buildId?: string | null;
};

function servingLabel(value: string): string {
  return sanitizeTerminalText(value).slice(0, 240);
}

export function resolveUpdateRunServingChange(
  verification: UpdateRunRecord["verification"],
  serving?: UpdateRunServingIdentity,
) {
  if (!serving || verification.serviceRunning !== true) {
    return null;
  }
  // The installed package can already be ahead of the process serving requests.
  const version = normalizeOptionalString(serving.version);
  const recordedVersion = normalizeOptionalString(verification.runningVersion);
  const build = normalizeOptionalString(serving.buildId);
  const recordedBuild = normalizeOptionalString(verification.runningBuildId);
  const versionChanged = version && recordedVersion && version !== recordedVersion;
  const current = versionChanged ? version : build;
  const recorded = versionChanged ? recordedVersion : recordedBuild;
  if (!current || !recorded || current === recorded) {
    return null;
  }
  return {
    kind: versionChanged ? "version" : "build",
    current: servingLabel(current),
    recorded: servingLabel(recorded),
  } as const;
}

/** Project saved failures against the serving process, without rewriting history. */
export function projectUpdateRunHistory(
  run: Pick<UpdateRunRecord, "status" | "reason" | "verification">,
  serving?: UpdateRunServingIdentity,
): string | null {
  const change =
    run.status === "failed" ? resolveUpdateRunServingChange(run.verification, serving) : null;
  if (!change) {
    return null;
  }
  const reason = servingLabel(run.reason?.trim() || "unknown reason");
  const current = change.kind === "build" ? `build ${change.current}` : change.current;
  return `Last update run failed (${reason}) — Gateway is serving ${current}; recorded serving ${change.kind} was ${change.recorded}.`;
}
