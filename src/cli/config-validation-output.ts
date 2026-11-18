import { configFailureHeading } from "../config/io.invalid-config.js";
import { normalizeConfigIssues } from "../config/issue-format.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { formatInvalidConfigRepairHint } from "./config-recovery-hints.js";
import { formatCliJsonFailure } from "./failure-output.js";

/** Render one failure document; the caller retains its existing exit and recovery policy. */
export function writeInvalidConfigCliJson(
  runtime: RuntimeEnv,
  snapshot: Pick<
    ConfigFileSnapshot,
    "path" | "valid" | "issues" | "warnings" | "legacyIssues" | "readError"
  >,
): void {
  writeRuntimeJson(runtime, {
    ...formatCliJsonFailure(`${configFailureHeading(snapshot)}: ${shortenHomePath(snapshot.path)}`),
    repairHint: formatInvalidConfigRepairHint(snapshot, "to repair, then retry."),
    issues: normalizeConfigIssues(snapshot.issues),
  });
}
