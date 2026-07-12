import { createHash } from "node:crypto";

export const CAPABILITY_NAMES = [
  "goal_tools",
  "workboard",
  "llm_task",
  "task_flow",
  "commitments",
  "hooks",
  "browser",
  "memory",
  "messaging",
  "shell_execution",
  "readiness_health",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type EvidenceValue = "true" | "false" | "unknown" | "not_applicable";
export type EvidenceBasis = "direct" | "derived" | "historical" | "none";
export type CallabilityStatus =
  | "verified_callable_read_only"
  | "verified_callable_from_existing_turn_evidence"
  | "projected_not_call_tested"
  | "projected_but_not_safely_probed"
  | "not_projected"
  | "disabled"
  | "unknown_due_to_evidence_gap";
export type MutationRisk = "read_only" | "mutating" | "privacy_sensitive_read" | "unknown";

export const MISMATCH_CODES = [
  "CAPABILITY_MEMBER_STATE_MIXED",
  "CONFIGURED_NOT_LOADED",
  "DERIVED_REGISTRY_STALE",
  "EVIDENCE_COLLECTION_FAILED",
  "EVIDENCE_PERIOD_MISMATCH",
  "HISTORICAL_CURRENT_STATE_DIFFERENCE",
  "LOADED_NOT_CONFIGURED",
  "LOADED_NOT_POLICY_ALLOWED",
  "MISSING_SESSION_PROJECTION",
  "PARTIAL_PLUGIN_INSPECTION",
  "POLICY_ALLOWED_NOT_PROJECTED",
  "PROJECTED_NOT_POLICY_ALLOWED",
  "PROJECTED_NOT_RUNTIME_LOADED",
  "PROJECTED_NOT_SAFELY_CALL_TESTED",
  "SELF_REPORT_UNCORROBORATED",
] as const;

export type MismatchCode = (typeof MISMATCH_CODES)[number];

export type EvidenceState = {
  value: EvidenceValue;
  basis: EvidenceBasis;
  evidenceRefs: string[];
  reasonCode?: string;
};

export type ToolRecord = {
  name: string;
  membership: "required" | "optional";
  mutationRisk: MutationRisk;
  configured: EvidenceState;
  runtimeLoaded: EvidenceState;
  policyAllowed: EvidenceState;
  turnProjected: EvidenceState;
  callabilityStatus: CallabilityStatus;
  mismatchCodes: MismatchCode[];
  mismatchReason: string | null;
  evidenceRefs: string[];
};

export type CapabilityRecord = {
  name: CapabilityName;
  summary: {
    configured: EvidenceState;
    runtimeLoaded: EvidenceState;
    policyAllowed: EvidenceState;
    turnProjected: EvidenceState;
  };
  callabilityCounts: Partial<Record<CallabilityStatus, number>>;
  tools: ToolRecord[];
  mismatchCodes: MismatchCode[];
  mismatchReason: string | null;
  evidenceRefs: string[];
};

export type EvidenceRecord = {
  id: string;
  rank: number;
  kind:
    | "context_compiled"
    | "gateway_policy_log"
    | "plugin_runtime"
    | "effective_policy"
    | "health_probe"
    | "raw_config"
    | "derived_registry"
    | "agent_self_report"
    | "existing_tool_result";
  source: string;
  observedAt: string | null;
  periodRelation: "exact_turn" | "same_period" | "current" | "historical" | "unknown";
  status: "collected" | "partial" | "failed" | "missing";
  fields: Record<string, string | number | boolean | null | string[]>;
  redactionApplied: boolean;
};

export type CollectionError = {
  collector: string;
  code: string;
  message: string;
  occurredAt: string;
  affectedClaims: string[];
};

export type CapabilityProjectionReport = {
  schema: "openclaw.capability-projection-report";
  schemaVersion: 1;
  reportId: string;
  generatedAt: string;
  host: {
    hostname: string;
    user: string;
    uid: number;
    instanceDir: string;
    workspaceDir: string;
  };
  openclawVersion: { value: string | null; evidenceRefs: string[] };
  target: {
    agentId: string;
    sessionKey: string;
    sessionId: string | null;
    runId: string | null;
    turnSequence: number | null;
    contextCompiledAt: string | null;
    selectionMode: "exact_run_id" | "exact_event_sequence" | "latest_in_window" | "unresolved";
  };
  evidenceWindow: { start: string; end: string };
  capabilities: CapabilityRecord[];
  evidence: EvidenceRecord[];
  observations: Array<{
    code: string;
    period: "current" | "historical";
    severity: "info" | "watch" | "block";
    summary: string;
    evidenceRefs: string[];
  }>;
  collectionErrors: CollectionError[];
  redaction: {
    policy: "allowlist-before-serialization-v1";
    excludedFieldClasses: string[];
    notes: string[];
  };
  overallConfidence: { level: "high" | "medium" | "low"; reasonCodes: string[] };
};

export type ToolFact = {
  capability: CapabilityName;
  name: string;
  membership?: "required" | "optional";
  mutationRisk: MutationRisk;
  configured: EvidenceState;
  runtimeLoaded: EvidenceState;
  policyAllowed: EvidenceState;
  turnProjected: EvidenceState;
  existingSuccessfulCall?: boolean;
  disabled?: boolean;
  derivedRegistryLoaded?: boolean;
  selfReportedCallable?: boolean;
  evidencePeriodMismatch?: boolean;
};

const MISMATCH_REASON: Record<MismatchCode, string> = {
  CAPABILITY_MEMBER_STATE_MIXED: "Capability members have different evidence states.",
  CONFIGURED_NOT_LOADED:
    "Configuration enables the tool, but runtime evidence says it is not loaded.",
  DERIVED_REGISTRY_STALE:
    "Derived registry evidence conflicts with higher-authority runtime evidence.",
  EVIDENCE_COLLECTION_FAILED: "A required evidence collector failed.",
  EVIDENCE_PERIOD_MISMATCH: "Evidence does not describe the selected turn's time period.",
  HISTORICAL_CURRENT_STATE_DIFFERENCE:
    "Historical evidence differs from the current health snapshot.",
  LOADED_NOT_CONFIGURED:
    "Runtime evidence reports the tool loaded without affirmative configuration evidence.",
  LOADED_NOT_POLICY_ALLOWED: "The tool is loaded but effective policy does not allow it.",
  MISSING_SESSION_PROJECTION: "No unambiguous context.compiled event was selected.",
  PARTIAL_PLUGIN_INSPECTION: "Plugin runtime inspection was incomplete.",
  POLICY_ALLOWED_NOT_PROJECTED:
    "Effective policy allows the tool, but the exact turn did not project it.",
  PROJECTED_NOT_POLICY_ALLOWED:
    "The exact turn projected the tool despite policy evidence denying it.",
  PROJECTED_NOT_RUNTIME_LOADED:
    "The exact turn projected the tool without affirmative runtime-loaded evidence.",
  PROJECTED_NOT_SAFELY_CALL_TESTED:
    "The tool is projected but was intentionally not invoked for verification.",
  SELF_REPORT_UNCORROBORATED: "Agent self-report is not corroborated by higher-authority evidence.",
};

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function stateSummary(states: EvidenceState[]): EvidenceState {
  if (states.length === 0) {
    return { value: "unknown", basis: "none", evidenceRefs: [] };
  }
  const values = new Set(states.map((state) => state.value));
  const evidenceRefs = sortedUnique(states.flatMap((state) => state.evidenceRefs));
  if (values.size === 1) {
    const state = states[0];
    return { value: state.value, basis: state.basis, evidenceRefs };
  }
  return {
    value: "unknown",
    basis: "derived",
    evidenceRefs,
    reasonCode: "CAPABILITY_MEMBER_STATE_MIXED",
  };
}

function resolveCallability(fact: ToolFact): CallabilityStatus {
  if (fact.disabled) {
    return "disabled";
  }
  if (fact.turnProjected.value === "false") {
    return "not_projected";
  }
  if (fact.turnProjected.value !== "true") {
    return "unknown_due_to_evidence_gap";
  }
  if (fact.existingSuccessfulCall) {
    return fact.mutationRisk === "read_only" || fact.mutationRisk === "privacy_sensitive_read"
      ? "verified_callable_read_only"
      : "verified_callable_from_existing_turn_evidence";
  }
  return fact.mutationRisk === "mutating" || fact.mutationRisk === "privacy_sensitive_read"
    ? "projected_but_not_safely_probed"
    : "projected_not_call_tested";
}

function mismatchCodesForFact(fact: ToolFact, callability: CallabilityStatus): MismatchCode[] {
  const codes: MismatchCode[] = [];
  if (fact.configured.value === "true" && fact.runtimeLoaded.value === "false") {
    codes.push("CONFIGURED_NOT_LOADED");
  }
  if (fact.runtimeLoaded.value === "true" && fact.configured.value === "false") {
    codes.push("LOADED_NOT_CONFIGURED");
  }
  if (fact.runtimeLoaded.value === "true" && fact.policyAllowed.value === "false") {
    codes.push("LOADED_NOT_POLICY_ALLOWED");
  }
  if (fact.policyAllowed.value === "true" && fact.turnProjected.value === "false") {
    codes.push("POLICY_ALLOWED_NOT_PROJECTED");
  }
  if (fact.turnProjected.value === "true" && fact.policyAllowed.value === "false") {
    codes.push("PROJECTED_NOT_POLICY_ALLOWED");
  }
  if (fact.turnProjected.value === "true" && fact.runtimeLoaded.value === "false") {
    codes.push("PROJECTED_NOT_RUNTIME_LOADED");
  }
  if (
    callability === "projected_not_call_tested" ||
    callability === "projected_but_not_safely_probed"
  ) {
    codes.push("PROJECTED_NOT_SAFELY_CALL_TESTED");
  }
  if (fact.derivedRegistryLoaded === true && fact.runtimeLoaded.value === "false") {
    codes.push("DERIVED_REGISTRY_STALE");
  }
  if (
    fact.selfReportedCallable &&
    callability !== "verified_callable_read_only" &&
    callability !== "verified_callable_from_existing_turn_evidence"
  ) {
    codes.push("SELF_REPORT_UNCORROBORATED");
  }
  if (fact.evidencePeriodMismatch) {
    codes.push("EVIDENCE_PERIOD_MISMATCH");
  }
  return [...new Set(codes)].sort();
}

export function buildCapabilityRecords(facts: ToolFact[]): CapabilityRecord[] {
  return CAPABILITY_NAMES.map((name) => {
    const tools = facts
      .filter((fact) => fact.capability === name)
      .map<ToolRecord>((fact) => {
        const callabilityStatus = resolveCallability(fact);
        const mismatchCodes = mismatchCodesForFact(fact, callabilityStatus);
        return {
          name: fact.name,
          membership: fact.membership ?? "required",
          mutationRisk: fact.mutationRisk,
          configured: fact.configured,
          runtimeLoaded: fact.runtimeLoaded,
          policyAllowed: fact.policyAllowed,
          turnProjected: fact.turnProjected,
          callabilityStatus,
          mismatchCodes,
          mismatchReason: mismatchCodes.map((code) => MISMATCH_REASON[code]).join(" ") || null,
          evidenceRefs: sortedUnique([
            ...fact.configured.evidenceRefs,
            ...fact.runtimeLoaded.evidenceRefs,
            ...fact.policyAllowed.evidenceRefs,
            ...fact.turnProjected.evidenceRefs,
          ]),
        };
      })
      .sort(
        (a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name),
      );
    const required = tools.filter((tool) => tool.membership === "required");
    const summaryTools = required.length > 0 ? required : tools;
    const summary = {
      configured: stateSummary(summaryTools.map((tool) => tool.configured)),
      runtimeLoaded: stateSummary(summaryTools.map((tool) => tool.runtimeLoaded)),
      policyAllowed: stateSummary(summaryTools.map((tool) => tool.policyAllowed)),
      turnProjected: stateSummary(summaryTools.map((tool) => tool.turnProjected)),
    };
    const mismatchCodes = sortedUnique([
      ...tools.flatMap((tool) => tool.mismatchCodes),
      ...Object.values(summary)
        .filter((state) => state.reasonCode === "CAPABILITY_MEMBER_STATE_MIXED")
        .map(() => "CAPABILITY_MEMBER_STATE_MIXED"),
    ]) as MismatchCode[];
    const callabilityCounts: Partial<Record<CallabilityStatus, number>> = {};
    for (const tool of tools) {
      callabilityCounts[tool.callabilityStatus] =
        (callabilityCounts[tool.callabilityStatus] ?? 0) + 1;
    }
    return {
      name,
      summary,
      callabilityCounts,
      tools,
      mismatchCodes,
      mismatchReason: mismatchCodes.map((code) => MISMATCH_REASON[code]).join(" ") || null,
      evidenceRefs: sortedUnique(tools.flatMap((tool) => tool.evidenceRefs)),
    };
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "generatedAt" && key !== "reportId")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function computeCapabilityReportId(
  report: Omit<CapabilityProjectionReport, "reportId">,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalize(report)))
    .digest("hex");
  return `cpr-v1-${digest.slice(0, 16)}`;
}
