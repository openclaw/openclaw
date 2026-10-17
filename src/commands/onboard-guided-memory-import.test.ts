import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GuidedOrchestrationFixture as GuidedOnboardingDeps } from "./onboard-guided-runtime.test-support.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";

describe("guided onboarding post-inference steps", () => {
  const {
    candidate,
    detection,
    expectCallOrder,
    expectNotCalled,
    localOnboarding,
    makeRuntime,
    promptAuthChoiceGrouped,
    restoreTerminalState,
    runGuidedOnboarding,
    setupApplyResult,
    setupDeps,
  } = setupGuidedCustodianTestSuite();
  const run = (deps: ReturnType<typeof setupDeps>, runtime = makeRuntime()) =>
    runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);
  const modelRef = "openai/gpt-5.5";
  const appliedConfig = (): OpenClawConfig => ({
    agents: { defaults: { model: { primary: modelRef }, workspace: "/tmp/work" } },
    gateway: { mode: "local" },
    telemetry: { enabled: false, consentedAt: expect.any(String) },
    wizard: localOnboarding.persisted.config?.wizard,
  });
  function setupPostInferenceDeps(params: Parameters<typeof setupDeps>[0] = {}) {
    return setupDeps({
      ...params,
      detect: async () => detection({ candidates: [candidate("codex-cli", "Codex")] }),
      activate: vi.fn<NonNullable<GuidedOnboardingDeps["activate"]>>(async (activation) => {
        activation.onCommitStarted?.(localOnboarding.persisted.config ?? {});
        localOnboarding.persisted.config = {
          ...localOnboarding.persisted.config,
          agents: { defaults: { model: { primary: modelRef } } },
        };
        return { ok: true, modelRef, latencyMs: 1250, lines: ["Inference connected"] };
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
    const prompter = createWizardPrompter();
    const deps = setupPostInferenceDeps({ prompter });
    const runAppRecommendations = vi.mocked(deps.runAppRecommendations);
    const applySetup = vi.mocked(deps.applySetup);
    const activate = vi.mocked(deps.activate);
    const runtime = makeRuntime();

    await run(deps, runtime);

    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "codex-cli",
        modelRef,
        workspace: "/tmp/work",
        surface: "cli",
      }),
    );
    expectCallOrder(promptAuthChoiceGrouped, activate);
    expectNotCalled(prompter.text, deps.runSystemAgentChat);
    expect(deps.observeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/work", next: "hatch" }),
    );
    expect(deps.launchHatchTui).toHaveBeenCalledWith(expect.objectContaining({ deliver: false }));
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/work", surface: "cli" }),
      expect.objectContaining({ beforePersistentApply: expect.any(Function) }),
    );
    expect(runAppRecommendations).toHaveBeenCalledWith({
      config: appliedConfig(),
      prompter,
      runtime,
      workspaceDir: "/tmp/work",
      modelRouteVerified: true,
    });
    expectCallOrder(applySetup, runAppRecommendations, deps.launchHatchTui);
    expectCallOrder(restoreTerminalState, deps.launchHatchTui);
  });

  it("offers memory setup after inference and local setup, before handoff", async () => {
    const runMemorySetupFlow = vi.fn(async (config: OpenClawConfig) => ({
      ...config,
      memory: { search: { provider: "openai", model: "text-embedding-3-small" } },
    }));
    const deps = setupPostInferenceDeps({ runMemorySetupFlow });
    await run(deps);
    expect(localOnboarding.persisted.config?.memory?.search).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
    });
    expect(runMemorySetupFlow).toHaveBeenCalledWith(
      expect.objectContaining({ gateway: { mode: "local" } }),
      expect.anything(),
      expect.objectContaining({ agentDir: expect.any(String) }),
    );
    expectCallOrder(vi.mocked(deps.activate), runMemorySetupFlow);
    expectCallOrder(vi.mocked(deps.applySetup), runMemorySetupFlow, deps.runBrowserHandoff);
  });

  it("waits for recommendation persistence and propagates failure before browser handoff", async () => {
    const commitStarted = createDeferred();
    const commit = createDeferred();
    const failure = new Error("Recommendation persistence failed");
    // Keep the injected rejection observed when checking a missing-await regression.
    void commit.promise.catch(() => undefined);
    const commitResult = vi.fn(() => {
      commitStarted.resolve();
      return commit.promise;
    });
    const deps = setupDeps({
      runAppRecommendations: async ({ config }) => ({ config, commitResult }),
      runBrowserHandoff: vi.fn(async () => true),
    });
    const outcome = run(deps).then(
      () => undefined,
      (error: unknown) => error,
    );

    try {
      await Promise.race([commitStarted.promise, outcome]);
      expect(commitResult).toHaveBeenCalledOnce();
      expectNotCalled(deps.runBrowserHandoff, deps.launchHatchTui);
      commit.reject(failure);
      expect(await outcome).toBe(failure);
      expectNotCalled(deps.runBrowserHandoff, deps.launchHatchTui);
      expect(restoreTerminalState).toHaveBeenCalledWith("setup finish", {
        resumeStdinIfPaused: false,
      });
    } finally {
      commit.resolve();
      await outcome;
    }
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
    await run(deps);

    expect(runSetupMemoryImportStep).toHaveBeenCalledWith(
      expect.objectContaining({ config: appliedConfig(), prompter }),
    );
    expectCallOrder(vi.mocked(deps.applySetup), runSetupMemoryImportStep, deps.launchHatchTui);
    const notes = vi.mocked(prompter.note).mock.calls;
    const appliedIndex = notes.findIndex((call) => call[1] === "Inference ready");
    const memoryIndex = notes.findIndex((call) => call[1] === "Memories found");
    expect(appliedIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeGreaterThan(appliedIndex);
  });
});
