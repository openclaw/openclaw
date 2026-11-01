import { writeSync } from "node:fs";
import { expect } from "vitest";

export type OpenAIUltraWireObservation = {
  model?: string;
  reasoningEffort?: string;
  sessionsSpawn?: { strict?: boolean; categoryRequired: boolean };
  requestIndex?: number;
  traceparent?: string;
  dispatch?: {
    runId: string;
    callId: string;
    sessionId?: string;
    sessionKey?: string;
  } | null;
};

export const OPENAI_ULTRA_NORMAL_EFFORT = "medium";
// src/skills/workshop/review-run.ts runs background reviews with thinkLevel "low".
const SKILL_WORKSHOP_REVIEW_EFFORT = "low";

function logUltraProgress(message: string): void {
  writeSync(2, `[live] ${message}\n`);
}

export function assertOpenAIUltraWireEffort(params: {
  expectedModel: string;
  observations: OpenAIUltraWireObservation[];
  ultraRuns: ReadonlyMap<string, string>;
}): number {
  const matching = params.observations.filter((entry) => entry.model === params.expectedModel);
  expect(
    matching.length,
    `expected captured OpenAI requests for ${params.expectedModel}; captured=${params.observations.length}`,
  ).toBeGreaterThan(0);
  const expectedEffort = ({ dispatch }: OpenAIUltraWireObservation) => {
    if (!dispatch || params.ultraRuns.has(dispatch.runId)) {
      return "max";
    }
    // Skill Workshop reviews run after the session idles, under their own run, with the
    // review owner's fixed thinking level instead of the session's Ultra level.
    if (dispatch.runId.startsWith("skill-workshop-review:")) {
      return SKILL_WORKSHOP_REVIEW_EFFORT;
    }
    return "max";
  };
  const workshopReviews = matching.filter(
    (entry) => expectedEffort(entry) === SKILL_WORKSHOP_REVIEW_EFFORT,
  ).length;
  const violations = matching.flatMap((entry, index) =>
    entry.reasoningEffort === expectedEffort(entry)
      ? []
      : [
          {
            ...entry,
            requestIndex: entry.requestIndex ?? index + 1,
            expectedEffort: expectedEffort(entry),
          },
        ],
  );
  const first = violations[0];
  if (first) {
    logUltraProgress(
      `[ultra] ${params.expectedModel}: violations=${violations.length}/${matching.length} first=${JSON.stringify(violations.slice(0, 3))}`,
    );
  }
  expect(
    matching.every((entry) => entry.reasoningEffort === expectedEffort(entry)),
    `expected effort=${first?.expectedEffort ?? "max"} for ${params.expectedModel}; observed=${first?.reasoningEffort ?? "missing"} request=${first?.requestIndex} run=${first?.dispatch?.runId ?? "unknown"}; violations=${violations.length}/${matching.length}`,
  ).toBe(true);
  const spawnSchemas = [
    ...new Set(
      matching.flatMap((entry) =>
        entry.sessionsSpawn ? [JSON.stringify(entry.sessionsSpawn)] : [],
      ),
    ),
  ];
  logUltraProgress(
    `[ultra] ${params.expectedModel}: checked=${matching.length} max=${matching.length - workshopReviews} workshop_reviews=${workshopReviews} sessions_spawn wire schemas=${spawnSchemas.join(",")}`,
  );
  return matching.length;
}
