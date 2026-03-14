import { formatCliCommand } from "../../cli/command-format.js";

export function formatElevatedUnavailableMessage(params: {
  runtimeSandboxed: boolean;
  failures: Array<{ gate: string; key: string }>;
  sessionKey?: string;
}): string {
  const lines: string[] = [];
  const layer = params.runtimeSandboxed ? "policy + sandbox" : "policy";
  lines.push(
    `blocked by ${layer}: elevated host exec is not available in this session (runtime=${params.runtimeSandboxed ? "sandboxed" : "direct"}).`,
  );
  if (params.failures.length > 0) {
    lines.push(`Failing gates: ${params.failures.map((f) => `${f.gate} (${f.key})`).join(", ")}`);
  } else {
    lines.push(
      "Failing gates: enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled), allowFrom (tools.elevated.allowFrom.<provider>).",
    );
  }
  lines.push("Next:");
  lines.push(
    params.runtimeSandboxed
      ? "- Stay in workspace tools (memory/... or /workspace/memory/...) or route host/admin work to Morpheus or Cipher."
      : "- Check session/channel policy or approval state, then retry.",
  );
  lines.push("Retryable: yes, after the failing gate changes.");
  lines.push("Fix-it keys:");
  lines.push("- tools.elevated.enabled");
  lines.push("- tools.elevated.allowFrom.<provider>");
  lines.push("- agents.list[].tools.elevated.enabled");
  lines.push("- agents.list[].tools.elevated.allowFrom.<provider>");
  if (params.sessionKey) {
    lines.push(
      `See: ${formatCliCommand(`openclaw sandbox explain --session ${params.sessionKey}`)}`,
    );
  }
  return lines.join("\n");
}
