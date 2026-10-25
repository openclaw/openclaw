import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerInternalHook, unregisterInternalHook } from "../../hooks/internal-hooks.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { getExistingSessionControllerMailbox } from "../../sessions/session-controller.mailbox.js";
import { resetSessionControllerStateForTest } from "../../sessions/session-lifecycle-admission.test-support.js";
import type { AgentInputRecoveryAdmission } from "../../state/agent-input-recovery-context.js";
import { createChatRunState } from "../server-chat-state.js";
import { createControlFixture } from "./client-control-fixture.test-support.js";

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
import {
  createConsultRunner,
  resetConsultFixture,
} from "./client-gateway-control.agent-consult-fixture.test-support.js";
import type { ConsultParams } from "./client-gateway-control.agent-consult.test-support.js";
import { controlContext } from "./client-gateway-control.test-support.js";
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

const order: string[] = [];

/** Parks the next backend run until the returned gate is released. */
function gate(backend = true) {
  const started = createDeferred();
  const released = createDeferred();
  const run = async (params: { prompt: string; abortSignal?: AbortSignal }) => {
    order.push(params.prompt);
    started.resolve();
    params.abortSignal?.addEventListener(
      "abort",
      () => released.reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
    await released.promise;
    return { payloads: [] };
  };
  if (backend) {
    mocks.runEmbeddedAgentCore.mockImplementationOnce(run);
  }
  return { started, release: () => released.resolve(), run };
}

function createOwner(
  flushTranscript: () => Promise<void> = async () => undefined,
  inputRecovery?: AgentInputRecoveryAdmission,
) {
  const runner = createConsultRunner({
    context: { logGateway: { warn: vi.fn() } } as never,
    sessionTarget,
    ownerConnId: "conn-talk",
    getVoiceSessionId: () => "voice-talk",
  });
  const { owner, bridge } = createControlFixture({
    voiceSessionId: "voice-talk",
    sessionTarget,
    connId: "conn-talk",
    runToolAgentConsult: runner.runArgs,
    runAgentConsult: runner.runOwnedArgs,
    flushTranscript,
    context: Object.assign(controlContext(), { inputRecovery }),
  });
  owner.control.bindBridge(bridge);
  owner.activate();
  const consult = (callId: string, question: string) =>
    owner.control.onToolCall?.({
      itemId: `item-${callId}`,
      callId,
      name: "openclaw_agent_consult",
      args: { question },
    });
  return {
    owner,
    bridge,
    consult,
    enqueue: (kind: "channel" | "consult", prompt: string) => {
      const task = gate(kind === "consult");
      const done =
        kind === "channel" ? withSessionTurn(channelTurn, () => task.run({ prompt })) : undefined;
      if (kind === "consult") {
        consult(prompt, prompt);
      }
      return { ...task, done };
    },
    waitForResults: (count = 1) =>
      vi.waitFor(() => expect(bridge.submitToolResult).toHaveBeenCalledTimes(count)),
  };
}

let runSequence = 0;
const startedRunIds: string[] = [];

beforeEach(() => {
  resetConsultFixture();
  mocks.runEmbeddedAgentCore.mockReset();
  order.length = 0;
  startedRunIds.length = 0;
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

afterEach(resetSessionControllerStateForTest);

it.each([
  ["consult", "consult", ["first", "second"]],
  ["channel", "consult", ["second"]],
  ["consult", "channel", ["first"]],
] as const)(
  "runs %s then %s FIFO across transcript flush",
  async (firstKind, secondKind, callIds) => {
    const flush = createDeferred();
    const { bridge, enqueue, owner, waitForResults } = createOwner(() => flush.promise);
    const first = enqueue(firstKind, "first");
    const second = enqueue(secondKind, "second");
    flush.resolve();
    await first.started.promise;
    if (firstKind === "channel") {
      await vi.waitFor(() => expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledOnce());
    }
    expect(order).toEqual(["first"]);
    first.release();
    await second.started.promise;
    expect(order).toEqual(["first", "second"]);
    second.release();
    await Promise.all([first.done, second.done]);
    await waitForResults(callIds.length);
    expect(order).toEqual(["first", "second"]);
    expect(bridge.submitToolResult.mock.calls).toEqual(
      callIds.map((id) => [id, { result: `answer: ${id}` }]),
    );
    await owner.close();
  },
);

it.each(["recovered", "closed"] as const)(
  "reserves Talk consults after saved input recovery, preserving arrival order: %s",
  async (outcome) => {
    const recovery = createDeferred();
    const waiting = createDeferred();
    let pending = true;
    const fixture = createOwner(undefined, {
      isPending: () => pending,
      waitForAgentInputRecovery: (_agentId, options) => {
        if (!pending) {
          return undefined;
        }
        waiting.resolve();
        return racePromiseWithAbortSignal(recovery.promise, options?.signal);
      },
    });
    const first = gate();
    const second = gate();
    const target = captureSessionTarget({
      storeScope: sessionTarget.storePath,
      sessionKey: sessionTarget.canonicalKey,
      agentId: sessionTarget.agentId,
    });
    fixture.consult("first", "first");
    fixture.consult("second", "second");
    await waiting.promise;
    expect(getExistingSessionControllerMailbox(sessionTarget.canonicalKey, target)).toBeUndefined();
    let savedRun: Promise<unknown> | undefined;
    const saved = gate(false);
    try {
      if (outcome === "closed") {
        await fixture.owner.close();
        expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
        expect(
          getExistingSessionControllerMailbox(sessionTarget.canonicalKey, target),
        ).toBeUndefined();
        return;
      }
      savedRun = withSessionTurn(channelTurn, () => saved.run({ prompt: "saved" }));
      await saved.started.promise;
      pending = false;
      recovery.resolve();
      await vi.waitFor(() => expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledTimes(2));
      expect(order).toEqual(["saved"]);
      saved.release();
      await first.started.promise;
      expect(order).toEqual(["saved", "first"]);
      first.release();
      await second.started.promise;
      expect(order).toEqual(["saved", "first", "second"]);
      second.release();
      await fixture.waitForResults(2);
      expect(fixture.bridge.submitToolResult.mock.calls).toEqual([
        ["first", { result: "answer: first" }],
        ["second", { result: "answer: second" }],
      ]);
    } finally {
      pending = false;
      recovery.resolve();
      saved.release();
      first.release();
      second.release();
      await Promise.allSettled([savedRun, fixture.owner.close()]);
    }
  },
);

it("closes a native Talk consultation waiting for saved-input recovery before admission", async () => {
  const recovery = createDeferred();
  const waiting = createDeferred();
  const fixture = createOwner(undefined, {
    isPending: () => true,
    waitForAgentInputRecovery: (_agentId, options) => {
      waiting.resolve();
      return racePromiseWithAbortSignal(recovery.promise, options?.signal);
    },
  });
  const consultation = fixture.owner.runAgentConsult({ prompt: "native consult" });
  void consultation.catch(() => {});
  try {
    await waiting.promise;
    expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
    await fixture.owner.close();
    await expect(consultation).rejects.toMatchObject({
      name: "AbortError",
      cause: fixture.owner.signal.reason,
    });
    expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
  } finally {
    recovery.resolve();
    await Promise.allSettled([consultation, fixture.owner.close()]);
  }
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
  await replacement.waitForResults();
  await replacement.owner.close();
});
