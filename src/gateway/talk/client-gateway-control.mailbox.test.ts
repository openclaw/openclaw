// Browser Talk consult tool calls are session mailbox inputs reserved on arrival.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { registerInternalHook, unregisterInternalHook } from "../../hooks/internal-hooks.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { resetSessionControllerStateForTest } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createChatRunState } from "../server-chat-state.js";

const { config, coreParams, mocks } = await vi.hoisted(
  () => import("./client-gateway-control.agent-consult.test-support.js"),
);

// mock-isolation: Mailbox ordering uses fixture-owned run admission instead of the process-wide model and tool authority context.
vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
// mock-isolation: The gated backend controls mailbox execution order without starting a real model run.
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../talk/agent-consult-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-consult-runtime.js")>()),
  consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
}));

import { parseRealtimeVoiceAgentConsultArgs } from "../../talk/agent-consult-tool.js";
import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";
import type { ConsultParams } from "./client-gateway-control.agent-consult.test-support.js";
import { createTalkClientGatewayControlOwner } from "./client-gateway-control.js";
import { controlBridge, controlContext } from "./client-gateway-control.test-support.js";
import { createTalkRunCancel } from "./realtime-run-control.js";

const sessionTarget = {
  agentId: "researcher",
  sessionKey: "agent:researcher:talk",
  canonicalKey: "agent:researcher:talk",
  storePath: "/tmp/sessions",
  assertCurrent: () => {},
};
const channelTurn = {
  sessionKey: sessionTarget.canonicalKey,
  sessionId: "session-talk",
  agentId: sessionTarget.agentId,
  storePath: sessionTarget.storePath,
};

/** Backend prompts in the order their turns started. */
const order: string[] = [];

/** Parks the next backend run until the returned gate is released. */
function gate() {
  const started = createDeferred();
  const released = createDeferred();
  mocks.runEmbeddedAgentCore.mockImplementationOnce(
    async (params: { prompt: string; abortSignal?: AbortSignal }) => {
      order.push(params.prompt);
      started.resolve();
      await new Promise<void>((resolve, reject) => {
        void released.promise.then(() => resolve());
        params.abortSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      return { payloads: [] };
    },
  );
  return { started, release: () => released.resolve() };
}

function createOwner(flushTranscript: () => Promise<void> = async () => undefined) {
  const runner = createTalkClientAgentConsultRunner({
    config,
    context: { logGateway: { warn: vi.fn() } } as never,
    sessionTarget,
    ownerConnId: "conn-talk",
    getVoiceSessionId: () => "voice-talk",
    initialItems: [],
    registerRun: vi.fn(async () => ({ release: vi.fn(), isCurrent: () => true })),
  });
  const owner = createTalkClientGatewayControlOwner({
    voiceSessionId: "voice-talk",
    sessionTarget,
    connId: "conn-talk",
    context: controlContext(),
    runToolAgentConsult: runner.runArgs,
    runAgentConsult: runner.runOwnedArgs,
    appendTranscript: vi.fn(async () => undefined),
    flushTranscript,
    closeLogicalSession: vi.fn(async () => undefined),
  });
  const bridge = controlBridge();
  owner.control.bindBridge(bridge);
  owner.activate();
  const consult = (callId: string, question: string) =>
    owner.control.onToolCall?.({
      itemId: `item-${callId}`,
      callId,
      name: "openclaw_agent_consult",
      args: { question },
    });
  return { owner, bridge, consult };
}

let runSequence = 0;
const startedRunIds: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  startedRunIds.length = 0;
  mocks.prepareAgentRunAdmission.mockImplementation(
    (params: { operationalRunInstance: OperationalRunInstanceRef }) => ({
      operationalRunInstance: params.operationalRunInstance,
      admit: vi.fn(),
      close: vi.fn(),
    }),
  );
  mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
    const { question } = parseRealtimeVoiceAgentConsultArgs(params.args);
    const runId = `talk-run-${++runSequence}`;
    startedRunIds.push(runId);
    const registration = await params.onRunStarted?.({
      runId,
      sessionId: "session-talk",
      timeoutMs: 60_000,
    });
    try {
      await params.agentRuntime.runEmbeddedAgent({
        ...coreParams,
        runId,
        prompt: question,
        abortSignal: registration?.abortSignal ?? params.abortSignal,
      });
      return { text: `answer: ${question}` };
    } finally {
      registration?.cleanup?.();
    }
  });
});

afterEach(() => {
  resetSessionControllerStateForTest();
});

describe("browser Talk consults through the session mailbox", () => {
  it("runs two quick consults FIFO and answers them in order", async () => {
    const first = gate();
    const second = gate();
    const { bridge, consult, owner } = createOwner();

    consult("call-1", "first");
    consult("call-2", "second");
    await first.started.promise;
    expect(order).toEqual(["first"]);

    first.release();
    await second.started.promise;
    second.release();
    await vi.waitFor(() => expect(bridge.submitToolResult).toHaveBeenCalledTimes(2));
    expect(order).toEqual(["first", "second"]);
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(1, "call-1", expect.anything());
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(2, "call-2", expect.anything());
    await owner.close();
  });

  it("waits behind a running channel turn", async () => {
    const consultGate = gate();
    const channelRelease = createDeferred();
    const channelStarted = createDeferred();
    const channel = withSessionTurn(channelTurn, async () => {
      channelStarted.resolve();
      await channelRelease.promise;
    });
    await channelStarted.promise;
    const { bridge, consult, owner } = createOwner();

    consult("call-1", "after channel");
    await vi.waitFor(() => expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledOnce());
    expect(order).toEqual([]);

    channelRelease.resolve();
    await channel;
    await consultGate.started.promise;
    consultGate.release();
    await vi.waitFor(() => expect(bridge.submitToolResult).toHaveBeenCalledOnce());
    await owner.close();
  });

  it("reserves its mailbox position when the tool call arrives", async () => {
    const consultGate = gate();
    const flush = createDeferred();
    const { bridge, consult, owner } = createOwner(async () => await flush.promise);
    const channelRan = vi.fn(() => order.push("channel"));

    consult("call-1", "reserved first");
    const channel = withSessionTurn(channelTurn, async () => channelRan());
    flush.resolve();
    await consultGate.started.promise;
    expect(channelRan).not.toHaveBeenCalled();

    consultGate.release();
    await channel;
    expect(order).toEqual(["reserved first", "channel"]);
    await vi.waitFor(() => expect(bridge.submitToolResult).toHaveBeenCalledOnce());
    await owner.close();
  });

  it("cancels a running consult through Stop and keeps the session's waiting turn", async () => {
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);
    const consultGate = gate();
    const { bridge, consult, owner } = createOwner();
    try {
      consult("call-1", "cancel me");
      await consultGate.started.promise;
      const waitingRan = vi.fn();
      const waiting = withSessionTurn(channelTurn, async () => waitingRan());
      const cancelRun = createTalkRunCancel({
        sessionTarget,
        context: {
          getRuntimeConfig: () => config,
          chatRunState: createChatRunState(),
          removeChatRun: vi.fn(),
          agentRunSeq: new Map(),
          broadcast: vi.fn(),
          nodeSendToSession: vi.fn(),
        },
        connId: "conn-talk",
      });

      await expect(cancelRun(startedRunIds[0]!)).resolves.toBe(true);
      await waiting;
      expect(waitingRan).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(bridge.submitToolResult).toHaveBeenCalledWith(
          "call-1",
          expect.objectContaining({ status: "cancelled" }),
        ),
      );
      expect(hook).toHaveBeenCalledOnce();
      expect(hook.mock.calls[0]?.[0]).toMatchObject({
        action: "stop",
        context: { commandSource: "talk", senderId: "conn-talk" },
      });
    } finally {
      unregisterInternalHook("command:stop", hook);
      await owner.close();
    }
  });

  it("keeps an in-flight consult running across a preserveRuns transport replacement", async () => {
    const consultGate = gate();
    const { bridge, consult, owner } = createOwner();
    consult("call-1", "survives");
    await consultGate.started.promise;

    await owner.close({ preserveLogicalSession: true, preserveRuns: true });
    consultGate.release();

    await expect(mocks.consultRealtimeVoiceAgent.mock.results[0]?.value).resolves.toEqual({
      text: "answer: survives",
    });
    // The retired transport owns no presentation; the run itself still completed.
    expect(bridge.submitToolResult).not.toHaveBeenCalled();
    const next = gate();
    const replacement = createOwner();
    replacement.consult("call-2", "next");
    await next.started.promise;
    next.release();
    await vi.waitFor(() => expect(replacement.bridge.submitToolResult).toHaveBeenCalledOnce());
    await replacement.owner.close();
  });
});
