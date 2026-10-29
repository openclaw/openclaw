import path from "node:path";
import { isGatewayResponseFrame } from "@openclaw/gateway-protocol/frame-guards";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { expect, it, onTestFinished, vi } from "vitest";
import type { RawData } from "ws";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { readAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { getEmbeddedRunAttachment } from "../agents/embedded-agent-runner/run-state.js";
import { prepareCatalogExecutor } from "../agents/embedded-agent-runner/run/attempt-stream-prepare.test-support.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../agents/embedded-agent-runner/run/types.js";
import { detachActiveEmbeddedRun } from "../agents/embedded-agent-runner/runs.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  streamMocks,
} from "../agents/sessions/agent-session-loop-correctness.test-support.js";
import { runAnnounceAgentCall } from "../agents/subagents/announce/subagent-announce-completion-delivery.js";
import { makeEmbeddedRunnerAttempt } from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { rawDataToString } from "../infra/ws.js";
import { createDiagnosticEmbeddedRunOwner } from "../logging/diagnostic-run-activity.js";
import * as messageInjection from "../sessions/session-controller.message-injection.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
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

// The real harness selects the runtime and binds its authority to the controller
// operation before this model-execution boundary.
vi.mock("../agents/embedded-agent-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: runAttempt,
}));

const browserOrigin = "https://steering.example.test";
const gatewayToken = "synthetic-steering-gateway-token";
let harness: Awaited<ReturnType<typeof startServerWithClient>>;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;

installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    kernel = await captureGatewayKernel(async () => {
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
    });
  },
  cleanup: async () => {
    harness?.ws.close();
    await harness?.server.close();
    await closeSkillsWatchers(true);
    harness?.envSnapshot.restore();
  },
});

it.for([
  { source: "browser", disposition: "steered" },
  { source: "system", disposition: "followup" },
] as const)(
  "routes browser corrections to a $source direct command as $disposition",
  async ({ source, disposition: expectedDisposition }, { signal }) => {
    const sessionKey = `agent:main:direct-steering-${source}`;
    const sessionId = `direct-steering-session-${source}`;
    const runId = `announce:direct-steering-${source}`;
    const model = makeProviderModelFixture<"openai-responses">({
      id: "mock-1",
      name: "Steering fixture",
      provider: "steering-fixture",
      api: "openai-responses",
      baseUrl: "https://steering.example.test",
      maxTokens: 2_048,
    });
    const { provider, baseUrl, api, ...modelDefinition } = model;
    testState.sessionStorePath = path.join(
      process.env.OPENCLAW_STATE_DIR!,
      "agents/main/sessions/sessions.json",
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
          [provider]: {
            api,
            apiKey: "synthetic-steering-key",
            baseUrl,
            models: [modelDefinition],
          },
        },
      },
    });
    const discovery = await import("../agents/agent-model-discovery.js");
    const actualDiscovery = await vi.importActual<
      typeof import("../agents/agent-model-discovery.js")
    >("../agents/agent-model-discovery.js");
    const discoverySpy = vi
      .spyOn(discovery, "discoverModelsAsync")
      .mockImplementation(actualDiscovery.discoverModelsAsync);
    onTestFinished(() => discoverySpy.mockRestore());
    await prepareGatewayReplyRuntimeForTest({ force: true });
    await writeSessionStore({
      entries: {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
          agentHarnessId: "openclaw",
          permissionMode: "full",
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
    const sessionLifecycleState = await import("./session-lifecycle-state.js");
    const startCommitted = createDeferred();
    // Persistence and model readiness must both settle before inspecting sharing facts.
    void startCommitted.promise.catch(() => undefined);
    const prepareLifecycle = sessionLifecycleState.prepareGatewaySessionLifecycleEvent;
    const lifecycleSpy = vi
      .spyOn(sessionLifecycleState, "prepareGatewaySessionLifecycleEvent")
      .mockImplementation((params) => {
        const persist = prepareLifecycle(params);
        if (
          params.sessionKey !== sessionKey ||
          params.event.runId !== runId ||
          params.event.data?.phase !== "start"
        ) {
          return persist;
        }
        return () => {
          const committed = persist();
          void committed.then(startCommitted.resolve, startCommitted.reject);
          return committed;
        };
      });
    onTestFinished(() => lifecycleSpy.mockRestore());
    const ownerReady = createDeferred<{
      attempt: EmbeddedRunAttemptParams;
      handle: ReturnType<typeof prepareCatalogExecutor>["queueHandle"];
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
          createAssistantResultStream(createAssistant(attempt.model, "Correction applied.")),
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
      const prepared = prepareCatalogExecutor({
        attempt,
        activeSession: session,
        diagnosticOwner: createDiagnosticEmbeddedRunOwner({ sessionId, runId }),
        runAbortController: controller,
        abortRun: (_timeout, reason) => controller.abort(reason),
        getRunState: () => ({
          aborted: controller.signal.aborted,
          promptError: undefined,
          timedOut: false,
          yieldDetected: false,
        }),
        streamReplies: false,
      });
      embeddedRunMock.activeIds.add(sessionId);
      const prompt = session.prompt(attempt.prompt);
      try {
        await modelStarted.promise;
        ownerReady.resolve({ attempt, handle: prepared.queueHandle });
        await releaseModel.promise;
        const assistant = createAssistant(attempt.model, "Completed.");
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
        detachActiveEmbeddedRun(sessionId, prepared.queueHandle, sessionKey, attempt.sessionFile);
        embeddedRunMock.activeIds.delete(sessionId);
        session.dispose();
      }
    });
    const requestId = `original-${source}`;
    const browserTerminal = createDeferred<unknown>();
    let browserTerminalObserved = false;
    const isOriginalTerminal = (frame: unknown) =>
      isGatewayResponseFrame(frame) &&
      frame.id === requestId &&
      (!isRecord(frame.payload) || frame.payload.status !== "accepted");
    if (source === "browser") {
      const observeTerminal = (data: RawData) => {
        const frame: unknown = JSON.parse(rawDataToString(data));
        if (isOriginalTerminal(frame)) {
          browserTerminalObserved = true;
          browserTerminal.resolve(frame);
        }
      };
      const closed = () => {
        browserTerminalObserved = true;
        browserTerminal.reject(new Error("Original agent socket closed"));
      };
      harness.ws.on("message", observeTerminal);
      harness.ws.once("close", closed);
      onTestFinished(() => {
        harness.ws.off("message", observeTerminal);
        harness.ws.off("close", closed);
      });
    }
    const accepted =
      source === "browser"
        ? onceMessage(harness.ws, (frame) => frame.type === "res" && frame.id === requestId)
        : undefined;
    const original =
      source === "browser"
        ? browserTerminal.promise
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
    const capture = vi.spyOn(messageInjection, "captureCurrentReplyMessageInjectionTarget");
    onTestFinished(() => capture.mockRestore());
    try {
      if (accepted) {
        expect(await accepted).toMatchObject({ ok: true, payload: { status: "accepted" } });
      }
      const { attempt, handle } = await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([ownerReady.promise, startCommitted.promise]).then(([owner]) => owner),
          original,
          "Direct command finished before steering ownership and lifecycle start",
        ),
        signal,
      );
      const registration = getEmbeddedRunAttachment(handle);
      expect(registration?.toolAuthority?.source).toBe("reply");
      expect(readAdmittedRunOperatorAuthority(attempt.admittedRunContext) !== undefined).toBe(
        source === "browser",
      );
      expect(registration?.operationalRunInstance).toBe(
        attempt.admittedRunContext.operationalRunInstance,
      );
      expect(registration?.delegatedAuthority).toBeDefined();
      expect(getAgentRunContext(runId)?.isControlUiVisible).toBe(true);
      const response = await rpcReq(harness.ws, "chat.send", {
        sessionKey,
        sessionId,
        message: "Stop waiting and use the corrected approach.",
        idempotencyKey: `browser-direct-command-correction-${source}`,
        queueMode: "steer",
      });
      expect(response.ok).toBe(true);
      expect(
        capture.mock.results.find(
          (result) => result.type === "return" && result.value?.runId === runId,
        )?.value,
      ).toMatchObject({ runId, sourceTurnId: runId });
      expect(await withinTest(disposition.promise, signal)).toBe(expectedDisposition);
      if (expectedDisposition === "steered") {
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      }
    } finally {
      // The fixture prevents completion until release; only then does its response budget begin.
      const settled =
        source === "browser" && !browserTerminalObserved
          ? Promise.allSettled([onceMessage(harness.ws, isOriginalTerminal)])
          : originalSettled;
      releaseModel.resolve();
      const outcomes = await settled;
      expect.soft(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
    }
  },
);
