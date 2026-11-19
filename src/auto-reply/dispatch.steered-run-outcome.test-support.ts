// Shared harness for the steered-run-outcome regression. Each scenario runs in
// its own test file so the forks-pool worker state (session controller, sqlite
// broker, plugin registry) is fresh per scenario; reusing one process for two
// scenarios synchronously stalls the second admission.
import { createServer } from "node:http";
import { expect, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred, type Deferred } from "../../test/helpers/promise.js";
import { setSessionMcpRuntimeScheduler } from "../agents/agent-bundle-mcp-manager-api.js";
import { getSessionMcpRuntimeTestManager } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { model as createModelFixture } from "../agents/model-catalog-fixtures.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyGatewayLaneConcurrency,
  resolveGatewayLaneConcurrency,
} from "../gateway/server-lanes.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "./dispatch.js";
import { getFollowupQueueDepth } from "./reply/queue.js";

const parkToolPlugin = `module.exports = {
  id: "fixture-steer-park",
  register(api) {
    api.registerTool({
      name: "fixture_park", label: "Fixture park", description: "Park the active run",
      parameters: { type: "object", properties: {} },
      async execute() {
        const gate = globalThis.steerParkGateFixture;
        globalThis.steerParkEnteredFixture?.();
        if (gate) { await gate; }
        return { content: [{ type: "text", text: "park released" }] };
      },
    });
    api.registerTool({
      name: "fixture_pass", label: "Fixture pass", description: "Immediate no-op",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "passed" }] };
      },
    });
  },
};`;

function completion(delta: Record<string, unknown>, finish_reason?: string) {
  return `data: ${JSON.stringify({ id: "completion-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
}

function toolCallChunks(id: string, name: string) {
  return (
    completion({
      role: "assistant",
      content: null,
      tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "{}" } }],
    }) +
    completion({}, "tool_calls") +
    "data: [DONE]\n\n"
  );
}

const finalChunks =
  completion({ role: "assistant", content: "steered run finished" }) +
  completion({}, "stop") +
  "data: [DONE]\n\n";

/** Gates the continuation response so the test controls when the run advances. */
async function createScriptedProvider(gate: Deferred<void>, failContinuation: boolean) {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount++;
    if (requestCount === 1) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(toolCallChunks("park-call", "fixture_park"));
      return;
    }
    if (requestCount === 2) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(toolCallChunks("pass-call", "fixture_pass"));
      return;
    }
    void gate.promise.then(
      () => {
        if (failContinuation) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { code: "provider_failed", message: "continuation failed" } }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(finalChunks);
      },
      () => {},
    );
  });
  const baseUrl = `${await listenLoopback(server)}/v1`;
  return {
    server,
    provider: {
      baseUrl,
      apiKey: "synthetic-test-key",
      api: "openai-completions" as const,
      request: { allowPrivateNetwork: true },
      models: [createModelFixture("fixture", "Answer", { contextWindow: 128000, maxTokens: 4096 })],
    },
  };
}

/**
 * Runs one steered settlement scenario: m1 parks inside a tool, m2 arrives and
 * is accepted into m1's active run through production steering, then the
 * released run's terminal classification must reach m2's observer.
 */
export async function runSteeredOutcomeScenario(
  expectedOutcome: "completed" | "failed",
): Promise<void> {
  const failContinuation = expectedOutcome === "failed";
  const sessionKey = `agent:main:discord:direct:steer-${expectedOutcome}`;
  const parkGate = createDeferred<void>();
  const { server, provider } = await createScriptedProvider(parkGate, failContinuation);
  const state = await createOpenClawTestState({
    label: "steered-run-outcome",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  const scheduler = createTestGatewayScheduler();
  const parkedEntered = createDeferred<void>();
  const steerReserved = createDeferred<void>();
  const consumingRunOutcome = createDeferred<"completed" | "failed">();
  const steeredRunOutcome = createDeferred<"completed" | "failed">();
  const toolPluginPath = state.statePath("steer-park-plugin", "index.cjs");
  try {
    await setSessionMcpRuntimeScheduler(scheduler);
    await state.writeJson("steer-park-plugin/openclaw.plugin.json", {
      id: "fixture-steer-park",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { tools: ["fixture_park", "fixture_pass"] },
    });
    await state.writeText("steer-park-plugin/index.cjs", parkToolPlugin);
    // The plugin runs in-process; the park tool awaits this shared promise and
    // reports its entry so the test can admit the steer mid-run.
    (globalThis as Record<string, unknown>).steerParkEnteredFixture = () => parkedEntered.resolve();
    (globalThis as Record<string, unknown>).steerParkGateFixture = (async () => {
      await parkedEntered.promise;
      return steerReserved.promise;
    })();
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {} },
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: "fixture/answer" },
          models: {
            "fixture/answer": { agentRuntime: { id: "openclaw" as const } },
          },
        },
      },
      models: { mode: "replace", providers: { fixture: provider } },
      channels: { discord: { streaming: { mode: "off", block: { enabled: false } } } },
      messages: {
        visibleReplies: "automatic",
        queue: { debounceMsByChannel: { discord: 0 } },
      },
      plugins: {
        slots: { memory: "none" },
        allow: ["fixture-steer-park"],
        load: { paths: [toolPluginPath] },
      },
      tools: {
        profile: "minimal",
        toolSearch: false,
        alsoAllow: ["fixture_park", "fixture_pass"],
      },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(cfg));

    const baseCtx = {
      From: "discord:user:1001",
      To: "discord:channel:2001",
      SessionKey: sessionKey,
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      CommandAuthorized: true,
    };
    const dispatcherOptions = { deliver: async () => ({ visibleReplySent: true }) };

    // m1 parks inside fixture_park while the steered source is admitted.
    const consumingDispatch = dispatchInboundMessageWithBufferedDispatcher({
      ctx: { ...baseCtx, Body: "Start the parked run.", MessageSid: "request-consume" },
      cfg,
      replyOptions: {
        onAgentRunTerminalOutcome: (outcome) => consumingRunOutcome.resolve(outcome),
      },
      dispatcherOptions,
    });
    await parkedEntered.promise;

    // m2 arrives mid-run; queue mode steer injects it into m1's active run.
    // Durable ingress carries a turn adoption lifecycle so queue policy can
    // resolve while the owner run is active instead of waiting behind it.
    const steeredDispatch = dispatchInboundMessageWithBufferedDispatcher({
      ctx: { ...baseCtx, Body: "Steered follow-up.", MessageSid: "request-steered" },
      cfg,
      replyOptions: {
        onAgentRunTerminalOutcome: (outcome) => steeredRunOutcome.resolve(outcome),
        turnAdoptionLifecycle: {
          onAdopted: () => {},
          onAbandoned: () => {},
          onSettled: () => {},
        },
      },
      dispatcherOptions,
    });
    // The steer candidate is reserved before injection; admission may land in
    // either tool batch, so the continuation keeps one batch before the final.
    await vi.waitFor(
      () => {
        expect(getFollowupQueueDepth(sessionKey)).toBe(1);
      },
      { timeout: 30000, interval: 200 },
    );
    steerReserved.resolve();
    parkGate.resolve();

    const steeredResult = await steeredDispatch;
    expect(steeredResult.deferredToActiveRun).toBe("steer");

    const consumingResult = await consumingDispatch.catch((error: unknown) => {
      if (!failContinuation) {
        throw error;
      }
      return undefined;
    });
    expect(await consumingRunOutcome.promise).toBe(expectedOutcome);
    // The steered source settles from the consuming run's settlement, not its
    // own abandoned execution custody; on the base revision this stays pending.
    expect(await steeredRunOutcome.promise).toBe(expectedOutcome);
    expect(consumingResult).toBeDefined();
  } finally {
    parkGate.resolve();
    delete (globalThis as Record<string, unknown>).steerParkGateFixture;
    delete (globalThis as Record<string, unknown>).steerParkEnteredFixture;
    const mcpManager = getSessionMcpRuntimeTestManager();
    for (const sessionId of mcpManager.listSessionIds()) {
      if (mcpManager.peekSession({ sessionId })?.workspaceDir === state.workspaceDir) {
        await mcpManager.disposeSession(sessionId);
      }
    }
    await scheduler.stop();
    await closeHttpServer(server);
    await state.cleanup();
    resetCommandQueueStateForTest();
  }
}
