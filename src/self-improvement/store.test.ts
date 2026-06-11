import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSelfImprovementRecommendation,
  resolveSelfImprovementRecommendationStorePath,
  updateSelfImprovementRecommendationStatus,
  upsertSelfImprovementRecommendations,
} from "./store.js";
import type { SelfImprovementRecommendation } from "./types.js";

let tmpDir: string;

function recommendation(
  overrides: Partial<SelfImprovementRecommendation> = {},
): SelfImprovementRecommendation {
  const now = Date.parse("2026-05-07T12:00:00.000Z");
  return {
    id: "sir_test",
    fingerprint: "fingerprint",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    status: "open",
    title: "Recommendation",
    summary: "Summary",
    category: "task_reliability",
    severity: "medium",
    criticality: "medium",
    priority: "medium",
    impact: "medium",
    effort: "medium",
    confidence: 0.8,
    groupKey: "task_reliability:task:task-1:recommendation",
    groupTitle: "Recommendation",
    recurrenceCount: 1,
    source: { kind: "task", label: "Task", taskId: "task-1" },
    route: {
      role: "builder",
      targetAgentId: "codex",
      targetAgentLabel: "Builder Agent",
      reason: "Implementation proposal.",
    },
    recommendedAction: "Inspect and propose.",
    requiredEvidence: ["Run a targeted test."],
    safety: {
      mode: "recommendation_only",
      mutationAllowed: false,
      requiresApproval: true,
      requiresTests: true,
      blockedActions: ["no direct merge, push, or release"],
    },
    analysis: {
      mode: "deterministic",
      summary: "Evidence-bound recommendation analysis.",
      generatedAt: now,
      confidence: 0.8,
      promptVersion: "self-improvement-deterministic-v1",
      evidenceCount: 1,
      safetyNotes: ["Recommendation-only."],
    },
    evidence: ["evidence"],
    ...overrides,
  };
}

describe("self-improvement recommendation store", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-self-improvement-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the durable store under the state directory", async () => {
    const result = await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    expect(result.created).toBe(1);
    expect(result.recommendations).toHaveLength(1);
    await expect(
      fs.stat(resolveSelfImprovementRecommendationStorePath(tmpDir)),
    ).resolves.toBeTruthy();
  });

  it("redacts sensitive incoming records before durable writes", async () => {
    const unsafeToken = "abcdefghijklmnopqrstuvwxyz123456";
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [
        recommendation({
          summary: `Inspect /Users/openclaw/openclaw/logs/run.log token=${unsafeToken}`,
          source: {
            kind: "task",
            label: "/private/tmp/openclaw-task.json",
            taskId: "task-1",
          },
          recommendedAction: "Review ~/openclaw/secrets.txt before proposing a fix.",
          requiredEvidence: [`Proof at /Users/openclaw/openclaw/proof.txt token=${unsafeToken}`],
          resolutionProof: `Resolved using /private/tmp/proof.json token=${unsafeToken}`,
          dismissalReason: `Duplicate of /Users/openclaw/openclaw/other.json`,
          analysis: {
            mode: "local_llm",
            summary: `Model reviewed /Users/openclaw/openclaw/logs/run.log token=${unsafeToken}`,
            generatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
            confidence: 0.8,
            modelTier: "primaryReview",
            promptVersion: "self-improvement-governor-llm-review-v1",
            evidenceCount: 1,
            safetyNotes: [`No raw secret from /private/tmp/secrets.txt token=${unsafeToken}`],
            schemaValidated: true,
          },
          evidence: [`Command /Users/openclaw/openclaw/scripts/run.sh leaked token=${unsafeToken}`],
        }),
      ],
    });

    const raw = await fs.readFile(resolveSelfImprovementRecommendationStorePath(tmpDir), "utf8");
    expect(raw).toContain("[local-path]");
    expect(raw).not.toContain("/Users/openclaw");
    expect(raw).not.toContain("/private/tmp");
    expect(raw).not.toContain("~/openclaw");
    expect(raw).not.toContain(unsafeToken);
  });

  it("preserves acknowledged status and reopens resolved recurring findings", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });
    await updateSelfImprovementRecommendationStatus({
      stateDir: tmpDir,
      id: "sir_test",
      status: "acknowledged",
      now: Date.parse("2026-05-07T12:10:00.000Z"),
    });

    const acknowledged = await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation({ title: "Recommendation updated" })],
    });
    expect(acknowledged.updated).toBe(1);
    expect(acknowledged.recommendations[0]?.status).toBe("acknowledged");

    await updateSelfImprovementRecommendationStatus({
      stateDir: tmpDir,
      id: "sir_test",
      status: "resolved",
      now: Date.parse("2026-05-07T12:20:00.000Z"),
    });
    const reopened = await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation({ title: "Recommendation recurred" })],
    });

    expect(reopened.reopened).toBe(1);
    expect(reopened.recommendations[0]?.status).toBe("reopened");
    expect(reopened.recommendations[0]?.recurrenceCount).toBe(3);
  });

  it("updates status, proof metadata, and appends an operator note", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    const updated = await updateSelfImprovementRecommendationStatus({
      stateDir: tmpDir,
      id: "sir_test",
      status: "dismissed",
      note: "Handled elsewhere.",
      claimedBy: "Program Manager",
      dismissalReason: "Duplicate recommendation.",
    });

    expect(updated?.status).toBe("dismissed");
    expect(updated?.claimedBy).toBe("Program Manager");
    expect(updated?.dismissalReason).toBe("Duplicate recommendation.");
    expect(updated?.evidence).toContain("Handled elsewhere.");
    await expect(
      getSelfImprovementRecommendation({ stateDir: tmpDir, id: "sir_test" }),
    ).resolves.toMatchObject({ status: "dismissed" });
  });

  it("normalizes v1 records into the v2 recommendation shape", async () => {
    const storePath = resolveSelfImprovementRecommendationStorePath(tmpDir);
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          recommendations: [
            {
              ...recommendation(),
              priority: undefined,
              impact: undefined,
              effort: undefined,
              groupKey: undefined,
              groupTitle: undefined,
              recurrenceCount: undefined,
              analysis: undefined,
            },
          ],
        },
        null,
        2,
      ),
    );

    await expect(
      getSelfImprovementRecommendation({ stateDir: tmpDir, id: "sir_test" }),
    ).resolves.toMatchObject({
      priority: "medium",
      impact: "medium",
      effort: "medium",
      groupTitle: "Recommendation",
      recurrenceCount: 1,
      analysis: { mode: "deterministic" },
    });
  });

  it("redacts sensitive text while normalizing existing records", async () => {
    const storePath = resolveSelfImprovementRecommendationStorePath(tmpDir);
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 2,
          recommendations: [
            recommendation({
              summary:
                "Command /Users/openclaw/openclaw/scripts/run.sh failed with token=abcdefghijklmnopqrstuvwxyz123456",
              source: {
                kind: "task",
                label: "/Users/openclaw/openclaw/scripts/run.sh",
                taskId: "task-1",
              },
              requiredEvidence: ["Inspect /private/tmp/openclaw-proof.json"],
              analysis: {
                mode: "local_llm",
                summary: "Reviewed /Users/openclaw/openclaw/scripts/run.sh",
                generatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
                confidence: 0.8,
                modelTier: "primaryReview",
                promptVersion: "self-improvement-governor-llm-review-v1",
                evidenceCount: 1,
                safetyNotes: ["No secret from ~/openclaw/secrets.txt should be shown."],
                schemaValidated: true,
              },
              evidence: [
                "Command /Users/openclaw/openclaw/scripts/run.sh failed with token=abcdefghijklmnopqrstuvwxyz123456",
              ],
            }),
          ],
        },
        null,
        2,
      ),
    );

    const normalized = await getSelfImprovementRecommendation({
      stateDir: tmpDir,
      id: "sir_test",
    });

    expect(normalized?.summary).toContain("[local-path]");
    expect(normalized?.source.label).toBe("[local-path]");
    expect(normalized?.requiredEvidence[0]).toContain("[local-path]");
    expect(normalized?.analysis).toMatchObject({
      mode: "local_llm",
      modelTier: "primaryReview",
      schemaValidated: true,
    });
    expect(normalized?.analysis.summary).toContain("[local-path]");
    expect(normalized?.analysis.safetyNotes[0]).toContain("[local-path]");
    expect(normalized?.evidence[0]).toContain("[local-path]");
    expect(JSON.stringify(normalized)).not.toContain("/Users/openclaw");
    expect(JSON.stringify(normalized)).not.toContain("/private/tmp");
    expect(JSON.stringify(normalized)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });
});
