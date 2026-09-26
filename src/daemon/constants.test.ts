// Daemon constant tests cover platform constants used by service installers.
import { describe, expect, it } from "vitest";
import {
  resolveGatewayNativeServiceIdentityConflict,
  resolveGatewayProfileSuffix,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceNameCandidates,
} from "./constants.js";

describe("resolveGatewaySystemdServiceNameCandidates", () => {
  it("includes current default and legacy bare openclaw", () => {
    expect(resolveGatewaySystemdServiceNameCandidates()).toEqual(["openclaw-gateway", "openclaw"]);
    expect(resolveGatewaySystemdServiceNameCandidates("default")).toEqual([
      "openclaw-gateway",
      "openclaw",
    ]);
  });

  it("includes current and legacy names for a named profile", () => {
    expect(resolveGatewaySystemdServiceNameCandidates("lisa")).toEqual([
      "openclaw-gateway-lisa",
      "openclaw-lisa",
    ]);
  });

  it("omits legacy names that identify Node or another profile's gateway", () => {
    expect(resolveGatewaySystemdServiceNameCandidates("node")).toEqual(["openclaw-gateway-node"]);
    expect(resolveGatewaySystemdServiceNameCandidates("gateway")).toEqual([
      "openclaw-gateway-gateway",
    ]);
    expect(resolveGatewaySystemdServiceNameCandidates("gateway-lisa")).toEqual([
      "openclaw-gateway-gateway-lisa",
    ]);
  });
});

describe("resolveGatewayNativeServiceIdentityConflict", () => {
  it.each([
    {
      platform: "darwin" as const,
      envKey: "OPENCLAW_LAUNCHD_LABEL",
      value: "ai.openclaw.gateway",
    },
    {
      platform: "linux" as const,
      envKey: "OPENCLAW_SYSTEMD_UNIT",
      value: "openclaw-gateway.service",
    },
    {
      platform: "win32" as const,
      envKey: "OPENCLAW_WINDOWS_TASK_NAME",
      value: "OpenClaw Gateway",
    },
    {
      platform: "win32" as const,
      envKey: "OPENCLAW_WINDOWS_TASK_NAME",
      value: "\\Nested\\OpenClaw Gateway (work)",
    },
    {
      platform: "win32" as const,
      envKey: "OPENCLAW_WINDOWS_TASK_NAME",
      value: "\\OpenClaw Gateway (other)",
    },
  ])("rejects $envKey overrides for named profiles on $platform", ({ platform, envKey, value }) => {
    expect(
      resolveGatewayNativeServiceIdentityConflict(
        { OPENCLAW_PROFILE: "work", [envKey]: value },
        platform,
      ),
    ).toMatchObject({ envKey });
  });

  it.each([
    {
      name: "canonical named-profile systemd identity",
      platform: "linux",
      env: { OPENCLAW_PROFILE: "work", OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-work" },
    },
    {
      name: "default-profile systemd override",
      platform: "linux",
      env: { OPENCLAW_SYSTEMD_UNIT: "custom-gateway.service" },
    },
    ...["OpenClaw Gateway (work)", "\\OpenClaw Gateway (work)", "\\OPENCLAW GATEWAY (WORK)"].map(
      (taskName) => ({
        name: `native Windows identity ${taskName}`,
        platform: "win32" as const,
        env: { OPENCLAW_PROFILE: "work", OPENCLAW_WINDOWS_TASK_NAME: taskName },
      }),
    ),
    {
      name: "default-profile nested Windows override",
      platform: "win32",
      env: { OPENCLAW_WINDOWS_TASK_NAME: "\\Nested\\Custom Gateway" },
    },
  ] as const)("accepts $name", ({ env, platform }) => {
    expect(resolveGatewayNativeServiceIdentityConflict(env, platform)).toBeNull();
  });
});

describe("resolveGatewayProfileSuffix", () => {
  it("returns empty string for default profiles", () => {
    expect(resolveGatewayProfileSuffix("default")).toBe("");
    expect(resolveGatewayProfileSuffix(" Default ")).toBe("");
  });

  it("trims whitespace from profiles", () => {
    expect(resolveGatewayProfileSuffix("  staging  ")).toBe("-staging");
  });
});

describe("resolveGatewayServiceDescription", () => {
  it("includes profile when set", () => {
    expect(resolveGatewayServiceDescription({ env: { OPENCLAW_PROFILE: "work" } })).toBe(
      "OpenClaw Gateway (profile: work)",
    );
  });

  it("ignores legacy install-time version metadata", () => {
    expect(
      resolveGatewayServiceDescription({ env: { OPENCLAW_SERVICE_VERSION: "2026.1.10" } }),
    ).toBe("OpenClaw Gateway");
  });

  it("prefers explicit description override", () => {
    expect(
      resolveGatewayServiceDescription({
        env: { OPENCLAW_PROFILE: "work" },
        description: "Custom",
      }),
    ).toBe("Custom");
  });
});
