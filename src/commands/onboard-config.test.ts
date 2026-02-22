import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyOnboardingLocalWorkspaceConfig } from "./onboard-config.js";

describe("applyOnboardingLocalWorkspaceConfig", () => {
  it("sets workspace and local gateway mode", () => {
    const input: OpenClawConfig = { gateway: { mode: "remote" } };
    const result = applyOnboardingLocalWorkspaceConfig(input, "/tmp/workspace");
    expect(result.gateway?.mode).toBe("local");
    expect(result.agents?.defaults?.workspace).toBe("/tmp/workspace");
  });

  it("applies sandbox defaults when docker is available", () => {
    const input: OpenClawConfig = {};
    const result = applyOnboardingLocalWorkspaceConfig(input, "/tmp/workspace", {
      enableSandboxDefaults: true,
    });
    expect(result.agents?.defaults?.sandbox?.mode).toBe("non-main");
    expect(result.agents?.defaults?.sandbox?.workspaceAccess).toBe("none");
  });

  it("preserves explicit sandbox settings when docker defaults are enabled", () => {
    const input: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            workspaceAccess: "rw",
          },
        },
      },
    };
    const result = applyOnboardingLocalWorkspaceConfig(input, "/tmp/workspace", {
      enableSandboxDefaults: true,
    });
    expect(result.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(result.agents?.defaults?.sandbox?.workspaceAccess).toBe("rw");
  });

  it("does not create sandbox defaults when docker is unavailable", () => {
    const input: OpenClawConfig = {};
    const result = applyOnboardingLocalWorkspaceConfig(input, "/tmp/workspace", {
      enableSandboxDefaults: false,
    });
    expect(result.agents?.defaults?.sandbox).toBeUndefined();
  });
});
