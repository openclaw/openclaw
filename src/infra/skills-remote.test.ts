import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  getRemoteSkillEligibility,
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
} from "./skills-remote.js";

describe("skills-remote", () => {
  const remoteEligibilityEnabledConfig: OpenClawConfig = {
    skills: { allowRemoteEligibilityExpansion: true },
  };

  it("requires explicit config opt-in for remote skill eligibility expansion", () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Remote Mac",
      platform: "darwin",
      commands: ["system.run"],
    });
    recordRemoteNodeBins(nodeId, [bin]);

    expect(getRemoteSkillEligibility()).toBeUndefined();
    expect(getRemoteSkillEligibility(remoteEligibilityEnabledConfig)?.hasBin(bin)).toBe(true);

    removeRemoteNodeInfo(nodeId);

    expect(getRemoteSkillEligibility(remoteEligibilityEnabledConfig)?.hasBin(bin) ?? false).toBe(
      false,
    );
  });

  it("supports idempotent remote node removal", () => {
    const nodeId = `node-${randomUUID()}`;
    expect(() => {
      removeRemoteNodeInfo(nodeId);
      removeRemoteNodeInfo(nodeId);
    }).not.toThrow();
  });
});
