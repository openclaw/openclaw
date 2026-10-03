import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.js";

describe("runGuidedOnboarding quick start", () => {
  const {
    ensureAuthProfileStore,
    localOnboarding,
    makeRuntime,
    promptAuthChoiceGrouped,
    restoreTerminalState,
    runGuidedOnboardingImpl,
    setupApplyResult,
    setupDeps,
  } = setupGuidedCustodianTestSuite();

  it.each([undefined, "2026-08-01T00:00:00.000Z"])(
    "quick start restores stdin before foreground launch (acknowledgement: %s)",
    async (acknowledgedAt) => {
      if (acknowledgedAt) {
        localOnboarding.persisted.config = { wizard: { securityAcknowledgedAt: acknowledgedAt } };
      }
      const prompter = createWizardPrompter(undefined, { selectValues: ["quick", "one"] });
      const deps = setupDeps({
        prompter,
        applySetup: vi.fn(async () => ({
          ...setupApplyResult(),
          gateway: { status: "skipped" as const, reason: "explicit" as const },
        })),
      });
      promptAuthChoiceGrouped.mockImplementationOnce(async () => {
        expect(deps.activate).not.toHaveBeenCalled();
        expect(ensureAuthProfileStore).not.toHaveBeenCalled();
        expect(localOnboarding.begin).not.toHaveBeenCalled();
        expect(deps.applySetup).not.toHaveBeenCalled();
        return "candidate:claude-cli";
      });
      const runtime = makeRuntime();
      await runGuidedOnboardingImpl({}, runtime, deps);
      expect(prompter.confirm).not.toHaveBeenCalled();
      expect(prompter.text).not.toHaveBeenCalled();
      expect(prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("Web search setup is optional."),
        "Search",
      );
      expect(localOnboarding.persisted.config?.tools?.web?.search).toBeUndefined();
      expect(localOnboarding.persisted.config?.plugins?.installs).toBeUndefined();
      expect(localOnboarding.persisted.config?.telemetry).toBeUndefined();
      expect(localOnboarding.persisted.config?.wizard?.securityAcknowledgedAt).toEqual(
        acknowledgedAt ?? expect.any(String),
      );
      expect(deps.persistAccessMode).toHaveBeenCalledWith("full");
      expect(deps.applySetup).toHaveBeenCalledWith(
        expect.objectContaining({ installDaemon: false, firstAgent: { name: "main" } }),
        { beforePersistentApply: expect.any(Function) },
      );
      expect(deps.runSetupMemoryImportStep).not.toHaveBeenCalled();
      expect(deps.runAppRecommendations).not.toHaveBeenCalled();
      expect(deps.runBrowserHandoff).not.toHaveBeenCalled();
      expect(deps.launchHatchTui).not.toHaveBeenCalled();
      expect(deps.runForegroundGateway).toHaveBeenCalledExactlyOnceWith({ runtime });
      expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
      expect(restoreTerminalState.mock.invocationCallOrder[0]).toBeLessThan(
        deps.runForegroundGateway.mock.invocationCallOrder[0]!,
      );
      const securityNotes = vi
        .mocked(prompter.note)
        .mock.calls.filter(([message]) =>
          message.includes("https://docs.openclaw.ai/gateway/security"),
        );
      expect(securityNotes).toHaveLength(acknowledgedAt ? 0 : 1);
      expect(prompter.note).not.toHaveBeenCalledWith(
        expect.stringContaining("Recommended safer setup"),
        expect.anything(),
      );
    },
  );

  it("preserves guarded discovery consent in an incomplete config", async () => {
    localOnboarding.persisted.config = {
      wizard: { securityAcknowledgedAt: "2026-08-01T00:00:00.000Z", accessMode: "guarded" },
    };
    // Declined discovery still reaches the manual picker (Custom Provider is
    // always offered); skipping there keeps this test about consent only.
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
    const prompter = createWizardPrompter();
    vi.mocked(prompter.select).mockImplementation(async ({ options, initialValue }) => {
      // Accept saved defaults, but decline discovery if its consent prompt appears.
      const choice =
        options.find(({ value }) => value === "manual") ??
        options.find(({ value }) => value === initialValue);
      return choice!.value;
    });
    const deps = setupDeps({ prompter });

    await runGuidedOnboardingImpl({ agentName: "main" }, makeRuntime(), deps);

    expect(prompter.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "How would you like to start?" }),
    );
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How should I set things up?",
        initialValue: "guarded",
      }),
    );
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "May I look around to find your AI access?" }),
    );
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
    expect(selects[1]).toBeLessThan(firstAgentPrompt);
    expect(selects[2]).toBeLessThan(firstAgentPrompt);
    expect(firstAgentPrompt).toBeLessThan(selects[3]!);
    expect(selects[3]).toBeLessThan(promptAuthChoiceGrouped.mock.invocationCallOrder[0]!);
    expect(promptAuthChoiceGrouped.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.activate).mock.invocationCallOrder[0]!,
    );
    expect(prompter.confirm).toHaveBeenCalledOnce();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Recommended safer setup"),
      "Security disclaimer",
    );
    expect(localOnboarding.persisted.config?.telemetry).toEqual({
      enabled: false,
      consentedAt: expect.any(String),
    });
    expect(deps.applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ firstAgent: { name: "helper" } }),
      { beforePersistentApply: expect.any(Function) },
    );
    expect(vi.mocked(deps.applySetup).mock.calls[0]?.[0]).not.toEqual(
      expect.objectContaining({ installDaemon: false }),
    );
    expect(deps.runSetupMemoryImportStep).toHaveBeenCalledOnce();
    expect(deps.runAppRecommendations).toHaveBeenCalledOnce();
    expect(deps.runForegroundGateway).not.toHaveBeenCalled();
  });

  it("preserves external Gateway ownership and uses the existing browser handoff", async () => {
    const prompter = createWizardPrompter(undefined, { selectValues: ["quick"] });
    const runBrowserHandoff = vi.fn(async () => ({ handedOff: true as const }));
    const deps = setupDeps({
      prompter,
      runBrowserHandoff,
      applySetup: vi.fn(async () => ({
        ...setupApplyResult(),
        gateway: { status: "skipped" as const, reason: "external" as const },
      })),
    });

    await runGuidedOnboardingImpl({}, makeRuntime(), deps);

    expect(deps.runForegroundGateway).not.toHaveBeenCalled();
    expect(runBrowserHandoff).toHaveBeenCalledOnce();
    expect(prompter.outro).toHaveBeenCalledWith("Your browser is ready — I'll be in Settings.");
  });

  it("reports failed team setup without opening a coordinator chat", async () => {
    const prompter = createWizardPrompter(undefined, { selectValues: ["quick", "team"] });
    const deps = setupDeps({
      prompter,
      applySetup: vi.fn(async () => {
        throw new Error(
          "The requested team was not created because an agent roster already exists.",
        );
      }),
    });

    await expect(runGuidedOnboardingImpl({}, makeRuntime(), deps)).rejects.toThrow(
      "Onboarding did not complete: The requested team was not created",
    );
    expect(deps.runSystemAgentChat).not.toHaveBeenCalled();
    expect(deps.runForegroundGateway).not.toHaveBeenCalled();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
  });

  it.each(["Writer"])(
    "rejects coordinator %s before provider discovery or receipt creation",
    async (agentName) => {
      const prompter = createWizardPrompter(undefined, { selectValues: ["quick"] });
      const deps = setupDeps({ prompter });

      const failure = await runGuidedOnboardingImpl(
        { team: true, agentName },
        makeRuntime(),
        deps,
      ).catch((error: unknown) => error);

      expect(localOnboarding.begin).not.toHaveBeenCalled();
      expect(deps.detect).not.toHaveBeenCalled();
      expect(deps.activate).not.toHaveBeenCalled();
      expect(deps.applySetup).not.toHaveBeenCalled();
      expect(localOnboarding.states.size).toBe(0);
      expect(failure).toMatchObject({
        message: expect.stringContaining("Team member ids must be distinct"),
      });
    },
  );

  it.each(["no-config-write", "skipped"] as const)(
    "carries the team coordinator to the handoff (%s)",
    async (mode) => {
      const skip = mode === "skipped";
      const prompter = createWizardPrompter(undefined, { selectValues: ["quick", "team"] });
      const deps = setupDeps({
        prompter,
        applySetup: vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(
          async ({ workspace }) => {
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
          },
        ),
      });
      if (skip) {
        promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
      } else {
        vi.mocked(deps.activate).mockResolvedValueOnce({
          ok: true,
          modelRef: "fixture/model",
          latencyMs: 1,
          lines: [],
        });
      }
      await runGuidedOnboardingImpl({}, makeRuntime(), deps);

      expect(prompter.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "What would you like to create?",
          initialValue: "one",
        }),
      );
      expect(deps.applySetup).toHaveBeenCalledWith(
        expect.objectContaining({ firstAgent: { name: "coordinator", team: true } }),
        { beforePersistentApply: expect.any(Function) },
      );
      expect(localOnboarding.begin).toHaveBeenCalledWith(
        expect.objectContaining({ teamCoordinatorId: "coordinator" }),
      );
      if (skip) {
        expect(deps.activate).not.toHaveBeenCalled();
        expect(deps.runForegroundGateway).not.toHaveBeenCalled();
        expect(prompter.note).not.toHaveBeenCalledWith(expect.any(String), "Inference ready");
        expect(prompter.note).toHaveBeenCalledWith("Workspace prepared", "Local setup");
        expect(prompter.note).toHaveBeenCalledWith(
          expect.stringContaining("AI"),
          expect.any(String),
        );
      } else {
        expect(deps.runForegroundGateway).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: "coordinator" }),
        );
      }
    },
  );
});
