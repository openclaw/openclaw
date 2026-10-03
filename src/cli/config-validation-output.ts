import { configFailureHeading } from "../config/io.invalid-config.js";
import { normalizeConfigIssues } from "../config/issue-format.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { formatCliJsonFailure } from "./failure-output.js";

/** Render one failure document; the caller retains its existing exit and recovery policy. */
export function writeInvalidConfigCliJson(
  runtime: RuntimeEnv,
  snapshot: Pick<ConfigFileSnapshot, "path" | "issues" | "readError">,
): void {
  writeRuntimeJson(runtime, {
    ...formatCliJsonFailure(`${configFailureHeading(snapshot)}: ${shortenHomePath(snapshot.path)}`),
    issues: normalizeConfigIssues(snapshot.issues),
  });
}
