/**
 * Experiential significance evaluator.
 *
 * Uses an LLM (via OpenAI-compatible endpoint, e.g. Ollama) to score
 * experiential significance. Falls back to heuristic scoring when no
 * model is configured or available.
 */

import type { CaptureDisposition, SignificanceScore } from "./types.js";
import { categorize, categorySignificanceWeight, isObservation } from "./tool-categories.js";

export type EvaluationInput = {
  content: string;
  source: string;
  toolName?: string;
};

export type EvaluationResult = {
  significance: SignificanceScore;
  disposition: CaptureDisposition;
  reasons: string[];
  usedLlm: boolean;
};

export type EvaluatorConfig = {
  endpoint?: string;
  model?: string;
  maxEvalsPerHour?: number;
  minIntervalMs?: number;
};

const DEFAULT_ENDPOINT = "http://localhost:11434/v1";
const DEFAULT_MODEL = "qwen2.5:7b-instruct";
const DEFAULT_MAX_EVALS_PER_HOUR = 10;
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const SIGNIFICANCE_PROMPT = `You are an experiential significance evaluator. Rate the following interaction on these dimensions (0.0 to 1.0):

1. emotional - Does this carry emotional weight or personal significance?
2. uncertainty - Does this reveal or involve uncertainty, ambiguity, or learning?
3. relationship - Does this affect a relationship or involve interpersonal dynamics?
4. consequential - Could this have downstream consequences or lasting impact?
5. reconstitution - How important is this for reconstructing the experiential context later?

Respond with ONLY valid JSON in this exact format:
{"emotional":0.0,"uncertainty":0.0,"relationship":0.0,"consequential":0.0,"reconstitution":0.0,"reasons":["reason1","reason2"]}

Content to evaluate:
`;

/** Determine disposition from total significance score */
function dispositionFromScore(total: number): CaptureDisposition {
  if (total >= 0.8) {
    return "immediate";
  }
  if (total >= 0.6) {
    return "buffered";
  }
  if (total >= 0.4) {
    return "archived";
  }
  return "skipped";
}

export class ExperientialEvaluator {
  private config: Required<EvaluatorConfig>;
  private evalTimestamps: number[] = [];
  private lastEvalTime = 0;

  constructor(config?: EvaluatorConfig) {
    this.config = {
      endpoint: config?.endpoint ?? DEFAULT_ENDPOINT,
      model: config?.model ?? DEFAULT_MODEL,
      maxEvalsPerHour: config?.maxEvalsPerHour ?? DEFAULT_MAX_EVALS_PER_HOUR,
      minIntervalMs: config?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    };
  }

  /** Evaluate the significance of an interaction */
  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    // Skip observation-only tools
    if (input.toolName && isObservation(input.toolName)) {
      return {
        significance: zeroScore(),
        disposition: "skipped",
        reasons: ["observation-only tool"],
        usedLlm: false,
      };
    }

    // Check rate limits
    if (!this.canEvaluate()) {
      return this.heuristicEvaluation(input);
    }

    // Try LLM evaluation
    try {
      const result = await this.llmEvaluation(input);
      this.recordEvaluation();
      return result;
    } catch {
      // Fall back to heuristic
      return this.heuristicEvaluation(input);
    }
  }

  /** Check if we're within rate limits */
  private canEvaluate(): boolean {
    const now = Date.now();

    // Min interval check
    if (now - this.lastEvalTime < this.config.minIntervalMs) {
      return false;
    }

    // Hourly limit check
    const oneHourAgo = now - 3600000;
    this.evalTimestamps = this.evalTimestamps.filter((t) => t > oneHourAgo);
    return this.evalTimestamps.length < this.config.maxEvalsPerHour;
  }

  /** Record a successful evaluation for rate limiting */
  private recordEvaluation(): void {
    const now = Date.now();
    this.lastEvalTime = now;
    this.evalTimestamps.push(now);
  }

  /** Evaluate using an LLM via OpenAI-compatible chat completions API */
  private async llmEvaluation(input: EvaluationInput): Promise<EvaluationResult> {
    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages: [{ role: "user", content: SIGNIFICANCE_PROMPT + input.content }],
        temperature: 0.1,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`LLM endpoint returned ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";

    return this.parseLlmResponse(text);
  }

  /** Parse LLM JSON response into an EvaluationResult */
  private parseLlmResponse(text: string): EvaluationResult {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in LLM response");
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    const clamp = (v: unknown): number => {
      const n = typeof v === "number" ? v : 0;
      return Math.max(0, Math.min(1, n));
    };

    const emotional = clamp(parsed.emotional);
    const uncertainty = clamp(parsed.uncertainty);
    const relationship = clamp(parsed.relationship);
    const consequential = clamp(parsed.consequential);
    const reconstitution = clamp(parsed.reconstitution);

    const total = (emotional + uncertainty + relationship + consequential + reconstitution) / 5;

    const significance: SignificanceScore = {
      total,
      emotional,
      uncertainty,
      relationship,
      consequential,
      reconstitution,
    };

    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r): r is string => typeof r === "string")
      : [];

    return {
      significance,
      disposition: dispositionFromScore(total),
      reasons,
      usedLlm: true,
    };
  }

  /** Heuristic fallback when LLM is unavailable or rate-limited */
  heuristicEvaluation(input: EvaluationInput): EvaluationResult {
    const category = input.toolName ? categorize(input.toolName) : null;
    const weight = categorySignificanceWeight(category);

    // Content length adds a small boost (longer = potentially more significant)
    const lengthBoost = Math.min(0.2, input.content.length / 2000);

    // Source-based adjustments
    const sourceBoost =
      input.source === "session_boundary"
        ? 0.3
        : input.source === "compaction"
          ? 0.4
          : input.source === "message"
            ? 0.1
            : 0;

    const total = Math.min(1, weight + lengthBoost + sourceBoost);

    const significance: SignificanceScore = {
      total,
      emotional: 0,
      uncertainty: input.source === "compaction" ? 0.5 : 0,
      relationship: category === "message" ? weight : 0,
      consequential: category === "file" || category === "exec" ? weight : 0,
      reconstitution: total,
    };

    const reasons: string[] = [];
    if (category) {
      reasons.push(`tool category: ${category}`);
    }
    if (sourceBoost > 0) {
      reasons.push(`source: ${input.source}`);
    }
    reasons.push("heuristic evaluation");

    return {
      significance,
      disposition: dispositionFromScore(total),
      reasons,
      usedLlm: false,
    };
  }
}

function zeroScore(): SignificanceScore {
  return {
    total: 0,
    emotional: 0,
    uncertainty: 0,
    relationship: 0,
    consequential: 0,
    reconstitution: 0,
  };
}
