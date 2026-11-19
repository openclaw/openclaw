import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunServingIdentity = {
  version?: string | null;
  buildId?: string | null;
};

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
  const label = (value: string) => sanitizeTerminalText(value).slice(0, 240);
  if (version && recordedVersion && version !== recordedVersion) {
    return { kind: "version", current: label(version), recorded: label(recordedVersion) } as const;
  }
  if (build && recordedBuild && build !== recordedBuild) {
    return { kind: "build", current: label(build), recorded: label(recordedBuild) } as const;
  }
  return null;
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
  const reason = sanitizeTerminalText(run.reason?.trim() || "unknown reason").slice(0, 240);
  const current = change.kind === "build" ? `build ${change.current}` : change.current;
  return `Last update run failed (${reason}) — Gateway is serving ${current}; recorded serving ${change.kind} was ${change.recorded}.`;
}
