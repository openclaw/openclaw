import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { GuidedOrchestrationFixture as GuidedOnboardingDeps } from "./onboard-guided-runtime.test-support.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";

describe("runGuidedOnboarding quick start", () => {
  const {
    ensureAuthProfileStore,
    expectCallOrder,
    expectNotCalled,
    localOnboarding,
    makeRuntime,
    promptAuthChoiceGrouped,
    restoreTerminalState,
    runGuidedOnboardingImpl,
    setupApplyResult,
    setupDeps,
  } = setupGuidedCustodianTestSuite();
  const match = expect.objectContaining;
  const beforePersistentApply = { beforePersistentApply: expect.any(Function) };
  const setupQuick = (selectValues = ["quick"], overrides: Parameters<typeof setupDeps>[0] = {}) =>
    setupDeps({ prompter: createWizardPrompter(undefined, { selectValues }), ...overrides });
  const expectSetup = (deps: ReturnType<typeof setupDeps>, options: object) =>
    expect(deps.applySetup).toHaveBeenCalledWith(match(options), beforePersistentApply);
  const expectSelection = (prompter: ReturnType<typeof createWizardPrompter>, options: object) =>
    expect(prompter.select).toHaveBeenCalledWith(match(options));
  const skippedGateway = (reason: "explicit" | "external") =>
    vi.fn(async () => ({
      ...setupApplyResult(),
      gateway: { status: "skipped" as const, reason },
    }));

  it("quick start restores stdin before foreground launch", async () => {
    const deps = setupQuick(["quick", "one"], {
      applySetup: skippedGateway("explicit"),
    });
    const prompter = deps.createPrompter();
    promptAuthChoiceGrouped.mockImplementationOnce(async () => {
      expectNotCalled(
        deps.activate,
        ensureAuthProfileStore,
        localOnboarding.begin,
        deps.applySetup,
      );
      return "candidate:claude-cli";
    });
    const runtime = makeRuntime();
    await runGuidedOnboardingImpl({}, runtime, deps);
    expectNotCalled(prompter.confirm, prompter.text);
    expect(localOnboarding.persisted.config?.telemetry).toBeUndefined();
    expect(localOnboarding.persisted.config?.wizard?.securityAcknowledgedAt).toEqual(
      expect.any(String),
    );
    expect(deps.persistAccessMode).toHaveBeenCalledWith("full");
    expectSetup(deps, { installDaemon: false, firstAgent: { name: "main" } });
    expectNotCalled(
      deps.runSetupMemoryImportStep,
      deps.runAppRecommendations,
      deps.runBrowserHandoff,
      deps.launchHatchTui,
    );
    expect(deps.runForegroundGateway).toHaveBeenCalledExactlyOnceWith({ runtime });
    expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
    expectCallOrder(restoreTerminalState, deps.runForegroundGateway);
    const securityNotes = vi
      .mocked(prompter.note)
      .mock.calls.filter(([message]) =>
        message.includes("https://docs.openclaw.ai/gateway/security"),
      );
    expect(securityNotes).toHaveLength(1);
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Recommended safer setup"),
      expect.anything(),
    );
  });

  it("preserves guarded discovery consent in an incomplete config", async () => {
    localOnboarding.persisted.config = {
      wizard: { securityAcknowledgedAt: "2026-08-01T00:00:00.000Z", accessMode: "guarded" },
    };
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
    const prompter = createWizardPrompter();
    vi.mocked(prompter.select).mockImplementation(async ({ options, initialValue }) => {
      const choice =
        options.find(({ value }) => value === "manual") ??
        options.find(({ value }) => value === initialValue);
      return choice!.value;
    });
    const deps = setupDeps({ prompter });

    await runGuidedOnboardingImpl({ agentName: "main" }, makeRuntime(), deps);

    expect(prompter.select).not.toHaveBeenCalledWith(
      match({ message: "How would you like to start?" }),
    );
    expectSelection(prompter, { message: "How should I set things up?", initialValue: "guarded" });
    expectSelection(prompter, { message: "May I look around to find your AI access?" });
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.listManualOptions).toHaveBeenCalledOnce();
    expect(deps.persistAccessMode).not.toHaveBeenCalledWith("full");
    expect(localOnboarding.persisted.config?.wizard?.accessMode).toBe("guarded");
  });

  it("custom setup keeps telemetry, first-agent, access, and provider choices in order", async () => {
    const prompter = createWizardPrompter(
      { text: vi.fn(async () => "helper"), confirm: vi.fn(async () => true) },
      { selectValues: ["custom", "one", "full"] },
    );
    const deps = setupDeps({ prompter });

    await runGuidedOnboardingImpl({}, makeRuntime(), deps);

    expect(vi.mocked(prompter.select).mock.calls.map(([params]) => params.message)).toEqual([
      "How would you like to start?",
      "Help make OpenClaw better?",
      "What would you like to create?",
      "How should I set things up?",
    ]);
    const selects = vi.mocked(prompter.select).mock.invocationCallOrder;
    const firstAgentPrompt = vi.mocked(prompter.text).mock.invocationCallOrder[0]!;
    expectCallOrder(selects[1], selects[2], firstAgentPrompt, selects[3]);
    expectCallOrder(selects[3], promptAuthChoiceGrouped, vi.mocked(deps.activate));
    expect(prompter.confirm).toHaveBeenCalledOnce();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Recommended safer setup"),
      "Security disclaimer",
    );
    expect(localOnboarding.persisted.config?.telemetry).toEqual({
      enabled: false,
      consentedAt: expect.any(String),
    });
    expectSetup(deps, { firstAgent: { name: "helper" } });
    expect(vi.mocked(deps.applySetup).mock.calls[0]?.[0]).not.toEqual(
      match({ installDaemon: false }),
    );
    expect(deps.runSetupMemoryImportStep).toHaveBeenCalledOnce();
    expect(deps.runAppRecommendations).toHaveBeenCalledOnce();
    expect(deps.runForegroundGateway).not.toHaveBeenCalled();
  });

  it("preserves external Gateway ownership and uses the existing browser handoff", async () => {
    const runBrowserHandoff = vi.fn(async () => true);
    const deps = setupQuick(["quick"], {
      runBrowserHandoff,
      applySetup: skippedGateway("external"),
    });

    await runGuidedOnboardingImpl({}, makeRuntime(), deps);

    expect(deps.runForegroundGateway).not.toHaveBeenCalled();
    expect(runBrowserHandoff).toHaveBeenCalledOnce();
    expect(deps.createPrompter().outro).toHaveBeenCalledWith(
      "Your browser is ready — I'll be in Settings.",
    );
  });

  it("reports failed team setup without opening a coordinator chat", async () => {
    const deps = setupQuick(["quick", "team"], {
      applySetup: vi.fn(async () => {
        throw new Error(
          "The requested team was not created because an agent roster already exists.",
        );
      }),
    });

    await expect(runGuidedOnboardingImpl({}, makeRuntime(), deps)).rejects.toThrow(
      "Onboarding did not complete: The requested team was not created",
    );
    expectNotCalled(deps.runSystemAgentChat, deps.runForegroundGateway, localOnboarding.complete);
  });

  it("rejects coordinator Writer before provider discovery or receipt creation", async () => {
    const deps = setupQuick();

    const failure = await runGuidedOnboardingImpl(
      { team: true, agentName: "Writer" },
      makeRuntime(),
      deps,
    ).catch((error: unknown) => error);

    expectNotCalled(localOnboarding.begin, deps.detect, deps.activate, deps.applySetup);
    expect(localOnboarding.states.size).toBe(0);
    expect(failure).toMatchObject({
      message: expect.stringContaining("Team member ids must be distinct"),
    });
  });

  it("carries the team coordinator to the handoff without an inference config write", async () => {
    const deps = setupQuick(["quick", "team"], {
      applySetup: vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async ({ workspace }) => {
        const config = localOnboarding.persisted.config;
        const specialists = ["researcher", "writer", "reviewer"];
        localOnboarding.persisted.config = {
          ...config,
          agents: {
            ...config?.agents,
            ownership: "explicit",
            defaults: {
              ...config?.agents?.defaults,
              workspace,
              systemAgent: { agentId: "coordinator" },
            },
            entries: Object.fromEntries(
              ["coordinator", ...specialists].map((id) => [
                id,
                {
                  workspace: `${workspace}/${id}`,
                  subagents:
                    id === "coordinator"
                      ? { allowAgents: specialists, delegationMode: "prefer" }
                      : { allowAgents: [] },
                },
              ]),
            ),
          },
        };
        return { ...setupApplyResult(), lines: ["Workspace prepared"] };
      }),
    });
    vi.mocked(deps.activate).mockResolvedValueOnce({
      ok: true,
      modelRef: "fixture/model",
      latencyMs: 1,
      lines: [],
    });
    await runGuidedOnboardingImpl({}, makeRuntime(), deps);

    expectSelection(deps.createPrompter(), {
      message: "What would you like to create?",
      initialValue: "one",
    });
    expectSetup(deps, { firstAgent: { name: "coordinator", team: true } });
    expect(localOnboarding.begin).toHaveBeenCalledWith(match({ teamCoordinatorId: "coordinator" }));
    expect(deps.runForegroundGateway).toHaveBeenCalledWith(match({ agentId: "coordinator" }));
  });
});
