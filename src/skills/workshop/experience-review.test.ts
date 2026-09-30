import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkshopChange } from "./changes.kernel.js";
import { runSkillExperienceReview } from "./experience-review.js";
import { createExperienceReviewCandidate } from "./experience-review.test-support.js";

const mocks = vi.hoisted(() => ({
  runSkillWorkshopReview: vi.fn(),
  listWorkshopChanges: vi.fn(),
  postWorkshopChangeNotice: vi.fn(async () => {}),
}));
vi.mock("./review-run.js", () => ({ runSkillWorkshopReview: mocks.runSkillWorkshopReview }));
vi.mock("./library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./library.js")>()),
  listWorkshopChanges: mocks.listWorkshopChanges,
}));
vi.mock("./review-outcome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-outcome.js")>()),
  postWorkshopChangeNotice: mocks.postWorkshopChangeNotice,
}));

const tempPaths: string[] = [];
afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runSkillExperienceReview", () => {
  it("announces changes committed before the review run failed", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-review-failed-"));
    tempPaths.push(workspaceDir);
    const candidate = await createExperienceReviewCandidate(
      "review-fails-after-commit",
      [{ role: "user", content: "Reconcile the budget.", timestamp: 1 }],
      { workspaceDir, modelId: "gpt-test" },
    );
    const committed: WorkshopChange = {
      id: "c1",
      agentId: "main",
      skillName: "actual-budget-operations",
      action: "patch",
      actor: "review",
      summary: "tightened reconciliation step",
      versionId: "20260101T000000001Z-patch",
      createdAtMs: 1,
    };
    mocks.listWorkshopChanges.mockResolvedValue([committed]);
    // The skill_workshop call committed; the follow-up model request then timed out.
    mocks.runSkillWorkshopReview.mockResolvedValue({
      meta: { durationMs: 1, error: { kind: "timeout", message: "model request timed out" } },
    });

    await expect(runSkillExperienceReview(candidate)).rejects.toThrow("model request timed out");
    expect(mocks.postWorkshopChangeNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: expect.objectContaining({
          sessionKey: candidate.source.sessionKey,
          sessionId: candidate.source.sessionId,
        }),
        changes: [committed],
      }),
    );
  });
});
