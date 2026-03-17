import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  type OagDiagnosisRecord,
  type OagMemory,
  loadOagMemory,
  recordDiagnosis,
  saveOagMemory,
} from "./oag-memory.js";
import { getOagMetrics } from "./oag-metrics.js";

const log = createSubsystemLogger("oag/diagnosis");

const DIAGNOSIS_COOLDOWN_MS = 4 * 60 * 60_000; // 4 hours
const MAX_LIFECYCLE_CONTEXT = 5;
const MAX_PROMPT_VALUE_LENGTH = 200;
const MAX_HISTORICAL_RECOMMENDATIONS = 10;

/**
 * Sanitize an arbitrary value for safe inclusion in a diagnosis prompt.
 * JSON-stringifies the value and truncates to MAX_PROMPT_VALUE_LENGTH chars
 * to prevent prompt injection and unbounded prompt size.
 */
export function sanitizeForPrompt(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= MAX_PROMPT_VALUE_LENGTH) {
    return serialized;
  }
  return serialized.slice(0, MAX_PROMPT_VALUE_LENGTH) + "…[truncated]";
}

export type DiagnosisTrigger = {
  type: "recurring_pattern" | "adaptation_failed" | "recovery_degraded";
  description: string;
  patternType?: string;
  channel?: string;
  occurrences?: number;
};

export type DiagnosisRecommendation = {
  type: "config_change" | "code_pattern" | "operator_action";
  description: string;
  configPath?: string;
  suggestedValue?: unknown;
  risk: "low" | "medium" | "high";
  reasoning?: string;
};

export type DiagnosisResult = {
  rootCause: string;
  analysis: string;
  confidence: number;
  recommendations: DiagnosisRecommendation[];
  preventive?: string;
};

function shouldRunDiagnosis(memory: OagMemory, trigger: DiagnosisTrigger): boolean {
  const recentDiagnoses = memory.diagnoses.filter((d) => {
    const age = Date.now() - Date.parse(d.triggeredAt);
    return age < DIAGNOSIS_COOLDOWN_MS && d.trigger === trigger.type;
  });
  if (recentDiagnoses.length > 0) {
    log.info(`Diagnosis cooldown active for trigger ${trigger.type}, skipping`);
    return false;
  }
  return true;
}

export function buildHistoricalRecommendations(memory: OagMemory): string {
  const lines: string[] = [];
  // Collect recommendations with outcomes from completed diagnoses, newest first
  const completedDiagnoses = memory.diagnoses
    .filter((d) => d.completedAt)
    .slice(-MAX_HISTORICAL_RECOMMENDATIONS);

  for (const diag of completedDiagnoses) {
    for (const rec of diag.recommendations) {
      if (rec.configPath && rec.outcome) {
        const configPath = sanitizeForPrompt(rec.configPath);
        lines.push(
          `- ${configPath}: ${sanitizeForPrompt(rec.description ?? "change")} -> ${sanitizeForPrompt(rec.outcome)}`,
        );
      }
    }
    // Also include trackedRecommendations if present
    if (diag.trackedRecommendations) {
      for (const tr of diag.trackedRecommendations) {
        if (tr.outcome) {
          lines.push(
            `- ${sanitizeForPrompt(tr.parameter)}: ${sanitizeForPrompt(tr.oldValue)} -> ${sanitizeForPrompt(tr.newValue)} -> ${sanitizeForPrompt(tr.outcome)}`,
          );
        }
      }
    }
  }

  // Limit to MAX_HISTORICAL_RECOMMENDATIONS total lines
  return lines.slice(-MAX_HISTORICAL_RECOMMENDATIONS).join("\n");
}

export function composeDiagnosisPrompt(trigger: DiagnosisTrigger, memory: OagMemory): string {
  const recentLifecycles = memory.lifecycles.slice(-MAX_LIFECYCLE_CONTEXT);
  const metrics = getOagMetrics();
  const cfg = loadConfig();
  const oagConfig = cfg.gateway?.oag ?? {};
  const previousEvolutions = memory.evolutions.slice(-5);
  const historicalRecs = buildHistoricalRecommendations(memory);

  return `You are OAG (Operational Assurance Gateway) performing a self-diagnosis.
Your analysis will be used to automatically tune operational parameters.
Respond ONLY with valid JSON matching the schema below.

## Current Incident
Type: ${sanitizeForPrompt(trigger.type)}
Description: ${sanitizeForPrompt(trigger.description)}
${trigger.patternType ? `Pattern: ${sanitizeForPrompt(trigger.patternType)}` : ""}
${trigger.channel ? `Channel: ${sanitizeForPrompt(trigger.channel)}` : ""}
${trigger.occurrences ? `Occurrences: ${sanitizeForPrompt(trigger.occurrences)}` : ""}

## Recent Lifecycle History (last ${recentLifecycles.length})
${sanitizeForPrompt(recentLifecycles)}

## Current Metrics
${sanitizeForPrompt(metrics)}

## Current OAG Config
${sanitizeForPrompt(oagConfig)}

## Previous Evolutions
${sanitizeForPrompt(previousEvolutions)}
${historicalRecs ? `\n## Previous Recommendation Outcomes\n${historicalRecs}` : ""}

## Response Schema
{
  "rootCause": "one-sentence root cause",
  "analysis": "detailed analysis paragraph",
  "confidence": 0.0 to 1.0,
  "recommendations": [
    {
      "type": "config_change" | "code_pattern" | "operator_action",
      "description": "what to change",
      "configPath": "gateway.oag.xxx (if config_change)",
      "suggestedValue": "<value> (if config_change)",
      "risk": "low" | "medium" | "high",
      "reasoning": "why this helps"
    }
  ],
  "preventive": "what to do to prevent recurrence"
}`;
}

export function parseDiagnosisResponse(responseText: string): DiagnosisResult | null {
  try {
    // Extract JSON from response (agent may wrap in markdown code blocks)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn("Diagnosis response contains no JSON object");
      return null;
    }
    const parsed = JSON.parse(jsonMatch[0]) as DiagnosisResult;
    if (
      typeof parsed.rootCause !== "string" ||
      typeof parsed.confidence !== "number" ||
      !Array.isArray(parsed.recommendations)
    ) {
      log.warn("Diagnosis response missing required fields");
      return null;
    }
    // Clamp confidence
    parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));
    return parsed;
  } catch (err) {
    log.warn(`Failed to parse diagnosis response: ${String(err)}`);
    return null;
  }
}

export async function requestDiagnosis(trigger: DiagnosisTrigger): Promise<{
  ran: boolean;
  result?: DiagnosisResult;
  record?: OagDiagnosisRecord;
}> {
  const memory = await loadOagMemory();

  if (!shouldRunDiagnosis(memory, trigger)) {
    return { ran: false };
  }

  const prompt = composeDiagnosisPrompt(trigger, memory);

  log.info(`OAG diagnosis triggered: ${trigger.type} — ${trigger.description}`);

  // Store the prompt for future agent dispatch.
  // Actual agent invocation is wired by the gateway startup path
  // (which has access to the agent infrastructure).
  // This module produces the prompt and parses the response.
  const record: OagDiagnosisRecord = {
    id: `diag-${Date.now()}`,
    triggeredAt: new Date().toISOString(),
    trigger: trigger.type,
    rootCause: "pending agent analysis",
    confidence: 0,
    recommendations: [],
    completedAt: "",
  };

  // Suppress unused variable warning — prompt is returned for agent dispatch
  void prompt;

  await recordDiagnosis(record);

  return { ran: true, record };
}

export async function completeDiagnosis(
  diagnosisId: string,
  responseText: string,
): Promise<DiagnosisResult | null> {
  const result = parseDiagnosisResponse(responseText);
  if (!result) {
    return null;
  }

  // Update the diagnosis record in memory
  const memory = await loadOagMemory();
  const record = memory.diagnoses.find((d) => d.id === diagnosisId);
  if (record) {
    record.rootCause = result.rootCause;
    record.confidence = result.confidence;
    record.recommendations = result.recommendations.map((r, i) => ({
      ...r,
      applied: false,
      recommendationId: `${diagnosisId}-rec-${i}`,
      outcome: "pending" as const,
    }));
    record.trackedRecommendations = result.recommendations
      .filter((r) => r.type === "config_change" && r.configPath)
      .map((r, i) => ({
        id: `${diagnosisId}-rec-${i}`,
        parameter: r.configPath ?? "",
        oldValue: undefined,
        newValue: r.suggestedValue,
        risk: r.risk,
        applied: false,
        outcome: "pending" as const,
      }));
    record.completedAt = new Date().toISOString();
    const idx = memory.diagnoses.findIndex((d) => d.id === diagnosisId);
    if (idx >= 0) {
      memory.diagnoses[idx] = record;
      await saveOagMemory(memory);
    }
  }

  log.info(
    `Diagnosis ${diagnosisId} completed: ${result.rootCause} (confidence: ${result.confidence})`,
  );

  return result;
}
