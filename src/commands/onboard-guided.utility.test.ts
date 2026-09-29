import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";

describe("guided onboarding utility handoff", () => {
  const { localOnboarding, setupDeps, detection, makeRuntime, runGuidedOnboarding } =
    setupGuidedCustodianTestSuite();

  it("returns a utility-only installation to the setup assistant instead of regular agent hatch", async () => {
    const config: OpenClawConfig = {
      meta: { migrations: { utilityModelSeparation: true } },
      agents: {
        defaults: { utilityModel: "fixture/small", workspace: "/tmp/work" },
        entries: { main: { default: true, workspace: "/tmp/work" } },
      },
      gateway: { mode: "local" },
      wizard: { securityAcknowledgedAt: "2026-09-16T00:00:00.000Z" },
    };
    localOnboarding.persisted.config = config;
    const prompter = createWizardPrompter();
    const utilityCandidate = {
      kind: "provider-auto:fixture" as const,
      label: "Local setup helper",
      detail: "Setup and utility",
      modelRef: "fixture/small",
      modelTarget: "utility" as const,
      recommended: false as const,
    };
    const activate = vi.fn(async () => ({
      ok: true as const,
      modelRef: "fixture/small",
      modelTarget: "utility" as const,
      latencyMs: 100,
      lines: ["Utility model verified"],
    }));
    const deps = setupDeps({
      prompter,
      activate,
      detect: async () =>
        detection({ candidates: [utilityCandidate], setupModel: "fixture/small" }),
    });
    await runGuidedOnboarding({ acceptRisk: true, tui: true }, makeRuntime(), deps);
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ modelTarget: "utility", modelRef: "fixture/small" }),
    );
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
    expect(deps.runAppRecommendations).not.toHaveBeenCalled();
    expect(localOnboarding.persisted.config?.agents?.defaults?.model).toBeUndefined();
  });
});
