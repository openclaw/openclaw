import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../agents/failover-error.js";
import * as execution from "../agents/simple-completion-execution.js";
import * as runtime from "../agents/simple-completion-runtime.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import * as utilityCompletion from "../agents/utility-completion.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { defaultCompleteModel, defaultPrepareModel } from "./session-observer-model.js";
import {
  createHarness,
  flushObserver,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

const runtimeMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  runEmbeddedAttempt: vi.fn(),
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: runtimeMocks.acquire,
}));
vi.mock("../agents/embedded-agent-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: runtimeMocks.runEmbeddedAttempt,
}));

describe("utility completion with an unavailable implicit harness", () => {
  let state: OpenClawTestState;
  let config: OpenClawConfig;
  let dispose: (() => void | Promise<void>) | undefined;
  const completionPrompt = {
    systemPrompt: "Return a short reply.",
    prompt: "Check the fix.",
    timeoutMs: 1000,
  };
  const prepare = () =>
    defaultPrepareModel({ cfg: config, agentId: "main", useUtilityModel: true });
  const runtimeSnapshot = (pluginRegistry = createEmptyPluginRegistry()) => ({
    config,
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    metadataSnapshot: createEmptyPluginMetadataSnapshot(state.workspaceDir),
    pluginRegistry,
  });
  const useFallbacks = () => {
    config.agents!.defaults!.utilityModel = {
      primary: "openai/gpt-5.4-mini",
      fallbacks: ["openai/utility-backup"],
    };
    config.agents!.entries!.main!.model = {
      primary: "openai/gpt-5.4",
      fallbacks: ["openai/main-backup"],
    };
  };
  const transportReply = (text: string) =>
    vi
      .spyOn(execution, "completeWithPreparedSimpleCompletionModel")
      .mockResolvedValue(
        makeAssistantMessageFixture({ stopReason: "stop", content: [{ type: "text", text }] }),
      );
  beforeEach(async () => {
    vi.spyOn(utilityCompletion, "hasAvailableUtilityCompletionAuth").mockResolvedValue(true);
    dispose = undefined;
    state = await createOpenClawTestState({ scenario: "minimal" });
    config = {
      agents: {
        defaults: { utilityModel: "openai/gpt-5.4-mini", workspace: state.workspaceDir },
        entries: {
          main: {
            model: "openai/gpt-5.4",
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      plugins: { entries: { codex: { enabled: false } } },
    };
    setRuntimeConfigSnapshot(config);
    runtimeMocks.acquire.mockReset().mockResolvedValue({
      snapshot: runtimeSnapshot(),
      [Symbol.asyncDispose]: async () => {},
    });
    runtimeMocks.runEmbeddedAttempt.mockReset();
    // Keep routing and the built-in zero-tool execution real; isolate only auth and transport.
    vi.spyOn(runtime, "prepareSimpleCompletionModel").mockImplementation(
      async ({ provider, modelId: id }) => ({
        model: makeProviderModelFixture({
          provider,
          id,
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
        }),
        auth: { apiKey: "synthetic-utility-key", mode: "api-key", source: "test" },
      }),
    );
  });

  afterEach(async () => {
    try {
      await dispose?.();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      resetSessionObserverEventSequence();
      await state.cleanup();
    }
  });

  it.each([false, true])(
    "publishes the observer digest without inheriting session harness state: fallback=%s",
    async (fallback) => {
      const transport = transportReply('{"headline":"Checking the fix","health":"on-track"}');
      if (fallback) {
        useFallbacks();
        transport.mockRejectedValueOnce(
          new FailoverError("Fixture server unavailable", { reason: "server_error" }),
        );
      }
      vi.useFakeTimers();
      const observer = createHarness({
        config,
        prepareModel: vi.fn(defaultPrepareModel),
        completeModel: vi.fn(defaultCompleteModel),
        readSession: vi.fn(() => ({
          sessionId: "session-id",
          updatedAt: 0,
          agentHarnessId: "openclaw",
        })),
      });
      dispose = () => observer.observer.disposeAsync();
      await startAndAddToolNotes(observer.observer);
      await vi.advanceTimersByTimeAsync(12_000);
      await vi.dynamicImportSettled();
      await flushObserver();

      expect(observer.broadcastToConnIds).toHaveBeenCalledWith(
        "session.observer",
        expect.objectContaining({ headline: "Checking the fix", health: "on-track" }),
        expect.any(Set),
        expect.anything(),
      );
      expect(transport.mock.calls[0]?.[0].context.tools).toEqual([]);
      expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
      expect(transport.mock.calls.map(([request]) => request.model.id)).toEqual(
        fallback ? ["gpt-5.4-mini", "utility-backup"] : ["gpt-5.4-mini"],
      );
    },
  );

  it("admits the utility harness from its run-owned registry before validating registration", async () => {
    config.agents!.defaults!.utilityModel = {
      primary: "utility-fixture/small",
      fallbacks: ["utility-fixture/backup"],
    };
    config.agents!.entries!.main!.models!["utility-fixture/small"] = {
      agentRuntime: { id: "admitted-utility" },
    };
    const registry = createEmptyPluginRegistry();
    const dispatch = vi.fn(async () => ({
      assistant: makeAssistantMessageFixture({
        stopReason: "stop",
        provider: "utility-fixture",
        model: "small",
        content: [{ type: "text", text: "The admitted utility harness answered." }],
      }),
    }));
    registry.agentHarnesses.push({
      pluginId: "utility-fixture",
      source: "fixture",
      harness: {
        id: "admitted-utility",
        label: "Admitted utility fixture",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("The utility fixture only supports isolated completion");
        },
        runIsolatedCompletionV2: dispatch,
      },
    });
    const release = vi.fn(async () => {});
    const snapshot = runtimeSnapshot(registry);
    runtimeMocks.acquire.mockResolvedValue({
      snapshot,
      [Symbol.asyncDispose]: release,
    });
    const builtInTransport = vi
      .spyOn(execution, "completeWithPreparedSimpleCompletionModel")
      .mockRejectedValue(new Error("Unexpected built-in utility completion"));
    const prepared = await prepare();

    await expect(
      withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: snapshot.metadataSnapshot,
          pluginRegistry: createEmptyPluginRegistry(),
        },
        () => defaultCompleteModel({ ...prepared, ...completionPrompt }),
      ),
    ).resolves.toMatchObject({
      text: "The admitted utility harness answered.",
      owner: { kind: "harness", id: "admitted-utility" },
    });
    expect(release).toHaveBeenCalledOnce();
    expect(builtInTransport).not.toHaveBeenCalled();
    expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it.each(["model policy", "request override"])(
    "rejects an unavailable explicit Codex %s before preparing credentials",
    async (source) => {
      if (source === "model policy") {
        config.agents!.entries!.main!.models!["openai/gpt-5.4-mini"] = {
          agentRuntime: { id: "codex" },
        };
      }
      const prepared = await prepare();
      await expect(
        defaultCompleteModel({
          ...prepared,
          ...completionPrompt,
          ...(source === "request override" ? { agentHarnessRuntimeOverride: "codex" } : {}),
        }),
      ).rejects.toThrow('Agent harness runtime "codex" is unavailable');
      expect(runtime.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      expect(runtimeMocks.runEmbeddedAttempt).not.toHaveBeenCalled();
    },
  );
});
