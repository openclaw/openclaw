import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.js";

const launchTuiCli = vi.hoisted(() => vi.fn(async (_opts: unknown) => undefined));
vi.mock("../tui/tui-launch.js", () => ({ launchTuiCli }));

describe("runGuidedOnboarding", () => {
  const {
    candidate,
    detection,
    existingModelCandidate,
    localOnboarding,
    makeRuntime,
    pendingLocalSetup,
    promptAuthChoiceGrouped,
    readConfigFileSnapshot,
    runGuidedOnboarding,
    setupApplyResult,
    setupDeps,
    withConfigMutationExclusive,
  } = setupGuidedCustodianTestSuite();
  beforeAll(() => {
    vi.doMock("./auth-choice-prompt.js", async () => ({
      ...(await vi.importActual<typeof import("./auth-choice-prompt.js")>(
        "./auth-choice-prompt.js",
      )),
      promptAuthChoiceGrouped,
    }));
  });
  beforeEach(() => {
    launchTuiCli.mockClear();
  });

  it("uses --skip-ui to skip both browser and terminal handoffs", async () => {
    const prompter = createWizardPrompter();
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/work", skipUi: true },
      makeRuntime(),
      deps,
    );

    expect(deps.runBrowserHandoff).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalledWith("OpenClaw is ready.");
  });

  it("launches the guided terminal hatch through the running Gateway", async () => {
    const prompter = createWizardPrompter();
    const deps: GuidedOnboardingDeps = setupDeps({ prompter });
    delete deps.launchHatchTui;

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/work", tui: true },
      makeRuntime(),
      deps,
    );

    expect(launchTuiCli).toHaveBeenCalledOnce();
    const options = launchTuiCli.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({ deliver: false });
    expect(options).not.toHaveProperty("local");
  });

  it("keeps the local terminal hatch for configured reruns", async () => {
    localOnboarding.persisted.config = { gateway: {} };
    const prompter = createWizardPrompter();
    const deps: GuidedOnboardingDeps = setupDeps({ prompter });
    delete deps.launchHatchTui;

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/work", tui: true },
      makeRuntime(),
      deps,
    );

    expect(launchTuiCli).toHaveBeenCalledOnce();
    expect(launchTuiCli).toHaveBeenCalledWith(expect.objectContaining({ local: true }));
    expect(deps.applySetup).not.toHaveBeenCalled();
  });

  it("never attempts browser handoff for remote chat onboarding", async () => {
    const prompter = createWizardPrompter();
    const runBrowserHandoff = vi.fn(async () => ({ handedOff: true as const }));
    const deps = setupDeps({
      prompter,
      handoffMode: "chat",
      runBrowserHandoff,
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runBrowserHandoff).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(localOnboarding.read).not.toHaveBeenCalled();
    expect(localOnboarding.begin).not.toHaveBeenCalled();
  });

  it("never replaces a configured model by fallthrough when its check fails", async () => {
    const existingModel = existingModelCandidate();
    promptAuthChoiceGrouped
      .mockResolvedValueOnce("candidate:existing-model")
      .mockResolvedValueOnce("candidate:existing-model");
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => false),
    });
    const activate = vi
      .fn<NonNullable<GuidedOnboardingDeps["activate"]>>()
      .mockResolvedValueOnce({
        ok: false,
        status: "unavailable",
        error: "provider not loaded",
      })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "acme/workspace-model",
        latencyMs: 400,
        lines: ["Default model: acme/workspace-model"],
      });
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [existingModel, candidate("claude-cli", "Claude Code")],
        }),
      ),
      activate,
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    // Both attempts follow an explicit choice of the existing route.
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate.mock.calls.map(([call]) => call.kind)).toEqual([
      "existing-model",
      "existing-model",
    ]);
    expect(activate.mock.calls.map(([call]) => call.modelRef)).toEqual([
      "acme/workspace-model",
      "acme/workspace-model",
    ]);
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("kept unchanged");
    expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(deps.launchHatchTui).toHaveBeenCalledOnce();
  });

  it("routes detected local provider setup through its provider-owned flow", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("ollama");
    const prompter = createWizardPrompter();
    const activate = vi.fn(async () => ({
      ok: true as const,
      modelRef: "ollama/qwen3.5:4b",
      latencyMs: 500,
      lines: ["Default model: ollama/qwen3.5:4b"],
    })) as GuidedOnboardingDeps["activate"];
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [],
          prepareOptions: [
            {
              id: "ollama",
              brandId: "ollama",
              label: "Ollama",
              actionLabel: "Choose connection",
            },
          ],
        }),
      ),
      activate,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(activate).toHaveBeenCalledWith({
      kind: "provider-auth",
      authChoice: "ollama",
      workspace: "/tmp/work",
      surface: "cli",
      runtime,
      prompter,
      onCommitStarted: expect.any(Function),
    });
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("cancels before detection or activation when risk is declined", async () => {
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => false) });
    const deps = setupDeps({ prompter });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ tui: true }, runtime, deps);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("shows copyable repair commands without opening AI when config is invalid", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      path: "/tmp/broken-openclaw.json",
      issues: [{ path: "agents.defaults.model", message: "Expected a model reference" }],
      config: {},
    });
    const prompter = createWizardPrompter();
    const deps = setupDeps({ prompter });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ workspace: "/tmp/repair" }, runtime, deps);

    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("/tmp/broken-openclaw.json");
    expect(notes).toContain("agents.defaults.model: Expected a model reference");
    expect(prompter.outro).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
    expect(prompter.outro).toHaveBeenCalledWith(
      expect.stringContaining("openclaw config validate"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(deps.runSystemAgentChat).not.toHaveBeenCalled();
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("records setup ownership at inference commit and completes before optional imports", async () => {
    const prompter = createWizardPrompter();
    const activate = vi.fn<NonNullable<GuidedOnboardingDeps["activate"]>>(async (params) => {
      expect(localOnboarding.begin).not.toHaveBeenCalled();
      params.onCommitStarted?.(localOnboarding.persisted.config ?? {});
      expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("pending");
      return {
        ok: true,
        modelRef: "claude-cli/opus",
        latencyMs: 50,
        lines: ["Inference verified"],
      };
    });
    const runSetupMemoryImportStep = vi.fn<
      NonNullable<GuidedOnboardingDeps["runSetupMemoryImportStep"]>
    >(async () => {
      expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("completed");
      return { status: "skipped", providers: [] };
    });
    const deps = setupDeps({ prompter, activate, runSetupMemoryImportStep });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(localOnboarding.begin).toHaveBeenCalledOnce();
    expect(localOnboarding.complete).toHaveBeenCalledOnce();
    expect(localOnboarding.complete.mock.invocationCallOrder[0]).toBeLessThan(
      runSetupMemoryImportStep.mock.invocationCallOrder[0]!,
    );
  });

  it("enables default hooks in the persisted setup config", async () => {
    const applySetup = vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async (params) => {
      const sourceConfig = localOnboarding.persisted.config ?? {};
      localOnboarding.persisted.config =
        params.finalizeConfig?.(sourceConfig, sourceConfig) ?? sourceConfig;
      return setupApplyResult();
    });
    const deps = setupDeps({ prompter: createWizardPrompter(), applySetup });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(
      localOnboarding.persisted.config?.hooks?.internal?.entries?.["session-memory"]?.enabled,
    ).toBe(true);
  });

  it("resumes an interrupted gateway install using its approved workspace", async () => {
    const first = setupDeps({
      prompter: createWizardPrompter(),
      applySetup: vi.fn(async () => ({
        ...setupApplyResult(),
        gateway: { status: "failed" as const, error: "service install failed" },
      })),
    });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/approved-workspace", tui: true },
      makeRuntime(),
      first,
    );

    const pending = localOnboarding.states.get("/tmp/openclaw.json");
    expect(pending).toMatchObject({ status: "pending", workspace: "/tmp/approved-workspace" });
    expect(first.runSystemAgentChat).toHaveBeenCalledOnce();

    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: {
        agents: {
          defaults: {
            model: { primary: "acme/workspace-model" },
            workspace: "/tmp/approved-workspace",
          },
        },
        gateway: { mode: "local" as const },
        wizard: { securityAcknowledgedAt: pending?.securityAcknowledgedAt },
      },
    });
    const retry = setupDeps({
      prompter: createWizardPrompter(),
      detect: vi.fn(async () =>
        detection({
          candidates: [existingModelCandidate()],
          configuredModel: "acme/workspace-model",
          setupComplete: true,
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true, tui: true }, makeRuntime(), retry);

    expect(retry.applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/approved-workspace", resume: true }),
      { beforePersistentApply: expect.any(Function) },
    );
    expect(localOnboarding.states.get("/tmp/openclaw.json")).toMatchObject({
      status: "completed",
      runId: pending?.runId,
    });
    expect(retry.launchHatchTui).toHaveBeenCalledWith("/tmp/approved-workspace");
  });

  it("replaces a stale receipt when explicit onboarding owns the replacement config", async () => {
    const stale = pendingLocalSetup({
      runId: "replaced-config-run",
      workspace: "/tmp/stale-workspace",
    });
    const securityAcknowledgedAt = "2026-08-03T00:00:00.000Z";
    localOnboarding.persisted.config = { wizard: { securityAcknowledgedAt } };
    const deps = setupDeps({ prompter: createWizardPrompter() });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/replacement-workspace" },
      makeRuntime(),
      deps,
    );

    expect(localOnboarding.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        replace: true,
        expectedRunId: stale.runId,
        securityAcknowledgedAt,
        workspace: "/tmp/replacement-workspace",
      }),
    );
    expect(localOnboarding.states.get(stale.configPath)).toMatchObject({
      status: "completed",
      securityAcknowledgedAt,
    });
  });

  it("restarts an incomplete config with its completed receipt", async () => {
    const securityAcknowledgedAt = "2026-01-01T00:00:00.000Z";
    const previous = pendingLocalSetup({
      runId: "completed-incomplete-run",
      workspace: "/tmp/old-workspace",
    });
    localOnboarding.states.set(previous.configPath, {
      ...previous,
      status: "completed",
      completedAtMs: 2,
    });
    localOnboarding.persisted.config = { wizard: { securityAcknowledgedAt } };
    const deps = setupDeps({ prompter: createWizardPrompter() });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/new-workspace" },
      makeRuntime(),
      deps,
    );

    expect(localOnboarding.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        replace: true,
        expectedRunId: previous.runId,
        securityAcknowledgedAt,
        workspace: "/tmp/new-workspace",
      }),
    );
    expect(localOnboarding.states.get(previous.configPath)).toMatchObject({
      status: "completed",
      workspace: "/tmp/new-workspace",
      securityAcknowledgedAt,
    });
  });

  it("binds a new receipt to the acknowledgement actually won by a concurrent writer", async () => {
    const committedAcknowledgement = "2026-08-03T00:00:00.000Z";
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      persistRiskAcknowledgement: async () => {
        localOnboarding.persisted.config = {
          wizard: { securityAcknowledgedAt: committedAcknowledgement },
        };
        return committedAcknowledgement;
      },
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(localOnboarding.begin).toHaveBeenCalledWith(
      expect.objectContaining({ securityAcknowledgedAt: committedAcknowledgement }),
    );
    expect(localOnboarding.states.get("/tmp/openclaw.json")).toMatchObject({
      status: "completed",
      securityAcknowledgedAt: committedAcknowledgement,
    });
  });

  it("rejects a replaced config before recording inference setup ownership", async () => {
    const replacementConfig: OpenClawConfig = {
      wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
    };
    const activate = vi.fn<NonNullable<GuidedOnboardingDeps["activate"]>>(async (params) => {
      localOnboarding.persisted.config = replacementConfig;
      params.onCommitStarted?.(replacementConfig);
      return {
        ok: true,
        modelRef: "claude-cli/opus",
        latencyMs: 50,
        lines: ["Inference verified"],
      };
    });
    const deps = setupDeps({ prompter: createWizardPrompter(), activate });

    await expect(
      runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps),
    ).rejects.toThrow("configuration changed before inference could be saved");

    expect(localOnboarding.begin).not.toHaveBeenCalled();
    expect(deps.applySetup).not.toHaveBeenCalled();
  });

  it("never mistakes a concurrently created config owner for a stale reset receipt", async () => {
    const competing = pendingLocalSetup({
      runId: "concurrent-config-run",
      workspace: "/tmp/concurrent-workspace",
    });
    const firstSnapshot = {
      exists: false,
      valid: true,
      path: competing.configPath,
      issues: [],
      config: {},
    };
    readConfigFileSnapshot.mockResolvedValueOnce(firstSnapshot);
    localOnboarding.persisted.config = {
      wizard: { securityAcknowledgedAt: competing.securityAcknowledgedAt },
    };
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      persistRiskAcknowledgement: async () => competing.securityAcknowledgedAt,
    });

    await expect(
      runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps),
    ).rejects.toThrow("already owns this installation");

    expect(localOnboarding.begin).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(competing.configPath)).toEqual(competing);
  });

  it("rejects an explicit workspace different from the pending approved workspace", async () => {
    const pending = pendingLocalSetup({
      runId: "approved-workspace-run",
      workspace: "/tmp/approved-workspace",
    });
    localOnboarding.persisted.config = {
      wizard: { securityAcknowledgedAt: pending.securityAcknowledgedAt },
    };
    const deps = setupDeps({ prompter: createWizardPrompter() });

    await expect(
      runGuidedOnboarding(
        { acceptRisk: true, workspace: "/tmp/different-workspace" },
        makeRuntime(),
        deps,
      ),
    ).rejects.toThrow("owns a different workspace");

    expect(localOnboarding.begin).not.toHaveBeenCalled();
    expect(deps.applySetup).not.toHaveBeenCalled();
  });

  it("rejects a resolved fleet workspace that differs from the pending approved workspace", async () => {
    const pending = pendingLocalSetup({
      runId: "approved-fleet-workspace-run",
      workspace: "/tmp/approved-workspace",
    });
    localOnboarding.persisted.config = {
      agents: {
        defaults: { workspace: "/tmp/existing-workspace" },
        entries: { main: { workspace: "/tmp/existing-workspace" } },
      },
      wizard: { securityAcknowledgedAt: pending.securityAcknowledgedAt },
    };
    const deps = setupDeps({ prompter: createWizardPrompter() });

    await expect(runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps)).rejects.toThrow(
      "owns a different workspace",
    );

    expect(deps.applySetup).not.toHaveBeenCalled();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
  });

  it("rejects replacement config identity at the setup config-write boundary", async () => {
    const setupEffects = vi.fn();
    const applySetup = vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async (params) => {
      const replacementConfig: OpenClawConfig = {
        agents: { defaults: { workspace: params.workspace } },
        wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
      };
      params.assertCommitPreconditions?.(replacementConfig);
      setupEffects();
      return setupApplyResult();
    });
    const deps = setupDeps({ prompter: createWizardPrompter(), applySetup });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(setupEffects).not.toHaveBeenCalled();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "installation identity",
      replace: (config: OpenClawConfig): OpenClawConfig => ({
        ...config,
        wizard: { ...config.wizard, securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
      }),
    },
    {
      label: "effective workspace",
      replace: (config: OpenClawConfig): OpenClawConfig => ({
        ...config,
        agents: {
          ...config.agents,
          defaults: { ...config.agents?.defaults, workspace: "/tmp/changed-before-lock" },
        },
      }),
    },
  ])(
    "keeps onboarding pending when $label changes before the completion lock",
    async ({ replace }) => {
      const completionLock = vi.fn(async (effect: (config: OpenClawConfig) => Promise<unknown>) => {
        localOnboarding.persisted.config = replace(localOnboarding.persisted.config ?? {});
        return await effect(localOnboarding.persisted.config);
      });
      const deps = setupDeps({
        prompter: createWizardPrompter(),
        applySetup: vi.fn(async () => {
          withConfigMutationExclusive.mockImplementationOnce(completionLock);
          return setupApplyResult();
        }),
      });

      await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

      expect(completionLock).toHaveBeenCalledOnce();
      expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("pending");
      expect(localOnboarding.complete).not.toHaveBeenCalled();
      expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
    },
  );

  it("rejects a concurrent fresh owner before the inference config can commit", async () => {
    const competing = pendingLocalSetup({
      runId: "competing-run",
      workspace: "/tmp/competing-workspace",
    });
    localOnboarding.states.delete(competing.configPath);
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      persistRiskAcknowledgement: async (config) => {
        localOnboarding.persisted.config = config;
        localOnboarding.states.set("/tmp/openclaw.json", competing);
      },
    });

    await expect(
      runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps),
    ).rejects.toThrow("already owns this installation");

    expect(localOnboarding.states.get("/tmp/openclaw.json")).toEqual(competing);
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(deps.applySetup).not.toHaveBeenCalled();
  });

  it("identifies workspace failures and keeps the setup-chat recovery", async () => {
    const title = "Workspace setup failed";
    const detail = "workspace could not be prepared";
    const stop = vi.fn();
    const prompter = createWizardPrompter({ progress: () => ({ update: vi.fn(), stop }) });
    const applySetup = vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async () => ({
      ...setupApplyResult(),
      workspaceReady: false,
    }));
    const deps = setupDeps({ prompter, applySetup });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledWith("/tmp/work", runtime, true, "main");
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain(detail);
    expect(notes).toContain("Let's finish together in chat instead.");
    expect(stop).toHaveBeenLastCalledWith(title);
    expect(stop).not.toHaveBeenCalledWith("AI check failed.");
    expect(prompter.note).toHaveBeenCalledWith(expect.stringContaining(detail), title);
  });

  it("returns a utility-only installation to the setup assistant instead of regular agent hatch", async () => {
    const config: OpenClawConfig = {
      meta: { migrations: { utilityModelSeparation: true } },
      agents: {
        defaults: { utilityModel: "fixture/small", workspace: "/tmp/work" },
        entries: { main: { workspace: "/tmp/work" } },
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
