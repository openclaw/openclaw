import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyOnboardingWorkspaceConfig,
  applyLocalSetupWorkspaceConfig,
  ONBOARDING_DEFAULT_DM_SCOPE,
  ONBOARDING_DEFAULT_TOOLS_PROFILE,
  resolveOnboardingWorkspaceDir,
} from "./onboard-config.js";

describe("resolveOnboardingWorkspaceDir", () => {
  it("prefers an explicit requested workspace", () => {
    expect(
      resolveOnboardingWorkspaceDir({
        requestedWorkspace: "/tmp/requested",
        configuredWorkspace: "/tmp/configured",
        defaultWorkspaceDir: "/tmp/default",
      }),
    ).toBe("/tmp/requested");
  });

  it("falls back to configured workspace before the default", () => {
    expect(
      resolveOnboardingWorkspaceDir({
        configuredWorkspace: "/tmp/configured",
        defaultWorkspaceDir: "/tmp/default",
      }),
    ).toBe("/tmp/configured");
  });
});

describe("applyOnboardingWorkspaceConfig", () => {
  it("updates only the workspace portion of config", () => {
    const baseConfig: OpenClawConfig = {
      gateway: {
        mode: "remote",
      },
      agents: {
        defaults: {
          model: "openai/gpt-5",
        },
      },
    };

    const result = applyOnboardingWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.agents?.defaults?.workspace).toBe("/tmp/workspace");
    expect(result.agents?.defaults?.model).toBe("openai/gpt-5");
    expect(result.gateway?.mode).toBe("remote");
  });
});

describe("applyLocalSetupWorkspaceConfig", () => {
  it("defaults local setup tool profile to coding", () => {
    expect(ONBOARDING_DEFAULT_TOOLS_PROFILE).toBe("coding");
  });

  it("sets secure dmScope default when unset", () => {
    const baseConfig: OpenClawConfig = {};
    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe(ONBOARDING_DEFAULT_DM_SCOPE);
    expect(result.gateway?.mode).toBe("local");
    expect(result.agents?.defaults?.workspace).toBe("/tmp/workspace");
    expect(result.tools?.profile).toBe(ONBOARDING_DEFAULT_TOOLS_PROFILE);
  });

  it("preserves existing dmScope when already configured", () => {
    const baseConfig: OpenClawConfig = {
      session: {
        dmScope: "main",
      },
    };
    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe("main");
  });

  it("preserves explicit non-main dmScope values", () => {
    const baseConfig: OpenClawConfig = {
      session: {
        dmScope: "per-account-channel-peer",
      },
    };
    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe("per-account-channel-peer");
  });

  it("preserves an explicit tools.profile when already configured", () => {
    const baseConfig: OpenClawConfig = {
      tools: {
        profile: "full",
      },
    };
    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.tools?.profile).toBe("full");
  });
});
