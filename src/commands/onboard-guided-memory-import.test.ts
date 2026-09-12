import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.js";

describe("guided onboarding post-inference steps", () => {
  const {
    candidate,
    detection,
    localOnboarding,
    makeRuntime,
    promptAuthChoiceGrouped,
    restoreTerminalState,
    runGuidedOnboarding,
    setupApplyResult,
    setupDeps,
  } = setupGuidedCustodianTestSuite();

  function setupPostInferenceDeps(params: {
    prompter: WizardPrompter;
    runSetupMemoryImportStep?: GuidedOnboardingDeps["runSetupMemoryImportStep"];
    runAppRecommendations?: GuidedOnboardingDeps["runAppRecommendations"];
  }) {
    return setupDeps({
      ...params,
      detect: async () => detection({ candidates: [candidate("codex-cli", "Codex")] }),
      activate: vi.fn<NonNullable<GuidedOnboardingDeps["activate"]>>(async (activation) => {
        activation.onCommitStarted?.(localOnboarding.persisted.config ?? {});
        localOnboarding.persisted.config = {
          ...localOnboarding.persisted.config,
          agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
        };
        return {
          ok: true,
          modelRef: "openai/gpt-5.5",
          latencyMs: 1250,
          lines: ["Inference connected"],
        };
      }),
      applySetup: vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async (options, hooks) => {
        const config = localOnboarding.persisted.config ?? {};
        options.assertCommitPreconditions?.(config);
        hooks?.beforePersistentApply?.();
        localOnboarding.persisted.config = {
          ...config,
          agents: {
            ...config.agents,
            defaults: { ...config.agents?.defaults, workspace: options.workspace },
          },
          gateway: { mode: "local" },
        };
        return setupApplyResult();
      }),
    });
  }

  it("connects the selected candidate before any workspace prompt", async () => {
    const text = vi.fn(async () => "unexpected");
    const prompter = createWizardPrompter({
      text,
      confirm: vi.fn(async () => false),
    });
    const runAppRecommendations = vi.fn<NonNullable<GuidedOnboardingDeps["runAppRecommendations"]>>(
      async ({ config }) => ({ config, commitResult: vi.fn() }),
    );
    const deps = setupPostInferenceDeps({ prompter, runAppRecommendations });
    const applySetup = vi.mocked(deps.applySetup);
    const activate = vi.mocked(deps.activate);
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    const appliedConfig: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" }, workspace: "/tmp/work" },
      },
      gateway: { mode: "local" },
      telemetry: { enabled: false, consentedAt: expect.any(String) },
      wizard: localOnboarding.persisted.config?.wizard,
    };
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "codex-cli",
        modelRef: "openai/gpt-5.5",
        workspace: "/tmp/work",
        surface: "cli",
      }),
    );
    expect(promptAuthChoiceGrouped.mock.invocationCallOrder[0]).toBeLessThan(
      activate.mock.invocationCallOrder[0]!,
    );
    expect(text).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/work", surface: "cli" }),
      expect.objectContaining({ beforePersistentApply: expect.any(Function) }),
    );
    expect(deps.runSystemAgentChat).not.toHaveBeenCalled();
    expect(runAppRecommendations).toHaveBeenCalledWith({
      config: appliedConfig,
      prompter,
      runtime,
      workspaceDir: "/tmp/work",
      modelRouteVerified: true,
    });
    expect(applySetup.mock.invocationCallOrder[0]).toBeLessThan(
      runAppRecommendations.mock.invocationCallOrder[0]!,
    );
    expect(runAppRecommendations.mock.invocationCallOrder[0]).toBeLessThan(
      deps.launchHatchTui.mock.invocationCallOrder[0]!,
    );
    expect(restoreTerminalState.mock.invocationCallOrder[0]).toBeLessThan(
      deps.launchHatchTui.mock.invocationCallOrder[0]!,
    );
  });

  it("imports memories only after setup persists the selected agent workspace", async () => {
    const prompter = createWizardPrompter();
    const runSetupMemoryImportStep = vi.fn<
      NonNullable<GuidedOnboardingDeps["runSetupMemoryImportStep"]>
    >(async ({ prompter: stepPrompter }) => {
      await stepPrompter.note("Codex — /source/codex (1 memories)", "Memories found");
      return { status: "completed", providers: [] };
    });
    const deps = setupPostInferenceDeps({ prompter, runSetupMemoryImportStep });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    const appliedConfig: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          workspace: "/tmp/work",
        },
      },
      gateway: { mode: "local" },
      telemetry: { enabled: false, consentedAt: expect.any(String) },
      wizard: localOnboarding.persisted.config?.wizard,
    };
    expect(runSetupMemoryImportStep).toHaveBeenCalledWith(
      expect.objectContaining({ config: appliedConfig, prompter }),
    );
    expect(vi.mocked(deps.applySetup).mock.invocationCallOrder[0]).toBeLessThan(
      runSetupMemoryImportStep.mock.invocationCallOrder[0]!,
    );
    const notes = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
    const appliedIndex = notes.findIndex((call) => call[1] === "Inference ready");
    const memoryIndex = notes.findIndex((call) => call[1] === "Memories found");
    expect(appliedIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeGreaterThan(appliedIndex);
    expect(runSetupMemoryImportStep.mock.invocationCallOrder[0]).toBeLessThan(
      deps.launchHatchTui.mock.invocationCallOrder[0]!,
    );
  });

  it("shows no memory page when the memory step finds no offers", async () => {
    const prompter = createWizardPrompter();
    const runSetupMemoryImportStep = vi.fn<
      NonNullable<GuidedOnboardingDeps["runSetupMemoryImportStep"]>
    >(async () => ({ status: "nothing-to-import", providers: [] }));
    const deps = setupPostInferenceDeps({ prompter, runSetupMemoryImportStep });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runSetupMemoryImportStep).toHaveBeenCalledOnce();
    expect((prompter.note as ReturnType<typeof vi.fn>).mock.calls).not.toContainEqual([
      expect.anything(),
      "Memories found",
    ]);
  });
});
