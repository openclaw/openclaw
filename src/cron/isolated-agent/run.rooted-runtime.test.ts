// Rooted cron reviews preserve their host-selected root and instructions across runtimes.
import { describe, expect, it, vi } from "vitest";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  SKILL_WORKSHOP_MAINTENANCE_PROMPT,
  SKILL_WORKSHOP_MAINTENANCE_TOOLS,
} from "../../skills/workshop/maintenance-prompt.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  isThinkingLevelSupportedMock,
  acquirePreparedModelRuntimeMock,
  loadPublishedReplyDispatchRuntimeMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveCronPayloadOutcomeMock,
  resolveConfiguredModelRefMock,
  resolveEffectiveAgentRuntimeMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const executionRoot = "/tmp/workshop-skills";

describe("runCronIsolatedAgentTurn — rooted runtime fallback", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("carries the review runtime override through preparation and fallback execution", async () => {
    const original: OpenClawConfig = {
      agents: { entries: { main: {} } },
      models: {
        providers: {
          openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1", models: [] },
        },
      },
    };
    loadPublishedReplyDispatchRuntimeMock.mockResolvedValue({
      agentId: "main",
      agentDir: "/tmp/agent-dir",
      workspaceDir: "/tmp/workspace",
      config: original,
      modelCatalog: { entries: [], routeVariants: [] },
      pluginGeneration: {
        pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
        configuredCatalogEntries: [],
        inlineProviderModels: [],
      },
    });
    resolveEffectiveAgentRuntimeMock.mockImplementation(
      ({ cfg, provider, modelId }: { cfg: OpenClawConfig; provider: string; modelId: string }) =>
        resolveAgentHarnessPolicy({ config: cfg, agentId: "main", provider, modelId }).runtime,
    );
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await runInitialModelFallbackAttempt(params);
      const result = await runFallbackModelAttempt(params, "openai", "gpt-fallback", "unknown");
      return { result, provider: "openai", model: "gpt-fallback", attempts: [] };
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: original,
        agentId: "main",
        executionRoot,
        job: makeIsolatedAgentJobFixture({ declarationKey: "skill-collection-review:main" }),
      }),
    );
    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(isThinkingLevelSupportedMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: "openclaw" }),
    );
    expect(isThinkingLevelSupportedMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: "codex" }),
    );
    const admittedConfig = acquirePreparedModelRuntimeMock.mock.calls[0]?.[0].config;
    expect(admittedConfig.agents?.entries?.main.models).toBeUndefined();
    expect(
      acquirePreparedModelRuntimeMock.mock.calls[0]?.[0].runtimePluginSelections,
    ).toContainEqual({
      provider: "openai",
      modelId: "gpt-5.4",
      runtime: "openclaw",
      agentId: "main",
    });
    expect(
      resolveAgentHarnessPolicy({
        config: original,
        agentId: "main",
        provider: "openai",
        modelId: "gpt-5.4",
      }).runtime,
    ).toBe("codex");
    for (const [params] of runEmbeddedAgentMock.mock.calls) {
      expect(
        resolveAgentHarnessPolicy({
          config: params.config,
          agentId: "main",
          provider: "openai",
          modelId: params.model,
        }).runtime,
      ).toBe("codex");
      expect(params.agentHarnessRuntimeOverride).toBe("openclaw");
      expect(params.sessionRoot).toBe(executionRoot);
    }
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it.each(["primary", "fallback"])(
    "preserves a custom provider for a bare %s model",
    async (position) => {
      const original: OpenClawConfig = {
        agents: {
          defaults: {
            model:
              position === "primary"
                ? "gpt-shared"
                : {
                    primary: "openai/gpt-5.4",
                    fallbacks: ["backup"],
                  },
            models: {
              "gpt-shared": { agentRuntime: { id: "auto" } },
              ...(position === "fallback" ? { "relay/gpt-shared": { alias: "backup" } } : {}),
            },
          },
          entries: { main: {} },
        },
        models: {
          providers: {
            openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1", models: [] },
            relay: {
              api: "openai-responses",
              baseUrl: "https://relay.example.test/v1",
              models: [
                {
                  id: "gpt-shared",
                  name: "Shared",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32000,
                  maxTokens: 4000,
                },
              ],
            },
          },
        },
      };
      loadPublishedReplyDispatchRuntimeMock.mockResolvedValue({
        agentId: "main",
        agentDir: "/tmp/agent-dir",
        workspaceDir: "/tmp/workspace",
        config: original,
        modelCatalog: { entries: [], routeVariants: [] },
        pluginGeneration: {
          pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
          configuredCatalogEntries: [],
          inlineProviderModels: [],
        },
      });
      const selection = await vi.importActual<
        typeof import("../../agents/model-selection-shared.js")
      >("../../agents/model-selection-shared.js");
      resolveConfiguredModelRefMock.mockImplementation(selection.resolveConfiguredModelRef);
      const { resolveModelCandidateChain } = await vi.importActual<
        typeof import("../../agents/model-fallback-candidates.js")
      >("../../agents/model-fallback-candidates.js");
      runWithModelFallbackMock.mockImplementation(
        async (
          params: TestModelFallbackRunnerParams & {
            cfg: OpenClawConfig;
            fallbacksOverride?: string[];
          },
        ) => {
          const candidates = resolveModelCandidateChain({
            ...params,
            agentId: "main",
            requestedRouteResolution: "resolved",
          });
          const candidate = candidates.at(-1)!;
          expect(candidate.provider).toBe("relay");
          const result =
            position === "primary"
              ? await runInitialModelFallbackAttempt(params)
              : await runFallbackModelAttempt(
                  params,
                  candidate.provider,
                  candidate.model,
                  "unknown",
                );
          return { result, provider: candidate.provider, model: candidate.model, attempts: [] };
        },
      );
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg: original,
          agentId: "main",
          executionRoot,
          job: makeIsolatedAgentJobFixture({ declarationKey: "skill-collection-review:main" }),
        }),
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "relay",
          model: "gpt-shared",
          sessionRoot: executionRoot,
        }),
      );
      expect(original.agents?.entries?.main?.models).toBeUndefined();
    },
  );

  it("rejects a rooted turn before the unsupported Codex harness starts", async () => {
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot }),
    );

    expect(result).toMatchObject({
      status: "error",
      admissionDisposition: "rejected",
    });
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each([
    { prompt: "", skills: [] },
    { prompt: "Explicit safe instructions", skills: [{ name: "safe" }] },
  ])("preserves the host-selected instruction snapshot: $prompt", async (skillsSnapshot) => {
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot, skillsSnapshot }),
    );
    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(expect.objectContaining({ skillsSnapshot }));
  });

  it("runs a rooted review with a Claude CLI primary and returns its report", async () => {
    const helpers = await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      helpers.pickLastNonEmptyTextFromPayloads,
    );
    resolveCronPayloadOutcomeMock.mockImplementation(helpers.resolveCronPayloadOutcome);
    const skillsSnapshot = { prompt: "", skills: [] };
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    resolveEffectiveAgentRuntimeMock.mockReturnValue("claude-cli");
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    runCliAgentMock.mockImplementation(async (params) => {
      params.onExecutionStarted?.();
      return {
        payloads: [{ text: "Workshop review complete: retained useful procedures." }],
        meta: { agentMeta: {} },
      };
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        executionRoot,
        skillsSnapshot,
        job: {
          payload: {
            kind: "agentTurn",
            message: SKILL_WORKSHOP_MAINTENANCE_PROMPT,
            toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
          },
          delivery: { mode: "none" },
        },
        cfg: {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-6",
              models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } } },
            },
          },
        },
      }),
    );
    expect(result).toMatchObject({
      status: "ok",
      outputText: "Workshop review complete: retained useful procedures.",
    });
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        rootedExecution: { root: executionRoot },
        workspaceDir: executionRoot,
        skillsSnapshot,
        trigger: "cron",
        toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
      }),
    );
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("skips an unsupported rooted runtime and reaches a later embedded candidate", async () => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ modelId }: { modelId: string }) =>
      modelId === "gpt-5.4" || modelId === "gpt-5" ? "openclaw" : "unsupported-harness",
    );
    isCliProviderMock.mockReturnValue(false);
    runEmbeddedAgentMock.mockImplementation(
      async (params: { model?: string; onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        if (params.model === "gpt-5.4") {
          throw new Error("embedded primary failed");
        }
        return { payloads: [{ text: "later embedded succeeded" }], meta: { agentMeta: {} } };
      },
    );
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow(
        "embedded primary failed",
      );
      await expect(
        runFallbackModelAttempt(params, "claude-cli", "claude-opus-4-6", "unknown"),
      ).rejects.toThrow("collection review requires a runtime that enforces the Workshop root");
      const result = await runFallbackModelAttempt(params, "openai", "gpt-5", "unknown");
      return { result, provider: "openai", model: "gpt-5", attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ provider: "openai", model: "gpt-5" }),
    );
  });
});
