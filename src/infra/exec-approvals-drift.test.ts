import { describe, expect, it } from "vitest";
import { collectExecApprovalDriftStats } from "./exec-approvals-drift.js";
import type { ExecApprovalsFile } from "./exec-approvals.js";

const mixedFixture: ExecApprovalsFile = {
  version: 1,
  agents: {
    alpha: {
      allowlist: [
        { pattern: "/Users/hide/bin/oc-builder-run", source: "allow-always" },
        { pattern: "/Users/hide/bin/oc-host-diag" },
        { pattern: "=command:613b5a60181648fd", source: "allow-always" },
        { pattern: "/PATH=/tmp/evil" },
        { pattern: "/usr/bin/python3", source: "allow-always", argPattern: "^script\\.py\x00$" },
        { pattern: "rg" },
      ],
    },
    beta: {
      allowlist: [
        { pattern: "C:\\tools\\oc-safe-git.exe", source: "allow-always" },
        { pattern: "**/node" },
        { pattern: "/HOME=/tmp/evil-home" },
        { pattern: "/usr/bin/find" },
        { pattern: "/usr/bin/jq" },
      ],
    },
  },
};

const sparseFixture: ExecApprovalsFile = {
  version: 1,
  agents: {
    alpha: {},
    beta: {
      allowlist: [],
    },
  },
};

const zeroCounts = {
  totalAllowlistEntries: 0,
  allowAlwaysCount: 0,
  nonAllowAlwaysCount: 0,
  opaqueCommandPatternCount: 0,
  bogusEnvironmentLikePatternCount: 0,
  rawUtilityPatternCount: 0,
  interpreterPatternCount: 0,
  wrapperCoverage: {
    ocBuilderRunCount: 0,
    ocHostDiagCount: 0,
    ocSafeGitCount: 0,
  },
};

describe("collectExecApprovalDriftStats", () => {
  it("collects total and per-agent drift stats from mixed allowlist fixtures", () => {
    expect(collectExecApprovalDriftStats(mixedFixture)).toEqual({
      totalAllowlistEntries: 11,
      allowAlwaysCount: 4,
      nonAllowAlwaysCount: 7,
      opaqueCommandPatternCount: 1,
      bogusEnvironmentLikePatternCount: 2,
      rawUtilityPatternCount: 2,
      interpreterPatternCount: 3,
      wrapperCoverage: {
        ocBuilderRunCount: 1,
        ocHostDiagCount: 1,
        ocSafeGitCount: 1,
      },
      agentSummaries: [
        {
          agentId: "alpha",
          totalAllowlistEntries: 6,
          allowAlwaysCount: 3,
          nonAllowAlwaysCount: 3,
          opaqueCommandPatternCount: 1,
          bogusEnvironmentLikePatternCount: 1,
          rawUtilityPatternCount: 1,
          interpreterPatternCount: 1,
          wrapperCoverage: {
            ocBuilderRunCount: 1,
            ocHostDiagCount: 1,
            ocSafeGitCount: 0,
          },
        },
        {
          agentId: "beta",
          totalAllowlistEntries: 5,
          allowAlwaysCount: 1,
          nonAllowAlwaysCount: 4,
          opaqueCommandPatternCount: 0,
          bogusEnvironmentLikePatternCount: 1,
          rawUtilityPatternCount: 1,
          interpreterPatternCount: 2,
          wrapperCoverage: {
            ocBuilderRunCount: 0,
            ocHostDiagCount: 0,
            ocSafeGitCount: 1,
          },
        },
      ],
    });
  });

  it("returns zeroed totals for agents without allowlist entries", () => {
    expect(collectExecApprovalDriftStats(sparseFixture)).toEqual({
      ...zeroCounts,
      agentSummaries: [
        {
          agentId: "alpha",
          ...zeroCounts,
        },
        {
          agentId: "beta",
          ...zeroCounts,
        },
      ],
    });
  });
});
