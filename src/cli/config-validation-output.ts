import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  configFailureHeading,
  formatInvalidConfigDetails,
  isConfigReadFailure,
} from "../config/io.invalid-config.js";
import { normalizeConfigIssues } from "../config/issue-format.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { formatCliJsonFailure } from "./failure-output.js";

/** An unavailable read cannot establish whether authored settings need repair. */
export function formatConfigReadFailureForCli(
  snapshot: Pick<ConfigFileSnapshot, "path" | "issues" | "readError">,
): string | undefined {
  if (!isConfigReadFailure(snapshot)) {
    return undefined;
  }
  return [
    `${configFailureHeading(snapshot)}: ${sanitizeTerminalText(shortenHomePath(snapshot.path))}`,
    formatInvalidConfigDetails(snapshot.issues),
    "Resolve the read error shown above, then retry.",
  ].join("\n");
}

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
