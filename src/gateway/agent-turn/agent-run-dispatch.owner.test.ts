import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentCommandDeliveryResult } from "../../agents/command/delivery-result.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";

const mocks = vi.hoisted(() => ({
  agentCommand: vi.fn(
    async (
      _options: AgentCommandOpts,
    ): Promise<
      Pick<AgentCommandDeliveryResult, "payloads"> & {
        meta: Partial<AgentCommandDeliveryResult["meta"]>;
      }
    > => ({ payloads: [], meta: {} }),
  ),
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
    mocks.agentCommand.mockImplementation(async () => ({ payloads: [], meta: {} }));
  });

  function createFollowupDispatch() {
    const f = createTrackedDispatch();
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
    const dispatch = (
      runId = f.runId,
      entry = f.entry,
      assertCurrent?: () => void,
      onSettled?: Parameters<typeof dispatchAgentRunFromGateway>[0]["onSettled"],
    ) => {
      owner.markAccepted(runId);
      return dispatchAgentRunFromGateway({
        assertCurrent,
        admittedRunEntry: entry,
        ingressOpts: {
          message: "followup",
          sessionKey: f.sessionKey,
          allowModelOverride: false,
          abortSignal: entry.controller.signal,
        },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
        context: f.context,
        followupCompletion: owner,
        onSettled,
      });
    };
    return { f, owner, dispatch };
  }

  it("joins a captured terminal save when command startup fails before its delivery hook", async () => {
    const { runId, sessionKey, context, entry } = createTrackedDispatch();
    const finishCommand = createDeferred();
    const saving = createDeferred();
    const finishSave = createDeferred();
    mocks.agentCommand.mockImplementationOnce(async () => {
      await finishCommand.promise;
      throw new Error("Synthetic startup failure");
    });
    const emitFinal = vi.fn();
    const completion = dispatchAgentRunFromGateway({
      admittedRunEntry: entry,
      ingressOpts: {
        message: "Synthetic startup",
        sessionKey,
        allowModelOverride: false,
        abortSignal: entry.controller.signal,
      },
      runId,
      dedupeKeys: [],
      abortController: entry.controller,
      cleanupAbortController: vi.fn(),
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
    });
    try {
      const producer = entry.resolveTerminalProducer?.();
      expect(
        producer?.handoff(async (producerCompleted) => {
          await producerCompleted;
          saving.resolve();
          await finishSave.promise;
        }),
      ).toBe(true);
      entry.controller.abort();
      finishCommand.resolve();
      await saving.promise;
      expect(emitFinal).not.toHaveBeenCalled();
      finishSave.resolve();
      await completion;
      expect(emitFinal).toHaveBeenCalledOnce();
      expect(entry.resolveTerminalProducer?.()).toBeUndefined();
    } finally {
      finishCommand.resolve();
      finishSave.resolve();
      await completion;
    }
  });

  it.each(["registration", "controller", "session", "instance"] as const)(
    "rejects captured transcript custody after %s replacement",
    async (replacement) => {
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      const finish = createDeferred();
      mocks.agentCommand.mockImplementationOnce(async () => {
        await finish.promise;
        return { payloads: [], meta: {} };
      });
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: {
          message: "Synthetic stale producer",
          sessionKey,
          allowModelOverride: false,
          abortSignal: entry.controller.signal,
        },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
        context,
      });
      try {
        const producer = entry.resolveTerminalProducer?.();
        expect(producer).toBeDefined();
        if (replacement === "registration") {
          context.chatAbortControllers.set(runId, { ...entry });
        } else if (replacement === "controller") {
          entry.controller = new AbortController();
        } else if (replacement === "session") {
          entry.sessionId = "successor-session";
        } else {
          entry.operationalRunInstance = { runId, instanceId: "successor-instance" };
        }
        const save = vi.fn(async () => {});
        expect(producer?.handoff(save)).toBe(false);
        expect(save).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        await completion;
      }
    },
  );

  it("keeps rejected pre-dispatch results with their admitted registration", async () => {
    const { runId, sessionKey, context, entry } = createTrackedDispatch();
    const successor: ChatAbortControllerEntry = {
      ...entry,
      controller: new AbortController(),
      sessionId: "successor-session",
      sessionKey: "agent:main:successor-session",
      operationalRunInstance: { runId, instanceId: "successor-instance" },
    };
    context.chatAbortControllers.set(runId, successor);
    const emitFinal = vi.fn();
    await dispatchAgentRunFromGateway({
      assertCurrent() {
        if (context.chatAbortControllers.get(runId) !== entry) {
          throw new Error("Gateway run owner replaced");
        }
      },
      admittedRunEntry: entry,
      ingressOpts: {
        message: "run only for the admitted owner",
        sessionKey,
        allowModelOverride: false,
      },
      runId,
      dedupeKeys: [`agent:${runId}`],
      abortController: entry.controller,
      cleanupAbortController: vi.fn(),
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.get(runId)).toBe(successor);
    expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        session: {
          sessionKey,
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          lifecycleGeneration: entry.lifecycleGeneration,
        },
        entry: expect.objectContaining({ ok: false }),
      }),
    );
    expect(emitFinal).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure", "cancelled"] as const)(
    "awaits continuation settlement before releasing the run and reporting %s",
    async (outcome) => {
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      const entered = createDeferred();
      const resume = createDeferred();
      mocks.agentCommand.mockImplementationOnce(async () => {
        if (outcome === "failure") {
          throw new Error("Synthetic active run failure");
        }
        if (outcome === "cancelled") {
          entry.controller.abort();
          throw entry.controller.signal.reason;
        }
        return { payloads: [], meta: {} };
      });
      const emitFinal = vi.fn();
      const cleanupAbortController = vi.fn();
      const onSettled = vi.fn(async () => {
        entered.resolve();
        await resume.promise;
        return true;
      });
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: { message: "continue", sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController,
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        onSettled,
      });
      try {
        await entered.promise;
        expect(emitFinal).not.toHaveBeenCalled();
        expect(cleanupAbortController).not.toHaveBeenCalled();
        resume.resolve();
        await completion;
        expect(cleanupAbortController).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledWith(
          [
            outcome !== "failure",
            expect.objectContaining({
              status: outcome === "success" ? "ok" : outcome === "failure" ? "error" : "timeout",
            }),
            outcome === "failure" ? expect.any(Object) : undefined,
          ],
          expect.objectContaining({ runId }),
        );
        expect(cleanupAbortController.mock.invocationCallOrder[0]).toBeLessThan(
          emitFinal.mock.invocationCallOrder[0] ?? Infinity,
        );
      } finally {
        resume.resolve();
        await completion;
      }
    },
  );

  it.each(["same-session", "different-session", "removed-by-abort", "mutated-entry"] as const)(
    "settles retained followup custody without releasing a %s registration",
    async (replacement) => {
      const { f, owner, dispatch } = createFollowupDispatch();
      const { runId, sessionKey, context, entry } = f;
      const successor = {
        ...entry,
        controller: new AbortController(),
        operationalRunInstance: { runId, instanceId: "successor" },
        sessionKey: replacement === "same-session" ? sessionKey : "agent:main:other",
      };
      const finishCommand = createDeferred();
      const saving = createDeferred();
      const finishSave = createDeferred();
      mocks.agentCommand.mockImplementationOnce(async () => {
        await finishCommand.promise;
        return {
          payloads: [],
          meta: {
            ...(entry.controller.signal.aborted ? { aborted: true, stopReason: "rpc" } : {}),
            terminalReply: { disposition: "visible", text: "Original result" },
          },
        };
      });
      let observed = false;
      const reply = owner.take().then(
        (result) => {
          observed = true;
          return { result };
        },
        (error: unknown) => {
          observed = true;
          return { error };
        },
      );
      const completion = dispatch();
      try {
        const producer = entry.resolveTerminalProducer?.();
        expect(
          producer?.handoff(async (producerCompleted) => {
            await producerCompleted;
            saving.resolve();
            await finishSave.promise;
          }),
        ).toBe(true);
        if (replacement === "removed-by-abort") {
          expect(
            abortChatRunById(createChatAbortOps(context), { runId, sessionKey, stopReason: "rpc" }),
          ).toEqual({ aborted: true });
          expect(context.chatAbortControllers.has(runId)).toBe(false);
        } else if (replacement === "mutated-entry") {
          entry.sessionKey = successor.sessionKey;
        } else {
          context.chatAbortControllers.set(runId, successor);
        }
        finishCommand.resolve();
        await saving.promise;
        expect(observed).toBe(false);
        finishSave.resolve();
        await completion;
        if (replacement === "same-session" || replacement === "mutated-entry") {
          await expect(reply).resolves.toMatchObject({
            error: expect.objectContaining({
              message: expect.stringContaining("lost its Gateway registration"),
            }),
          });
        } else {
          await expect(reply).resolves.toMatchObject({
            result:
              replacement === "removed-by-abort"
                ? { status: "error", stopReason: "rpc" }
                : { status: "ok", replyText: "Original result" },
          });
        }
        if (replacement !== "removed-by-abort") {
          expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
          expect(context.chatAbortControllers.get(runId)).toBe(
            replacement === "mutated-entry" ? entry : successor,
          );
        }
        expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
          expect.objectContaining({
            session: {
              sessionKey: replacement === "mutated-entry" ? entry.sessionKey : sessionKey,
              sessionId: entry.sessionId,
              agentId: entry.agentId,
              lifecycleGeneration: entry.lifecycleGeneration,
            },
          }),
        );
      } finally {
        finishCommand.resolve();
        finishSave.resolve();
        await completion;
        owner.close();
        await reply;
      }
    },
  );

  it.each(["Primitive command failure", 42])(
    "retains the rendered message and original cause for synchronous throw %s",
    async (failure) => {
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      mocks.agentCommand.mockImplementationOnce(() => {
        // oxlint-disable-next-line typescript/only-throw-error -- Exercise JavaScript primitive throws at the dispatch boundary.
        throw failure;
      });
      const emitFinal = vi.fn();
      await dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: { message: "continue", sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
      });
      expect(emitFinal).toHaveBeenCalledWith(
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
    const { f, owner, dispatch } = createFollowupDispatch();
    const settlementEntered = createDeferred();
    const finishSettlement = createDeferred();
    const finishExecution = vi.spyOn(owner, "finishExecution");
    let predecessor: ReturnType<typeof dispatch> | undefined;
    let successorDispatch: ReturnType<typeof dispatch> | undefined;
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
    try {
      mocks.agentCommand.mockResolvedValueOnce({
        payloads: [],
        meta: { yielded: true, terminalReply: { disposition: "empty" } },
      });
      predecessor = dispatch(f.runId, f.entry, undefined, async () => {
        settlementEntered.resolve();
        await finishSettlement.promise;
        return true;
      });
      await Promise.race([settlementEntered.promise, predecessor]);
      expect(finishExecution).not.toHaveBeenCalled();
      finishSettlement.resolve();
      await predecessor;
      expect(finishExecution).toHaveBeenCalledWith(f.runId);
      const successor = owner.successor(entries, "exact-successor", vi.fn());
      await owner.prepareSuccessor(successor);
      owner.adopt(successor);
      const successorEntry = {
        ...f.entry,
        controller: new AbortController(),
        operationalRunInstance: { runId: successor.runId, instanceId: "successor-instance" },
      };
      f.context.chatAbortControllers.set(successor.runId, successorEntry);
      mocks.agentCommand.mockImplementationOnce(async (opts) => {
        await opts.onExecutionStarted?.();
        return {
          payloads: [{ text: "not canonical", mediaUrl: null }],
          meta: { terminalReply: { disposition: "visible", text: "B_YIELD_DONE" } },
        };
      });
      successorDispatch = dispatch(successor.runId, successorEntry);
      await successorDispatch;
      await expect(owner.take()).resolves.toMatchObject({
        status: "ok",
        replyText: "B_YIELD_DONE",
        terminalReply: { disposition: "visible", text: "B_YIELD_DONE" },
      });
      expect(mocks.agentCommand).toHaveBeenCalledTimes(2);
    } finally {
      finishSettlement.resolve();
      await Promise.allSettled([predecessor, successorDispatch]);
      owner.close();
    }
  });

  it.each([
    {
      name: "provider failure",
      meta: { error: { kind: "incomplete_turn" as const, message: "provider failed" } },
      status: "error",
      stopReason: undefined,
    },
    {
      name: "RPC cancellation",
      meta: { aborted: true, stopReason: "rpc" },
      status: "error",
      stopReason: "rpc",
    },
    {
      name: "timeout",
      meta: { aborted: true, stopReason: "timeout" },
      status: "timeout",
      stopReason: "timeout",
    },
  ])(
    "passes canonical $name rather than wire status to the completion owner",
    async ({ meta, status, stopReason }) => {
      const { owner, dispatch } = createFollowupDispatch();
      mocks.agentCommand.mockResolvedValueOnce({ payloads: [], meta });
      try {
        await dispatch();
        await expect(owner.take()).resolves.toMatchObject({
          status,
          ...(stopReason ? { stopReason } : {}),
        });
      } finally {
        owner.close();
      }
    },
  );

  it("does not invoke a followup after its admitted registration was replaced", async () => {
    const { f, owner, dispatch } = createFollowupDispatch();
    const successor = { ...f.entry, controller: new AbortController() };
    f.context.chatAbortControllers.set(f.runId, successor);
    try {
      await expect(dispatch()).rejects.toThrow("lost its Gateway registration");
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(f.context.chatAbortControllers.get(f.runId)).toBe(successor);
      await expect(owner.take()).rejects.toThrow("lost its Gateway registration");
    } finally {
      owner.close();
    }
  });

  it("settles an admitted followup that fails before physical activation", async () => {
    const { f, owner, dispatch } = createFollowupDispatch();
    try {
      await dispatch(f.runId, f.entry, () => {
        throw new Error("activation denied");
      });
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      await expect(owner.take()).resolves.toMatchObject({
        status: "error",
        error: "activation denied",
      });
    } finally {
      owner.close();
    }
  });

  it.each(["silent", "empty"] as const)(
    "does not invent reply text for a canonical %s reply",
    async (disposition) => {
      const { owner, dispatch } = createFollowupDispatch();
      mocks.agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "payload is not canonical", mediaUrl: null }],
        meta: { terminalReply: { disposition } },
      });
      try {
        await dispatch();
        const result = await owner.take();
        expect(result?.terminalReply).toEqual({ disposition });
        expect(result?.replyText).toBeUndefined();
      } finally {
        owner.close();
      }
    },
  );
});
