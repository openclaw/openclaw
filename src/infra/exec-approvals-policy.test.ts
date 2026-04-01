import { describe, expect, it } from "vitest";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import {
  evaluateExecAllowlist,
  hasDurableExecApproval,
  maxAsk,
  minSecurity,
  normalizeExecAsk,
  normalizeExecHost,
  normalizeExecTarget,
  normalizeExecSecurity,
  requiresExecApproval,
} from "./exec-approvals.js";

describe("exec approvals policy helpers", () => {
  it.each([
    { raw: " gateway ", expected: "gateway" },
    { raw: "NODE", expected: "node" },
    { raw: "", expected: null },
    { raw: "ssh", expected: null },
  ])("normalizes exec host value %j", ({ raw, expected }) => {
    expect(normalizeExecHost(raw)).toBe(expected);
  });

  it.each([
    { raw: " auto ", expected: "auto" },
    { raw: " gateway ", expected: "gateway" },
    { raw: "NODE", expected: "node" },
    { raw: "", expected: null },
    { raw: "ssh", expected: null },
  ])("normalizes exec target value %j", ({ raw, expected }) => {
    expect(normalizeExecTarget(raw)).toBe(expected);
  });

  it.each([
    { raw: " allowlist ", expected: "allowlist" },
    { raw: "FULL", expected: "full" },
    { raw: "unknown", expected: null },
  ])("normalizes exec security value %j", ({ raw, expected }) => {
    expect(normalizeExecSecurity(raw)).toBe(expected);
  });

  it.each([
    { raw: " on-miss ", expected: "on-miss" },
    { raw: "ALWAYS", expected: "always" },
    { raw: "maybe", expected: null },
  ])("normalizes exec ask value %j", ({ raw, expected }) => {
    expect(normalizeExecAsk(raw)).toBe(expected);
  });

  it.each([
    { left: "deny" as const, right: "full" as const, expected: "deny" as const },
    {
      left: "allowlist" as const,
      right: "full" as const,
      expected: "allowlist" as const,
    },
    {
      left: "full" as const,
      right: "allowlist" as const,
      expected: "allowlist" as const,
    },
  ])("minSecurity picks the more restrictive value for %j", ({ left, right, expected }) => {
    expect(minSecurity(left, right)).toBe(expected);
  });

  it.each([
    { left: "off" as const, right: "always" as const, expected: "always" as const },
    { left: "on-miss" as const, right: "off" as const, expected: "on-miss" as const },
    { left: "always" as const, right: "on-miss" as const, expected: "always" as const },
  ])("maxAsk picks the more aggressive ask mode for %j", ({ left, right, expected }) => {
    expect(maxAsk(left, right)).toBe(expected);
  });

  it.each([
    {
      ask: "always" as const,
      security: "allowlist" as const,
      analysisOk: true,
      allowlistSatisfied: true,
      expected: true,
    },
    {
      ask: "always" as const,
      security: "full" as const,
      analysisOk: true,
      allowlistSatisfied: false,
      durableApprovalSatisfied: true,
      expected: true,
    },
    {
      ask: "off" as const,
      security: "allowlist" as const,
      analysisOk: true,
      allowlistSatisfied: false,
      expected: false,
    },
    {
      ask: "on-miss" as const,
      security: "allowlist" as const,
      analysisOk: true,
      allowlistSatisfied: true,
      expected: false,
    },
    {
      ask: "on-miss" as const,
      security: "allowlist" as const,
      analysisOk: false,
      allowlistSatisfied: false,
      expected: true,
    },
    {
      ask: "on-miss" as const,
      security: "full" as const,
      analysisOk: false,
      allowlistSatisfied: false,
      expected: false,
    },
  ])("requiresExecApproval respects ask mode and allowlist satisfaction for %j", (testCase) => {
    expect(requiresExecApproval(testCase)).toBe(testCase.expected);
  });

  it("treats exact-command allow-always approvals as durable trust", () => {
    expect(
      hasDurableExecApproval({
        analysisOk: false,
        segmentAllowlistEntries: [],
        allowlist: [
          {
            pattern: "=command:613b5a60181648fd",
            source: "allow-always",
          },
        ],
        commandText: 'powershell -NoProfile -Command "Write-Output hi"',
      }),
    ).toBe(true);
  });

  it("marks policy-blocked segments as non-durable allowlist entries", () => {
    const executable = makeMockExecutableResolution({
      rawExecutable: "/usr/bin/echo",
      resolvedPath: "/usr/bin/echo",
      executableName: "echo",
    });
    const result = evaluateExecAllowlist({
      analysis: {
        ok: true,
        segments: [
          {
            raw: "/usr/bin/echo ok",
            argv: ["/usr/bin/echo", "ok"],
            resolution: makeMockCommandResolution({
              execution: executable,
            }),
          },
          {
            raw: "/bin/sh -lc whoami",
            argv: ["/bin/sh", "-lc", "whoami"],
            resolution: makeMockCommandResolution({
              execution: makeMockExecutableResolution({
                rawExecutable: "/bin/sh",
                resolvedPath: "/bin/sh",
                executableName: "sh",
              }),
              policyBlocked: true,
            }),
          },
        ],
      },
      allowlist: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      safeBins: new Set(),
      cwd: "/tmp",
      platform: process.platform,
    });

    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentAllowlistEntries).toEqual([
      expect.objectContaining({ pattern: "/usr/bin/echo" }),
      null,
    ]);
    expect(
      hasDurableExecApproval({
        analysisOk: true,
        segmentAllowlistEntries: result.segmentAllowlistEntries,
        allowlist: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      }),
    ).toBe(false);
  });
});
