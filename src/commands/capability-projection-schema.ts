import { z } from "zod";
import { CAPABILITY_NAMES, MISMATCH_CODES } from "./capability-projection-model.js";

const stringArray = z.array(z.string());
const evidenceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const evidenceRefArray = z.array(evidenceIdSchema);
const toolNameSchema = z
  .string()
  .regex(
    /^(?:Bash|browser|create_goal|exec|gateway_health|get_goal|llm_task(?:_[a-z0-9_]+)?|memory_(?:get|search)|message|process|readiness_(?:canary|health)|shell|task_flow_(?:cancel|list|show)|commitments_(?:dismiss|list)|update_goal|workboard_[a-z0-9_]+|hook[a-z0-9_.:-]*)$/u,
  );
const toolNameArray = z.array(toolNameSchema);
const hookNameArray = z.array(z.string().regex(/^hook[a-z0-9_.:-]{0,127}$/u));
const capabilityIdSchema = z.enum(CAPABILITY_NAMES);
const pluginIdSchema = z.enum([
  "workboard",
  "llm-task",
  "task-flow",
  "commitments",
  "hooks",
  "browser",
  "memory",
  "messaging",
  "shell-execution",
  "readiness-health",
]);
const sourceSchema = z.enum([
  "selected trajectory event",
  "gateway policy audit",
  "plugin runtime inspection",
  "effective policy resolver",
  "current health probe",
  "canonical config",
  "derived registry",
  "agent self-report",
  "existing tool result",
  "sanitized fixture",
]);
const stateSchema = z.strictObject({
  value: z.enum(["true", "false", "unknown", "not_applicable"]),
  basis: z.enum(["direct", "derived", "historical", "none"]),
  evidenceRefs: evidenceRefArray,
  reasonCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
    .optional(),
});

const evidenceBase = {
  id: evidenceIdSchema,
  rank: z.number().int().min(1).max(8),
  source: sourceSchema,
  observedAt: z.iso.datetime().nullable(),
  periodRelation: z.enum(["exact_turn", "same_period", "current", "historical", "unknown"]),
  status: z.enum(["collected", "partial", "failed", "missing"]),
  redactionApplied: z.boolean(),
};

// Each evidence kind has a closed field allowlist. Raw commands, config, logs,
// prompts, messages, arguments, results, and environment values have no slot.
export const CapabilityProjectionEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("context_compiled"),
    fields: z.strictObject({
      sessionId: z.string(),
      sessionKey: z.string(),
      runId: z.string().nullable(),
      sequence: z.number().int(),
      toolNames: toolNameArray,
    }),
  }),
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("gateway_policy_log"),
    fields: z.strictObject({
      ruleCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
      toolNames: toolNameArray,
      correlation: z.enum(["run", "time_window"]),
    }),
  }),
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("plugin_runtime"),
    fields: z.strictObject({
      pluginId: pluginIdSchema,
      enabled: z.boolean().nullable(),
      loaded: z.boolean().nullable(),
      toolNames: toolNameArray,
      hookNames: hookNameArray,
    }),
  }),
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("effective_policy"),
    fields: z.strictObject({
      profile: z
        .enum(["minimal", "messaging", "coding", "full", "custom", "fixture", "unknown"])
        .nullable(),
      allowedToolNames: toolNameArray,
      deniedToolNames: toolNameArray,
      sandboxMode: z.enum(["off", "non-main", "all", "fixture", "unknown"]).nullable(),
    }),
  }),
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("health_probe"),
    fields: z.strictObject({
      component: z.enum(["gateway", "node", "discord", "readiness_monitor", "control_plane"]),
      healthy: z.boolean().nullable(),
      statusCode: z.enum([
        "healthy",
        "unhealthy",
        "connected",
        "disconnected",
        "ready",
        "not_ready",
        "ok",
        "error",
        "timeout",
        "unknown",
      ]),
    }),
  }),
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("raw_config"),
    fields: z.strictObject({
      capability: capabilityIdSchema,
      configured: z.boolean().nullable(),
      enabled: z.boolean().nullable(),
    }),
  }),
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("derived_registry"),
    fields: z.strictObject({
      registryId: capabilityIdSchema,
      toolNames: toolNameArray,
      hookNames: hookNameArray,
    }),
  }),
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("agent_self_report"),
    fields: z.strictObject({
      claimCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
      toolNames: toolNameArray,
    }),
  }),
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("existing_tool_result"),
    fields: z.strictObject({
      toolName: toolNameSchema,
      runId: evidenceIdSchema,
      success: z.literal(true),
      operationClass: z.enum(["read_only", "mutating", "privacy_sensitive_read", "unknown"]),
    }),
  }),
]);

const toolSchema = z.strictObject({
  name: toolNameSchema,
  membership: z.enum(["required", "optional"]),
  mutationRisk: z.enum(["read_only", "mutating", "privacy_sensitive_read", "unknown"]),
  configured: stateSchema,
  runtimeLoaded: stateSchema,
  policyAllowed: stateSchema,
  turnProjected: stateSchema,
  callabilityStatus: z.enum([
    "verified_callable_read_only",
    "verified_callable_from_existing_turn_evidence",
    "projected_not_call_tested",
    "projected_but_not_safely_probed",
    "not_projected",
    "disabled",
    "unknown_due_to_evidence_gap",
  ]),
  mismatchCodes: z.array(z.enum(MISMATCH_CODES)),
  mismatchReason: z.string().nullable(),
  evidenceRefs: evidenceRefArray,
});

export const CapabilityProjectionReportSchema = z.strictObject({
  schema: z.literal("openclaw.capability-projection-report"),
  schemaVersion: z.literal(1),
  reportId: z.string().regex(/^cpr-v1-[a-f0-9]{16}$/u),
  generatedAt: z.iso.datetime(),
  host: z.strictObject({
    hostname: z.string(),
    user: z.string(),
    uid: z.number().int().nonnegative(),
    instanceDir: z.string(),
    workspaceDir: z.string(),
  }),
  openclawVersion: z.strictObject({
    value: z
      .string()
      .regex(/^[A-Za-z0-9.+_-]{1,64}$/u)
      .nullable(),
    evidenceRefs: evidenceRefArray,
  }),
  target: z.strictObject({
    agentId: z.string(),
    sessionKey: z.string(),
    sessionId: z.string().nullable(),
    runId: z.string().nullable(),
    turnSequence: z.number().int().nullable(),
    contextCompiledAt: z.iso.datetime().nullable(),
    selectionMode: z.enum([
      "exact_run_id",
      "exact_event_sequence",
      "latest_in_window",
      "unresolved",
    ]),
  }),
  evidenceWindow: z.strictObject({ start: z.iso.datetime(), end: z.iso.datetime() }),
  capabilities: z.array(
    z.strictObject({
      name: z.enum(CAPABILITY_NAMES),
      summary: z.strictObject({
        configured: stateSchema,
        runtimeLoaded: stateSchema,
        policyAllowed: stateSchema,
        turnProjected: stateSchema,
      }),
      callabilityCounts: z.record(z.string(), z.number().int().nonnegative()),
      tools: z.array(toolSchema),
      mismatchCodes: z.array(z.enum(MISMATCH_CODES)),
      mismatchReason: z.string().nullable(),
      evidenceRefs: evidenceRefArray,
    }),
  ),
  evidence: z.array(CapabilityProjectionEvidenceSchema),
  observations: z.array(
    z.strictObject({
      code: z.string(),
      period: z.enum(["current", "historical"]),
      severity: z.enum(["info", "watch", "block"]),
      summary: z.string(),
      evidenceRefs: evidenceRefArray,
    }),
  ),
  collectionErrors: z.array(
    z.strictObject({
      collector: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
      message: z.literal("Evidence collection did not complete; affected claims remain unknown."),
      occurredAt: z.iso.datetime(),
      affectedClaims: evidenceRefArray,
    }),
  ),
  redaction: z.strictObject({
    policy: z.literal("allowlist-before-serialization-v1"),
    excludedFieldClasses: stringArray,
    notes: stringArray,
  }),
  overallConfidence: z.strictObject({
    level: z.enum(["high", "medium", "low"]),
    reasonCodes: stringArray,
  }),
});

export const capabilityProjectionReportJsonSchema = CapabilityProjectionReportSchema.toJSONSchema({
  target: "draft-2020-12",
});
