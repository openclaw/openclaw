import { describe, expect, it } from "vitest";
import { getRemoteSkillEligibility, recordRemoteNodeInfo } from "./skills-remote.js";

describe("skills-remote node cache cap", () => {
  it("evicts oldest node when cap is exceeded", () => {
    // Record a macOS node with system.run so it appears in eligibility
    recordRemoteNodeInfo({
      nodeId: "eviction-target",
      displayName: "Target",
      platform: "darwin",
      commands: ["system.run"],
    });

    // Verify it appears in eligibility
    let elig = getRemoteSkillEligibility();
    expect(elig).toBeDefined();

    // Flood with 1 100 distinct non-mac nodes to exceed the 1 000 cap.
    // The eviction-target (oldest) should be evicted.
    for (let i = 0; i < 1_100; i++) {
      recordRemoteNodeInfo({
        nodeId: `flood-${i}`,
        displayName: `Flood ${i}`,
        platform: "linux",
      });
    }

    // The evicted macOS node should no longer appear in eligibility
    elig = getRemoteSkillEligibility();
    // Either undefined (no mac nodes left) or doesn't mention our target
    if (elig) {
      expect(elig.note).not.toContain("Target");
    }
  });

  it("upserts an existing node without eviction", () => {
    // Re-recording the same nodeId should not throw regardless of map size.
    recordRemoteNodeInfo({
      nodeId: "stable-node",
      displayName: "Stable",
      platform: "darwin",
      commands: ["system.run"],
    });
    recordRemoteNodeInfo({
      nodeId: "stable-node",
      displayName: "Stable Updated",
      platform: "darwin",
      commands: ["system.run"],
    });

    const elig = getRemoteSkillEligibility();
    expect(elig).toBeDefined();
    expect(elig!.note).toContain("Stable Updated");
  });
});
