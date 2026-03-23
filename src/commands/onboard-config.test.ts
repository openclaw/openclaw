import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyLocalSetupWorkspaceConfig,
  applyOnboardAgentDefaults,
  ONBOARDING_DEFAULT_DM_SCOPE,
  ONBOARDING_DEFAULT_TOOLS_PROFILE,
} from "./onboard-config.js";

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
    expect(result.agents?.defaults?.userTimezone).toBeDefined();
    expect(result.tools?.profile).toBe(ONBOARDING_DEFAULT_TOOLS_PROFILE);
  });

  it("sets a detected user timezone during onboarding when unset", () => {
    const result = applyOnboardAgentDefaults({});

    expect(result?.defaults?.userTimezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("preserves an explicit user timezone when already configured", () => {
    const result = applyOnboardAgentDefaults({
      agents: {
        defaults: {
          userTimezone: "America/Denver",
        },
      },
    });

    expect(result?.defaults?.userTimezone).toBe("America/Denver");
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
