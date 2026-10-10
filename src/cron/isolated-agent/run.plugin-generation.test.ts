// Proves isolated cron/hook runs carry the published Gateway plugin generation
// into embedded execution instead of rebuilding metadata per run (#125596 family).
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getPreparedModelRuntimePluginGeneration,
  getPreparedModelRuntimeBorrowedSnapshot,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import { normalizeVerboseLevel } from "../../auto-reply/thinking.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
  acquirePreparedModelRuntimeMock,
  loadPublishedReplyDispatchRuntimeMock,
  loadModelCatalogOwnerMock,
  resolveAgentConfigMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  makeCronSession,
  resolveCronSessionMock,
  resolveSessionAuthSelectionMock,
} from "./run.test-harness.js";

const { PreparedModelRuntimeOwnerNotPublishedError } = await vi.importActual<
  typeof import("../../agents/prepared-model-runtime.errors.js")
>("../../agents/prepared-model-runtime.errors.js");

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

async function setupPublishedGeneration(withAuth = false) {
  const config = {
    ...(withAuth
      ? { auth: { profiles: { test: { provider: "openai", mode: "api_key" as const } } } }
      : {}),
    agents: { entries: { default: { thinkingDefault: "high" as const } } },
  };
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    manifestRegistry: { plugins: [], diagnostics: [] },
  });
  const makeGeneration = () =>
    ({
      remoteCatalog: null,
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
    }) satisfies PreparedModelRuntimePluginGeneration;
  const pluginGeneration = makeGeneration();
  const { resolveAgentConfig } = await vi.importActual<
    typeof import("../../agents/agent-scope-config.js")
  >("../../agents/agent-scope-config.js");
  resolveAgentConfigMock.mockImplementation(resolveAgentConfig);
  mockRunCronFallbackPassthrough();
  const owner = {
    agentId: "default",
    agentDir: "/tmp/dispatch-agent-dir",
    workspaceDir: "/tmp/workspace",
    config,
    metadataSnapshot,
    modelCatalog: { entries: [], routeVariants: [] },
  };
  const dispatchRuntime = {
    agentId: "default",
    agentDir: "/tmp/dispatch-agent-dir",
    workspaceDir: "/tmp/dispatch-workspace",
    config,
    modelCatalog: { entries: [], routeVariants: [] },
    pluginGeneration,
  };
  return {
    config,
    metadataSnapshot,
    makeGeneration,
    pluginGeneration,
    owner,
    dispatchRuntime,
    release: vi.fn(async () => {}),
  };
}

describe("runCronIsolatedAgentTurn plugin generation carry", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("carries the admitted config into execution while preserving agent overrides", async () => {
    const runtime = await import("./run-execution.runtime.js");
    vi.mocked(runtime.normalizeVerboseLevel).mockImplementation(normalizeVerboseLevel);
    const agent = {
      model: "google/gemini-2.0-flash",
      identity: { name: "Scheduled worker" },
      verboseDefault: "on" as const,
    };
    const config = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6" },
        entries: { main: agent },
      },
    };
    const admittedConfig = structuredClone(config);
    const selected = { provider: "google", model: "gemini-2.0-flash" };
    resolveAgentConfigMock.mockReturnValue(agent);
    resolveConfiguredModelRefMock.mockReturnValue(selected);
    resolveAllowedModelRefMock.mockReturnValue({ ref: selected });
    const acquire = acquirePreparedModelRuntimeMock.getMockImplementation()!;
    acquirePreparedModelRuntimeMock.mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args);
      return { ...lease, snapshot: { ...lease.snapshot, config: admittedConfig } };
    });
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      const generation = getPreparedModelRuntimePluginGeneration();
      expect(generation).toBeDefined();
      const borrowed = getPreparedModelRuntimeBorrowedSnapshot(generation!);
      expect(params.config).toBe(borrowed?.config);
      expect(params.config).toBe(admittedConfig);
      return { payloads: [{ text: "summary done" }], meta: { agentMeta: {} } };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ cfg: config, agentId: "main" }),
    );

    expect(result.status).toBe("ok");
    expect(acquirePreparedModelRuntimeMock.mock.calls[0]?.[0].config).toBe(config);
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ ...selected, verboseLevel: "on" }),
    );
  });

  it("admits the published generation and keeps it active through embedded execution", async () => {
    const { config, metadataSnapshot, pluginGeneration, owner, dispatchRuntime, release } =
      await setupPublishedGeneration();
    loadModelCatalogOwnerMock.mockResolvedValue(owner);
    const fullCatalog = {
      entries: [{ provider: "openai", id: "gpt-5.4", reasoning: true }],
      routeVariants: [],
    };
    const readFullModelCatalog = vi.fn(() => fullCatalog);
    const releaseDispatch = vi.fn(async () => {});
    const dispatchLease = {
      snapshot: { ...owner, metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
      pluginGeneration,
      [Symbol.asyncDispose]: releaseDispatch,
    };
    loadPublishedReplyDispatchRuntimeMock.mockImplementation(async ({ onRuntimeLease }) => {
      onRuntimeLease?.(dispatchLease);
      return { ...dispatchRuntime, readFullModelCatalog };
    });
    const selectedGeneration = {
      ...pluginGeneration,
      pluginRegistry: createEmptyPluginRegistry(),
    };
    const afterPreparation = createDeferred();
    let borrowedAfterPreparation: Promise<unknown> | undefined;
    acquirePreparedModelRuntimeMock.mockImplementation(async () => {
      expect(getPreparedModelRuntimeBorrowedSnapshot(pluginGeneration)).toBe(
        dispatchLease.snapshot,
      );
      expect(releaseDispatch).not.toHaveBeenCalled();
      borrowedAfterPreparation = afterPreparation.promise.then(() =>
        getPreparedModelRuntimeBorrowedSnapshot(pluginGeneration),
      );
      return {
        snapshot: { config, metadataSnapshot, pluginRegistry: selectedGeneration.pluginRegistry },
        pluginGeneration: selectedGeneration,
        [Symbol.asyncDispose]: release,
      };
    });
    const afterRun = createDeferred();
    let borrowedAfterClose: Promise<unknown> | undefined;
    let embeddedRunGeneration: unknown = "not-captured";
    runEmbeddedAgentMock.mockImplementation(async (params) => {
      expect(releaseDispatch).toHaveBeenCalledOnce();
      afterPreparation.resolve();
      await expect(borrowedAfterPreparation).resolves.toBeUndefined();
      expect(params.config).toEqual(acquirePreparedModelRuntimeMock.mock.calls[0]?.[0].config);
      embeddedRunGeneration = getPreparedModelRuntimePluginGeneration();
      borrowedAfterClose = afterRun.promise.then(() =>
        getPreparedModelRuntimeBorrowedSnapshot(selectedGeneration),
      );
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ cfg: config, agentId: "default" }),
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ok");
    const dispatchAdmission = loadPublishedReplyDispatchRuntimeMock.mock.calls[0]?.[0] as {
      abortSignal: AbortSignal;
    };
    expect(dispatchAdmission).toMatchObject({ agentId: "default", abortSignal: expect.anything() });
    expect(acquirePreparedModelRuntimeMock.mock.calls[0]?.[1]).toEqual({
      catalogMode: "static",
      pluginGeneration,
      abortSignal: dispatchAdmission.abortSignal,
    });
    expect(embeddedRunGeneration).toBe(selectedGeneration);
    expect(readFullModelCatalog).toHaveBeenCalledOnce();
    expect(loadModelCatalogOwnerMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    afterRun.resolve();
    await expect(borrowedAfterClose).resolves.toBeUndefined();
    expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
  });

  it("retains the admitted runtime when a generation publishes during auth preparation", async () => {
    const fixture = await setupPublishedGeneration(true);
    const { config, metadataSnapshot, pluginGeneration: generationA, release } = fixture;
    const generationB = fixture.makeGeneration();
    let publishedGeneration: PreparedModelRuntimePluginGeneration = generationA;
    loadModelCatalogOwnerMock.mockResolvedValue(fixture.owner);
    loadPublishedReplyDispatchRuntimeMock.mockImplementation(async () => ({
      ...fixture.dispatchRuntime,
      pluginGeneration: publishedGeneration,
    }));
    resolveSessionAuthSelectionMock.mockImplementation(async () => {
      publishedGeneration = generationB;
      return undefined;
    });
    acquirePreparedModelRuntimeMock.mockImplementation(async (input, options) => {
      if (options?.pluginGeneration !== publishedGeneration) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime plugin generation was superseded for ${input.agentDir}`,
        );
      }
      const pluginRegistry = createEmptyPluginRegistry();
      return {
        snapshot: { ...input, metadataSnapshot, pluginRegistry },
        pluginGeneration: { ...publishedGeneration, pluginRegistry },
        [Symbol.asyncDispose]: release,
      };
    });

    await expect(
      runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture({ cfg: config, agentId: "default" })),
    ).resolves.toMatchObject({ status: "ok" });
    expect(resolveSessionAuthSelectionMock).toHaveBeenCalledOnce();
    expect(loadPublishedReplyDispatchRuntimeMock).toHaveBeenCalledOnce();
    expect(acquirePreparedModelRuntimeMock.mock.calls[0]?.[1]).toMatchObject({
      pluginGeneration: generationA,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps the execution owner's model pricing through finalization", async () => {
    const config = {
      models: {
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid/v1",
            models: [
              {
                id: "alias",
                name: "Alias",
                cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    const snapshot = (model: string) =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            providers: ["fixture"],
            modelIdNormalization: { providers: { fixture: { aliases: { alias: model } } } },
          },
        ],
      });
    const selected = snapshot("selected");
    const ambient = snapshot("other");
    loadModelCatalogOwnerMock.mockResolvedValue({
      config,
      agentId: "default",
      agentDir: "/tmp/agent-dir",
      workspaceDir: "/tmp/workspace",
      metadataSnapshot: selected,
      modelCatalog: { entries: [], routeVariants: [] },
    });
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
    acquirePreparedModelRuntimeMock.mockImplementation(async (input) => ({
      snapshot: {
        ...input,
        metadataSnapshot: selected,
        pluginRegistry: createEmptyPluginRegistry(),
      },
      pluginGeneration: {
        pluginMetadataSnapshot: selected,
        remoteCatalog: null,
        configuredCatalogEntries: [],
        inlineProviderModels: [],
      },
      [Symbol.asyncDispose]: vi.fn(async () => {}),
    }));
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: {
          provider: "fixture",
          model: "selected",
          usage: { input: 1_000_000, output: 0 },
        },
      },
    });
    const result = await withPluginRuntimeGenerationScope({ metadataSnapshot: ambient }, () =>
      runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture({ cfg: config })),
    );
    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.estimatedCostUsd).toBe(3);
    expect(acquirePreparedModelRuntimeMock.mock.calls[0]?.[1].pluginMetadataSnapshot).toBe(
      selected,
    );
  });

  it("releases the prepared lease when continuation initialization fails", async () => {
    const fixture = await setupPublishedGeneration();
    const releaseDispatch = vi.fn(async () => {});
    loadPublishedReplyDispatchRuntimeMock.mockImplementation(async ({ onRuntimeLease }) => {
      onRuntimeLease?.({
        snapshot: fixture.owner,
        pluginGeneration: fixture.pluginGeneration,
        [Symbol.asyncDispose]: releaseDispatch,
      });
      return fixture.dispatchRuntime;
    });
    const state = await import("./run-session-state.js");
    const initialize = vi.spyOn(state, "createCronRunContinuationSession").mockReturnValue({
      initialize: async () => {
        throw new Error("continuation fixture failed");
      },
      sync: async () => {},
      setCliExecutionProvider: async () => {},
      seal: async () => {},
    });
    const release = vi.fn(async () => {});
    acquirePreparedModelRuntimeMock.mockResolvedValue({
      snapshot: { config: fixture.config, pluginRegistry: createEmptyPluginRegistry() },
      [Symbol.asyncDispose]: release,
    });
    try {
      await expect(runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture())).rejects.toThrow(
        "continuation fixture failed",
      );
      expect(release).toHaveBeenCalledOnce();
      expect(releaseDispatch).toHaveBeenCalledOnce();
    } finally {
      initialize.mockRestore();
    }
  });
});
