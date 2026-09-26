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
  ])("rejects $envKey overrides for named profiles on $platform", ({ platform, envKey, value }) => {
    expect(
      resolveGatewayNativeServiceIdentityConflict(
        { OPENCLAW_PROFILE: "work", [envKey]: value },
        platform,
      ),
    ).toMatchObject({ envKey });
  });

  it("accepts canonical named-profile identities and default-profile overrides", () => {
    expect(
      resolveGatewayNativeServiceIdentityConflict(
        { OPENCLAW_PROFILE: "work", OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-work" },
        "linux",
      ),
    ).toBeNull();
    expect(
      resolveGatewayNativeServiceIdentityConflict(
        { OPENCLAW_SYSTEMD_UNIT: "custom-gateway.service" },
        "linux",
      ),
    ).toBeNull();
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
