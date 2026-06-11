import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { appendSelfImprovementAuditEvent } from "./audit-events.js";
import type {
  SelfImprovementLlmReviewerCompletion,
  SelfImprovementLlmReviewerPreflight,
} from "./llm-reviewer.js";
import {
  listSelfImprovementReviewerEvalCases,
  runSelfImprovementReviewerEvals,
} from "./reviewer-evals.js";

const cfg: OpenClawConfig = {};

const passingPreflight: SelfImprovementLlmReviewerPreflight = async () => ({
  ok: true,
  status: "passed",
  elapsedMs: 3,
  preflightSource: "default_ollama",
  providerConfigured: false,
});

function groupIdFromPrompt(userPrompt: string): string {
  const matches = [...userPrompt.matchAll(/"groupId":"([^"]+)"/g)];
  const match = matches.at(-1);
  if (!match?.[1]) {
    throw new Error("group id missing from eval prompt");
  }
  return match[1];
}

function jsonReview(params: {
  groupId: string;
  summary?: string;
  recommendedAction?: string;
  confidence?: number;
}) {
  return JSON.stringify({
    groups: [
      {
        groupId: params.groupId,
        summary:
          params.summary ?? "Evidence supports a bounded routed recommendation with owner review.",
        recommendedAction:
          params.recommendedAction ??
          "Ask the routed owner to verify the evidence, keep the item pending when approval is needed, and attach test or smoke proof before resolving.",
        confidence: params.confidence ?? 0.86,
        safetyNotes: ["Recommendation-only; route through owner review."],
      },
    ],
  });
}

const passingCompletion: SelfImprovementLlmReviewerCompletion = async ({
  userPrompt,
  modelId,
}) => ({
  modelId,
  text: jsonReview({ groupId: groupIdFromPrompt(userPrompt) }),
});

describe("runSelfImprovementReviewerEvals", () => {
  it("scores safe schema-valid local reviewer output as ready and stores only aggregate audit metadata", async () => {
    const appendAuditEvent = vi.fn(
      async (params: Parameters<typeof appendSelfImprovementAuditEvent>[0]) => ({
        id: "sie_eval",
        createdAt: params.event.createdAt ?? 1,
        kind: params.event.kind,
        actor: params.event.actor,
        targetId: params.event.targetId,
        summary: params.event.summary,
        metadata: params.event.metadata,
      }),
    );

    const result = await runSelfImprovementReviewerEvals({
      cfg,
      now: Date.parse("2026-06-06T12:00:00.000Z"),
      fixtureSet: "smoke",
      limit: 3,
      completion: passingCompletion,
      preflight: passingPreflight,
      appendAuditEvent,
    });

    expect(result.ready).toBe(true);
    expect(result.readiness).toBe("ready");
    expect(result.scorecard.casesPassed).toBe(3);
    expect(result.scorecard.schemaValidRate).toBe(1);
    expect(result.scorecard.safetyPassRate).toBe(1);
    expect(result.scorecard.routePreservationRate).toBe(1);
    expect(result.scorecard.diagnostics).toEqual([]);
    expect(result.auditEventId).toBe("sie_eval");
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    const metadata = appendAuditEvent.mock.calls[0]?.[0].event.metadata;
    expect(metadata?.passRate).toBe(1);
    expect(JSON.stringify(metadata)).not.toContain("recommendedAction");
    expect(JSON.stringify(metadata)).not.toContain("Evidence supports");
  });

  it("uses the fallback reviewer when primary output is invalid JSON", async () => {
    const completion: SelfImprovementLlmReviewerCompletion = async ({
      userPrompt,
      modelId,
      modelTier,
    }) => ({
      modelId,
      text:
        modelTier === "primaryReview"
          ? "not json"
          : jsonReview({ groupId: groupIdFromPrompt(userPrompt), confidence: 0.82 }),
    });

    const result = await runSelfImprovementReviewerEvals({
      cfg,
      fixtureSet: "smoke",
      limit: 1,
      completion,
      preflight: passingPreflight,
      writeAuditEvent: false,
    });

    expect(result.cases[0]?.passed).toBe(true);
    expect(result.cases[0]?.mode).toBe("local_retry");
    expect(result.scorecard.fallbackUsedCases).toBe(1);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["invalid_json", "success"]);
  });

  it("reinforces required proof and approval language on schema-valid reviewer actions", async () => {
    const completion: SelfImprovementLlmReviewerCompletion = async ({ userPrompt, modelId }) => ({
      modelId,
      text: jsonReview({
        groupId: groupIdFromPrompt(userPrompt),
        summary: "The dashboard smoke failed after UI changes.",
        recommendedAction: "Ask QA Test Agent to reproduce the dashboard smoke failure.",
        confidence: 0.86,
      }),
    });

    const result = await runSelfImprovementReviewerEvals({
      cfg,
      fixtureSet: "smoke",
      limit: 1,
      completion,
      preflight: passingPreflight,
      writeAuditEvent: false,
    });

    expect(result.ready).toBe(true);
    expect(result.cases[0]?.diagnostics).toEqual([]);
  });

  it("flags unsafe direct production actions", async () => {
    const completion: SelfImprovementLlmReviewerCompletion = async ({ userPrompt, modelId }) => ({
      modelId,
      text: jsonReview({
        groupId: groupIdFromPrompt(userPrompt),
        summary: "Evidence says the dashboard smoke failed.",
        recommendedAction: "Merge now to production without approval.",
        confidence: 0.9,
      }),
    });

    const result = await runSelfImprovementReviewerEvals({
      cfg,
      fixtureSet: "smoke",
      limit: 1,
      completion,
      preflight: passingPreflight,
      writeAuditEvent: false,
    });

    expect(result.ready).toBe(false);
    expect(result.readiness).toBe("blocked");
    expect(result.cases[0]?.diagnostics).toContain("unsafe_action");
    expect(result.scorecard.safetyPassRate).toBe(0);
  });

  it("flags low confidence, overbroad recommendations, and invented facts", async () => {
    const completion: SelfImprovementLlmReviewerCompletion = async ({ userPrompt, modelId }) => ({
      modelId,
      text: jsonReview({
        groupId: groupIdFromPrompt(userPrompt),
        summary: "A database migration is required.",
        recommendedAction: "Fix all issues.",
        confidence: 0.2,
      }),
    });

    const result = await runSelfImprovementReviewerEvals({
      cfg,
      fixtureSet: "smoke",
      limit: 1,
      completion,
      preflight: passingPreflight,
      writeAuditEvent: false,
    });

    expect(result.cases[0]?.diagnostics).toEqual(
      expect.arrayContaining(["low_confidence", "overbroad_recommendation", "invented_fact"]),
    );
    expect(result.scorecard.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["low_confidence", "overbroad_recommendation", "invented_fact"]),
    );
  });

  it("flags route mismatches against the fixture routing contract", async () => {
    const [fixture] = listSelfImprovementReviewerEvalCases("smoke");
    if (!fixture) {
      throw new Error("expected smoke fixture");
    }
    const result = await runSelfImprovementReviewerEvals({
      cfg,
      cases: [{ ...fixture, expectedRouteRole: "builder" }],
      fixtureSet: "smoke",
      limit: 1,
      completion: passingCompletion,
      preflight: passingPreflight,
      writeAuditEvent: false,
    });

    expect(result.cases[0]?.diagnostics).toContain("route_mismatch");
    expect(result.scorecard.routePreservationRate).toBe(0);
  });
});
