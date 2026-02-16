import { describe, expect, it } from "vitest";
import {
  formatGatewayServiceDescription,
  GATEWAY_LAUNCH_AGENT_LABEL,
  GATEWAY_SYSTEMD_SERVICE_NAME,
  GATEWAY_WINDOWS_TASK_NAME,
  resolveGatewayLaunchAgentLabel,
  resolveGatewayProfileSuffix,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "./constants.js";

describe("resolveGatewayLaunchAgentLabel", () => {
  it("returns default label when no profile is set", () => {
    const result = resolveGatewayLaunchAgentLabel();
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
    expect(result).toBe("ai.openclaw.gateway");
  });

  it("returns default label when profile is 'default'", () => {
    const result = resolveGatewayLaunchAgentLabel("default");
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
  });

  it("returns default label when profile is 'Default' (case-insensitive)", () => {
    const result = resolveGatewayLaunchAgentLabel("Default");
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
  });

  it("returns profile-specific label when profile is set", () => {
    const result = resolveGatewayLaunchAgentLabel("dev");
    expect(result).toBe("ai.openclaw.dev");
  });

  it("returns profile-specific label for custom profile", () => {
    const result = resolveGatewayLaunchAgentLabel("work");
    expect(result).toBe("ai.openclaw.work");
  });

  it("trims whitespace from profile", () => {
    const result = resolveGatewayLaunchAgentLabel("  staging  ");
    expect(result).toBe("ai.openclaw.staging");
  });

  it("returns default label for empty string profile", () => {
    const result = resolveGatewayLaunchAgentLabel("");
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
  });

  it("returns default label for whitespace-only profile", () => {
    const result = resolveGatewayLaunchAgentLabel("   ");
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
  });
});

describe("resolveGatewaySystemdServiceName", () => {
  it("returns default service name when no profile is set", () => {
    const result = resolveGatewaySystemdServiceName();
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
    expect(result).toBe("openclaw-gateway");
  });

  it("returns default service name when profile is 'default'", () => {
    const result = resolveGatewaySystemdServiceName("default");
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
  });

  it("returns profile-specific service name when profile is set", () => {
    const result = resolveGatewaySystemdServiceName("dev");
    expect(result).toBe("openclaw-gateway-dev");
  });

  it("returns profile-specific service name for custom profile", () => {
    const result = resolveGatewaySystemdServiceName("production");
    expect(result).toBe("openclaw-gateway-production");
  });

  it("trims whitespace from profile", () => {
    const result = resolveGatewaySystemdServiceName("  test  ");
    expect(result).toBe("openclaw-gateway-test");
  });

  it("returns default service name for empty string profile", () => {
    const result = resolveGatewaySystemdServiceName("");
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
  });

  it("returns default service name for whitespace-only profile", () => {
    const result = resolveGatewaySystemdServiceName("   ");
    expect(result).toBe(GATEWAY_SYSTEMD_SERVICE_NAME);
  });
});

describe("resolveGatewayWindowsTaskName", () => {
  it("returns default task name when no profile is set", () => {
    const result = resolveGatewayWindowsTaskName();
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
    expect(result).toBe("OpenClaw Gateway");
  });

  it("returns default task name when profile is 'default'", () => {
    const result = resolveGatewayWindowsTaskName("default");
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
  });

  it("returns profile-specific task name when profile is set", () => {
    const result = resolveGatewayWindowsTaskName("dev");
    expect(result).toBe("OpenClaw Gateway (dev)");
  });

  it("returns profile-specific task name for custom profile", () => {
    const result = resolveGatewayWindowsTaskName("work");
    expect(result).toBe("OpenClaw Gateway (work)");
  });

  it("trims whitespace from profile", () => {
    const result = resolveGatewayWindowsTaskName("  ci  ");
    expect(result).toBe("OpenClaw Gateway (ci)");
  });

  it("returns default task name for empty string profile", () => {
    const result = resolveGatewayWindowsTaskName("");
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
  });

  it("returns default task name for whitespace-only profile", () => {
    const result = resolveGatewayWindowsTaskName("   ");
    expect(result).toBe(GATEWAY_WINDOWS_TASK_NAME);
  });
});

describe("resolveGatewayProfileSuffix", () => {
  it("returns empty string when no profile is set", () => {
    expect(resolveGatewayProfileSuffix()).toBe("");
  });

  it("returns empty string for default profiles", () => {
    expect(resolveGatewayProfileSuffix("default")).toBe("");
    expect(resolveGatewayProfileSuffix(" Default ")).toBe("");
  });

  it("returns a hyphenated suffix for custom profiles", () => {
    expect(resolveGatewayProfileSuffix("dev")).toBe("-dev");
  });

  it("trims whitespace from profiles", () => {
    expect(resolveGatewayProfileSuffix("  staging  ")).toBe("-staging");
  });
});

describe("formatGatewayServiceDescription", () => {
  it("returns default description when no profile/version", () => {
    expect(formatGatewayServiceDescription()).toBe("OpenClaw Gateway");
  });

  it("includes profile when set", () => {
    expect(formatGatewayServiceDescription({ profile: "work" })).toBe(
      "OpenClaw Gateway (profile: work)",
    );
  });

  it("includes version when set", () => {
    expect(formatGatewayServiceDescription({ version: "2026.1.10" })).toBe(
      "OpenClaw Gateway (v2026.1.10)",
    );
  });

  it("includes profile and version when set", () => {
    expect(formatGatewayServiceDescription({ profile: "dev", version: "1.2.3" })).toBe(
      "OpenClaw Gateway (profile: dev, v1.2.3)",
    );
  });
});

describe("resolveGatewayServiceDescription", () => {
  it("prefers explicit description override", () => {
    expect(
      resolveGatewayServiceDescription({
        env: { OPENCLAW_PROFILE: "work", OPENCLAW_SERVICE_VERSION: "1.0.0" },
        description: "Custom",
      }),
    ).toBe("Custom");
  });

  it("resolves version from explicit environment map", () => {
    expect(
      resolveGatewayServiceDescription({
        env: { OPENCLAW_PROFILE: "work", OPENCLAW_SERVICE_VERSION: "local" },
        environment: { OPENCLAW_SERVICE_VERSION: "remote" },
      }),
    ).toBe("OpenClaw Gateway (profile: work, vremote)");
  });
});
