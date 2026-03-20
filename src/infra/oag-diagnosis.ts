import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  type OagDiagnosisRecord,
  type OagMemory,
  loadOagMemory,
  recordDiagnosis,
  withOagMemory,
} from "./oag-memory.js";
import { getOagMetrics } from "./oag-metrics.js";

const log = createSubsystemLogger("oag/diagnosis");

const DIAGNOSIS_COOLDOWN_MS = 4 * 60 * 60_000; // 4 hours
const MAX_LIFECYCLE_CONTEXT = 5;
const MAX_PROMPT_VALUE_LENGTH = 200;
const MAX_HISTORICAL_RECOMMENDATIONS = 10;

/**
 * Patterns that could be used for prompt injection attacks.
 * These are neutralized by replacing with safe alternatives.
 */
const PROMPT_INJECTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Role markers that could hijack conversation context (anchored to line start to avoid false positives)
  { pattern: /^(System|User|Assistant|Human|AI|Model):\s*/gm, replacement: "[ROLE]: " },
  // Instruction override attempts
  {
    pattern:
      /\b(Ignore|Disregard|Forget|Skip)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|directions?|rules)/gi,
    replacement: "[IGNORE_BLOCKED]",
  },
  // Common injection phrases
  {
    pattern: /\b(new\s+instructions?|override\s+(previous|prior|default)|disregard\s+everything)/gi,
    replacement: "[INJECTION_BLOCKED]",
  },
  // Code fence attempts that could break prompt structure (matches both opening and closing)
  {
    pattern: /```(?:\s*(?:json|javascript|js|typescript|ts|python|py|bash|shell|sh)?)?\s*/gi,
    replacement: "[CODE_FENCE_BLOCKED]",
  },
  // XML-like tags that could be interpreted as prompt markers (allows attributes)
  {
    pattern:
      /<\/?(?:system|user|assistant|instruction|prompt|context|input|output)(?:\s+[^>]*)?>/gi,
    replacement: "[TAG_BLOCKED]",
  },
];

/**
 * Escape prompt injection patterns in a string.
 * Replaces known injection patterns with safe placeholders to prevent
 * malicious instructions from hijacking the diagnosis output.
 *
 * @param text - The text to escape
 * @returns The text with injection patterns neutralized
 */
export function escapePromptInjection(text: string): string {
  let escaped = text;
  for (const { pattern, replacement } of PROMPT_INJECTION_PATTERNS) {
    escaped = escaped.replace(pattern, replacement);
  }
  return escaped;
}

/**
 * Recursively sanitize all string values in a nested structure.
 * This ensures prompt injection patterns are escaped BEFORE JSON serialization,
 * so anchored patterns like ^(System|...): match at actual string starts.
 */
function sanitizeDeep(v: unknown): unknown {
  if (typeof v === "string") {
    return escapePromptInjection(v);
  }
  if (Array.isArray(v)) {
    return v.map(sanitizeDeep);
  }
  if (v && typeof v === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      result[k] = sanitizeDeep(val);
    }
    return result;
  }
  return v;
}

/**
 * Sanitize an arbitrary value for safe inclusion in a diagnosis prompt.
 * JSON-stringifies the value, truncates to MAX_PROMPT_VALUE_LENGTH chars,
 * and escapes prompt injection patterns to prevent hijacking.
 */
export function sanitizeForPrompt(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(sanitizeDeep(value));
  } catch {
    serialized = escapePromptInjection(String(value));
  }
  // Escape injection patterns BEFORE truncation to prevent attacks hidden at boundaries
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

export type DiagnosisModelConfig = {
  /** Which model mode to use: lightweight (built-in) or embedded (user's configured LLM). */
  mode: "lightweight" | "embedded";
  /** @experimental - "embedded" announced but not yet wired */
  useEmbeddedRunner: boolean;
};

/**
 * Resolves which model should be used for OAG diagnosis.
 * If `gateway.oag.diagnosis.model` is "embedded", returns embedded mode so
 * callers can dispatch to the user's configured LLM. Otherwise returns
 * lightweight mode (default -- no behavior change for existing users).
 *
 * @experimental Embedded mode is announced but not yet wired to the embedded runner.
 */
export function getDiagnosisModelConfig(cfg?: OpenClawConfig): DiagnosisModelConfig {
  const model = cfg?.gateway?.oag?.diagnosis?.model;
  if (model === "embedded") {
    return { mode: "embedded", useEmbeddedRunner: true };
  }
  return { mode: "lightweight", useEmbeddedRunner: false };
}

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
    // Extract JSON from response (agent may wrap in ```json ... ``` fences).
    // Try code-fence extraction first to avoid the greedy-regex multi-object
    // problem; fall back to greedy match for plain JSON responses.
    const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonStr = fenceMatch ? fenceMatch[1] : responseText.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonStr) {
      log.warn("Diagnosis response contains no JSON object");
      return null;
    }
    const parsed = JSON.parse(jsonStr) as DiagnosisResult;
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
  prompt?: string;
}> {
  const memory = await loadOagMemory();

  if (!shouldRunDiagnosis(memory, trigger)) {
    return { ran: false };
  }

  const cfg = loadConfig();
  if (getDiagnosisModelConfig(cfg).useEmbeddedRunner) {
    log.warn(
      "oag.diagnosis.model=embedded is experimental and not yet wired to the embedded runner; using lightweight diagnosis",
    );
  }

  const prompt = composeDiagnosisPrompt(trigger, memory);

  log.info(`OAG diagnosis triggered: ${trigger.type} — ${trigger.description}`);

  // Actual agent invocation is wired by the gateway startup path via
  // registerDiagnosisDispatch(). The prompt is returned so callers can
  // attempt live dispatch when the dispatch function is available.
  const record: OagDiagnosisRecord = {
    id: `diag-${Date.now()}`,
    triggeredAt: new Date().toISOString(),
    trigger: trigger.type,
    rootCause: "pending agent analysis",
    confidence: 0,
    recommendations: [],
    completedAt: "",
  };

  await recordDiagnosis(record);

  return { ran: true, record, prompt };
}

export async function completeDiagnosis(
  diagnosisId: string,
  responseText: string,
): Promise<DiagnosisResult | null> {
  const result = parseDiagnosisResponse(responseText);
  if (!result) {
    return null;
  }

  // Update the diagnosis record in memory via the serialized write chain
  await withOagMemory((memory) => {
    const idx = memory.diagnoses.findIndex((d) => d.id === diagnosisId);
    if (idx < 0) {
      return false; // skip save when diagnosis not found
    }
    const record = memory.diagnoses[idx];
    const updated: OagDiagnosisRecord = {
      ...record,
      rootCause: result.rootCause,
      confidence: result.confidence,
      recommendations: result.recommendations.map((r, i) => ({
        ...r,
        applied: false,
        recommendationId: `${diagnosisId}-rec-${i}`,
        outcome: "pending" as const,
      })),
      trackedRecommendations: result.recommendations
        .map((r, i) => ({ ...r, _origIdx: i }))
        .filter((r) => r.type === "config_change" && r.configPath)
        .map((r) => ({
          id: `${diagnosisId}-rec-${r._origIdx}`,
          parameter: r.configPath ?? "",
          oldValue: undefined,
          newValue: r.suggestedValue,
          risk: r.risk,
          applied: false,
          outcome: "pending" as const,
        })),
      completedAt: new Date().toISOString(),
    };
    memory.diagnoses[idx] = updated;
  });

  log.info(
    `Diagnosis ${diagnosisId} completed: ${result.rootCause} (confidence: ${result.confidence})`,
  );

  return result;
}
