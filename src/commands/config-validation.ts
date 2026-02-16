import type { RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "../cli/command-format.js";
import { type SmartAgentNeoConfig, readConfigFileSnapshot } from "../config/config.js";

export async function requireValidConfigSnapshot(
  runtime: RuntimeEnv,
): Promise<SmartAgentNeoConfig | null> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    const issues =
      snapshot.issues.length > 0
        ? snapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")
        : "Unknown validation issue.";
    runtime.error(`Config invalid:\n${issues}`);
    runtime.error(`Fix the config or run ${formatCliCommand("smart-agent-neo doctor")}.`);
    runtime.exit(1);
    return null;
  }
  return snapshot.config;
}
