import path from "node:path";
import { afterAll, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { bindSessionMcpRuntimeTestScheduler } from "../../agents/agent-bundle-mcp-manager.test-support.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "../../agents/embedded-agent-runner/model.generation-scope.test-support.js";
import { makeAttemptResult } from "../../agents/embedded-agent-runner/run.overflow-compaction.fixture.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { capturePreparedModelRuntimeCatalog } from "../../agents/prepared-model-runtime.capture.js";
import * as preparedRuntime from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createFollowupRunner } from "./followup-runner.js";
import { enqueueFollowupRun } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const startup = vi.hoisted(() => vi.fn());
// mock-isolation: Fail at harness startup; queue admission, writer claim, settlement and delivery stay real.
vi.mock("../../agents/embedded-agent-runner/run/attempt-session-runtime-prepare.js", () => ({
  prepareEmbeddedAttemptSessionRuntime: startup,
}));

const state = await createOpenClawTestState({ label: "followup-writer-failure" });
afterAll(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  await state.cleanup();
});

it.each(["failure", "cancellation"] as const)(
  "settles queued startup %s against its claimed writer without replay",
  async (mode) => {
    startup.mockReset();
    const sessionKey = "agent:main:writer-failure";
    const sessionId = "writer-failure-session";
    const storePath = path.join(state.sessionsDir(), "openclaw-agent.sqlite");
    const scope = { agentId: "main", storePath, sessionKey };
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        entries: { main: { workspace: state.workspaceDir, agentDir: state.agentDir() } },
        defaults: {
          model: "proof/model",
          models: { "proof/model": { agentRuntime: { id: "openclaw" } } },
          sandbox: { mode: "off" },
          skipBootstrap: true,
        },
      },
      models: {
        providers: {
          proof: {
            api: "openai-completions",
            apiKey: "synthetic-proof-key",
            baseUrl: "http://127.0.0.1:1/v1",
            models: [
              {
                id: "model",
                name: "Proof model",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      plugins: { slots: { memory: "none" } },
      skills: { load: { watch: false } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await bindSessionMcpRuntimeTestScheduler();
    await replaceSessionEntry(scope, {
      sessionId,
      lifecycleRevision: "original-lifecycle",
      activeWriterRunId: "prior-run",
      updatedAt: 1,
    });
    const deliver = vi.fn(async () => {});
    const failure =
      mode === "cancellation"
        ? createAgentRunDirectAbortError()
        : new AgentHarnessPreflightError("synthetic harness startup failed", {
            userMessage: "Synthetic harness startup failed. Try again.",
          });
    startup.mockImplementation(async () => {
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId,
        lifecycleRevision: "original-lifecycle",
      });
      expect(loadSessionEntry(scope)?.activeWriterRunId).not.toBe("prior-run");
      throw failure;
    });
    const queued = createMockFollowupRun({
      prompt: "Run the queued request",
      originatingChannel: "webchat",
      queuedFollowupReplyDisposition: { kind: "deliver", deliver },
      run: {
        agentId: "main",
        sessionId,
        sessionKey,
        config: cfg,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        provider: "proof",
        model: "model",
        messageProvider: "webchat",
        verboseLevel: "on",
        thinkingCatalog: [{ provider: "proof", id: "model", input: ["text"] }],
      },
    });
    const runner = createFollowupRunner({
      storePath,
      sessionKey,
      sessionEntry: loadSessionEntry(scope),
      defaultModel: "proof/model",
      typing: createMockTypingController(),
      typingMode: "never",
    });
    const completed = createDeferred();
    expect(
      enqueueFollowupRun(
        sessionKey,
        queued,
        { mode: "followup", debounceMs: 0 },
        "none",
        async (run) => {
          try {
            await runner(run);
            completed.resolve();
          } catch (error) {
            completed.reject(error);
          }
        },
      ),
    ).toBe(true);
    await completed.promise;
    expect(startup).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(
        mode === "cancellation"
          ? {
              payloads: [],
              completion: expect.objectContaining({ kind: "aborted" }),
            }
          : {
              payloads: [
                expect.objectContaining({
                  text: expect.stringContaining("Synthetic harness startup failed. Try again."),
                }),
              ],
              completion: expect.objectContaining({
                kind: "failed",
                error: expect.stringContaining("Synthetic harness startup failed. Try again."),
              }),
            },
      ),
    );
  },
);

it("drains WebChat on the selected subscription runtime without borrowing the previous turn", async () => {
  const sessionKey = "agent:main:queued-subscription";
  const sessionId = "queued-subscription";
  const storePath = path.join(state.sessionsDir(), "openclaw-agent.sqlite");
  const scope = { agentId: "main", storePath, sessionKey };
  const model = { provider: "openai", id: "queued-model", name: "Queued model" };
  const profileId = "openai:queued-subscription";
  const config: OpenClawConfig = {
    session: { store: storePath },
    auth: {
      profiles: { [profileId]: { provider: "openai", mode: "oauth" } },
      order: { openai: [profileId] },
    },
    agents: {
      entries: { main: { workspace: state.workspaceDir, agentDir: state.agentDir() } },
      defaults: {
        model: { primary: "openai/queued-model", fallbacks: [] },
        models: { "openai/queued-model": { agentRuntime: { id: "codex" } } },
        sandbox: { mode: "off" },
        skipBootstrap: true,
      },
    },
    plugins: { slots: { memory: "none" } },
    skills: { load: { watch: false } },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      [profileId]: {
        type: "oauth",
        provider: "openai",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() + 86_400_000,
        accountId: "synthetic-account",
      },
    },
  });
  await bindSessionMcpRuntimeTestScheduler();
  await replaceSessionEntry(scope, {
    sessionId,
    lifecycleRevision: "queued-subscription-lifecycle",
    providerOverride: model.provider,
    modelOverride: model.id,
    agentRuntimeOverride: "codex",
    updatedAt: 1,
  });

  const generation = createModelGenerationFixture({
    label: "queued-subscription",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    modelId: model.id,
    provider: model.provider,
    requestProvider: model.provider,
    config,
  });
  publishCurrentModelGeneration(generation);
  onTestFinished(resetModelGenerationFixtureState);
  const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
    makeAttemptResult({ assistantTexts: ["Synthetic queued reply"] }),
  );
  registerAgentHarness({
    id: "codex",
    label: "Synthetic Codex transport",
    authBootstrap: "harness",
    supports: ({ provider }) => ({ supported: provider === "openai" }),
    runAttempt,
  });
  const source = {
    ...generation.preparedModelRuntime,
    agentId: "main",
    allowGatewaySubagentBinding: true,
    modelCatalog: {
      entries: [],
      routeVariants: [
        { ...model, api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1" },
      ],
    },
    readFullModelCatalog: () => ({
      entries: [{ ...model, nativeRuntime: "codex" as const }],
      routeVariants: [
        {
          ...model,
          api: "openai-chatgpt-responses" as const,
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      ],
    }),
  };
  using acquire = vi
    .spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime")
    .mockImplementation(async () => ({
      snapshot: capturePreparedModelRuntimeCatalog(source, source),
      pluginGeneration: {
        remoteCatalog: null,
        pluginMetadataSnapshot: generation.metadataSnapshot,
        pluginRegistry: generation.pluginRegistry,
        configuredCatalogEntries: [],
        inlineProviderModels: [],
      },
      run: (operation) => operation(),
      [Symbol.asyncDispose]: async () => {},
    }));
  const deliver = vi.fn(async () => {});
  const prompt = "Synthetic queued WebChat request";
  const queued = createMockFollowupRun({
    prompt,
    messageId: "queued-webchat-source",
    originatingChannel: "webchat",
    originatingThreadId: "queued-webchat-thread",
    queuedFollowupReplyDisposition: { kind: "deliver", deliver },
    run: {
      agentId: "main",
      sessionId,
      sessionKey,
      config,
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      provider: model.provider,
      model: model.id,
      messageProvider: "webchat",
      thinkingCatalog: [{ ...model, input: ["text"] }],
    },
  });
  const runner = createFollowupRunner({
    storePath,
    sessionKey,
    sessionEntry: loadSessionEntry(scope),
    defaultModel: "openai/queued-model",
    typing: createMockTypingController(),
    typingMode: "never",
  });
  const completed = createDeferred();
  expect(
    enqueueFollowupRun(
      sessionKey,
      queued,
      { mode: "followup", debounceMs: 0 },
      "none",
      async (run) => {
        try {
          await runner(run);
          completed.resolve();
        } catch (error) {
          completed.reject(error);
        }
      },
    ),
  ).toBe(true);
  await completed.promise;

  expect(acquire).toHaveBeenCalled();
  expect(deliver).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      originatingChannel: "webchat",
      payloads: [expect.objectContaining({ text: "Synthetic queued reply" })],
      completion: expect.objectContaining({ kind: "completed" }),
    }),
  );
  expect(runAttempt.mock.calls[0]?.[0].runtimePlan?.auth).toMatchObject({
    forwardedAuthProfileId: profileId,
    selectedAuthMode: "oauth",
    modelRoute: {
      api: "openai-chatgpt-responses",
      authRequirement: "subscription",
    },
  });
  expect(runAttempt).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sessionId,
      sessionKey,
      messageThreadId: "queued-webchat-thread",
      prompt,
      provider: model.provider,
      modelId: model.id,
    }),
  );
});
