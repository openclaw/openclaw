import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../../agents/auth-profiles/runtime-snapshots.js";
import { resolveCodexNativeSearchActivation } from "../../agents/codex-native-web-search-core.js";
import { buildEmbeddedAttemptToolRunContext } from "../../agents/embedded-agent-runner/run/attempt-tool-run-context.js";
import { bindRunToPreparedModelRuntime } from "../../agents/embedded-agent-runner/run/prepared-runtime-context.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveWebSearchProviderForRun } from "../../secrets/runtime-command-secrets.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
} from "../../secrets/runtime.js";
import { createWebSearchTestProvider } from "../../test-utils/web-provider-runtime.test-helpers.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  acquirePreparedModelRuntimeMock,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const { execute, providers } = vi.hoisted(() => ({ execute: vi.fn(), providers: vi.fn() }));
// Fixed provider I/O; cron preparation, config rebinding, tool context, selection and execution are real.
vi.mock("../../plugins/web-search-providers.runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../plugins/web-search-providers.runtime.js")>();
  return {
    ...actual,
    resolveRuntimeWebSearchProviders: providers,
  };
});
// mock-isolation: This suite owns provider discovery and must not enter the shared bundled-discovery lifecycle.
vi.mock("../../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));
vi.doUnmock("../../web-search/runtime.js");
vi.doUnmock("../../agents/tools/web-tools.js");
const { createWebSearchTool } = await import("../../agents/tools/web-search.js");
const { createOpenClawTools } = await import("../../agents/openclaw-tools.js");
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function config(): OpenClawConfig {
  return {
    tools: { web: { search: { openaiCodex: { enabled: true } } } },
    plugins: {
      entries: { brave: { enabled: true, config: { webSearch: { apiKey: "synthetic-brave" } } } },
    },
  };
}

function activate(cfg: OpenClawConfig) {
  activateSecretsRuntimeSnapshot({
    sourceConfig: cfg,
    config: structuredClone(cfg),
    authStores: [],
    warnings: [],
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
    webTools: {
      search: {
        providerSource: "auto-detect",
        selectedProvider: cfg.tools?.web?.search?.provider ?? "brave",
        diagnostics: [],
      },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
  });
}

const searchArgs = {
  query: "synthetic cron news",
  date_after: "2026-10-14",
  date_before: "2026-10-15",
};

describe("isolated cron webSearchProvider at the managed tool boundary", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });
  beforeEach(() => {
    mockRunCronFallbackPassthrough();
    execute.mockReset().mockResolvedValue({ results: [] });
    providers.mockImplementation(() =>
      ["duckduckgo", "brave"].map((id) =>
        createWebSearchTestProvider({
          pluginId: id,
          id,
          credentialPath: `plugins.entries.${id}.config.webSearch.apiKey`,
          requiresCredential: false,
          createTool: ({ config: cfg }) => ({
            description: id,
            parameters: {},
            execute: (args) => execute(id, args, cfg?.tools?.web?.search?.provider),
          }),
        }),
      ),
    );
  });
  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
  });

  it.each(["brave", " BRAVE \t"])(
    "retains %j across cron admission, prepared config rebinding and late-bound execution",
    async (webSearchProvider) => {
      const cfg = config();
      activate(cfg);
      const original = structuredClone(cfg);
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg,
          job: {
            sessionTarget: "isolated",
            delivery: { mode: "none" },
            payload: { kind: "agentTurn", message: "search", webSearchProvider },
          },
        }),
      );
      expect(result.status).toBe("ok");
      const run = runEmbeddedAgentMock.mock.calls[0]?.[0];
      expect(run).toBeDefined();
      expect(run.webSearchProvider).toBe("brave");
      expect(acquirePreparedModelRuntimeMock.mock.calls[0]?.[0].runtimePluginSelections).toEqual(
        expect.arrayContaining([expect.objectContaining({ webSearchProvider: "brave" })]),
      );
      // Exercise config rebinding; real registry admission is covered by runtime-plugins.web-search.integration.test.ts.
      const preparation = acquirePreparedModelRuntimeMock.mock.results[0];
      if (preparation?.type !== "return") {
        throw new Error("Expected a prepared runtime lease");
      }
      const lease = await preparation.value;
      const bound = bindRunToPreparedModelRuntime({
        runParams: run,
        preparedModelRuntime: lease.snapshot,
        requestedWorkspaceResolution: {
          workspaceDir: "/tmp/workspace",
          agentId: "main",
          agentIdSource: "explicit",
          usedFallback: false,
          isCanonicalWorkspace: true,
        },
      }).runParams;
      expect(
        resolveCodexNativeSearchActivation({
          config: bound.config,
          modelApi: "openai-chatgpt-responses",
        }),
      ).toMatchObject({ state: "managed_only", inactiveReason: "managed_provider_selected" });
      const context = buildEmbeddedAttemptToolRunContext({
        ...bound,
        model: { id: bound.model ?? "fixture-model", provider: bound.provider ?? "openai" },
      });
      const tool = createOpenClawTools({
        ...context,
        config: bound.config,
        disableMessageTool: true,
        disablePluginTools: true,
        wrapBeforeToolCallHook: false,
      }).find((entry) => entry.name === "web_search");
      expect(tool).toBeDefined();
      await tool!.execute("cron-search", searchArgs, undefined);
      expect(execute).toHaveBeenCalledExactlyOnceWith("brave", searchArgs, "brave");
      expect(cfg).toEqual(original);
      expect(
        resolveCodexNativeSearchActivation({ config: cfg, modelApi: "openai-chatgpt-responses" })
          .state,
      ).toBe("native_active");
    },
  );

  it("pins concurrent cron search without changing the chat selection or date arguments", async () => {
    const cfg = config();
    cfg.tools!.web!.search!.provider = "duckduckgo";
    activate(cfg);
    const cron = createWebSearchTool({
      config: cfg,
      webSearchProvider: " BRAVE \t",
      lateBindRuntimeConfig: true,
    })!;
    const chat = createWebSearchTool({ config: cfg, lateBindRuntimeConfig: true })!;
    await Promise.all([
      cron.execute("cron", searchArgs, undefined),
      chat.execute("chat", searchArgs, undefined),
    ]);
    expect(
      execute.mock.calls
        .map(([id]) => String(id))
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["brave", "duckduckgo"]);
    expect(
      execute.mock.calls.every(([, args]) => JSON.stringify(args) === JSON.stringify(searchArgs)),
    ).toBe(true);
  });

  it.each([
    {
      label: "unknown provider",
      provider: "unknown-provider",
      change: (cfg: OpenClawConfig) => cfg,
      error: /provider.*unknown-provider/i,
    },
    {
      label: "disabled plugin",
      provider: "brave",
      change: (cfg: OpenClawConfig) => {
        cfg.plugins!.entries!.brave!.enabled = false;
        return cfg;
      },
      error: /brave.*disabled|disabled.*brave/i,
    },
    {
      label: "disabled search",
      provider: "brave",
      change: (cfg: OpenClawConfig) => {
        cfg.tools!.web!.search!.enabled = false;
        return cfg;
      },
      error: /disabled/i,
    },
    {
      label: "native domain constraint",
      provider: "brave",
      change: (cfg: OpenClawConfig) => {
        cfg.tools!.web!.search!.openaiCodex!.allowedDomains = ["example.org"];
        return cfg;
      },
      error: /allowedDomains/,
    },
  ])("fails closed at execution after live $label changes", async ({ provider, change, error }) => {
    const cfg = config();
    activate(cfg);
    const tool = createWebSearchTool({
      config: cfg,
      webSearchProvider: provider,
      lateBindRuntimeConfig: true,
    })!;
    activate(change(structuredClone(cfg)));
    await expect(tool.execute("cron", searchArgs, undefined)).rejects.toThrow(error);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects CLI search overrides before inference (fallback=%s)",
    async (fallback) => {
      const cfg = config();
      activate(cfg);
      isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
      runCliAgentMock.mockResolvedValue({ payloads: [{ text: "synthetic reply" }], meta: {} });
      runWithModelFallbackMock.mockImplementation(async (params) => ({
        result: fallback
          ? await runFallbackModelAttempt(params, "claude-cli", "synthetic-model", "rate_limit")
          : await runInitialModelFallbackAttempt(params, "claude-cli", "synthetic-model"),
        provider: "claude-cli",
        model: "synthetic-model",
        attempts: [],
      }));
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg,
          job: {
            sessionTarget: "isolated",
            delivery: { mode: "none" },
            payload: { kind: "agentTurn", message: "search", webSearchProvider: "brave" },
          },
        }),
      );
      expect(result).toMatchObject({
        status: "error",
        error: expect.stringMatching(/webSearchProvider.*CLI/i),
      });
      expect(runCliAgentMock).not.toHaveBeenCalled();
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { id: "grok", pluginId: "xai", authProviderId: "xai" },
    { id: "brave", pluginId: "brave", authProviderId: undefined },
  ])(
    "defers only declared profile auth for $id without config/env credentials",
    async ({ id, pluginId, authProviderId }) => {
      const cfg: OpenClawConfig = { plugins: { entries: { [pluginId]: { enabled: true } } } };
      activate(cfg);
      providers.mockReturnValue([
        {
          ...createWebSearchTestProvider({
            id,
            pluginId,
            authProviderId,
            requiresCredential: true,
            credentialPath: `plugins.entries.${pluginId}.config.webSearch.apiKey`,
          }),
          envVars: [],
        },
      ]);
      const result = resolveWebSearchProviderForRun({ config: cfg, providerId: id });
      if (authProviderId) {
        await expect(result).resolves.toMatchObject({
          runtimeWebSearch: { selectedProvider: "grok", selectedProviderKeySource: "missing" },
        });
      } else {
        await expect(result).rejects.toThrow(/brave.*credentials/i);
      }
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("rejects an unavailable explicit provider before model execution", async () => {
    const cfg = config();
    activate(cfg);
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg,
        job: {
          sessionTarget: "isolated",
          delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: "search", webSearchProvider: "missing-provider" },
        },
      }),
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/provider.*missing-provider/i),
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("leaves an omitted selection on native Codex", async () => {
    const cfg = config();
    activate(cfg);
    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg,
        job: { payload: { kind: "agentTurn", message: "search" } },
      }),
    );
    const run = runEmbeddedAgentMock.mock.calls[0]?.[0];
    expect(run.webSearchProvider).toBeUndefined();
    expect(
      resolveCodexNativeSearchActivation({
        config: run.config,
        modelApi: "openai-chatgpt-responses",
      }).state,
    ).toBe("native_active");
    expect(execute).not.toHaveBeenCalled();
  });
});
