import { beforeAll, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GuidedOrchestrationFixture as Deps } from "./onboard-guided-runtime.test-support.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";

const launchTuiCli = vi.hoisted(() => vi.fn(async (_opts: unknown) => undefined));
vi.mock("../tui/tui-launch.js", () => ({ launchTuiCli }));

const {
  expectCallOrder,
  expectNotCalled,
  candidate,
  detection,
  existingModelCandidate,
  localOnboarding: onboarding,
  makeRuntime,
  pendingLocalSetup,
  promptAuthChoiceGrouped: chooseProvider,
  readConfigFileSnapshot: readSnapshot,
  runGuidedOnboarding,
  setupApplyResult,
  setupDeps,
  withConfigMutationExclusive: withConfigLock,
} = setupGuidedCustodianTestSuite();
const match = expect.objectContaining;
const run = (
  deps: Parameters<typeof runGuidedOnboarding>[2],
  opts: Parameters<typeof runGuidedOnboarding>[0] = {},
  runtime = makeRuntime(),
) => runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work", ...opts }, runtime, deps);

const verified = (modelRef = "claude-cli/opus") => ({
  ok: true as const,
  modelRef,
  latencyMs: 50,
  lines: ["Inference verified"],
});

beforeAll(() => {
  vi.doMock("./auth-choice-prompt.js", async () => ({
    ...(await vi.importActual<typeof import("./auth-choice-prompt.js")>("./auth-choice-prompt.js")),
    promptAuthChoiceGrouped: chooseProvider,
  }));
});

it("uses --skip-ui to skip both browser and terminal handoffs", async () => {
  const deps = setupDeps();
  await run(deps, { skipUi: true });
  expectNotCalled(deps.runBrowserHandoff, deps.launchHatchTui);
  expect(deps.createPrompter().outro).toHaveBeenCalledWith("OpenClaw is ready.");
});

it.each([false, true])("selects the terminal hatch for configured=%s", async (configured) => {
  launchTuiCli.mockClear();
  if (configured) {
    onboarding.persisted.config = { gateway: {} };
  }
  const deps: Deps = setupDeps();
  delete deps.launchHatchTui;
  await run(deps, { tui: true });
  expect(launchTuiCli).toHaveBeenCalledOnce();
  if (configured) {
    expect(launchTuiCli).toHaveBeenCalledWith(match({ local: true }));
    expect(deps.applySetup).not.toHaveBeenCalled();
  } else {
    expect(launchTuiCli.mock.calls[0]?.[0]).toMatchObject({ deliver: false });
    expect(launchTuiCli.mock.calls[0]?.[0]).not.toHaveProperty("local");
  }
});

it("never attempts browser handoff for remote chat onboarding", async () => {
  const deps = setupDeps({ handoffMode: "chat" });

  await run(deps);

  expect(deps.runBrowserHandoff).not.toHaveBeenCalled();
  expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
  expectNotCalled(deps.launchHatchTui, onboarding.read, onboarding.begin);
});

it("never replaces a configured model by fallthrough when its check fails", async () => {
  chooseProvider
    .mockResolvedValueOnce("candidate:existing-model")
    .mockResolvedValueOnce("candidate:existing-model");
  const activate = vi
    .fn<NonNullable<Deps["activate"]>>()
    .mockResolvedValueOnce({
      ok: false,
      status: "unavailable",
      error: "provider not loaded",
    })
    .mockResolvedValueOnce(verified("acme/workspace-model"));
  const deps = setupDeps({
    detect: vi.fn(async () =>
      detection({
        candidates: [existingModelCandidate(), candidate("claude-cli", "Claude Code")],
      }),
    ),
    activate,
  });

  await run(deps);

  const prompter = deps.createPrompter();
  expect(activate.mock.calls.map(([{ kind, modelRef }]) => ({ kind, modelRef }))).toEqual([
    { kind: "existing-model", modelRef: "acme/workspace-model" },
    { kind: "existing-model", modelRef: "acme/workspace-model" },
  ]);
  const notes = JSON.stringify(vi.mocked(prompter.note).mock.calls);
  expect(notes).toContain("kept unchanged");
  expect(chooseProvider).toHaveBeenCalledTimes(2);
  expect(deps.launchHatchTui).toHaveBeenCalledOnce();
});

it("routes detected local provider setup through its provider-owned flow", async () => {
  chooseProvider.mockResolvedValueOnce("ollama");
  const prompter = createWizardPrompter();
  const activate = vi.fn(async () => verified("ollama/qwen3.5:4b"));
  const deps = setupDeps({
    prompter,
    detect: vi.fn(async () =>
      detection({
        candidates: [],
        prepareOptions: [{ id: "ollama", label: "Ollama" }],
      }),
    ),
    activate,
  });
  const runtime = makeRuntime();

  await run(deps, {}, runtime);

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
  const deps = setupDeps();
  const runtime = makeRuntime();

  await runGuidedOnboarding({ tui: true }, runtime, deps);

  expect(runtime.exit).toHaveBeenCalledWith(1);
  expectNotCalled(deps.detect, deps.activate);
});

it("shows copyable repair commands without opening AI when config is invalid", async () => {
  readSnapshot.mockResolvedValueOnce({
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

  const notes = JSON.stringify(vi.mocked(prompter.note).mock.calls);
  expect(notes).toContain("/tmp/broken-openclaw.json");
  expect(notes).toContain("agents.defaults.model: Expected a model reference");
  expect(prompter.outro).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
  expect(prompter.outro).toHaveBeenCalledWith(expect.stringContaining("openclaw config validate"));
  expect(runtime.exit).toHaveBeenCalledWith(1);
  expectNotCalled(deps.runSystemAgentChat, deps.detect, deps.activate);
});

it("records setup ownership at inference commit and completes before optional imports", async () => {
  const activate = vi.fn<NonNullable<Deps["activate"]>>(async (params) => {
    expect(onboarding.begin).not.toHaveBeenCalled();
    params.onCommitStarted?.(onboarding.persisted.config ?? {});
    expect(onboarding.states.get("/tmp/openclaw.json")?.status).toBe("pending");
    return verified();
  });
  const runSetupMemoryImportStep = vi.fn(async () => {
    expect(onboarding.states.get("/tmp/openclaw.json")?.status).toBe("completed");
    return { status: "skipped" as const, providers: [] };
  });
  const deps = setupDeps({ activate, runSetupMemoryImportStep });

  await run(deps);

  expect(onboarding.begin).toHaveBeenCalledOnce();
  expect(onboarding.complete).toHaveBeenCalledOnce();
  expectCallOrder(onboarding.complete, runSetupMemoryImportStep);
});

it("resumes an interrupted gateway install using its approved workspace", async () => {
  const workspace = "/tmp/approved-workspace";
  const first = setupDeps({
    applySetup: vi.fn(async () => ({
      ...setupApplyResult(),
      gateway: { status: "failed" as const, error: "service install failed" },
    })),
  });

  await run(first, { workspace, tui: true });

  const pending = onboarding.states.get("/tmp/openclaw.json");
  expect(pending).toMatchObject({ status: "pending", workspace });
  expect(first.runSystemAgentChat).toHaveBeenCalledOnce();

  readSnapshot.mockResolvedValue({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    issues: [],
    config: {
      agents: {
        defaults: {
          workspace,
        },
      },
      gateway: { mode: "local" as const },
      wizard: { securityAcknowledgedAt: pending?.securityAcknowledgedAt },
    },
  });
  const retry = setupDeps({
    detect: vi.fn(async () =>
      detection({
        candidates: [existingModelCandidate()],
        configuredModel: "acme/workspace-model",
        setupComplete: true,
      }),
    ),
  });

  await run(retry, { workspace: undefined, tui: true });

  expect(retry.applySetup).toHaveBeenCalledWith(match({ workspace, resume: true }), {
    beforePersistentApply: expect.any(Function),
  });
  expect(onboarding.states.get("/tmp/openclaw.json")).toMatchObject({
    status: "completed",
    runId: pending?.runId,
  });
  expect(retry.observeHandoff).toHaveBeenCalledWith(match({ workspace, next: "hatch" }));
});

it.each(["stale", "completed"])(
  "replaces a %s receipt for an incomplete config",
  async (receipt) => {
    const workspace = "/tmp/new-workspace";
    const previous = pendingLocalSetup({
      runId: "previous-run",
      workspace: "/tmp/old-workspace",
    });
    const securityAcknowledgedAt =
      receipt === "stale" ? "2026-08-03T00:00:00.000Z" : previous.securityAcknowledgedAt;
    if (receipt === "completed") {
      onboarding.states.set(previous.configPath, {
        ...previous,
        status: "completed",
        completedAtMs: 2,
      });
    }
    onboarding.persisted.config = { wizard: { securityAcknowledgedAt } };
    await run(setupDeps(), { workspace });
    const expected = { workspace, securityAcknowledgedAt };
    expect(onboarding.begin).toHaveBeenCalledWith(
      match({ ...expected, replace: true, expectedRunId: previous.runId }),
    );
    expect(onboarding.states.get(previous.configPath)).toMatchObject({
      ...expected,
      status: "completed",
    });
  },
);

it("binds a new receipt to the acknowledgement actually won by a concurrent writer", async () => {
  const committedAcknowledgement = "2026-08-03T00:00:00.000Z";
  const deps = setupDeps({
    persistRiskAcknowledgement: async () => {
      onboarding.persisted.config = {
        wizard: { securityAcknowledgedAt: committedAcknowledgement },
      };
      return committedAcknowledgement;
    },
  });

  await run(deps);

  expect(onboarding.begin).toHaveBeenCalledWith(
    match({ securityAcknowledgedAt: committedAcknowledgement }),
  );
  expect(onboarding.states.get("/tmp/openclaw.json")).toMatchObject({
    status: "completed",
    securityAcknowledgedAt: committedAcknowledgement,
  });
});

it("rejects a replaced config before recording inference setup ownership", async () => {
  const replacementConfig: OpenClawConfig = {
    wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
  };
  const activate = vi.fn<NonNullable<Deps["activate"]>>(async (params) => {
    onboarding.persisted.config = replacementConfig;
    params.onCommitStarted?.(replacementConfig);
    return verified();
  });
  const deps = setupDeps({ activate });

  await expect(run(deps)).rejects.toThrow("configuration changed before inference could be saved");

  expectNotCalled(onboarding.begin, deps.applySetup);
});

it.each(["before snapshot", "during acknowledgement"])(
  "rejects a competing owner created %s",
  async (phase) => {
    const competing = pendingLocalSetup({
      runId: "competing-run",
      workspace: "/tmp/competing-workspace",
    });
    if (phase === "before snapshot") {
      readSnapshot.mockResolvedValueOnce({
        exists: false,
        valid: true,
        path: competing.configPath,
        issues: [],
        config: {},
      });
      onboarding.persisted.config = {
        wizard: { securityAcknowledgedAt: competing.securityAcknowledgedAt },
      };
    } else {
      onboarding.states.delete(competing.configPath);
    }
    const deps = setupDeps({
      persistRiskAcknowledgement: async (config) => {
        if (phase === "before snapshot") {
          return competing.securityAcknowledgedAt;
        }
        onboarding.persisted.config = config;
        onboarding.states.set(competing.configPath, competing);
        return undefined;
      },
    });
    await expect(run(deps)).rejects.toThrow("already owns this installation");
    expect(onboarding.states.get(competing.configPath)).toEqual(competing);
    expectNotCalled(onboarding.begin, onboarding.complete, deps.applySetup);
  },
);

it.each([false, true])("rejects a conflicting %s fleet-resolved workspace", async (resolved) => {
  const pending = pendingLocalSetup({
    runId: resolved ? "approved-fleet-workspace-run" : "approved-workspace-run",
    workspace: "/tmp/approved-workspace",
  });
  onboarding.persisted.config = {
    ...(resolved
      ? {
          agents: {
            defaults: { workspace: "/tmp/existing-workspace" },
            entries: { main: { workspace: "/tmp/existing-workspace" } },
          },
        }
      : {}),
    wizard: { securityAcknowledgedAt: pending.securityAcknowledgedAt },
  };
  const deps = setupDeps();
  await expect(
    run(deps, { workspace: resolved ? undefined : "/tmp/different-workspace" }),
  ).rejects.toThrow("owns a different workspace");
  expectNotCalled(onboarding.begin, deps.applySetup, onboarding.complete);
});

it("rejects replacement config identity at the setup config-write boundary", async () => {
  const setupEffects = vi.fn();
  const applySetup = vi.fn<NonNullable<Deps["applySetup"]>>(async (params) => {
    const replacementConfig: OpenClawConfig = {
      agents: { defaults: { workspace: params.workspace } },
      wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
    };
    params.assertCommitPreconditions?.(replacementConfig);
    setupEffects();
    return setupApplyResult();
  });
  const deps = setupDeps({ applySetup });

  await run(deps);

  expectNotCalled(setupEffects, onboarding.complete);
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
      onboarding.persisted.config = replace(onboarding.persisted.config ?? {});
      return await effect(onboarding.persisted.config);
    });
    const deps = setupDeps({
      applySetup: vi.fn(async () => {
        withConfigLock.mockImplementationOnce(completionLock);
        return setupApplyResult();
      }),
    });

    await run(deps);

    expect(completionLock).toHaveBeenCalledOnce();
    expect(onboarding.states.get("/tmp/openclaw.json")?.status).toBe("pending");
    expect(onboarding.complete).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
  },
);

it("identifies workspace failures and keeps the setup-chat recovery", async () => {
  const title = "Workspace setup failed";
  const detail = "workspace could not be prepared";
  const stop = vi.fn();
  const prompter = createWizardPrompter({ progress: () => ({ update: vi.fn(), stop }) });
  const applySetup = vi.fn<NonNullable<Deps["applySetup"]>>(async () => ({
    ...setupApplyResult(),
    workspaceReady: false,
  }));
  const deps = setupDeps({ prompter, applySetup });
  const runtime = makeRuntime();

  await run(deps, {}, runtime);

  expect(deps.launchHatchTui).not.toHaveBeenCalled();
  expect(deps.runSystemAgentChat).toHaveBeenCalledWith("/tmp/work", runtime, true, "main");
  const notes = JSON.stringify(vi.mocked(prompter.note).mock.calls);
  expect(notes).toContain("Let's finish together in chat instead.");
  expect(stop).toHaveBeenLastCalledWith(title);
  expect(stop).not.toHaveBeenCalledWith("AI check failed.");
  expect(prompter.note).toHaveBeenCalledWith(expect.stringContaining(detail), title);
});

it("returns a utility-only installation to the setup assistant instead of regular agent hatch", async () => {
  onboarding.persisted.config = {
    meta: { migrations: { utilityModelSeparation: true } },
    agents: {
      defaults: { utilityModel: "fixture/small", workspace: "/tmp/work" },
      entries: { main: { workspace: "/tmp/work" } },
    },
    gateway: { mode: "local" },
    wizard: { securityAcknowledgedAt: "2026-09-16T00:00:00.000Z" },
  };
  const utilityCandidate = {
    kind: "provider-auto:fixture" as const,
    label: "Local setup helper",
    detail: "Setup and utility",
    modelRef: "fixture/small",
    modelTarget: "utility" as const,
    recommended: false as const,
  };
  const activate = vi.fn(async () => ({
    ...verified("fixture/small"),
    modelTarget: "utility" as const,
  }));
  const deps = setupDeps({
    activate,
    detect: async () => detection({ candidates: [utilityCandidate], setupModel: "fixture/small" }),
  });
  await run(deps, { workspace: undefined, tui: true });
  expect(activate).toHaveBeenCalledWith(
    match({ modelTarget: "utility", modelRef: "fixture/small" }),
  );
  expect(deps.launchHatchTui).not.toHaveBeenCalled();
  expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
  expect(deps.runAppRecommendations).not.toHaveBeenCalled();
  expect(onboarding.persisted.config?.agents?.defaults?.model).toBeUndefined();
});
