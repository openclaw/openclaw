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
