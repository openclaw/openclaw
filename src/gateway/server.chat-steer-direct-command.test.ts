import path from "node:path";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { ACTIVE_EMBEDDED_RUN_REGISTRATIONS } from "../agents/embedded-agent-runner/run-state.js";
import { prepareEmbeddedAttemptStream } from "../agents/embedded-agent-runner/run/attempt-stream-prepare.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../agents/embedded-agent-runner/run/types.js";
import { clearActiveEmbeddedRun } from "../agents/embedded-agent-runner/runs.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  streamMocks,
} from "../agents/sessions/agent-session-loop-correctness.test-support.js";
import { runAnnounceAgentCall } from "../agents/subagents/announce/subagent-announce-completion-delivery.js";
import { makeEmbeddedRunnerAttempt } from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { createDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { createDiagnosticEmbeddedRunOwner } from "../logging/diagnostic-run-activity.js";
import { diagnosticLogger } from "../logging/diagnostic-runtime.js";
import {
  agentCommandMock,
  connectOk,
  dispatchInboundMessageMock,
  embeddedRunMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

const runAttempt = vi.hoisted(() =>
  vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>(),
);

// The real harness selects the runtime and prepares its authority before this
// model-execution boundary. The test never creates a reply operation or hash.
vi.mock("../agents/embedded-agent-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: runAttempt,
}));

const browserOrigin = "https://steering.example.test";
const gatewayToken = "synthetic-steering-gateway-token";
let harness: Awaited<ReturnType<typeof startServerWithClient>>;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;

type AgentResponse = {
  type: string;
  id: string;
  ok: boolean;
  payload?: { runId?: string; status?: string };
  error?: { message?: string };
};

installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    const module = await import("./server-kernel.js");
    const create = module.createGatewayKernel;
    const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
      kernel = await create(...args);
      return kernel;
    });
    try {
      testState.gatewayControlUi = { allowedOrigins: [browserOrigin] };
      harness = await startServerWithClient(gatewayToken, {
        controlUiEnabled: true,
        wsHeaders: { origin: browserOrigin },
      });
      await connectOk(harness.ws, {
        token: gatewayToken,
        browserOrigin,
        prePairDevice: true,
        client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
        scopes: ["operator.read", "operator.write", "operator.admin"],
      });
    } finally {
      capture.mockRestore();
    }
  },
  cleanup: async () => {
    harness?.ws.close();
    await harness?.server.close();
    harness?.envSnapshot.restore();
  },
});

it.each([
  { source: "browser", disposition: "steered", expectation: "required" },
  { source: "system", disposition: "followup", expectation: "optional" },
] as const)(
  "routes browser corrections to a $source direct command as $disposition",
  async ({ source, disposition: expectedDisposition, expectation }) => {
    const sessionKey = `agent:main:direct-steering-${source}`;
    const sessionId = `direct-steering-session-${source}`;
    const runId = `announce:direct-steering-${source}`;
    const model: Model = {
      id: "mock-1",
      name: "Steering fixture",
      provider: "steering-fixture",
      api: "openai-responses",
      baseUrl: "https://steering.example.test",
      reasoning: false,
      input: ["text"],
      contextWindow: 16_000,
      maxTokens: 2_048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    testState.sessionStorePath = path.join(
      process.env.OPENCLAW_STATE_DIR!,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    testState.agentConfig = {
      model: { primary: `${model.provider}/${model.id}` },
      thinkingDefault: "off",
      compaction: { enabled: false },
    };
    testState.gatewayAuth = { mode: "token", token: gatewayToken };
    testState.gatewayControlUi = { allowedOrigins: [browserOrigin] };
    const config = getRuntimeConfig();
    await writeConfigFile({
      ...config,
      plugins: { ...config.plugins, enabled: false },
      models: {
        providers: {
          [model.provider]: {
            api: "openai-responses",
            apiKey: "synthetic-steering-key",
            baseUrl: model.baseUrl,
            models: [
              {
                id: model.id,
                name: model.name,
                reasoning: model.reasoning,
                input: model.input,
                cost: model.cost,
                contextWindow: model.contextWindow,
                maxTokens: model.maxTokens,
              },
            ],
          },
        },
      },
    });
    const discovery = await import("../agents/agent-model-discovery.js");
    const actualDiscovery = await vi.importActual<
      typeof import("../agents/agent-model-discovery.js")
    >("../agents/agent-model-discovery.js");
    const discoverySpy = vi
      .spyOn(discovery, "discoverModels")
      .mockImplementation(actualDiscovery.discoverModels);
    onTestFinished(() => discoverySpy.mockRestore());
    await prepareGatewayReplyRuntimeForTest({ force: true });
    await writeSessionStore({
      entries: {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
          agentHarnessId: "openclaw",
          permissionMode: "full",
          restartRecoveryTerminalRunIds: ["unrelated-completed-source"],
        },
      },
    });

    const command = await import("../agents/agent-command.js");
    agentCommandMock.mockImplementation((...args) =>
      command.agentCommandFromGatewayIngress(
        ...(args as Parameters<typeof command.agentCommandFromGatewayIngress>),
      ),
    );
    const releaseModel = createDeferred();
    const modelStarted = createDeferred();
    const ownerReady = createDeferred<{
      attempt: EmbeddedRunAttemptParams;
      handle: ReturnType<typeof prepareEmbeddedAttemptStream>["queueHandle"];
    }>();
    const disposition = createDeferred<"steered" | "followup">();
    dispatchInboundMessageMock.mockImplementation(async () => {
      disposition.resolve("followup");
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    runAttempt.mockImplementation(async (attempt) => {
      const modelStream = createAssistantMessageEventStream();
      streamMocks.streamSimple
        .mockImplementation(() =>
          createAssistantResultStream(
            createAssistant(attempt.model, [{ type: "text", text: "Correction applied." }]),
          ),
        )
        .mockImplementationOnce(() => {
          modelStarted.resolve();
          return modelStream;
        });
      const { session } = await createTestSession({ model: attempt.model });
      const steer = session.steer.bind(session);
      vi.spyOn(session, "steer").mockImplementation(async (...args) => {
        const result = await steer(...args);
        disposition.resolve("steered");
        return result;
      });
      const controller = new AbortController();
      const prepared = prepareEmbeddedAttemptStream({
        attempt,
        agentSession: {
          activeSession: session,
          hookRunner: null,
          clientToolCallSlots: [],
          hasDeliveredSourceReply: () => false,
          markSourceReplyDelivered: vi.fn(),
          builtinToolNames: new Set(),
          coreBuiltinToolNames: new Set(),
          replaySafeToolNames: new Set(),
          codeModeExecToolNames: new Set(),
          sideEffectToolOwners: new Map(),
          trustedLocalMediaToolNames: new Set(),
        },
        hookAgentId: attempt.agentId ?? "main",
        diagnosticTrace: createDiagnosticTraceContext(),
        diagnosticOwner: createDiagnosticEmbeddedRunOwner({ sessionId, runId }),
        nestedToolActivities: [],
        isReplaySafeTool: () => false,
        runAbortController: controller,
        abortRun: (_timeout, reason) => controller.abort(reason),
        markExternalAbort: vi.fn(),
        getRunState: () => ({
          aborted: controller.signal.aborted,
          promptError: undefined,
          timedOut: false,
          yieldDetected: false,
        }),
        onBlockReply: undefined,
        onBlockReplyFlush: undefined,
      });
      embeddedRunMock.activeIds.add(sessionId);
      const prompt = session.prompt(attempt.prompt);
      try {
        await modelStarted.promise;
        ownerReady.resolve({ attempt, handle: prepared.queueHandle });
        await releaseModel.promise;
        const assistant = createAssistant(attempt.model, [{ type: "text", text: "Completed." }]);
        modelStream.push({ type: "done", reason: "stop", message: assistant });
        modelStream.end();
        await prompt;
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: sessionId,
          lastAssistant: assistant,
          assistantTexts: ["Completed."],
          messagesSnapshot: session.messages,
        });
      } finally {
        prepared.subscription.unsubscribe();
        clearActiveEmbeddedRun(sessionId, prepared.queueHandle, sessionKey, attempt.sessionFile);
        embeddedRunMock.activeIds.delete(sessionId);
        session.dispose();
      }
    });
    const requestId = `original-${source}`;
    const accepted =
      source === "browser"
        ? onceMessage<AgentResponse>(
            harness.ws,
            (frame) => frame.type === "res" && frame.id === requestId,
          )
        : undefined;
    const original =
      source === "browser"
        ? onceMessage<AgentResponse>(
            harness.ws,
            (frame) =>
              frame.type === "res" &&
              frame.id === requestId &&
              frame.payload?.status !== "accepted",
          )
        : runAnnounceAgentCall({
            agentParams: {
              sessionKey,
              message: "Continue the requester task after its child completed.",
              deliver: false,
              idempotencyKey: runId,
              inputProvenance: {
                kind: "inter_session",
                sourceSessionKey: "agent:main:subagent:completed-child",
                sourceChannel: "internal",
                sourceTool: "subagent_settle",
              },
            },
            expectFinal: true,
            isExecutionAllowed: () => true,
            resolveGatewayContext: () => kernel.gatewayRequestContext,
          });
    const originalSettled = Promise.allSettled(accepted ? [accepted, original] : [original]);
    if (source === "browser") {
      harness.ws.send(
        JSON.stringify({
          type: "req",
          id: requestId,
          method: "agent",
          params: {
            sessionKey,
            message: "Keep working until I send a correction.",
            deliver: false,
            idempotencyKey: runId,
          },
        }),
      );
    }
    const capture = vi.spyOn(replyRunRegistry, "resolveCurrentMessageInjectionTarget");
    const diagnostics = vi.spyOn(diagnosticLogger, "info");
    onTestFinished(() => diagnostics.mockRestore());
    try {
      if (accepted) {
        expect(await accepted).toMatchObject({ ok: true, payload: { status: "accepted" } });
      }
      const { attempt, handle } = await Promise.race([
        ownerReady.promise,
        original.then((response) => {
          throw new Error(
            `Direct command finished before publishing its steering owner: ${JSON.stringify(response)}`,
          );
        }),
      ]);
      const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
      const facts = {
        hasReplyOperation: replyRunRegistry.get(sessionKey) !== undefined,
        authoritySource: registration?.toolAuthority?.source,
        hasOperatorAuthority:
          readAdmittedRunOperatorAuthority(attempt.admittedRunContext) !== undefined,
        ownsAdmittedInstance:
          registration?.operationalRunInstance ===
          attempt.admittedRunContext.operationalRunInstance,
        hasDelegatedAuthority: registration?.delegatedAuthority !== undefined,
        isControlUiVisible: getAgentRunContext(runId)?.isControlUiVisible,
        terminalReplyExpectation: handle.terminalReplyExpectation,
        injectionVersion: handle.messageInjectionV2?.version,
        supportsTranscriptCommitWait: handle.supportsTranscriptCommitWait,
      };
      expect(facts).toEqual({
        hasReplyOperation: false,
        authoritySource: "attempt",
        hasOperatorAuthority: source === "browser",
        ownsAdmittedInstance: true,
        hasDelegatedAuthority: true,
        isControlUiVisible: true,
        terminalReplyExpectation: expectation,
        injectionVersion: 2,
        supportsTranscriptCommitWait: true,
      });
      const response = await rpcReq(harness.ws, "chat.send", {
        sessionKey,
        sessionId,
        message: "Stop waiting and use the corrected approach.",
        idempotencyKey: `browser-direct-command-correction-${source}`,
        queueMode: "steer",
      });
      expect(response.ok).toBe(true);
      const captured = capture.mock.results.find(
        (result) => result.type === "return" && result.value?.runId === runId,
      );
      expect(captured?.value).toMatchObject({
        runId,
        sourceTurnId: runId,
      });
      expect(
        await disposition.promise,
        JSON.stringify(
          diagnostics.mock.calls.filter(([message]) => message.startsWith("direct steering")),
        ),
      ).toBe(expectedDisposition);
      if (expectedDisposition === "steered") {
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      }
    } finally {
      releaseModel.resolve();
      const outcomes = await originalSettled;
      expect
        .soft(
          outcomes.flatMap((outcome) =>
            outcome.status === "rejected" ? [String(outcome.reason)] : [],
          ),
        )
        .toEqual([]);
      capture.mockRestore();
    }
  },
);
