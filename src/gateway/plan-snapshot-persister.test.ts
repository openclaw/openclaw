/**
 * C4 (Plan Mode 1.0 follow-up): tests for the approvalRunId
 * defensive guard in `persistApprovalMetadata`.
 *
 * The module's production subscriber wiring is tested elsewhere via
 * end-to-end fixtures; this file pins the small-but-critical
 * defensive behavior we added in C4 without requiring a full
 * subscriber harness.
 */
import { describe, expect, it } from "vitest";
import { __testingPlanSnapshotPersister } from "./plan-snapshot-persister.js";

const { persistApprovalMetadata } = __testingPlanSnapshotPersister;

describe("persistApprovalMetadata — C4 approvalRunId guard", () => {
  it("throws when approvalRunId is empty string (silent-bypass prevention)", async () => {
    await expect(
      persistApprovalMetadata({
        sessionKey: "agent:main:main",
        title: "Test plan",
        approvalRunId: "",
      }),
    ).rejects.toThrow(/approvalRunId is required/);
  });

  it("throws when approvalRunId is whitespace-only", async () => {
    await expect(
      persistApprovalMetadata({
        sessionKey: "agent:main:main",
        title: "Test plan",
        approvalRunId: "   ",
      }),
    ).rejects.toThrow(/approvalRunId is required/);
  });

  it("error message mentions the diagnostic implication so operators understand the severity", async () => {
    await expect(
      persistApprovalMetadata({
        sessionKey: "agent:main:main",
        title: "Test plan",
        approvalRunId: "",
      }),
    ).rejects.toThrow(/subagent gate/);
  });
});
