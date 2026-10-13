// Formats guidance when an elevated command cannot run in the current channel.
import { formatCliCommand } from "../../cli/command-format.js";

export function formatElevatedUnavailableMessage(params: {
  runtimeSandboxed: boolean;
  failures: Array<{ gate: string; key: string }>;
  sessionKey?: string;
}): string {
  return [
    `elevated is not available right now (runtime=${params.runtimeSandboxed ? "sandboxed" : "direct"}).`,
    params.failures.length > 0
      ? `Failing gates: ${params.failures.map((f) => `${f.gate} (${f.key})`).join(", ")}`
      : "Failing gates: enabled (tools.elevated.enabled / agents.entries.*.tools.elevated.enabled), allowFrom (tools.elevated.allowFrom.<provider>).",
    "Fix-it keys:",
    "- tools.elevated.enabled",
    "- tools.elevated.allowFrom.<provider>",
    "- agents.entries.*.tools.elevated.enabled",
    "- agents.entries.*.tools.elevated.allowFrom.<provider>",
    ...(params.sessionKey
      ? [`See: ${formatCliCommand(`openclaw sandbox explain --session ${params.sessionKey}`)}`]
      : []),
  ].join("\n");
}
