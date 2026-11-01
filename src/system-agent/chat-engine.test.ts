import "./chat-engine.mocks.test-support.js";
import { expect, it, vi } from "vitest";
import * as embeddedAgent from "../agents/embedded-agent.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../agents/prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../agents/prepared-model-runtime.types.js";
import type { SystemAgentSession } from "./agent-turn.js";
import {
  mocks,
  operationMocks,
  createSystemAgentVerifiedInferenceTestFixture,
  useTempStateDir,
  configSnapshot,
  createAmbientVerifiedBinding,
  createChatEngine,
  inferenceConfig,
  SystemAgentChatEngine,
  RuntimeSystemAgentChatEngine,
  runSystemAgentTurn,
  type OpenClawConfig,
  type SystemAgentChatEngineOptions,
} from "./chat-engine.test-support.js";
import { createInferenceConfigFixture } from "./inference-config.test-support.js";

vi.mock("../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(),
}));

async function driftFixture() {
  const configFixture = await createInferenceConfigFixture(inferenceConfig());
  const snapshot = configFixture.snapshot;
  mocks.readConfigFileSnapshot.mockImplementation(configFixture.read);
  return {
    verifiedInference: await createAmbientVerifiedBinding(
      snapshot.runtimeConfig ?? snapshot.config,
      snapshot,
    ),
    drift: () =>
      configFixture.write({ agents: { defaults: { model: "anthropic/claude-opus-4-8" } } }),
  };
}

async function verifiedEngine(
  config: OpenClawConfig,
  options: Omit<SystemAgentChatEngineOptions, "verifiedInference">,
) {
  useTempStateDir();
  const inference = await createSystemAgentVerifiedInferenceTestFixture(config);
  mocks.readConfigFileSnapshot.mockImplementation(async () => configSnapshot(config));
  return createChatEngine({ verifiedInference: inference.binding, ...options }, true);
}

it.each(["requester", "alternate"])("preserves runtime ownership for %s", async (requester) => {
  const config: OpenClawConfig = {
    agents: {
      defaults: { model: "openai/gpt-5.5" },
      entries: { alternate: { model: "openai/gpt-5.5" } },
    },
  };
  const inheritedGeneration = {} as PreparedModelRuntimePluginGeneration;
  const observedGenerations: Array<PreparedModelRuntimePluginGeneration | undefined> = [];
  vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async () => {
    observedGenerations.push(getPreparedModelRuntimePluginGeneration());
    return { meta: { durationMs: 0, finalAssistantVisibleText: "ready" } };
  });
  vi.spyOn(
    await import("./assistant.js"),
    "planSystemAgentGreetingWithConfiguredModel",
  ).mockImplementation(async () => {
    observedGenerations.push(getPreparedModelRuntimePluginGeneration());
    return null;
  });
  const engine = await verifiedEngine(config, {
    requesterAgentId: requester,
    runAgentTurn: runSystemAgentTurn,
  });
  await withPreparedModelRuntimePluginGenerationScope(inheritedGeneration, () =>
    engine.handle("continue setup"),
  );
  await withPreparedModelRuntimePluginGenerationScope(inheritedGeneration, () =>
    engine.planGreeting({ overview: {} as never, facts: {} as never, timeoutMs: 10 }),
  );
  const expectedGeneration = requester === "alternate" ? inheritedGeneration : undefined;
  expect(observedGenerations).toEqual([expectedGeneration, expectedGeneration]);
});

it("ends a partial timed-out agent turn without starting a second planner inference", async () => {
  const config: OpenClawConfig = { agents: { defaults: { model: "openai/gpt-5.6-luna" } } };
  const planner = vi
    .spyOn(await import("./assistant.js"), "planSystemAgentCommand")
    .mockResolvedValue({ reply: "A second inference ran." });
  const runEmbeddedAgent = vi
    .spyOn(embeddedAgent, "runEmbeddedAgent")
    .mockResolvedValueOnce({
      meta: {
        durationMs: 120_000,
        finalAssistantVisibleText: "I'll begin checking your setup.",
        aborted: true,
        timeoutPhase: "provider",
        error: { kind: "incomplete_turn", message: "The setup turn timed out." },
      },
    })
    .mockResolvedValue({ meta: { durationMs: 1, finalAssistantVisibleText: "Ready to retry." } });
  let failedSession: SystemAgentSession | undefined;
  const engine = await verifiedEngine(config, {
    runAgentTurn: (params) => {
      failedSession = params.session;
      params.session.proposalRef.current = "unfinished-proposal";
      params.session.proposalRef.operation = { kind: "setup" };
      params.session.cliSession = { routeKey: "old", binding: { sessionId: "old" } };
      return runSystemAgentTurn(params);
    },
  });
  await expect(engine.handle("What is the next setup step?")).rejects.toMatchObject({
    code: "SYSTEM_AGENT_INFERENCE_UNAVAILABLE",
    message: expect.stringContaining("The setup turn timed out."),
  });
  expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  expect(planner).not.toHaveBeenCalled();
  expect(engine.getPendingOperatorProposal()).toBeNull();
  expect(failedSession?.cliSession).toBeUndefined();
  expect(engine.historyLength()).toBe(0);
  await expect(engine.handle("Try the next step again.")).resolves.toMatchObject({
    text: "Ready to retry.",
  });
  expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
  expect(planner).not.toHaveBeenCalled();
});

it.each(["classification", "reply"] as const)("rejects owner drift during %s", async (phase) => {
  const { verifiedInference, drift } = await driftFixture();
  const runConfigSet = operationMocks.runConfigSet.mockResolvedValue(undefined);
  const classifyApproval = async () => {
    await drift();
    return "approve" as const;
  };
  const runAgentTurn = async () => {
    await drift();
    return { text: "stale reply" };
  };
  const engine =
    phase === "classification"
      ? new SystemAgentChatEngine({ verifiedInference, classifyApproval })
      : createChatEngine({ verifiedInference, runAgentTurn });
  if (phase === "classification") {
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });
  }
  await expect(
    engine.handle(phase === "classification" ? "yes" : "what should I do next?"),
  ).rejects.toMatchObject({
    message: expect.stringContaining("verified inference route changed"),
  });
  expect(runConfigSet).not.toHaveBeenCalled();
});

it("rejects a setup write without a verified inference binding", async () => {
  useTempStateDir();
  expect(() => new RuntimeSystemAgentChatEngine({} as SystemAgentChatEngineOptions)).toThrow(
    "openclaw onboard",
  );
  expect(operationMocks.applySetup).not.toHaveBeenCalled();
});

it("preserves the inference failure without a second model attempt", async () => {
  const failure = new Error("workspace owner openclaw is missing from the roster");
  const engine = createChatEngine({
    runAgentTurn: async () => {
      throw failure;
    },
  });
  await expect(engine.handle("please make everything nice")).rejects.toBe(failure);
});
