import { describe, expect, it } from "vitest";
import {
  constrainCronScheduledNativePolicy,
  deriveCronScheduledNativePolicy,
  normalizeCronScheduledNativePolicy,
  resolveCronScheduledAgentRuntime,
} from "./scheduled-native-policy.js";

describe("scheduled native policy", () => {
  it("normalizes only the closed v1 shape", () => {
    expect(normalizeCronScheduledNativePolicy({ version: 1, mode: "inherit" })).toEqual({
      version: 1,
      mode: "inherit",
    });
    expect(normalizeCronScheduledNativePolicy({ version: 1, mode: "disabled" })).toEqual({
      version: 1,
      mode: "disabled",
    });
    expect(
      normalizeCronScheduledNativePolicy({ version: 1, mode: "inherit", apps: [] }),
    ).toBeUndefined();
    expect(normalizeCronScheduledNativePolicy({ version: 2, mode: "inherit" })).toBeUndefined();
    expect(normalizeCronScheduledNativePolicy({ version: 1, mode: "custom" })).toBeUndefined();
  });

  it("migrates wildcard jobs to inherit and bounded jobs to disabled", () => {
    expect(deriveCronScheduledNativePolicy(["*"])).toEqual({ version: 1, mode: "inherit" });
    expect(deriveCronScheduledNativePolicy(["read", "write"])).toEqual({
      version: 1,
      mode: "disabled",
    });
    expect(deriveCronScheduledNativePolicy([])).toEqual({ version: 1, mode: "disabled" });
    expect(deriveCronScheduledNativePolicy(undefined)).toBeUndefined();
  });

  it.each([
    {
      name: "wildcard cap",
      policy: { version: 1, mode: "inherit" } as const,
      toolsAllow: ["*"],
      toolsAllowIsDefault: false,
      expected: "inherit",
    },
    {
      name: "creator-default finite cap",
      policy: { version: 1, mode: "inherit" } as const,
      toolsAllow: ["read"],
      toolsAllowIsDefault: true,
      expected: "inherit",
    },
    {
      name: "explicit finite cap",
      policy: { version: 1, mode: "inherit" } as const,
      toolsAllow: ["read"],
      toolsAllowIsDefault: false,
      expected: "disabled",
    },
    {
      name: "disabled provenance",
      policy: { version: 1, mode: "disabled" } as const,
      toolsAllow: ["*"],
      toolsAllowIsDefault: true,
      expected: "disabled",
    },
  ])("constrains native authority for $name", (testCase) => {
    expect(
      constrainCronScheduledNativePolicy({
        scheduledNativePolicy: testCase.policy,
        toolsAllow: testCase.toolsAllow,
        toolsAllowIsDefault: testCase.toolsAllowIsDefault,
      }),
    ).toEqual({ version: 1, mode: testCase.expected });
  });

  it("forces OpenClaw only when native authority is disabled", () => {
    expect(resolveCronScheduledAgentRuntime({ version: 1, mode: "disabled" }, "codex")).toBe(
      "openclaw",
    );
    expect(resolveCronScheduledAgentRuntime({ version: 1, mode: "inherit" }, "codex")).toBe(
      "codex",
    );
    expect(resolveCronScheduledAgentRuntime(undefined, "claude-cli")).toBe("claude-cli");
  });
});
