import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveTrajectoryFilePath } from "../trajectory/paths.js";
import { VERSION } from "../version.js";
import {
  collectExactTurnFromTrajectory,
  collectToolFactsFromSanitizedEvidence,
  classifyCapabilityToolName,
  type ExactTurnSelection,
  type TrajectoryCollection,
} from "./capability-projection-collectors.js";
import {
  buildCapabilityRecords,
  computeCapabilityReportId,
  type CapabilityProjectionReport,
  type CollectionError,
  type EvidenceRecord,
  type ToolFact,
} from "./capability-projection-model.js";
import { publishCapabilityProjectionPair } from "./capability-projection-render.js";
import {
  CapabilityProjectionEvidenceSchema,
  CapabilityProjectionReportSchema,
} from "./capability-projection-schema.js";

export type CapabilityProjectionInput = {
  generatedAt: string;
  host: CapabilityProjectionReport["host"];
  openclawVersion: string | null;
  agentId: string;
  sessionKey: string;
  evidenceWindow: { start: string; end: string };
  selection: ExactTurnSelection;
  trajectory: TrajectoryCollection;
  evidence: EvidenceRecord[];
  observations?: CapabilityProjectionReport["observations"];
  collectionErrors?: CollectionError[];
};

export type CapabilityProjectionCommandOptions = {
  sessionKey?: string;
  agent?: string;
  store?: string;
  runId?: string;
  eventSequence?: string;
  windowStart?: string;
  windowEnd?: string;
  evidenceFile?: string;
  outputRoot?: string;
  outputDir?: string;
  workspace?: string;
};

export function resolveCapabilityProjectionTrajectoryPath(params: {
  sessionKey: string;
  agentId?: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
}): { sessionId: string; sessionFile: string; trajectoryPath: string } | null {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  const entry = loadSessionEntry({
    agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    env: params.env,
    clone: false,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
  });
  if (!entry?.sessionId) {
    return null;
  }
  const sessionFile = resolveSessionFilePath(
    entry.sessionId,
    entry,
    resolveSessionFilePathOptions({ agentId, storePath: params.storePath }),
  );
  return {
    sessionId: entry.sessionId,
    sessionFile,
    trajectoryPath: resolveTrajectoryFilePath({
      env: params.env,
      sessionFile,
      sessionId: entry.sessionId,
    }),
  };
}

export async function collectCapabilityProjectionTrajectory(params: {
  sessionKey: string;
  selection: ExactTurnSelection;
  evidenceWindow: { start: string; end: string };
  agentId?: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TrajectoryCollection> {
  const target = resolveCapabilityProjectionTrajectoryPath(params);
  if (!target) {
    return { compiled: null, successfulToolResults: [], errorCode: "MISSING_SESSION_PROJECTION" };
  }
  return await collectExactTurnFromTrajectory(
    target.trajectoryPath,
    params.selection,
    {
      sessionId: target.sessionId,
      sessionKey: params.sessionKey,
      evidenceWindow: params.evidenceWindow,
    },
    target.sessionFile,
  );
}

function selectionMode(
  selection: ExactTurnSelection,
): CapabilityProjectionReport["target"]["selectionMode"] {
  return selection.mode;
}

function withProjection(
  facts: ToolFact[],
  trajectory: TrajectoryCollection,
  resultEvidenceRefs: ReadonlyMap<string, string[]>,
): ToolFact[] {
  if (!trajectory.compiled) {
    return facts.map((fact) => ({
      ...fact,
      turnProjected: {
        value: "unknown",
        basis: "none",
        evidenceRefs: [],
        reasonCode: trajectory.errorCode ?? "MISSING_SESSION_PROJECTION",
      },
      existingSuccessfulCall: false,
      existingSuccessfulCallEvidenceRefs: [],
    }));
  }
  const projected = new Set(trajectory.compiled.toolNames);
  const successful = new Set(trajectory.successfulToolResults.map((result) => result.toolName));
  return facts.map((fact) => ({
    ...fact,
    turnProjected: {
      value: projected.has(fact.name) ? "true" : "false",
      basis: "direct",
      evidenceRefs: ["context-compiled"],
    },
    existingSuccessfulCall: successful.has(fact.name),
    existingSuccessfulCallEvidenceRefs: resultEvidenceRefs.get(fact.name) ?? [],
  }));
}

function buildExistingResultEvidence(
  facts: ToolFact[],
  trajectory: TrajectoryCollection,
): { records: EvidenceRecord[]; refsByTool: Map<string, string[]> } {
  const factsByName = new Map(facts.map((fact) => [fact.name, fact]));
  const refsByTool = new Map<string, string[]>();
  const results = trajectory.successfulToolResults
    .filter((result) => factsByName.has(result.toolName))
    .toSorted(
      (left, right) =>
        left.ts.localeCompare(right.ts) ||
        left.toolName.localeCompare(right.toolName) ||
        left.runId.localeCompare(right.runId),
    );
  const records = results.map<EvidenceRecord>((result, index) => {
    const id = `existing-tool-result-${index + 1}`;
    refsByTool.set(result.toolName, [...(refsByTool.get(result.toolName) ?? []), id]);
    return {
      id,
      rank: 1,
      kind: "existing_tool_result",
      source: "existing tool result",
      observedAt: result.ts,
      periodRelation: "exact_turn",
      status: "collected",
      fields: {
        toolName: result.toolName,
        runId: result.runId,
        success: true,
        operationClass: factsByName.get(result.toolName)?.mutationRisk ?? "unknown",
      },
      redactionApplied: true,
    };
  });
  records.forEach(validateEvidenceStrings);
  return { records, refsByTool };
}

function safeCollectionError(input: CollectionError): CollectionError {
  return {
    collector: input.collector,
    code: input.code,
    message: "Evidence collection did not complete; affected claims remain unknown.",
    occurredAt: input.occurredAt,
    affectedClaims: [...new Set(input.affectedClaims)].sort(),
  };
}

const SAFE_EVIDENCE_SOURCE_RE = /^[A-Za-z0-9_. -]{1,160}$/u;
const SECRET_BEARING_VALUE_RE =
  /(?:authorization|bearer\s+|cookie\s*[:=]|begin [A-Z ]*private key|(?:api[_-]?key|password|secret|token)\s*[:=]|https?:\/\/\S*\?|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b)/iu;

function validateEvidenceStrings(value: unknown, key = "evidence"): void {
  if (typeof value === "string") {
    if (SECRET_BEARING_VALUE_RE.test(value)) {
      throw new Error("Evidence contains a prohibited secret-bearing value");
    }
    if (key === "source" && !SAFE_EVIDENCE_SOURCE_RE.test(value)) {
      throw new Error("Evidence source must be a safe label");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      validateEvidenceStrings(item, key);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      validateEvidenceStrings(childValue, childKey);
    }
  }
}

function sanitizeEvidenceRecord(input: EvidenceRecord): EvidenceRecord {
  if (input.redactionApplied !== true) {
    throw new Error("Evidence record is not marked as redacted");
  }
  if (input.kind === "context_compiled" || input.kind === "existing_tool_result") {
    throw new Error("Reserved evidence kind cannot be supplied externally");
  }
  const parsed = CapabilityProjectionEvidenceSchema.parse({ ...input, redactionApplied: true });
  validateEvidenceStrings(parsed);
  return parsed as EvidenceRecord;
}

const OBSERVATION_SUMMARIES: Record<string, string> = {
  CURRENT_HEALTHY: "Current sanitized health evidence passed.",
  HISTORICAL_CURRENT_STATE_DIFFERENCE:
    "Historical evidence differs from the current sanitized health snapshot.",
  READINESS_OBSERVABILITY_ONLY:
    "Readiness evidence is observability only and does not establish autonomy or recovery.",
};

function sanitizeObservations(
  observations: CapabilityProjectionReport["observations"],
): CapabilityProjectionReport["observations"] {
  validateEvidenceStrings(observations);
  return observations.map((observation) => {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(observation.code)) {
      throw new Error("Observation contains an unsafe code");
    }
    return {
      code: observation.code,
      period: observation.period,
      severity: observation.severity,
      summary:
        OBSERVATION_SUMMARIES[observation.code] ?? "Observation recorded from sanitized evidence.",
      evidenceRefs: observation.evidenceRefs.map((reference) => {
        if (!/^[A-Za-z0-9_.:-]{1,160}$/u.test(reference)) {
          throw new Error("Observation contains an unsafe evidence reference");
        }
        return reference;
      }),
    };
  });
}

export function buildCapabilityProjectionReport(
  input: CapabilityProjectionInput,
): CapabilityProjectionReport {
  const collectionErrors = (input.collectionErrors ?? []).map(safeCollectionError);
  if (input.trajectory.errorCode) {
    collectionErrors.push({
      collector: "trajectory",
      code: input.trajectory.errorCode,
      message: "Evidence collection did not complete; affected claims remain unknown.",
      occurredAt: input.generatedAt,
      affectedClaims: ["turnProjected", "callabilityStatus"],
    });
  }
  const compiled = input.trajectory.compiled;
  const contextEvidence: EvidenceRecord = compiled
    ? {
        id: "context-compiled",
        rank: 1,
        kind: "context_compiled",
        source: "selected trajectory event",
        observedAt: compiled.ts,
        periodRelation: "exact_turn",
        status: "collected",
        fields: {
          sessionId: compiled.sessionId,
          sessionKey: compiled.sessionKey,
          runId: compiled.runId,
          sequence: compiled.seq,
          toolNames: [...new Set(compiled.toolNames)]
            .filter((name) => classifyCapabilityToolName(name) !== null)
            .sort(),
        },
        redactionApplied: true,
      }
    : {
        id: "context-compiled",
        rank: 1,
        kind: "context_compiled",
        source: "selected trajectory event",
        observedAt: null,
        periodRelation: "unknown",
        status: "missing",
        fields: {
          sessionId: "",
          sessionKey: input.sessionKey,
          runId: null,
          sequence: 0,
          toolNames: [],
        },
        redactionApplied: true,
      };
  validateEvidenceStrings(contextEvidence);
  const sanitizedInputEvidence = input.evidence.map(sanitizeEvidenceRecord);
  const facts = collectToolFactsFromSanitizedEvidence({
    evidence: sanitizedInputEvidence,
    compiled,
    evidenceWindow: input.evidenceWindow,
  });
  const resultEvidence = buildExistingResultEvidence(facts, input.trajectory);
  const evidence = [contextEvidence, ...resultEvidence.records, ...sanitizedInputEvidence].sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.observedAt ?? "~").localeCompare(b.observedAt ?? "~") ||
      a.id.localeCompare(b.id),
  );
  const capabilities = buildCapabilityRecords(
    withProjection(facts, input.trajectory, resultEvidence.refsByTool),
  );
  const lowConfidence = !compiled;
  const hasUnknownRequiredEvidence = capabilities.some((capability) =>
    capability.tools
      .filter((tool) => tool.membership === "required")
      .some(
        (tool) =>
          tool.configured.value === "unknown" ||
          tool.runtimeLoaded.value === "unknown" ||
          tool.policyAllowed.value === "unknown" ||
          tool.turnProjected.value === "unknown",
      ),
  );
  const evidenceGapReasonCodes = [
    ...new Set(
      sanitizedInputEvidence
        .filter((record) => record.status !== "collected")
        .map((record) =>
          record.kind === "plugin_runtime" && record.status === "partial"
            ? "PARTIAL_PLUGIN_INSPECTION"
            : "EVIDENCE_COLLECTION_FAILED",
        ),
    ),
  ].sort();
  const base = {
    schema: "openclaw.capability-projection-report" as const,
    schemaVersion: 1 as const,
    generatedAt: new Date(input.generatedAt).toISOString(),
    host: input.host,
    openclawVersion: {
      value: input.openclawVersion,
      evidenceRefs: input.openclawVersion ? ["openclaw-version"] : [],
    },
    target: {
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      sessionId: compiled?.sessionId ?? null,
      runId: compiled?.runId ?? null,
      turnSequence: compiled?.seq ?? null,
      contextCompiledAt: compiled?.ts ?? null,
      selectionMode: compiled ? selectionMode(input.selection) : ("unresolved" as const),
    },
    evidenceWindow: {
      start: new Date(input.evidenceWindow.start).toISOString(),
      end: new Date(input.evidenceWindow.end).toISOString(),
    },
    capabilities,
    evidence,
    observations: sanitizeObservations(input.observations ?? []).sort(
      (a, b) => a.period.localeCompare(b.period) || a.code.localeCompare(b.code),
    ),
    collectionErrors: collectionErrors.sort(
      (a, b) => a.collector.localeCompare(b.collector) || a.code.localeCompare(b.code),
    ),
    redaction: {
      policy: "allowlist-before-serialization-v1" as const,
      excludedFieldClasses: [
        "authorization_headers",
        "cookies",
        "credentials",
        "environment",
        "messages",
        "private_certificate_material",
        "prompts",
        "raw_config",
        "raw_logs",
        "tool_arguments",
        "tool_results",
      ],
      notes: ["Collectors reduce source data to fixed allowlisted fields before serialization."],
    },
    overallConfidence: {
      level: lowConfidence
        ? ("low" as const)
        : collectionErrors.length > 0 ||
            evidenceGapReasonCodes.length > 0 ||
            hasUnknownRequiredEvidence
          ? ("medium" as const)
          : ("high" as const),
      reasonCodes: lowConfidence
        ? [input.trajectory.errorCode ?? "MISSING_SESSION_PROJECTION"]
        : [
            ...new Set([
              ...collectionErrors.map((error) => error.code),
              ...evidenceGapReasonCodes,
              ...(hasUnknownRequiredEvidence ? ["MISSING_CAPABILITY_EVIDENCE"] : []),
            ]),
          ].sort(),
    },
  };
  const report: CapabilityProjectionReport = { ...base, reportId: computeCapabilityReportId(base) };
  return CapabilityProjectionReportSchema.parse(report) as CapabilityProjectionReport;
}

export function defaultCapabilityProjectionHost(params: {
  instanceDir: string;
  workspaceDir: string;
}): CapabilityProjectionReport["host"] {
  return {
    hostname: os.hostname(),
    user: os.userInfo().username,
    uid: process.getuid?.() ?? os.userInfo().uid,
    instanceDir: params.instanceDir,
    workspaceDir: params.workspaceDir,
  };
}

function resolveCommandSelection(
  opts: CapabilityProjectionCommandOptions,
): ExactTurnSelection | null {
  const windowStart = opts.windowStart?.trim();
  const windowEnd = opts.windowEnd?.trim();
  const startMs = windowStart ? Date.parse(windowStart) : Number.NaN;
  const endMs = windowEnd ? Date.parse(windowEnd) : Number.NaN;
  if (
    !windowStart ||
    !windowEnd ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs > endMs
  ) {
    return null;
  }
  const selectors = [Boolean(opts.runId?.trim()), Boolean(opts.eventSequence?.trim())].filter(
    Boolean,
  ).length;
  if (selectors > 1) {
    return null;
  }
  if (opts.runId?.trim()) {
    return { mode: "exact_run_id", runId: opts.runId.trim() };
  }
  if (opts.eventSequence?.trim()) {
    const sequence = Number(opts.eventSequence);
    return Number.isSafeInteger(sequence) && sequence >= 0
      ? { mode: "exact_event_sequence", sequence }
      : null;
  }
  return { mode: "latest_in_window", start: windowStart, end: windowEnd };
}

/** Generates a report from local trajectory metadata plus a closed sanitized-evidence file. */
export async function capabilityProjectionCommand(
  opts: CapabilityProjectionCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const sessionKey = opts.sessionKey?.trim();
  const selection = resolveCommandSelection(opts);
  const evidenceFile = opts.evidenceFile?.trim();
  const outputRoot = opts.outputRoot?.trim();
  if (!sessionKey || !selection || !evidenceFile || !outputRoot) {
    runtime.error(
      "Capability projection requires --session-key, --evidence-file, --output-root, both --window-start/--window-end, and at most one exact selector: --run-id or --event-sequence.",
    );
    runtime.exit(1);
    return;
  }
  let evidence: EvidenceRecord[];
  try {
    const parsed = JSON.parse(await fs.readFile(path.resolve(evidenceFile), "utf8")) as unknown;
    evidence = CapabilityProjectionEvidenceSchema.array().parse(parsed) as EvidenceRecord[];
    if (evidence.some((record) => record.redactionApplied !== true)) {
      throw new Error("unredacted evidence");
    }
  } catch {
    runtime.error("Capability projection evidence file is invalid or unreadable.");
    runtime.exit(1);
    return;
  }
  const targetAgentId = resolveAgentIdFromSessionKey(sessionKey);
  if (opts.agent?.trim() && opts.agent.trim() !== targetAgentId) {
    runtime.error("Capability projection --agent conflicts with the canonical session owner.");
    runtime.exit(1);
    return;
  }
  const evidenceWindow = { start: opts.windowStart as string, end: opts.windowEnd as string };
  const trajectory = await collectCapabilityProjectionTrajectory({
    sessionKey,
    selection,
    evidenceWindow,
    agentId: targetAgentId,
    storePath: opts.store,
  });
  const workspaceDir = path.resolve(opts.workspace ?? process.cwd());
  const resolvedOutputRoot = path.resolve(outputRoot);
  const resolvedOutputDir = path.resolve(
    opts.outputDir ?? path.join(resolvedOutputRoot, "reports", "capability-projection"),
  );
  const generatedAt = new Date().toISOString();
  let report: CapabilityProjectionReport;
  try {
    report = buildCapabilityProjectionReport({
      generatedAt,
      host: defaultCapabilityProjectionHost({
        instanceDir: resolveStateDir(process.env),
        workspaceDir,
      }),
      openclawVersion: VERSION,
      agentId: targetAgentId,
      sessionKey,
      evidenceWindow,
      selection,
      trajectory,
      evidence,
    });
  } catch {
    runtime.error("Capability projection evidence failed semantic validation.");
    runtime.exit(1);
    return;
  }
  try {
    const published = await publishCapabilityProjectionPair({
      report,
      outputRoot: resolvedOutputRoot,
      outputDir: resolvedOutputDir,
    });
    runtime.log(
      JSON.stringify({
        reportId: report.reportId,
        confidence: report.overallConfidence.level,
        jsonPath: published.jsonPath,
        markdownPath: published.markdownPath,
      }),
    );
  } catch {
    runtime.error("Capability projection publication failed.");
    runtime.exit(1);
  }
}
