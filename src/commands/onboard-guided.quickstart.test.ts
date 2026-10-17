import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { AgentEntryConfig } from "../config/types.agents.js";
import type { GuidedOrchestrationFixture as GuidedOnboardingDeps } from "./onboard-guided-runtime.test-support.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";

describe("runGuidedOnboarding quick start", () => {
  const {
    ensureAuthProfileStore,
    expectCallOrder,
    expectNotCalled,
    localOnboarding: onboarding,
    makeRuntime,
    promptAuthChoiceGrouped: promptAuth,
    restoreTerminalState,
    runGuidedOnboardingImpl: run,
    setupApplyResult,
    setupDeps,
  } = setupGuidedCustodianTestSuite();
  const match = expect.objectContaining;
  const contains = expect.stringContaining;
  const securityWarning = contains("Recommended safer setup");
  const beforePersistentApply = { beforePersistentApply: expect.any(Function) };
  const setupQuick = (selectValues = ["quick"], overrides: Parameters<typeof setupDeps>[0] = {}) =>
    setupDeps({ prompter: createWizardPrompter(undefined, { selectValues }), ...overrides });
  const expectSetup = (deps: ReturnType<typeof setupDeps>, options: object) =>
    expect(deps.applySetup).toHaveBeenCalledWith(match(options), beforePersistentApply);
  const expectSelection = (prompter: ReturnType<typeof createWizardPrompter>, options: object) =>
    expect(prompter.select).toHaveBeenCalledWith(match(options));
  const skippedGateway = (reason: "explicit" | "external") =>
    vi.fn(async () => ({ ...setupApplyResult(), gateway: { status: "skipped" as const, reason } }));

  it("quick start restores stdin before foreground launch", async () => {
    const deps = setupQuick(["quick", "one"], { applySetup: skippedGateway("explicit") });
    const prompter = deps.createPrompter();
    promptAuth.mockImplementationOnce(async () => {
      expectNotCalled(deps.activate, ensureAuthProfileStore, onboarding.begin, deps.applySetup);
      return "candidate:claude-cli";
    });
    const runtime = makeRuntime();
    await run({}, runtime, deps);
    expectNotCalled(prompter.confirm, prompter.text);
    expect(onboarding.persisted.config?.telemetry).toBeUndefined();
    expect(onboarding.persisted.config?.wizard?.securityAcknowledgedAt).toEqual(expect.any(String));
    expect(deps.persistAccessMode).toHaveBeenCalledWith("full");
    expectSetup(deps, { installDaemon: false, firstAgent: { name: "main" } });
    expectNotCalled(deps.runSetupMemoryImportStep, deps.runAppRecommendations);
    expectNotCalled(deps.runBrowserHandoff, deps.launchHatchTui);
    expect(deps.runForegroundGateway).toHaveBeenCalledExactlyOnceWith({ runtime });
    expect(promptAuth).toHaveBeenCalledOnce();
    expectCallOrder(restoreTerminalState, deps.runForegroundGateway);
    const notes = vi.mocked(prompter.note).mock.calls;
    const securityUrl = "https://docs.openclaw.ai/gateway/security";
    expect(notes.filter(([message]) => message.includes(securityUrl))).toHaveLength(1);
    expect(prompter.note).not.toHaveBeenCalledWith(securityWarning, expect.anything());
  });

  it("preserves guarded discovery consent in an incomplete config", async () => {
    onboarding.persisted.config = {
      wizard: { securityAcknowledgedAt: "2026-08-01T00:00:00.000Z", accessMode: "guarded" },
    };
    promptAuth.mockResolvedValueOnce("skip");
    const prompter = createWizardPrompter();
    vi.mocked(prompter.select).mockImplementation(async ({ options, initialValue }) => {
      const choice =
        options.find(({ value }) => value === "manual") ??
        options.find(({ value }) => value === initialValue);
      return choice!.value;
    });
    const deps = setupDeps({ prompter });

    await run({ agentName: "main" }, makeRuntime(), deps);

    expect(prompter.select).not.toHaveBeenCalledWith(
      match({ message: "How would you like to start?" }),
    );
    expectSelection(prompter, { message: "How should I set things up?", initialValue: "guarded" });
    expectSelection(prompter, { message: "May I look around to find your AI access?" });
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.listManualOptions).toHaveBeenCalledOnce();
    expect(deps.persistAccessMode).not.toHaveBeenCalledWith("full");
    expect(onboarding.persisted.config?.wizard?.accessMode).toBe("guarded");
  });

  it("custom setup keeps telemetry, first-agent, access, and provider choices in order", async () => {
    const prompter = createWizardPrompter(
      { text: vi.fn(async () => "helper"), confirm: vi.fn(async () => true) },
      { selectValues: ["custom", "one", "full"] },
    );
    const deps = setupDeps({ prompter });

    await run({}, makeRuntime(), deps);

    expect(vi.mocked(prompter.select).mock.calls.map(([params]) => params.message)).toEqual([
      "How would you like to start?",
      "Help make OpenClaw better?",
      "What would you like to create?",
      "How should I set things up?",
    ]);
    const selects = vi.mocked(prompter.select).mock.invocationCallOrder;
    const firstAgentPrompt = vi.mocked(prompter.text).mock.invocationCallOrder[0]!;
    expectCallOrder(selects[1], selects[2], firstAgentPrompt, selects[3]);
    expectCallOrder(selects[3], promptAuth, vi.mocked(deps.activate));
    expect(prompter.confirm).toHaveBeenCalledOnce();
    expect(prompter.note).toHaveBeenCalledWith(securityWarning, "Security disclaimer");
    const telemetry = onboarding.persisted.config?.telemetry;
    expect(telemetry).toEqual({ enabled: false, consentedAt: expect.any(String) });
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

    await run({}, makeRuntime(), deps);

    expect(deps.runForegroundGateway).not.toHaveBeenCalled();
    expect(runBrowserHandoff).toHaveBeenCalledOnce();
    expect(deps.createPrompter().outro).toHaveBeenCalledWith(
      "Your browser is ready — I'll be in Settings.",
    );
  });

  it("reports failed team setup without opening a coordinator chat", async () => {
    const deps = setupQuick(["quick", "team"], {
      applySetup: vi.fn(async () => {
        throw new Error("The requested team was not created");
      }),
    });

    await expect(run({}, makeRuntime(), deps)).rejects.toThrow(
      "Onboarding did not complete: The requested team was not created",
    );
    expectNotCalled(deps.runSystemAgentChat, deps.runForegroundGateway, onboarding.complete);
  });

  it("rejects coordinator Writer before provider discovery or receipt creation", async () => {
    const deps = setupQuick();

    const failure = await run({ team: true, agentName: "Writer" }, makeRuntime(), deps).catch(
      (error: unknown) => error,
    );

    expectNotCalled(onboarding.begin, deps.detect, deps.activate, deps.applySetup);
    expect(onboarding.states.size).toBe(0);
    expect(failure).toMatchObject({ message: contains("Team member ids must be distinct") });
  });

  it("carries the team coordinator to the handoff without an inference config write", async () => {
    const deps = setupQuick(["quick", "team"], {
      applySetup: vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async ({ workspace }) => {
        const { agents, ...config } = onboarding.persisted.config ?? {};
        const specialists = ["researcher", "writer", "reviewer"];
        const entries: Record<string, AgentEntryConfig> = {
          coordinator: {
            workspace: `${workspace}/coordinator`,
            subagents: { allowAgents: specialists, delegationMode: "prefer" },
          },
        };
        for (const id of specialists) {
          entries[id] = { workspace: `${workspace}/${id}`, subagents: { allowAgents: [] } };
        }
        onboarding.persisted.config = {
          ...config,
          agents: {
            ...agents,
            ownership: "explicit",
            defaults: { ...agents?.defaults, workspace, systemAgent: { agentId: "coordinator" } },
            entries,
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
    await run({}, makeRuntime(), deps);

    expectSelection(deps.createPrompter(), {
      message: "What would you like to create?",
      initialValue: "one",
    });
    expectSetup(deps, { firstAgent: { name: "coordinator", team: true } });
    expect(onboarding.begin).toHaveBeenCalledWith(match({ teamCoordinatorId: "coordinator" }));
    expect(deps.runForegroundGateway).toHaveBeenCalledWith(match({ agentId: "coordinator" }));
  });
});
