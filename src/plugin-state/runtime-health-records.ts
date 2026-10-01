import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import type { PluginStateEntry } from "./plugin-state-store.types.js";

export type RuntimeHealthRecordEnvelope = {
  processId: number;
  processToken: string;
  processStartTime: number | null;
  failedAtMs: number;
};

export type ContextEngineQuarantineRecord = RuntimeHealthRecordEnvelope & {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
};

export type ToolSchemaQuarantineRecord = RuntimeHealthRecordEnvelope & {
  toolName: string;
  owner?: string;
  reason: string;
};

export type RuntimeHealthClearSelection =
  | { kind: "context-engine"; engineId?: string }
  | { kind: "tool-schema"; keys: readonly string[] };

export function hasValidRuntimeHealthEnvelope(
  value: unknown,
): value is Record<string, unknown> & RuntimeHealthRecordEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: every envelope field is checked below before this predicate accepts the value.
  const record = value as Partial<RuntimeHealthRecordEnvelope>;
  return (
    typeof record.processId === "number" &&
    Number.isInteger(record.processId) &&
    record.processId > 0 &&
    typeof record.processToken === "string" &&
    record.processToken.length > 0 &&
    (record.processStartTime === null ||
      (typeof record.processStartTime === "number" &&
        Number.isFinite(record.processStartTime) &&
        record.processStartTime >= 0)) &&
    typeof record.failedAtMs === "number" &&
    Number.isFinite(record.failedAtMs)
  );
}

export function normalizeContextEngineQuarantineRecord(
  value: Record<string, unknown> & RuntimeHealthRecordEnvelope,
): ContextEngineQuarantineRecord | undefined {
  if (
    !hasNonEmptyString(value.engineId) ||
    !hasNonEmptyString(value.operation) ||
    !hasNonEmptyString(value.reason)
  ) {
    return undefined;
  }
  return {
    engineId: value.engineId,
    operation: value.operation,
    reason: value.reason,
    failedAtMs: value.failedAtMs,
    processId: value.processId,
    processToken: value.processToken,
    processStartTime: value.processStartTime,
    ...(hasNonEmptyString(value.owner) ? { owner: value.owner } : {}),
  };
}

export function normalizeToolSchemaQuarantineRecord(
  value: Record<string, unknown> & RuntimeHealthRecordEnvelope,
): ToolSchemaQuarantineRecord | undefined {
  if (!hasNonEmptyString(value.toolName) || !hasNonEmptyString(value.reason)) {
    return undefined;
  }
  return {
    toolName: value.toolName,
    reason: value.reason,
    failedAtMs: value.failedAtMs,
    processId: value.processId,
    processToken: value.processToken,
    processStartTime: value.processStartTime,
    ...(hasNonEmptyString(value.owner) ? { owner: value.owner } : {}),
  };
}

export function runtimeToolSchemaIdentityKey(identity: {
  toolName: string;
  owner?: string;
}): string {
  return JSON.stringify([identity.owner ?? "", identity.toolName]);
}

export function selectRuntimeHealthClearKeys(
  entries: readonly PluginStateEntry<unknown>[],
  processId: number,
  selection: RuntimeHealthClearSelection,
): string[] {
  const toolKeys = new Set(selection.kind === "tool-schema" ? selection.keys : []);
  return entries.flatMap(({ key, value }) => {
    if (!hasValidRuntimeHealthEnvelope(value) || value.processId !== processId) {
      return [];
    }
    if (selection.kind === "context-engine") {
      const record = normalizeContextEngineQuarantineRecord(value);
      return record && (selection.engineId === undefined || record.engineId === selection.engineId)
        ? [key]
        : [];
    }
    const record = normalizeToolSchemaQuarantineRecord(value);
    return record && toolKeys.has(runtimeToolSchemaIdentityKey(record)) ? [key] : [];
  });
}
