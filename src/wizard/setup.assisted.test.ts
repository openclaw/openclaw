import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  finishAgentAssistedSetup,
  hasExplicitFullWizardIntent,
  hasRunnableLocalAgent,
  resolveAgentAssistedSetupInstructions,
  resolveAgentAssistedSetupMessage,
} from "./setup.assisted.js";

type MockRuntimeAuthPlan = {
  providerForAuth: string;
  authProfileProviderForAuth: string;
  harnessAuthProvider?: string;
};
type MockResolvedModel = {
  model?: {
    provider: string;
    id: string;
    api: string;
  };
};
type MockAgentHarness = {
  id: string;
  checkReadiness?: ReturnType<typeof vi.fn>;
};
type LoadManifestModelCatalog =
  typeof import("../agents/model-catalog.js").loadManifestModelCatalog;
type ResolveRuntimeSyntheticAuthProviderRefs =
  typeof import("../plugins/synthetic-auth.runtime.js").resolveRuntimeSyntheticAuthProviderRefs;

const launchTuiCli = vi.hoisted(() => vi.fn(async () => {}));
const restoreTerminalState = vi.hoisted(() => vi.fn());
const stopGatewayRuntime = vi.hoisted(() => vi.fn(async () => {}));
const ensureAgentAssistedGatewayRuntime = vi.hoisted(() =>
  vi.fn(async () => ({ temporary: false, stop: stopGatewayRuntime })),
);
const hasAuthForModelProvider = vi.hoisted(() => vi.fn(async () => true));
const ensureSelectedAgentHarnessPlugin = vi.hoisted(() => vi.fn(async () => {}));
const ensureRuntimePluginsLoaded = vi.hoisted(() => vi.fn());
const selectAgentHarness = vi.hoisted(() =>
  vi.fn<() => MockAgentHarness>(() => ({ id: "openclaw" })),
);
const resolveCliRuntimeExecutionProvider = vi.hoisted(() => vi.fn());
const isCliProvider = vi.hoisted(() => vi.fn(() => false));
const resolveCliBackendConfig = vi.hoisted(() => vi.fn());
const resolveExecutablePath = vi.hoisted(() => vi.fn());
const resolveRuntimeSyntheticAuthProviderRefs = vi.hoisted(() =>
  vi.fn<ResolveRuntimeSyntheticAuthProviderRefs>(() => []),
);
const ensureOpenClawModelsJson = vi.hoisted(() => vi.fn(async () => ({ wrote: false })));
const buildAgentRuntimeAuthPlan = vi.hoisted(() =>
  vi.fn<({ provider }: { provider: string }) => MockRuntimeAuthPlan>(({ provider }) => ({
    providerForAuth: provider,
    authProfileProviderForAuth: provider,
  })),
);
const resolveModelAsync = vi.hoisted(() =>
  vi.fn<(provider: string, model: string) => Promise<MockResolvedModel>>(
    async (provider, model) => ({
      model: {
        provider,
        id: model,
        api: provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      },
    }),
  ),
);
const loadManifestModelCatalog = vi.hoisted(() => vi.fn<LoadManifestModelCatalog>(() => []));

vi.mock("../tui/tui-launch.js", () => ({
  launchTuiCli,
}));

vi.mock("./setup.assisted-gateway.js", () => ({
  ensureAgentAssistedGatewayRuntime,
}));

vi.mock("../../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState,
}));

vi.mock("../agents/model-provider-auth.js", () => ({
  hasAuthForModelProvider,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadManifestModelCatalog,
}));

vi.mock("../agents/runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded,
}));

vi.mock("../agents/model-runtime-aliases.js", () => ({
  resolveCliRuntimeExecutionProvider,
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-selection.js")>()),
  isCliProvider,
}));

vi.mock("../agents/cli-backends.js", () => ({
  resolveCliBackendConfig,
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutablePath,
}));

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs,
}));

vi.mock("../agents/embedded-agent-runner/model.js", () => ({
  resolveModelAsync,
}));

vi.mock("../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin,
}));

vi.mock("../agents/harness/selection.js", () => ({
  selectAgentHarness,
}));

vi.mock("../agents/models-config.js", () => ({
  ensureOpenClawModelsJson,
}));

vi.mock("../agents/runtime-plan/auth.js", () => ({
  buildAgentRuntimeAuthPlan,
}));

describe("agent-assisted setup handoff", () => {
  const settings = {
    port: 18789,
    bind: "loopback" as const,
    authMode: "token" as const,
    gatewayToken: "test-token",
    tailscaleMode: "off" as const,
    tailscaleResetOnExit: false,
  };
  beforeEach(() => {
    vi.clearAllMocks();
    hasAuthForModelProvider.mockResolvedValue(true);
    resolveCliRuntimeExecutionProvider.mockReturnValue(undefined);
    isCliProvider.mockReturnValue(false);
    resolveCliBackendConfig.mockReturnValue(undefined);
    resolveExecutablePath.mockReturnValue(undefined);
    resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue([]);
    selectAgentHarness.mockReturnValue({ id: "openclaw" });
    buildAgentRuntimeAuthPlan.mockImplementation(({ provider }: { provider: string }) => ({
      providerForAuth: provider,
      authProfileProviderForAuth: provider,
    }));
    resolveModelAsync.mockImplementation(async (provider: string, model: string) => ({
      model: {
        provider,
        id: model,
        api: provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      },
    }));
  });

  it("opens the local agent with a setup-focused first message", async () => {
    const prompter = createWizardPrompter();

    await finishAgentAssistedSetup({
      config: {},
      settings,
      opts: {},
      prompter,
    });

    expect(launchTuiCli).toHaveBeenCalledWith(
      {
        local: true,
        deliver: false,
        message: resolveAgentAssistedSetupMessage(),
        session: "agent:main:main",
      },
      {
        extraSystemPrompt: resolveAgentAssistedSetupInstructions(),
      },
    );
    expect(restoreTerminalState).toHaveBeenCalledWith("pre-agent-assisted setup", {
      resumeStdinIfPaused: true,
    });
    expect(restoreTerminalState).toHaveBeenCalledWith("post-agent-assisted setup", {
      resumeStdinIfPaused: true,
    });
    expect(ensureAgentAssistedGatewayRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ config: {}, settings }),
    );
    expect(stopGatewayRuntime).toHaveBeenCalledOnce();
  });

  it("keeps the visible setup request concise", () => {
    const message = resolveAgentAssistedSetupMessage();

    expect(message).toBe("Help me finish setting up OpenClaw.");
    expect(message).not.toContain("openclaw channels");
    expect(message).not.toContain("docsPath");
    expect(message).not.toContain("what I want to use OpenClaw for");
  });

  it("gives the setup agent a concrete menu and official channel setup contract", () => {
    const instructions = resolveAgentAssistedSetupInstructions();

    expect(instructions).toContain("messaging channels");
    expect(instructions).toContain("Gateway network access and Tailscale");
    expect(instructions).toContain("local Gateway is already securely configured and running");
    expect(instructions).toContain("do not ask the user to set it up before channels");
    expect(instructions).toContain("Do not run Gateway install, start, restart, or stop commands");
    expect(instructions).not.toContain("temporary local Gateway");
    expect(instructions).not.toContain("openclaw onboard --install-daemon");
    expect(instructions).toContain("model providers and authentication");
    expect(instructions).toContain("web search");
    expect(instructions).toContain("skills and plugins");
    expect(instructions).toContain("hooks and automation");
    expect(instructions).toContain("Control UI");
    expect(instructions).toContain("voice/TTS");
    expect(instructions).toContain("start using OpenClaw now");
    expect(instructions).toContain("inspect the current setup");
    expect(instructions).toContain("make the requested changes after the user confirms");
    expect(instructions).toContain("ask one concise question");
    expect(instructions).toContain("openclaw channels list --all --json");
    expect(instructions).toContain("docsPath");
    expect(instructions).toContain("full official guide");
    expect(instructions).toContain("If `docsPath` is missing or the full guide cannot be read");
    expect(instructions).toContain("openclaw channels add --help");
    expect(instructions).toContain(
      "Use bare `openclaw channels add` and select the channel in the wizard",
    );
    expect(instructions).toContain("every required flag is exposed by the installed help");
    expect(instructions).toContain("Do not improvise channel-specific setup instructions");
  });

  it("does not open the local agent when UI launch is explicitly skipped", async () => {
    const prompter = createWizardPrompter();

    await finishAgentAssistedSetup({
      config: {},
      settings,
      opts: { skipUi: true },
      prompter,
    });

    expect(launchTuiCli).not.toHaveBeenCalled();
    expect(ensureAgentAssistedGatewayRuntime).not.toHaveBeenCalled();
  });

  it("stops a temporary Gateway when the TUI handoff fails before launch", async () => {
    const prompter = createWizardPrompter({
      outro: vi.fn(async () => {
        throw new Error("handoff failed");
      }),
    });

    await expect(
      finishAgentAssistedSetup({
        config: {},
        settings,
        opts: {},
        prompter,
      }),
    ).rejects.toThrow("handoff failed");

    expect(launchTuiCli).not.toHaveBeenCalled();
    expect(stopGatewayRuntime).toHaveBeenCalledOnce();
  });

  it("opens an explicitly selected secondary agent after bare-root recovery", async () => {
    const prompter = createWizardPrompter();

    await finishAgentAssistedSetup({
      config: {
        session: { mainKey: "home" },
        agents: {
          list: [
            { id: "main", workspace: "/tmp/main-workspace", default: true },
            { id: "ops", workspace: process.cwd() },
          ],
        },
      },
      settings,
      opts: { agentId: "ops" },
      prompter,
    });

    expect(launchTuiCli).toHaveBeenCalledWith(
      expect.objectContaining({
        session: "agent:ops:home",
      }),
      expect.objectContaining({
        extraSystemPrompt: resolveAgentAssistedSetupInstructions(),
      }),
    );
  });

  it("keeps explicit Gateway and daemon requests on the infrastructure wizard", () => {
    expect(hasExplicitFullWizardIntent({})).toBe(false);
    expect(hasExplicitFullWizardIntent({ gatewayPort: 19001 })).toBe(true);
    expect(hasExplicitFullWizardIntent({ installDaemon: false })).toBe(true);
    expect(hasExplicitFullWizardIntent({ nodeManager: "pnpm" })).toBe(false);
    expect(hasExplicitFullWizardIntent({ mode: "local" })).toBe(true);
    expect(hasExplicitFullWizardIntent({ mode: "remote" })).toBe(true);
    expect(hasExplicitFullWizardIntent({ authChoice: "skip" })).toBe(true);
    expect(hasExplicitFullWizardIntent({ reset: true })).toBe(true);
  });

  it("checks the effective default agent model and auth scope", async () => {
    await expect(
      hasRunnableLocalAgent({
        agents: {
          defaults: {
            model: "openai/default-model",
            workspace: "/tmp/default-workspace",
          },
          list: [
            {
              id: "work",
              default: true,
              agentDir: "/tmp/work-agent",
              workspace: "/tmp/work-workspace",
              model: "anthropic/work-model",
            },
          ],
        },
      }),
    ).resolves.toBe(true);

    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        agentId: "work",
        agentDir: "/tmp/work-agent",
        workspaceDir: "/tmp/work-workspace",
      }),
    );
    expect(ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: expect.any(Object),
      workspaceDir: "/tmp/work-workspace",
    });
  });

  it("checks the default agent even when cwd belongs to a secondary agent", async () => {
    await expect(
      hasRunnableLocalAgent({
        agents: {
          list: [
            {
              id: "main",
              default: true,
              agentDir: "/tmp/main-agent",
              workspace: "/tmp/main-workspace",
              model: "openai/main-model",
            },
            {
              id: "ops",
              agentDir: "/tmp/ops-agent",
              workspace: process.cwd(),
              model: "anthropic/ops-model",
            },
          ],
        },
      }),
    ).resolves.toBe(true);

    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelApi: "openai-responses",
        agentId: "main",
        agentDir: "/tmp/main-agent",
        workspaceDir: "/tmp/main-workspace",
      }),
    );
  });

  it("checks an explicitly selected local agent", async () => {
    await expect(
      hasRunnableLocalAgent(
        {
          agents: {
            list: [
              {
                id: "main",
                default: true,
                agentDir: "/tmp/main-agent",
                workspace: "/tmp/main-workspace",
                model: "openai/main-model",
              },
              {
                id: "ops",
                agentDir: "/tmp/ops-agent",
                workspace: "/tmp/ops-workspace",
                model: "anthropic/ops-model",
              },
            ],
          },
        },
        { agentId: "ops" },
      ),
    ).resolves.toBe(true);

    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        agentId: "ops",
        agentDir: "/tmp/ops-agent",
        workspaceDir: "/tmp/ops-workspace",
      }),
    );
  });

  it("uses the configured default agent for handoff and readiness", async () => {
    const config = {
      session: { mainKey: "home" },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            agentDir: "/tmp/main-agent",
            workspace: "/tmp/main-workspace",
            model: "openai/main-model",
          },
          {
            id: "ops",
            agentDir: "/tmp/ops-agent",
            workspace: process.cwd(),
            model: "anthropic/ops-model",
          },
        ],
      },
    };
    const prompter = createWizardPrompter();

    await expect(hasRunnableLocalAgent(config)).resolves.toBe(true);
    await finishAgentAssistedSetup({ config, settings, opts: {}, prompter });

    expect(launchTuiCli).toHaveBeenCalledWith(
      expect.objectContaining({
        session: "agent:main:home",
      }),
      expect.objectContaining({
        extraSystemPrompt: resolveAgentAssistedSetupInstructions(),
      }),
    );
  });

  it("checks auth for the product default when no model is configured", async () => {
    await expect(hasRunnableLocalAgent({})).resolves.toBe(true);
    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelApi: "openai-responses",
      }),
    );
  });

  it("checks the canonical auth owner for a scoped provider alias", async () => {
    buildAgentRuntimeAuthPlan.mockReturnValueOnce({
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
    });

    await expect(
      hasRunnableLocalAgent({
        agents: {
          defaults: {
            model: "scoped-openai/gpt-5.5",
          },
        },
      }),
    ).resolves.toBe(true);

    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelApi: "openai-responses",
      }),
    );
  });

  it("resolves a providerless model through the configured model catalog", async () => {
    await expect(
      hasRunnableLocalAgent({
        agents: {
          defaults: {
            model: "claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
      }),
    ).resolves.toBe(true);

    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelApi: "anthropic-messages",
      }),
    );
  });

  it("checks the runtime-selected allowed model when the configured default is not allowed", async () => {
    loadManifestModelCatalog.mockReturnValueOnce([
      {
        provider: "anthropic",
        id: "allowed-model",
        name: "Allowed model",
        contextWindow: 200_000,
      },
    ]);

    await expect(
      hasRunnableLocalAgent({
        agents: {
          defaults: {
            model: "openai/default-model",
            models: {
              "anthropic/*": {},
            },
          },
        },
      }),
    ).resolves.toBe(true);

    expect(ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "allowed-model",
      }),
    );
    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelApi: "anthropic-messages",
      }),
    );
  });

  it("does not treat an unresolved default model as runnable", async () => {
    resolveModelAsync.mockResolvedValue({ model: undefined });

    await expect(hasRunnableLocalAgent({})).resolves.toBe(false);

    expect(ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    expect(resolveModelAsync).toHaveBeenCalledTimes(2);
    expect(hasAuthForModelProvider).not.toHaveBeenCalled();
  });

  it("uses a runnable configured fallback when the primary model is unavailable", async () => {
    resolveModelAsync.mockImplementation(async (provider: string, model: string) =>
      provider === "openai"
        ? { model: undefined }
        : {
            model: {
              provider,
              id: model,
              api: "anthropic-messages",
            },
          },
    );

    await expect(
      hasRunnableLocalAgent({
        agents: {
          defaults: {
            model: {
              primary: "openai/unavailable",
              fallbacks: ["anthropic/available"],
            },
          },
        },
      }),
    ).resolves.toBe(true);

    expect(ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "available",
      }),
    );
    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelApi: "anthropic-messages",
      }),
    );
  });

  it("loads and validates the selected harness before declaring the agent runnable", async () => {
    const checkReadiness = vi.fn(async () => ({ ready: true as const }));
    selectAgentHarness.mockReturnValueOnce({ id: "codex", checkReadiness });
    buildAgentRuntimeAuthPlan.mockReturnValueOnce({
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      harnessAuthProvider: "openai",
    });
    resolveModelAsync.mockResolvedValueOnce({
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-chatgpt-responses",
      },
    });

    await expect(hasRunnableLocalAgent({})).resolves.toBe(true);

    expect(ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.5",
        agentId: "main",
      }),
    );
    expect(resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "gpt-5.5",
      expect.any(String),
      {},
      expect.objectContaining({
        skipAgentDiscovery: true,
        allowBundledStaticCatalogFallback: true,
        preferBundledStaticCatalogTransport: true,
      }),
    );
    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelApi: "openai-chatgpt-responses",
      }),
    );
    expect(checkReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAuthAvailable: true,
      }),
    );
  });

  it("loads configured external harness plugins before selecting readiness", async () => {
    const checkReadiness = vi.fn(async () => ({ ready: true as const }));
    ensureRuntimePluginsLoaded.mockImplementationOnce(() => {
      selectAgentHarness.mockReturnValueOnce({ id: "external-harness", checkReadiness });
    });

    await expect(hasRunnableLocalAgent({})).resolves.toBe(true);

    expect(ensureRuntimePluginsLoaded.mock.invocationCallOrder[0]).toBeLessThan(
      selectAgentHarness.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(checkReadiness).toHaveBeenCalledOnce();
  });

  it("checks a configured CLI backend executable and runtime-owned auth", async () => {
    resolveCliRuntimeExecutionProvider.mockReturnValueOnce("claude-cli");
    resolveCliBackendConfig.mockReturnValueOnce({
      id: "claude-cli",
      config: { command: "claude" },
    });
    resolveExecutablePath.mockReturnValueOnce("/usr/local/bin/claude");
    resolveRuntimeSyntheticAuthProviderRefs.mockReturnValueOnce(["claude-cli"]);

    await expect(
      hasRunnableLocalAgent({
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-8",
            models: {
              "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      }),
    ).resolves.toBe(true);

    expect(resolveCliBackendConfig).toHaveBeenCalledWith("claude-cli", expect.any(Object), {
      agentId: "main",
    });
    expect(resolveExecutablePath).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        agentId: "main",
      }),
    );
    expect(selectAgentHarness).not.toHaveBeenCalled();
  });

  it("rejects a configured CLI backend whose executable is missing", async () => {
    resolveCliRuntimeExecutionProvider.mockReturnValueOnce("claude-cli");
    resolveCliBackendConfig.mockReturnValueOnce({
      id: "claude-cli",
      config: { command: "claude" },
    });
    resolveExecutablePath.mockReturnValueOnce(undefined);

    await expect(hasRunnableLocalAgent({})).resolves.toBe(false);

    expect(hasAuthForModelProvider).not.toHaveBeenCalled();
    expect(selectAgentHarness).not.toHaveBeenCalled();
  });

  it("rejects a configured CLI backend whose declared runtime auth is unavailable", async () => {
    resolveCliRuntimeExecutionProvider.mockReturnValueOnce("claude-cli");
    resolveCliBackendConfig.mockReturnValueOnce({
      id: "claude-cli",
      config: { command: "claude" },
    });
    resolveExecutablePath.mockReturnValueOnce("/usr/local/bin/claude");
    resolveRuntimeSyntheticAuthProviderRefs.mockReturnValueOnce(["claude-cli"]);
    hasAuthForModelProvider.mockResolvedValueOnce(false);

    await expect(hasRunnableLocalAgent({})).resolves.toBe(false);

    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude-cli" }),
    );
    expect(selectAgentHarness).not.toHaveBeenCalled();
  });

  it("does not treat an installed but unauthenticated Gemini CLI backend as runnable", async () => {
    resolveCliRuntimeExecutionProvider.mockReturnValueOnce("google-gemini-cli");
    resolveCliBackendConfig.mockReturnValueOnce({
      id: "google-gemini-cli",
      config: { command: "gemini" },
    });
    resolveExecutablePath.mockReturnValueOnce("/usr/local/bin/gemini");
    hasAuthForModelProvider.mockResolvedValueOnce(false);

    await expect(hasRunnableLocalAgent({})).resolves.toBe(false);

    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google-gemini-cli" }),
    );
    expect(selectAgentHarness).not.toHaveBeenCalled();
  });

  it("accepts an installed and authenticated Gemini CLI backend", async () => {
    resolveCliRuntimeExecutionProvider.mockReturnValueOnce("google-gemini-cli");
    resolveCliBackendConfig.mockReturnValueOnce({
      id: "google-gemini-cli",
      config: { command: "gemini" },
    });
    resolveExecutablePath.mockReturnValueOnce("/usr/local/bin/gemini");
    hasAuthForModelProvider.mockResolvedValueOnce(true);

    await expect(hasRunnableLocalAgent({})).resolves.toBe(true);

    expect(hasAuthForModelProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google-gemini-cli" }),
    );
    expect(selectAgentHarness).not.toHaveBeenCalled();
  });

  it("requires a selected plugin harness to prove runtime readiness with provider auth", async () => {
    const checkReadiness = vi.fn(async () => ({ ready: true as const }));
    selectAgentHarness.mockReturnValueOnce({ id: "custom-harness", checkReadiness });

    await expect(hasRunnableLocalAgent({})).resolves.toBe(true);

    expect(hasAuthForModelProvider).toHaveBeenCalledOnce();
    expect(checkReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAuthAvailable: true,
      }),
    );
  });

  it("bounds selected plugin harness readiness and aborts the probe", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      let readinessSignal: AbortSignal | undefined;
      const checkReadiness = vi.fn(
        async (ctx: { signal?: AbortSignal }) =>
          await new Promise<{ ready: true }>(() => {
            readinessSignal = ctx.signal;
          }),
      );
      selectAgentHarness.mockReturnValueOnce({ id: "custom-harness", checkReadiness });

      const readiness = hasRunnableLocalAgent({});
      await vi.advanceTimersByTimeAsync(0);
      const readinessTimeout = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
      expect(readinessTimeout.hasRef()).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(readiness).resolves.toBe(false);
      expect(readinessSignal?.aborted).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses a plugin-owned readiness probe when provider auth is unavailable", async () => {
    const checkReadiness = vi.fn(async () => ({ ready: true as const }));
    selectAgentHarness.mockReturnValueOnce({ id: "custom-harness", checkReadiness });
    hasAuthForModelProvider.mockResolvedValueOnce(false);

    await expect(hasRunnableLocalAgent({})).resolves.toBe(true);

    expect(checkReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        provider: "openai",
        modelId: "gpt-5.5",
        providerAuthAvailable: false,
      }),
    );
  });

  it("uses provider auth for plugin harnesses without the optional readiness probe", async () => {
    selectAgentHarness.mockReturnValueOnce({ id: "custom-harness" });

    await expect(hasRunnableLocalAgent({})).resolves.toBe(true);
    expect(hasAuthForModelProvider).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated plugin harnesses without the optional readiness probe", async () => {
    selectAgentHarness.mockReturnValueOnce({ id: "custom-harness" });
    hasAuthForModelProvider.mockResolvedValueOnce(false);

    await expect(hasRunnableLocalAgent({})).resolves.toBe(false);
    expect(hasAuthForModelProvider).toHaveBeenCalledOnce();
  });
});
