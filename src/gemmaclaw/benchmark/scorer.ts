/**
 * Scoring logic for benchmark tasks.
 *
 * Two scoring modes:
 *   1. Deterministic (--mock): compare model output against expected output using
 *      exact match, fuzzy match, contains-all, and JSON structure checks.
 *   2. LLM Judge (default): send output + criteria to the model itself for qualitative grading.
 */

import type { BenchmarkTask } from "./tasks.js";

export type TaskScore = {
  taskId: string;
  score: number;
  maxScore: number;
  percentage: number;
  method: "deterministic" | "llm_judge";
  details: string;
  passed: boolean;
};

// ── Deterministic scoring ──

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/["""'']/g, '"')
    .trim();
}

function scoreExactMatch(output: string, expected: string[]): { score: number; detail: string } {
  const norm = normalizeText(output);
  let matched = 0;
  const misses: string[] = [];

  for (const exp of expected) {
    if (norm.includes(normalizeText(exp))) {
      matched++;
    } else {
      misses.push(exp);
    }
  }

  const ratio = matched / expected.length;
  const detail =
    misses.length === 0 ? "All expected strings found" : `Missing: ${misses.join(", ")}`;

  return { score: ratio, detail };
}

function scoreContainsAll(output: string, expected: string[]): { score: number; detail: string } {
  return scoreExactMatch(output, expected);
}

function scoreJsonStructure(
  output: string,
  requiredKeys: string[],
): { score: number; detail: string } {
  // Try to extract JSON from the output (may have markdown fences or extra text).
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { score: 0, detail: "No JSON object found in output" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const keys = new Set(Object.keys(parsed).map((k) => k.toLowerCase()));
    let matched = 0;
    const misses: string[] = [];

    for (const rk of requiredKeys) {
      if (keys.has(rk.toLowerCase())) {
        matched++;
      } else {
        misses.push(rk);
      }
    }

    const ratio = matched / requiredKeys.length;
    const detail =
      misses.length === 0
        ? "All required keys present, valid JSON"
        : `Missing keys: ${misses.join(", ")}`;

    return { score: ratio, detail };
  } catch {
    return { score: 0, detail: "Invalid JSON in output" };
  }
}

function scoreMockDeterministic(
  output: string,
  task: BenchmarkTask,
): { score: number; detail: string } {
  if (!task.mock) {
    return { score: 0, detail: "No mock data defined for this task" };
  }

  const normOutput = normalizeText(output);
  const normExpected = normalizeText(task.mock.expectedOutput);

  // Exact match (after normalization).
  if (normOutput === normExpected) {
    return { score: 1, detail: "Exact match" };
  }

  // Check fuzzy matches.
  if (task.mock.fuzzyMatches) {
    for (const fm of task.mock.fuzzyMatches) {
      if (normOutput.includes(normalizeText(fm))) {
        return { score: 0.9, detail: `Fuzzy match: "${fm}"` };
      }
    }
  }

  // Fall through to grading-type-based scoring.
  switch (task.grading.type) {
    case "exact_match":
      return scoreExactMatch(output, task.grading.expected ?? []);
    case "contains_all":
      return scoreContainsAll(output, task.grading.expected ?? []);
    case "json_structure":
      return scoreJsonStructure(output, task.grading.requiredKeys ?? []);
    case "output_quality": {
      // For output_quality in mock mode, check if output contains key phrases
      // from the expected mock output.
      const expectedWords = normExpected.split(/\s+/).filter((w) => w.length > 4);
      const uniqueWords = [...new Set(expectedWords)];
      let hits = 0;
      for (const w of uniqueWords) {
        if (normOutput.includes(w)) {
          hits++;
        }
      }
      const ratio = uniqueWords.length > 0 ? hits / uniqueWords.length : 0;
      return {
        score: ratio,
        detail: `Keyword overlap: ${hits}/${uniqueWords.length} significant words`,
      };
    }
    default:
      return { score: 0, detail: `Unknown grading type: ${task.grading.type as string}` };
  }
}

export function scoreDeterministic(output: string, task: BenchmarkTask): TaskScore {
  const { score: ratio, detail } = scoreMockDeterministic(output, task);
  const score = Math.round(ratio * task.grading.maxScore * 10) / 10;

  return {
    taskId: task.id,
    score,
    maxScore: task.grading.maxScore,
    percentage: Math.round(ratio * 100),
    method: "deterministic",
    details: detail,
    passed: ratio >= 0.7,
  };
}

// ── LLM Judge scoring ──

export function buildJudgePrompt(task: BenchmarkTask, modelOutput: string): string {
  const criteria = task.grading.criteria ?? [];
  const criteriaText =
    criteria.length > 0
      ? criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "Evaluate the quality and correctness of the response.";

  return `You are an expert evaluator scoring an AI model's response.

TASK: ${task.name}
PROMPT GIVEN TO MODEL:
${task.prompt}

MODEL'S RESPONSE:
${modelOutput}

GRADING CRITERIA (max ${task.grading.maxScore} points):
${criteriaText}

Score the response. For each criterion, state whether it was met.
Then give a final score as an integer from 0 to ${task.grading.maxScore}.

Reply in this EXACT format:
SCORE: <number>
REASONING: <brief explanation>`;
}

export function parseJudgeResponse(response: string, maxScore: number): TaskScore {
  const scoreMatch = response.match(/SCORE:\s*(\d+(?:\.\d+)?)/i);
  const reasoningMatch = response.match(/REASONING:\s*([\s\S]+)/i);

  const score = scoreMatch ? Math.min(Number(scoreMatch[1]), maxScore) : 0;
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : "No reasoning provided";

  return {
    taskId: "",
    score,
    maxScore,
    percentage: Math.round((score / maxScore) * 100),
    method: "llm_judge",
    details: reasoning,
    passed: score / maxScore >= 0.7,
  };
}
