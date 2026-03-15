import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getRemoteSkillEligibility,
  parseBinProbePayload,
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
} from "./skills-remote.js";

describe("skills-remote", () => {
  it("removes disconnected nodes from remote skill eligibility", () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Remote Mac",
      platform: "darwin",
      commands: ["system.run"],
    });
    recordRemoteNodeBins(nodeId, [bin]);

    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);

    removeRemoteNodeInfo(nodeId);

    expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
  });

  it("supports idempotent remote node removal", () => {
    const nodeId = `node-${randomUUID()}`;
    expect(() => {
      removeRemoteNodeInfo(nodeId);
      removeRemoteNodeInfo(nodeId);
    }).not.toThrow();
  });

  it("ignores non-mac and non-system.run nodes for eligibility", () => {
    const linuxNodeId = `node-${randomUUID()}`;
    const noRunNodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: linuxNodeId,
        displayName: "Linux Box",
        platform: "linux",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(linuxNodeId, [bin]);

      recordRemoteNodeInfo({
        nodeId: noRunNodeId,
        displayName: "Remote Mac",
        platform: "darwin",
        commands: ["system.which"],
      });
      recordRemoteNodeBins(noRunNodeId, [bin]);

      expect(getRemoteSkillEligibility()).toBeUndefined();
    } finally {
      removeRemoteNodeInfo(linuxNodeId);
      removeRemoteNodeInfo(noRunNodeId);
    }
  });

  it("aggregates bins and note labels across eligible mac nodes", () => {
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const binA = `bin-${randomUUID()}`;
    const binB = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: nodeA,
        displayName: "Mac Studio",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeA, [binA]);

      recordRemoteNodeInfo({
        nodeId: nodeB,
        platform: "macOS",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeB, [binB]);

      const eligibility = getRemoteSkillEligibility();
      expect(eligibility?.platforms).toEqual(["darwin"]);
      expect(eligibility?.hasBin(binA)).toBe(true);
      expect(eligibility?.hasAnyBin([`missing-${randomUUID()}`, binB])).toBe(true);
      expect(eligibility?.note).toContain("Mac Studio");
      expect(eligibility?.note).toContain(nodeB);
    } finally {
      removeRemoteNodeInfo(nodeA);
      removeRemoteNodeInfo(nodeB);
    }
  });
});

describe("parseBinProbePayload", () => {
  it("parses string[] bins format", () => {
    const payload = JSON.stringify({ bins: ["git", "curl", "python3"] });
    expect(parseBinProbePayload(payload)).toEqual(["git", "curl", "python3"]);
  });

  it("parses Record<string, string> bins format (system.which response)", () => {
    const payload = JSON.stringify({
      bins: {
        git: "/usr/bin/git",
        curl: "/usr/bin/curl",
        python3: "/opt/homebrew/bin/python3",
      },
    });
    expect(parseBinProbePayload(payload)).toEqual(["git", "curl", "python3"]);
  });

  it("parses stdout format (system.run response)", () => {
    const payload = JSON.stringify({ stdout: "git\ncurl\npython3\n" });
    expect(parseBinProbePayload(payload)).toEqual(["git", "curl", "python3"]);
  });

  it("returns empty array for null/undefined input", () => {
    expect(parseBinProbePayload(null)).toEqual([]);
    expect(parseBinProbePayload(undefined)).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseBinProbePayload("not json")).toEqual([]);
  });

  it("returns empty array for empty bins object", () => {
    const payload = JSON.stringify({ bins: {} });
    expect(parseBinProbePayload(payload)).toEqual([]);
  });

  it("trims whitespace from bin names", () => {
    const payload = JSON.stringify({ bins: { "  git  ": "/usr/bin/git" } });
    expect(parseBinProbePayload(payload)).toEqual(["git"]);
  });

  it("accepts payload as second argument", () => {
    const payload = { bins: { git: "/usr/bin/git" } };
    expect(parseBinProbePayload(null, payload)).toEqual(["git"]);
  });
});
