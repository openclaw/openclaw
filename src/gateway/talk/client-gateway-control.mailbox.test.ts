import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerInternalHook, unregisterInternalHook } from "../../hooks/internal-hooks.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { getExistingSessionControllerMailbox } from "../../sessions/session-controller.mailbox.js";
import { resetSessionControllerStateForTest } from "../../sessions/session-lifecycle-admission.test-support.js";
import type { AgentInputRecoveryAdmission } from "../../state/agent-input-recovery.types.js";
import { createChatRunState } from "../server-chat-state.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
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

function recoveryGate() {
  const target = captureSessionTarget({ ...channelTurn, storeScope: sessionTarget.storePath });
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
  return {
    ...fixture,
    waiting,
    mailbox: () => getExistingSessionControllerMailbox(sessionTarget.canonicalKey, target),
    recover: () => {
      pending = false;
      recovery.resolve();
    },
  };
}

function createOwner(
  flushTranscript: () => Promise<void> = async () => undefined,
  inputRecovery?: AgentInputRecoveryAdmission,
  boundGateway = false,
) {
  const context: GatewayRequestContext = Object.assign(controlContext(), { inputRecovery });
  if (boundGateway) {
    context.resolveGatewayContext = () => context;
  }
  const runner = createConsultRunner({
    context,
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
    context,
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
    expectResults: (...ids: string[]) =>
      vi.waitFor(() =>
        expect(bridge.submitToolResult.mock.calls).toEqual(
          ids.map((id) => [id, { result: `answer: ${id}` }]),
        ),
      ),
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

it("runs a Gateway-bound voice consult outside the request scope", async () => {
  const { enqueue, owner, expectResults } = createOwner(undefined, undefined, true);
  const task = enqueue("consult", "configure the Dial");
  try {
    await vi.waitFor(() => expect(order).toEqual(["configure the Dial"]));
    task.release();
    await expectResults("configure the Dial");
  } finally {
    task.release();
    await owner.close();
  }
});

it.each([
  ["consult", "consult", ["first", "second"]],
  ["channel", "consult", ["second"]],
  ["consult", "channel", ["first"]],
] as const)(
  "runs %s then %s FIFO across transcript flush",
  async (firstKind, secondKind, callIds) => {
    const flush = createDeferred();
    const { enqueue, owner, expectResults } = createOwner(() => flush.promise);
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
    await expectResults(...callIds);
    expect(order).toEqual(["first", "second"]);
    await owner.close();
  },
);

it.each(["recovered", "closed"] as const)(
  "reserves Talk consults after saved input recovery, preserving arrival order: %s",
  async (outcome) => {
    const fixture = recoveryGate();
    const first = gate();
    const second = gate();
    fixture.consult("first", "first");
    fixture.consult("second", "second");
    await fixture.waiting.promise;
    expect(fixture.mailbox()).toBeUndefined();
    let savedRun: Promise<unknown> | undefined;
    const saved = gate(false);
    try {
      if (outcome === "closed") {
        await fixture.owner.close();
        expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
        expect(fixture.mailbox()).toBeUndefined();
        return;
      }
      savedRun = withSessionTurn(channelTurn, () => saved.run({ prompt: "saved" }));
      await saved.started.promise;
      fixture.recover();
      await vi.waitFor(() => expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledTimes(2));
      expect(order).toEqual(["saved"]);
      saved.release();
      await first.started.promise;
      expect(order).toEqual(["saved", "first"]);
      first.release();
      await second.started.promise;
      expect(order).toEqual(["saved", "first", "second"]);
      second.release();
      await fixture.expectResults("first", "second");
    } finally {
      fixture.recover();
      saved.release();
      first.release();
      second.release();
      await Promise.allSettled([savedRun, fixture.owner.close()]);
    }
  },
);

it("closes a native Talk consultation waiting for saved-input recovery before admission", async () => {
  const fixture = recoveryGate();
  const consultation = fixture.owner.runAgentConsult({ prompt: "native consult" });
  void consultation.catch(() => {});
  try {
    await fixture.waiting.promise;
    expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
    await fixture.owner.close();
    await expect(consultation).rejects.toMatchObject({
      name: "AbortError",
      cause: fixture.owner.signal.reason,
    });
    expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
  } finally {
    fixture.recover();
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
  await vi.waitFor(() =>
    expect(replacement.bridge.submitToolResult.mock.calls).toEqual([
      ["call-2", { result: "answer: next" }],
    ]),
  );
  await replacement.owner.close();
});
