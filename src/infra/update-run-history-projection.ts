import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunServingIdentity = {
  version?: string | null;
  buildId?: string | null;
};

/** Project saved failures against the serving process, without rewriting history. */
export function projectUpdateRunHistory(
  run: Pick<UpdateRunRecord, "status" | "reason" | "before">,
  serving?: UpdateRunServingIdentity,
): string | null {
  if (run.status !== "failed" || !serving) {
    return null;
  }
  const version = normalizeOptionalString(serving.version);
  const beforeVersion = normalizeOptionalString(run.before.version);
  const build = normalizeOptionalString(serving.buildId);
  const beforeBuild = normalizeOptionalString(run.before.buildId);
  const label = (value: string) => sanitizeTerminalText(value).slice(0, 240);
  let current: string;
  let starting: string;
  if (version && beforeVersion && version !== beforeVersion) {
    current = label(version);
    starting = `version was ${label(beforeVersion)}`;
  } else if (build && beforeBuild && build !== beforeBuild) {
    current = `build ${label(build)}`;
    starting = `build was ${label(beforeBuild)}`;
  } else {
    return null;
  }
  return `Last update run failed (${label(run.reason?.trim() || "unknown reason")}) — Gateway is serving ${current}; recorded starting ${starting}.`;
}
