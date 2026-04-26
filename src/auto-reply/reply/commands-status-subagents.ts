import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import { resolveSubagentLabel } from "./subagents-utils.js";

export function buildSubagentsStatusLine(params: {
  runs: SubagentRunRecord[];
  verboseEnabled: boolean;
  pendingDescendantsForRun: (entry: SubagentRunRecord) => number;
}): string | undefined {
  const { runs, verboseEnabled, pendingDescendantsForRun } = params;
  if (runs.length === 0) {
    return undefined;
  }
  const active = runs.filter((entry) => !entry.endedAt || pendingDescendantsForRun(entry) > 0);
  const done = runs.length - active.length;
  if (verboseEnabled) {
    const labels = active
      .map((entry) => resolveSubagentLabel(entry, ""))
      .filter(Boolean)
      .slice(0, 3);
    const labelText = labels.length ? ` (${labels.join(", ")})` : "";
    return `🤖 Subagents: ${active.length} active${labelText} · ${done} done`;
  }
  if (active.length > 0) {
    return `🤖 Subagents: ${active.length} active`;
  }
  return undefined;
}
