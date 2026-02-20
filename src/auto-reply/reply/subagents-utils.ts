import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import { truncateUtf16Safe } from "../../utils.js";

export function resolveSubagentLabel(entry: SubagentRunRecord, fallback = "subagent") {
  const raw = entry.label?.trim() || entry.task?.trim() || "";
  return raw || fallback;
}

export function formatRunLabel(entry: SubagentRunRecord, options?: { maxLength?: number }) {
  const raw = resolveSubagentLabel(entry);
  const maxLength = options?.maxLength ?? 72;
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return raw;
  }
  return raw.length > maxLength ? `${truncateUtf16Safe(raw, maxLength).trimEnd()}…` : raw;
}

export function formatRunStatus(entry: SubagentRunRecord) {
  if (!entry.endedAt) {
    return "running";
  }
  const status = entry.outcome?.status ?? "done";
  return status === "ok" ? "done" : status;
}

export function sortSubagentRuns(runs: SubagentRunRecord[]) {
  return [...runs].toSorted((a, b) => {
    const aTime = a.startedAt ?? a.createdAt ?? 0;
    const bTime = b.startedAt ?? b.createdAt ?? 0;
    return bTime - aTime;
  });
}

export type SubagentTargetResolution = {
  entry?: SubagentRunRecord;
  error?: string;
};

export function resolveSubagentTargetFromRuns(params: {
  runs: SubagentRunRecord[];
  token: string | undefined;
  recentWindowMinutes: number;
  label: (entry: SubagentRunRecord) => string;
  errors: {
    missingTarget: string;
    invalidIndex: (value: string) => string;
    unknownSession: (value: string) => string;
    ambiguousLabel: (value: string) => string;
    ambiguousLabelPrefix: (value: string) => string;
    ambiguousRunIdPrefix: (value: string) => string;
    unknownTarget: (value: string) => string;
  };
}): SubagentTargetResolution {
  const trimmed = params.token?.trim();
  if (!trimmed) {
    return { error: params.errors.missingTarget };
  }
  const sorted = sortSubagentRuns(params.runs);
  if (trimmed === "last") {
    return { entry: sorted[0] };
  }
  const recentCutoff = Date.now() - params.recentWindowMinutes * 60_000;
  const numericOrder = [
    ...sorted.filter((entry) => !entry.endedAt),
    ...sorted.filter((entry) => !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff),
  ];
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(idx) || idx <= 0 || idx > numericOrder.length) {
      return { error: params.errors.invalidIndex(trimmed) };
    }
    return { entry: numericOrder[idx - 1] };
  }
  if (trimmed.includes(":")) {
    const bySessionKey = sorted.find((entry) => entry.childSessionKey === trimmed);
    return bySessionKey
      ? { entry: bySessionKey }
      : { error: params.errors.unknownSession(trimmed) };
  }
  const lowered = trimmed.toLowerCase();
  const byExactLabel = sorted.filter((entry) => params.label(entry).toLowerCase() === lowered);
  if (byExactLabel.length === 1) {
    return { entry: byExactLabel[0] };
  }
  if (byExactLabel.length > 1) {
    return { error: params.errors.ambiguousLabel(trimmed) };
  }
  const byLabelPrefix = sorted.filter((entry) =>
    params.label(entry).toLowerCase().startsWith(lowered),
  );
  if (byLabelPrefix.length === 1) {
    return { entry: byLabelPrefix[0] };
  }
  if (byLabelPrefix.length > 1) {
    return { error: params.errors.ambiguousLabelPrefix(trimmed) };
  }
  const byRunIdPrefix = sorted.filter((entry) => entry.runId.startsWith(trimmed));
  if (byRunIdPrefix.length === 1) {
    return { entry: byRunIdPrefix[0] };
  }
  if (byRunIdPrefix.length > 1) {
    return { error: params.errors.ambiguousRunIdPrefix(trimmed) };
  }
  return { error: params.errors.unknownTarget(trimmed) };
}
