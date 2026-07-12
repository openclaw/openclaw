import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TrajectoryEvent } from "../trajectory/types.js";
import type {
  CapabilityName,
  EvidenceRecord,
  EvidenceState,
  MutationRisk,
  ToolFact,
} from "./capability-projection-model.js";

export type SafeCompiledContext = {
  ts: string;
  seq: number;
  sessionId: string;
  sessionKey: string;
  runId: string | null;
  toolNames: string[];
};

export type SafeExistingToolResult = {
  ts: string;
  runId: string;
  toolName: string;
  success: true;
};

export type ExactTurnSelection =
  | { mode: "exact_run_id"; runId: string }
  | { mode: "exact_event_sequence"; sequence: number }
  | { mode: "latest_in_window"; start: string; end: string };

export type TrajectoryCollection = {
  compiled: SafeCompiledContext | null;
  successfulToolResults: SafeExistingToolResult[];
  errorCode?:
    | "MISSING_SESSION_PROJECTION"
    | "AMBIGUOUS_SESSION_PROJECTION"
    | "EVIDENCE_COLLECTION_FAILED";
};

type ExpectedTrajectoryContext = {
  sessionId: string;
  sessionKey: string;
  evidenceWindow: { start: string; end: string };
};

const MAX_TRAJECTORY_BYTES = 50 * 1024 * 1024;

const BASE_TOOL_CATALOG: Array<{
  capability: CapabilityName;
  name: string;
  mutationRisk: MutationRisk;
}> = [
  { capability: "goal_tools", name: "create_goal", mutationRisk: "mutating" },
  { capability: "goal_tools", name: "get_goal", mutationRisk: "read_only" },
  { capability: "goal_tools", name: "update_goal", mutationRisk: "mutating" },
  { capability: "llm_task", name: "llm_task", mutationRisk: "mutating" },
  { capability: "task_flow", name: "task_flow_list", mutationRisk: "read_only" },
  { capability: "task_flow", name: "task_flow_show", mutationRisk: "read_only" },
  { capability: "task_flow", name: "task_flow_cancel", mutationRisk: "mutating" },
  { capability: "commitments", name: "commitments_list", mutationRisk: "read_only" },
  { capability: "commitments", name: "commitments_dismiss", mutationRisk: "mutating" },
  { capability: "browser", name: "browser", mutationRisk: "mutating" },
  { capability: "memory", name: "memory_get", mutationRisk: "privacy_sensitive_read" },
  { capability: "memory", name: "memory_search", mutationRisk: "privacy_sensitive_read" },
  { capability: "messaging", name: "message", mutationRisk: "mutating" },
  { capability: "shell_execution", name: "exec", mutationRisk: "mutating" },
  { capability: "shell_execution", name: "process", mutationRisk: "mutating" },
  { capability: "readiness_health", name: "readiness_health", mutationRisk: "read_only" },
];

export function classifyCapabilityToolName(
  name: string,
): { capability: CapabilityName; mutationRisk: MutationRisk } | null {
  if (name.startsWith("workboard_")) {
    return {
      capability: "workboard",
      mutationRisk: /(?:list|get|read|search|status)/u.test(name) ? "read_only" : "mutating",
    };
  }
  if (name.startsWith("llm_task")) {
    return { capability: "llm_task", mutationRisk: "mutating" };
  }
  if (name.startsWith("hook")) {
    return { capability: "hooks", mutationRisk: "unknown" };
  }
  if (name === "Bash" || name === "shell" || name.startsWith("exec")) {
    return { capability: "shell_execution", mutationRisk: "mutating" };
  }
  if (name === "gateway_health" || name === "readiness_canary") {
    return { capability: "readiness_health", mutationRisk: "read_only" };
  }
  return BASE_TOOL_CATALOG.find((entry) => entry.name === name) ?? null;
}

function state(
  value: EvidenceState["value"],
  basis: EvidenceState["basis"],
  evidenceRefs: string[],
): EvidenceState {
  return { value, basis, evidenceRefs: [...new Set(evidenceRefs)].sort() };
}

function booleanField(fields: EvidenceRecord["fields"], name: string): boolean | null {
  const value = fields[name];
  return typeof value === "boolean" ? value : null;
}

function stringArrayField(fields: EvidenceRecord["fields"], name: string): string[] {
  const value = fields[name];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

/** Builds tool facts only from already-sanitized, closed evidence records. */
export function collectToolFactsFromSanitizedEvidence(params: {
  evidence: EvidenceRecord[];
  compiled: SafeCompiledContext | null;
  evidenceWindow: { start: string; end: string };
}): ToolFact[] {
  const windowStart = Date.parse(params.evidenceWindow.start);
  const windowEnd = Date.parse(params.evidenceWindow.end);
  const isTemporallyAligned = (record: EvidenceRecord): boolean => {
    if (record.status !== "collected" || !record.observedAt) {
      return false;
    }
    const observedAt = Date.parse(record.observedAt);
    return (
      Number.isFinite(observedAt) &&
      observedAt >= windowStart &&
      observedAt <= windowEnd &&
      (record.periodRelation === "exact_turn" || record.periodRelation === "same_period")
    );
  };
  const targetEvidence = params.evidence.filter(isTemporallyAligned);
  const names = new Set(BASE_TOOL_CATALOG.map((entry) => entry.name));
  for (const record of targetEvidence) {
    for (const field of ["toolNames", "allowedToolNames", "deniedToolNames"]) {
      for (const name of stringArrayField(record.fields, field)) {
        if (classifyCapabilityToolName(name)) {
          names.add(name);
        }
      }
    }
  }
  for (const name of params.compiled?.toolNames ?? []) {
    if (classifyCapabilityToolName(name)) {
      names.add(name);
    }
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .flatMap<ToolFact>((name) => {
      const classification = classifyCapabilityToolName(name);
      if (!classification) {
        return [];
      }
      const config = targetEvidence.filter(
        (record) =>
          record.kind === "raw_config" && record.fields.capability === classification.capability,
      );
      const runtime = targetEvidence.filter(
        (record) =>
          record.kind === "plugin_runtime" &&
          stringArrayField(record.fields, "toolNames").includes(name),
      );
      const policy = targetEvidence.filter((record) => record.kind === "effective_policy");
      const allowed = policy.some((record) =>
        stringArrayField(record.fields, "allowedToolNames").includes(name),
      );
      const denied = policy.some((record) =>
        stringArrayField(record.fields, "deniedToolNames").includes(name),
      );
      const registry = targetEvidence.some(
        (record) =>
          record.kind === "derived_registry" &&
          stringArrayField(record.fields, "toolNames").includes(name),
      );
      const selfReport = targetEvidence.some(
        (record) =>
          record.kind === "agent_self_report" &&
          stringArrayField(record.fields, "toolNames").includes(name),
      );
      const configuredValues = config
        .map(
          (record) =>
            booleanField(record.fields, "configured") ?? booleanField(record.fields, "enabled"),
        )
        .filter((value): value is boolean => value !== null);
      const runtimeValues = runtime
        .map((record) => booleanField(record.fields, "loaded"))
        .filter((value): value is boolean => value !== null);
      const configEnabledValues = config
        .map((record) => booleanField(record.fields, "enabled"))
        .filter((value): value is boolean => value !== null);
      const runtimeEnabledValues = runtime
        .map((record) => booleanField(record.fields, "enabled"))
        .filter((value): value is boolean => value !== null);
      const configured = resolveBooleanEvidenceState(
        configuredValues,
        config.map((record) => record.id),
      );
      const runtimeLoaded = resolveBooleanEvidenceState(
        runtimeValues,
        runtime.map((record) => record.id),
      );
      const policyAllowed =
        allowed && denied
          ? {
              ...state(
                "unknown",
                "none",
                policy.map((record) => record.id),
              ),
              reasonCode: "CONFLICTING_EVIDENCE",
            }
          : denied
            ? state(
                "false",
                "direct",
                policy.map((record) => record.id),
              )
            : allowed
              ? state(
                  "true",
                  "direct",
                  policy.map((record) => record.id),
                )
              : state("unknown", "none", []);
      const evidencePeriodMismatch = params.evidence.some((record) => {
        if (isTemporallyAligned(record)) {
          return false;
        }
        if (record.kind === "raw_config") {
          return record.fields.capability === classification.capability;
        }
        return ["toolNames", "allowedToolNames", "deniedToolNames"].some((field) =>
          stringArrayField(record.fields, field).includes(name),
        );
      });
      return [
        {
          capability: classification.capability,
          name,
          mutationRisk: classification.mutationRisk,
          configured,
          runtimeLoaded,
          policyAllowed,
          turnProjected: state("unknown", "none", []),
          disabled:
            configEnabledValues.includes(false) &&
            !configEnabledValues.includes(true) &&
            runtimeEnabledValues.includes(false) &&
            !runtimeEnabledValues.includes(true),
          derivedRegistryLoaded: registry,
          selfReportedCallable: selfReport,
          evidencePeriodMismatch,
        },
      ];
    });
}

function resolveBooleanEvidenceState(values: boolean[], evidenceRefs: string[]): EvidenceState {
  const unique = new Set(values);
  if (unique.size === 0) {
    return state("unknown", "none", []);
  }
  if (unique.size > 1) {
    return {
      ...state("unknown", "none", evidenceRefs),
      reasonCode: "CONFLICTING_EVIDENCE",
    };
  }
  return state(values[0] ? "true" : "false", "direct", evidenceRefs);
}

function parseEvent(line: string): TrajectoryEvent | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (
      !isRecord(value) ||
      value.traceSchema !== "openclaw-trajectory" ||
      value.schemaVersion !== 1 ||
      typeof value.type !== "string" ||
      typeof value.ts !== "string" ||
      typeof value.seq !== "number" ||
      typeof value.sessionId !== "string"
    ) {
      return null;
    }
    return value as TrajectoryEvent;
  } catch {
    return null;
  }
}

function safeToolNames(data: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(data?.tools)) {
    return [];
  }
  return [
    ...new Set(
      data.tools.flatMap((item) =>
        isRecord(item) && typeof item.name === "string" ? [item.name] : [],
      ),
    ),
  ].sort();
}

function toCompiled(event: TrajectoryEvent): SafeCompiledContext | null {
  if (event.type !== "context.compiled" || typeof event.sessionKey !== "string") {
    return null;
  }
  return {
    ts: event.ts,
    seq: event.sourceSeq ?? event.seq,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    runId: event.runId ?? null,
    toolNames: safeToolNames(event.data),
  };
}

function matchesSelection(event: SafeCompiledContext, selection: ExactTurnSelection): boolean {
  if (selection.mode === "exact_run_id") {
    return event.runId === selection.runId;
  }
  if (selection.mode === "exact_event_sequence") {
    return event.seq === selection.sequence;
  }
  const timestamp = Date.parse(event.ts);
  return timestamp >= Date.parse(selection.start) && timestamp <= Date.parse(selection.end);
}

function successfulResult(
  event: TrajectoryEvent,
  runId: string,
  expected: ExpectedTrajectoryContext,
): SafeExistingToolResult | null {
  if (
    event.runId !== runId ||
    event.sessionId !== expected.sessionId ||
    event.sessionKey !== expected.sessionKey ||
    event.type !== "tool.result" ||
    !isRecord(event.data)
  ) {
    return null;
  }
  const eventTimestamp = Date.parse(event.ts);
  if (
    !Number.isFinite(eventTimestamp) ||
    eventTimestamp < Date.parse(expected.evidenceWindow.start) ||
    eventTimestamp > Date.parse(expected.evidenceWindow.end)
  ) {
    return null;
  }
  const toolName =
    typeof event.data.name === "string"
      ? event.data.name
      : typeof event.data.toolName === "string"
        ? event.data.toolName
        : null;
  const success =
    event.data.success === true || (event.data.isError !== true && event.data.status === "ok");
  return toolName && success ? { ts: event.ts, runId, toolName, success: true } : null;
}

/**
 * Reads one bounded trajectory artifact and immediately reduces events to safe
 * identifiers. No generic tool invocation or runtime mutation interface exists here.
 */
export async function collectExactTurnFromTrajectory(
  trajectoryPath: string,
  selection: ExactTurnSelection,
  expected: ExpectedTrajectoryContext,
): Promise<TrajectoryCollection> {
  try {
    const evidenceWindowStart = Date.parse(expected.evidenceWindow.start);
    const evidenceWindowEnd = Date.parse(expected.evidenceWindow.end);
    if (
      !Number.isFinite(evidenceWindowStart) ||
      !Number.isFinite(evidenceWindowEnd) ||
      evidenceWindowStart > evidenceWindowEnd
    ) {
      return {
        compiled: null,
        successfulToolResults: [],
        errorCode: "EVIDENCE_COLLECTION_FAILED",
      };
    }
    if (selection.mode === "latest_in_window") {
      const selectionStart = Date.parse(selection.start);
      const selectionEnd = Date.parse(selection.end);
      if (
        !Number.isFinite(selectionStart) ||
        !Number.isFinite(selectionEnd) ||
        selectionStart > selectionEnd
      ) {
        return {
          compiled: null,
          successfulToolResults: [],
          errorCode: "EVIDENCE_COLLECTION_FAILED",
        };
      }
    }
    const stat = await fs.stat(trajectoryPath);
    if (!stat.isFile() || stat.size > MAX_TRAJECTORY_BYTES) {
      return { compiled: null, successfulToolResults: [], errorCode: "EVIDENCE_COLLECTION_FAILED" };
    }
    const lines = (await fs.readFile(trajectoryPath, "utf8")).split("\n");
    const events = lines.flatMap((line) => {
      const event = parseEvent(line);
      return event ? [event] : [];
    });
    const candidates = events.flatMap((event, index) => {
      const compiled = toCompiled(event);
      return compiled &&
        compiled.sessionId === expected.sessionId &&
        compiled.sessionKey === expected.sessionKey &&
        Date.parse(compiled.ts) >= evidenceWindowStart &&
        Date.parse(compiled.ts) <= evidenceWindowEnd &&
        matchesSelection(compiled, selection)
        ? [{ compiled, index }]
        : [];
    });
    const selected =
      selection.mode === "latest_in_window"
        ? candidates
            .sort((a, b) => Date.parse(b.compiled.ts) - Date.parse(a.compiled.ts))
            .slice(0, 1)
        : candidates;
    if (selected.length === 0) {
      return { compiled: null, successfulToolResults: [], errorCode: "MISSING_SESSION_PROJECTION" };
    }
    if (selected.length > 1) {
      return {
        compiled: null,
        successfulToolResults: [],
        errorCode: "AMBIGUOUS_SESSION_PROJECTION",
      };
    }
    const { compiled, index: compiledIndex } = selected[0];
    const nextCompilationOffset = events
      .slice(compiledIndex + 1)
      .findIndex(
        (event) =>
          event.type === "context.compiled" &&
          event.sessionId === expected.sessionId &&
          event.sessionKey === expected.sessionKey,
      );
    const turnEnd =
      nextCompilationOffset === -1 ? events.length : compiledIndex + 1 + nextCompilationOffset;
    const turnEvents = events.slice(compiledIndex + 1, turnEnd);
    const successfulToolResults = compiled.runId
      ? turnEvents.flatMap((event) => {
          const result = successfulResult(event, compiled.runId as string, expected);
          return result ? [result] : [];
        })
      : [];
    return { compiled, successfulToolResults };
  } catch {
    return { compiled: null, successfulToolResults: [], errorCode: "EVIDENCE_COLLECTION_FAILED" };
  }
}
