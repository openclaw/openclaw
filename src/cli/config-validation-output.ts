// Canonical invalid-config JSON projection shared by startup and command validation.
import { normalizeConfigIssues } from "../config/issue-format.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { formatCliJsonFailure } from "./failure-output.js";

/** Render one failure document; the caller retains its existing exit and recovery policy. */
export function writeInvalidConfigCliJson(
  runtime: RuntimeEnv,
  snapshot: Pick<ConfigFileSnapshot, "path" | "issues">,
): void {
  writeRuntimeJson(runtime, {
    ...formatCliJsonFailure(`OpenClaw config is invalid: ${shortenHomePath(snapshot.path)}`),
    issues: normalizeConfigIssues(snapshot.issues),
  });
}
