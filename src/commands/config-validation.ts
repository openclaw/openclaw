import type { RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "../cli/command-format.js";
import { type OpenClawConfig, readConfigFileSnapshot } from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";

export async function requireValidConfigSnapshot(
  runtime: RuntimeEnv,
): Promise<OpenClawConfig | null> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    const issues =
      snapshot.issues.length > 0
        ? formatConfigIssueLines(snapshot.issues, "-").join("\n")
        : "Unknown validation issue.";
    runtime.error(`Config invalid:\n${issues}`);
    runtime.error(`Fix the config or run ${formatCliCommand("openclaw doctor")}.`);
    runtime.exit(1);
    return null;
  }
  return snapshot.config;
}
