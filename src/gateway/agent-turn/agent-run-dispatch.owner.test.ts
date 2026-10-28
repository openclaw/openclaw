import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { sanitizeAgentRunTerminalReply } from "../../agents/agent-run-terminal-reply.js";
import type { AgentCommandDeliveryResult } from "../../agents/command/delivery-result.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import * as transcript from "../../sessions/user-turn-transcript-admission.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById } from "../chat-abort.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { createGate, expectCalls } from "./agent-owner.test-support.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import {
  createTestRpcSource,
  setTestRpcSourceIdentity,
  testRpcSourceController,
} from "./rpc-source.test-support.js";

type CommandResult = Pick<AgentCommandDeliveryResult, "payloads"> & {
  meta: Partial<AgentCommandDeliveryResult["meta"]>;
};
type Entry = ReturnType<typeof createTrackedDispatch>["entry"];
const commandResult = (
  meta: CommandResult["meta"] = {},
  payloads: CommandResult["payloads"] = [],
) => ({ payloads, meta });

const mocks = vi.hoisted(() => ({
  agentCommand: vi.fn<(options: AgentCommandOpts) => Promise<CommandResult>>(),
  clearAgentRunContext: vi.fn(),
}));
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: mocks.agentCommand }));
vi.mock("../../runtime.js", () => ({ defaultRuntime: {} }));
vi.mock(import("../../infra/agent-run-registry.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  clearAgentRunContext: mocks.clearAgentRunContext,
  validateAgentRunDelegatedAuthority: () => true,
}));
vi.mock("./agent-dedupe.js", () => ({ setGatewayDedupeEntries: vi.fn() }));

describe("Gateway dispatch run ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentCommand.mockImplementation(async () => commandResult());
  });

  function createDispatch(terminalProducer = false) {
    const f = createTrackedDispatch();
    const params = {
      admittedRunEntry: f.entry,
      ingressOpts: {
        message: "continue",
        sessionKey: f.sessionKey,
        allowModelOverride: false,
        ...(terminalProducer ? { abortSignal: f.entry.input.abortSignal } : {}),
      },
      runId: f.runId,
      dedupeKeys: [],
      abortController: testRpcSourceController(f.entry),
      cleanupAbortController: vi.fn(),
      io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
      context: f.context,
    };
    return { ...f, params };
  }

  function createFollowupDispatch() {
    const f = createDispatch(true);
    const owner = SessionFollowupCompletion.bind({
      runId: f.runId,
      requesterSessionKey: "agent:main:parent",
      requesterSessionId: "requester-session",
      requesterAgentId: "main",
      targetAgentId: "main",
      targetSessionKey: f.sessionKey,
      custody: {
        run: (work) => work(),
        assertCurrent: vi.fn(),
        signal: new AbortController().signal,
        release: vi.fn(),
      },
    });
    onTestFinished(() => owner.close());
    const dispatch = (
      runId = f.runId,
      entry = f.entry,
      assertCurrent?: () => void,
      onSettled?: Parameters<typeof dispatchAgentRunFromGateway>[0]["onSettled"],
    ) => {
      owner.markAccepted(runId);
      return dispatchAgentRunFromGateway({
        ...f.params,
        assertCurrent,
        admittedRunEntry: entry,
        ingressOpts: {
          ...f.params.ingressOpts,
          message: "followup",
          abortSignal: entry.input.abortSignal,
        },
        runId,
        abortController: testRpcSourceController(entry),
        followupCompletion: owner,
        onSettled,
      });
    };
    return { f, owner, dispatch };
  }

  function createSuccessor(
    entry: Entry,
    runId: string,
    identity: Partial<Parameters<typeof createTestRpcSource>[0]> = {},
    sameStore = false,
  ) {
    return createTestRpcSource(
      {
        ...entry.adapter,
        ...getRpcSourceIdentity(entry),
        ...identity,
      },
      runId,
      sameStore ? entry.input.target?.storeScope : undefined,
    );
  }

  function expectReplaySession(
    entry: Entry,
    sessionKey: string,
    extra: Record<string, unknown> = {},
  ) {
    expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        session: {
          sessionKey,
          sessionId: getRpcSourceIdentity(entry).sessionId,
          agentId: getRpcSourceIdentity(entry).agentId,
          lifecycleGeneration: getRpcSourceLifecycleGeneration(entry),
        },
        ...extra,
      }),
    );
  }

  function releaseAfterTest(completion: Promise<unknown>, ...gates: { resolve: () => void }[]) {
    onTestFinished(async () => {
      for (const gate of gates) {
        gate.resolve();
      }
      await completion;
    });
  }

  function holdCommand(result: () => CommandResult = commandResult) {
    const finish = createDeferred();
    mocks.agentCommand.mockImplementationOnce(async () => {
      await finish.promise;
      return result();
    });
    return finish;
  }

  it.each(["command", "command-cleanup", "media"] as const)(
    "joins a captured terminal save with the %s producer failure",
    async (startup) => {
      const { entry, params } = createDispatch(true);
      const finishCommand = createDeferred();
      const save = createGate();
      const failure = new Error("Synthetic startup failure");
      const failStartup = async (options?: AgentCommandOpts) => {
        await finishCommand.promise;
        if (startup === "command-cleanup") {
          await options?.beforeTerminalDelivery?.(undefined, failure);
        }
        throw failure;
      };
      if (startup !== "media") {
        mocks.agentCommand.mockImplementationOnce(failStartup);
      }
      const { emitFinal } = params.io;
      const completion = dispatchAgentRunFromGateway({
        ...params,
        loadMedia: startup === "media" ? failStartup : undefined,
      });
      releaseAfterTest(completion, finishCommand, save);
      const producer = entry.adapter.resolveTerminalProducer?.();
      expect(
        producer?.handoff(async (producerCompleted) => {
          expect(await producerCompleted).toBe(failure);
          await save.wait();
        }),
      ).toBe(true);
      testRpcSourceController(entry).abort();
      finishCommand.resolve();
      await save.entered;
      expect(emitFinal).not.toHaveBeenCalled();
      save.resolve();
      await completion;
      expectCalls(1, emitFinal, params.cleanupAbortController);
      expect(entry.adapter.resolveTerminalProducer?.()).toBeUndefined();
    },
  );

  it.each([false, true])(
    "publishes confirmed withdrawal after cleanup (late timeout: %s)",
    async (late) => {
      const { params, entry } = createDispatch(true);
      const withdrawal = vi.spyOn(transcript, "readWithdrawnUserTurnInputId");
      withdrawal.mockReturnValue(undefined);
      onTestFinished(() => withdrawal.mockRestore());
      const timeout = new Error("deadline elapsed");
      timeout.name = "TimeoutError";
      const abort = () => {
        entry.adapter.abortStopReason = "timeout";
        testRpcSourceController(entry).abort(timeout);
      };
      mocks.agentCommand.mockImplementation(async () => {
        if (!late) {
          abort();
          throw timeout;
        }
        throw new Error("startup failed");
      });
      params.cleanupAbortController.mockImplementation(() => {
        expectCalls(0, params.io.emitFinal, setGatewayDedupeEntries);
        withdrawal.mockReturnValue("pending-input-1");
      });

      await dispatchAgentRunFromGateway({
        ...params,
        onSettled: async () => {
          if (late) {
            abort();
          }
          return true;
        },
      });

      const payload = expect.objectContaining({
        status: late ? "error" : "timeout",
        stopReason: "timeout",
        reason: "input_withdrawn_before_turn",
        pendingInputId: "pending-input-1",
        summary: expect.stringContaining("Raise --timeout and retry"),
      });
      expect(params.io.emitFinal).toHaveBeenCalledWith(
        [!late, payload, late ? expect.objectContaining({ message: "startup failed" }) : undefined],
        expect.any(Object),
      );
      expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
        expect.objectContaining({ entry: expect.objectContaining({ ok: !late, payload }) }),
      );
    },
  );

  it.each(["registration", "controller", "session", "instance"] as const)(
    "rejects captured transcript custody after %s replacement",
    async (replacement) => {
      const { runId, entry, params } = createDispatch(true);
      const finish = holdCommand();
      const completion = dispatchAgentRunFromGateway(params);
      releaseAfterTest(completion, finish);
      const producer = entry.adapter.resolveTerminalProducer?.();
      expect(producer).toBeDefined();
      if (replacement === "registration") {
        rpcSourceTesting.set(runId, { ...entry });
      } else if (replacement === "controller") {
        const successor = createSuccessor(entry, runId);
        rpcSourceTesting.set(runId, successor);
      } else if (replacement === "session") {
        setTestRpcSourceIdentity(entry, { sessionId: "successor-session" });
      } else {
        entry.adapter.operationalRunInstance = { runId, instanceId: "successor-instance" };
      }
      const save = vi.fn(async () => {});
      expect(producer?.handoff(save)).toBe(false);
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("keeps rejected pre-dispatch results with their admitted registration", async () => {
    const { runId, sessionKey, entry, params } = createDispatch();
    const successor = createSuccessor(entry, runId, {
      sessionId: "successor-session",
      sessionKey: "agent:main:successor-session",
      operationalRunInstance: { runId, instanceId: "successor-instance" },
    });
    rpcSourceTesting.set(runId, successor);
    const emitFinal = vi.fn();

    await dispatchAgentRunFromGateway({
      ...params,
      assertCurrent() {
        if (rpcSourceTesting.get(runId) !== entry) {
          throw new Error("Gateway run owner replaced");
        }
      },
      dedupeKeys: [`agent:${runId}`],
      io: { ...params.io, emitFinal },
    });
    expectCalls(0, mocks.agentCommand, mocks.clearAgentRunContext);
    expect(rpcSourceTesting.get(runId)).toBe(successor);
    expectReplaySession(entry, sessionKey, { entry: expect.objectContaining({ ok: false }) });
    expect(emitFinal).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure", "cancelled", "restart"] as const)(
    "joins continuation and input settlement before publishing final or replay for %s",
    async (outcome) => {
      const { runId, entry, params } = createDispatch();
      const settlement = createGate();
      const cleanup = createGate();
      let recover: (() => void) | undefined;
      mocks.agentCommand.mockImplementationOnce(async () => {
        if (outcome === "failure") {
          throw new Error("Synthetic active run failure");
        }
        if (outcome === "restart") {
          const reason = createAgentRunRestartAbortError();
          testRpcSourceController(entry).abort(reason);
          throw reason;
        }
        if (outcome === "cancelled") {
          testRpcSourceController(entry).abort();
          throw entry.input.abortSignal.reason;
        }
        return commandResult();
      });
      const { emitFinal } = params.io;
      const { cleanupAbortController } = params;
      cleanupAbortController.mockImplementation(cleanup.wait);
      const onSettled = vi.fn(async ({ onRecovered }: { onRecovered?: () => void }) => {
        recover = onRecovered;
        await settlement.wait();
        return true;
      });
      const completion = dispatchAgentRunFromGateway({ ...params, onSettled });
      releaseAfterTest(completion, settlement, cleanup);
      await settlement.entered;
      expectCalls(0, emitFinal, cleanupAbortController);
      settlement.resolve();
      await cleanup.entered;
      expectCalls(0, emitFinal, setGatewayDedupeEntries);
      recover?.();
      expect(setGatewayDedupeEntries).not.toHaveBeenCalled();
      cleanup.resolve();
      await completion;
      expectCalls(1, setGatewayDedupeEntries, cleanupAbortController);
      expect(emitFinal).toHaveBeenCalledExactlyOnceWith(
        [
          outcome !== "failure",
          expect.objectContaining({
            status: outcome === "success" ? "ok" : outcome === "failure" ? "error" : "timeout",
            ...(outcome === "restart" ? { stopReason: "restart" } : {}),
          }),
          outcome === "failure" ? expect.any(Object) : undefined,
        ],
        expect.objectContaining({ runId }),
      );
    },
  );

  it.each(["same-session", "different-session", "removed-by-abort", "mutated-entry"] as const)(
    "settles retained followup custody without releasing a %s registration",
    async (replacement) => {
      const { f, owner, dispatch } = createFollowupDispatch();
      const { runId, sessionKey, context, entry } = f;
      const successor = createSuccessor(
        entry,
        runId,
        {
          operationalRunInstance: { runId, instanceId: "successor" },
          sessionKey: replacement === "same-session" ? sessionKey : "agent:main:other",
        },
        replacement === "same-session",
      );
      const finishCommand = holdCommand(() =>
        commandResult({
          ...(entry.input.abortSignal.aborted ? { aborted: true, stopReason: "rpc" } : {}),
          terminalReply: { disposition: "visible", text: "Original result" },
        }),
      );
      const save = createGate();
      const observed = vi.fn();
      const reply = owner.take();
      void reply.then(observed, observed);
      const completion = dispatch();
      releaseAfterTest(completion, finishCommand, save);
      const producer = entry.adapter.resolveTerminalProducer?.();
      expect(
        producer?.handoff(async (producerCompleted) => {
          await producerCompleted;
          await save.wait();
        }),
      ).toBe(true);
      if (replacement === "removed-by-abort") {
        expect(
          abortChatRunById(createChatAbortOps(context), { runId, sessionKey, stopReason: "rpc" }),
        ).toEqual({ aborted: true });
        expect(rpcSourceTesting.has(runId)).toBe(false);
      } else if (replacement === "mutated-entry") {
        setTestRpcSourceIdentity(entry, {
          sessionKey: getRpcSourceIdentity(successor).sessionKey,
        });
      } else {
        rpcSourceTesting.set(runId, successor);
      }
      finishCommand.resolve();
      await save.entered;
      expect(observed).not.toHaveBeenCalled();
      save.resolve();
      await completion;
      if (replacement === "same-session" || replacement === "mutated-entry") {
        await expect(reply).rejects.toThrow("lost its Gateway registration");
      } else {
        await expect(reply).resolves.toMatchObject(
          replacement === "removed-by-abort"
            ? { status: "error", stopReason: "rpc" }
            : { status: "ok", replyText: "Original result" },
        );
      }
      if (replacement !== "removed-by-abort") {
        expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
        expect(rpcSourceTesting.get(runId)).toBe(
          replacement === "mutated-entry" ? entry : successor,
        );
      }
      expectReplaySession(
        entry,
        replacement === "mutated-entry" ? getRpcSourceIdentity(entry).sessionKey : sessionKey,
      );
    },
  );

  it.each(["Primitive command failure", 42])(
    "retains the rendered message and original cause for synchronous throw %s",
    async (failure) => {
      const { params } = createDispatch();
      mocks.agentCommand.mockImplementationOnce(() => {
        // oxlint-disable-next-line typescript/only-throw-error -- Exercise JavaScript primitive throws at the dispatch boundary.
        throw failure;
      });
      await dispatchAgentRunFromGateway(params);
      expect(params.io.emitFinal).toHaveBeenCalledWith(
        [
          false,
          expect.objectContaining({ status: "error", summary: String(failure) }),
          expect.objectContaining({
            message: String(failure),
            cause: expect.objectContaining({ cause: failure }),
          }),
        ],
        expect.objectContaining({ error: String(failure) }),
      );
    },
  );
  it("keeps one logical owner across yield and delivers only the admitted successor reply", async () => {
    const fullReply = "B_YIELD_DONE ".repeat(400) + "SUCCESSOR_END…";
    const terminalReply = sanitizeAgentRunTerminalReply(fullReply);
    const { f, owner, dispatch } = createFollowupDispatch();
    const settlement = createGate();
    const finishExecution = vi.spyOn(owner, "finishExecution");
    const entries: SubagentRunRecord[] = [
      {
        runId: "descendant",
        childSessionKey: "agent:main:descendant",
        requesterSessionKey: f.sessionKey,
        requesterDisplayKey: f.sessionKey,
        task: "descendant",
        cleanup: "keep",
        createdAt: 1,
        execution: { status: "terminal" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          rearmGeneration: 1,
          requesterYieldBatch: true,
        },
      },
    ];
    owner.promoteYield(f.runId, entries, 1);
    mocks.agentCommand.mockResolvedValueOnce(
      commandResult({ yielded: true, terminalReply: { disposition: "empty" } }),
    );
    const predecessor = dispatch(f.runId, f.entry, undefined, async () => {
      await settlement.wait();
      return true;
    });
    releaseAfterTest(predecessor, settlement);
    await Promise.race([settlement.entered, predecessor]);
    expect(finishExecution).not.toHaveBeenCalled();
    settlement.resolve();
    await predecessor;
    expect(finishExecution).toHaveBeenCalledWith(f.runId);
    const successor = owner.successor(entries, "exact-successor", vi.fn());
    await owner.prepareSuccessor(successor);
    owner.adopt(successor);
    const successorEntry = createSuccessor(f.entry, successor.runId, {
      operationalRunInstance: { runId: successor.runId, instanceId: "successor-instance" },
    });
    rpcSourceTesting.set(successor.runId, successorEntry);
    mocks.agentCommand.mockImplementationOnce(async (opts) => {
      await opts.onExecutionStarted?.();
      return commandResult({ terminalReply, finalAssistantVisibleText: fullReply }, [
        { text: "not canonical", mediaUrl: null },
      ]);
    });
    await dispatch(successor.runId, successorEntry);
    await expect(owner.take()).resolves.toMatchObject({
      status: "ok",
      replyText: fullReply,
      terminalReply,
    });
  });

  it.each<[string, Partial<AgentCommandDeliveryResult["meta"]>, string, string | undefined]>([
    [
      "provider failure",
      { error: { kind: "incomplete_turn", message: "provider failed" } },
      "error",
      undefined,
    ],
    ["RPC cancellation", { aborted: true, stopReason: "rpc" }, "error", "rpc"],
    ["timeout", { aborted: true, stopReason: "timeout" }, "timeout", "timeout"],
    ["silent reply", { terminalReply: { disposition: "silent" } }, "ok", undefined],
    ["empty reply", { terminalReply: { disposition: "empty" } }, "ok", undefined],
  ])(
    "passes canonical %s rather than wire status to the completion owner",
    async (_name, meta, status, stopReason) => {
      const { owner, dispatch } = createFollowupDispatch();
      mocks.agentCommand.mockResolvedValueOnce(
        commandResult(meta, [{ text: "payload is not canonical", mediaUrl: null }]),
      );
      await dispatch();
      const result = await owner.take();
      expect(result).toMatchObject({ status, ...(stopReason ? { stopReason } : {}) });
      if (meta.terminalReply) {
        expect(result?.terminalReply).toEqual(meta.terminalReply);
        expect(result?.replyText).toBeUndefined();
      }
    },
  );

  it.each(["replaced", "denied"] as const)(
    "settles an admitted followup without invoking it when activation is %s",
    async (outcome) => {
      const { f, owner, dispatch } = createFollowupDispatch();
      if (outcome === "replaced") {
        const successor = createSuccessor(f.entry, f.runId, {}, true);
        rpcSourceTesting.set(f.runId, successor);
        await expect(dispatch()).rejects.toThrow("lost its Gateway registration");
        expect(rpcSourceTesting.get(f.runId)).toBe(successor);
        await expect(owner.take()).rejects.toThrow("lost its Gateway registration");
      } else {
        await dispatch(f.runId, f.entry, () => {
          throw new Error("activation denied");
        });
        await expect(owner.take()).resolves.toMatchObject({
          status: "error",
          error: "activation denied",
        });
      }
      expect(mocks.agentCommand).not.toHaveBeenCalled();
    },
  );
});
