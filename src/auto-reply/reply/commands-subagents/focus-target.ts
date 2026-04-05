import { looksLikeSessionId } from "../../../sessions/session-id.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";
import { countPendingDescendantRunsFromRuns } from "../../../agents/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";

export type FocusTargetResolution = {
  targetKind: "subagent" | "acp";
  targetSessionKey: string;
  agentId: string;
  label?: string;
};

function formatRunLabel(entry: SubagentRunRecord) {
  const raw = entry.label?.trim() || entry.task?.trim() || "";
  return raw || "subagent";
}

function sortSubagentRuns(runs: SubagentRunRecord[]) {
  return [...runs].toSorted((a, b) => {
    const aTime = a.startedAt ?? a.createdAt ?? 0;
    const bTime = b.startedAt ?? b.createdAt ?? 0;
    return bTime - aTime;
  });
}

function resolveSubagentTarget(
  runs: SubagentRunRecord[],
  token: string | undefined,
): SubagentRunRecord | undefined {
  const trimmed = token?.trim();
  if (!trimmed) {
    return undefined;
  }
  const runsMap = new Map(runs.map((entry) => [entry.runId, entry] as const));
  const recentWindowMs = 30 * 60_000;
  const recentCutoff = Date.now() - recentWindowMs;
  const sorted = sortSubagentRuns(runs);
  const deduped: SubagentRunRecord[] = [];
  const seenChildSessionKeys = new Set<string>();
  for (const entry of sorted) {
    if (seenChildSessionKeys.has(entry.childSessionKey)) {
      continue;
    }
    seenChildSessionKeys.add(entry.childSessionKey);
    deduped.push(entry);
  }
  const isActive = (entry: SubagentRunRecord) =>
    !entry.endedAt || countPendingDescendantRunsFromRuns(runsMap, entry.childSessionKey) > 0;
  const numericOrder = [
    ...deduped.filter((entry) => isActive(entry)),
    ...deduped.filter(
      (entry) => !isActive(entry) && !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff,
    ),
  ];
  if (trimmed === "last") {
    return deduped[0];
  }
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10);
    return Number.isFinite(idx) && idx > 0 && idx <= numericOrder.length
      ? numericOrder[idx - 1]
      : undefined;
  }
  if (trimmed.includes(":")) {
    return deduped.find((entry) => entry.childSessionKey === trimmed);
  }
  const lowered = trimmed.toLowerCase();
  return deduped.find((entry) => formatRunLabel(entry).toLowerCase() === lowered)
    ?? deduped.find((entry) => formatRunLabel(entry).toLowerCase().startsWith(lowered))
    ?? deduped.find((entry) => entry.runId.startsWith(trimmed));
}

export async function resolveFocusTargetSession(params: {
  runs: SubagentRunRecord[];
  token: string;
}): Promise<FocusTargetResolution | null> {
  const subagentMatch = resolveSubagentTarget(params.runs, params.token);
  if (subagentMatch) {
    const key = subagentMatch.childSessionKey;
    const parsed = parseAgentSessionKey(key);
    return {
      targetKind: "subagent",
      targetSessionKey: key,
      agentId: parsed?.agentId ?? "main",
      label: formatRunLabel(subagentMatch),
    };
  }

  const token = params.token.trim();
  if (!token) {
    return null;
  }

  const attempts: Array<Record<string, string>> = [];
  attempts.push({ key: token });
  if (looksLikeSessionId(token)) {
    attempts.push({ sessionId: token });
  }
  attempts.push({ label: token });
  const { callGateway } = await import("../../../gateway/call.js");

  for (const attempt of attempts) {
    try {
      const resolved = await callGateway<{ key?: string }>({
        method: "sessions.resolve",
        params: attempt,
      });
      const key = typeof resolved?.key === "string" ? resolved.key.trim() : "";
      if (!key) {
        continue;
      }
      const parsed = parseAgentSessionKey(key);
      return {
        targetKind: key.includes(":subagent:") ? "subagent" : "acp",
        targetSessionKey: key,
        agentId: parsed?.agentId ?? "main",
        label: token,
      };
    } catch {
      continue;
    }
  }

  return null;
}
