import { expect, it } from "vitest";
import { WorktreeGcProgress } from "./gc-progress.js";
import { formatWorktreeGcResult } from "./gc-result.js";
import { WorktreeRemovalLockError } from "./removal-errors.js";

it("reports all deferred and failed outcomes after issue details fill up", () => {
  const progress = new WorktreeGcProgress();
  for (let index = 0; index < 70; index += 1) {
    progress.protect("idle", `protected-${index}`, "branch-moved");
  }
  progress.error("idle", new WorktreeRemovalLockError("busy", "owner changed"), "busy");
  progress.error("idle", new Error("snapshot failed"), "failed");
  progress.record("orphans", "retired", "checkout preserved", "orphan");
  progress.protect("idle", "late-protection", "run lease is active");

  expect(progress.result).toMatchObject({
    outcome: "partial",
    issueCount: 74,
    eligibleCount: 0,
    deferredCount: 72,
    failedCount: 1,
    protectedCount: 71,
  });
  expect(progress.result.issues).toHaveLength(64);
  expect(formatWorktreeGcResult(progress.result)).toContain("deferred 72; failed 1");
});
