import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  activate,
  controlOptions,
  createControlFixture,
  type ControlOwner,
} from "./client-control-fixture.test-support.js";
import {
  closeTalkClientGatewayControlSession,
  createTalkClientGatewayControlOwner,
} from "./client-gateway-control.js";
import { sessionTarget, controlContext } from "./client-gateway-control.test-support.js";
import { cleanupTalkConnection } from "./session-registry.js";

describe("Talk client Gateway control teardown", () => {
  it("detaches accepted provider consultations without extending admission", async () => {
    const result = createDeferred<{ text: string }>();
    const started = createDeferred();
    const providerController = new AbortController();
    let acceptedSignal: AbortSignal | undefined;
    const runAgentConsult = vi.fn(async (_args: unknown, signal: AbortSignal) => {
      acceptedSignal = signal;
      started.resolve();
      return await result.promise;
    });
    const { owner } = createControlFixture({
      voiceSessionId: "voice-delegation-detach",
      connId: "conn-delegation-detach",
      runToolAgentConsult: runAgentConsult,
      runAgentConsult,
    });
    await activate(owner);
    const accepted = owner.runAgentConsult({
      prompt: "accepted task",
      signal: providerController.signal,
    });
    try {
      await started.promise;
      await owner.close();
      expect(acceptedSignal?.aborted).toBe(false);
      await expect(owner.runAgentConsult({ prompt: "late task" })).rejects.toThrow("closed");
      expect(runAgentConsult).toHaveBeenCalledOnce();
      providerController.abort(new Error("provider cancelled accepted work"));
      expect(acceptedSignal?.aborted).toBe(true);
      result.resolve({ text: "accepted task finished" });
      await expect(accepted).resolves.toEqual({ text: "accepted task finished" });
    } finally {
      result.resolve({ text: "test cleanup" });
      await accepted;
      await owner.close();
    }
  });

  it.each([
    { transition: "disconnect", rejectProvider: false },
    { transition: "disconnect", rejectProvider: true },
    { transition: "close", rejectProvider: false },
    { transition: "replacement", rejectProvider: false },
  ] as const)(
    "joins $transition teardown (provider rejects: $rejectProvider)",
    async ({ transition, rejectProvider }) => {
      const providerStarted = createDeferred();
      const finishProvider = createDeferred();
      const writeStarted = createDeferred();
      const finishWrite = createDeferred();
      const failure = new Error("provider close failed");
      const closeProvider = vi.fn(async () => {
        providerStarted.resolve();
        await finishProvider.promise;
        if (rejectProvider) {
          throw failure;
        }
      });
      const ownerWarn = vi.fn();
      const log = { warn: vi.fn() };
      const common = controlOptions({
        voiceSessionId: "voice-disconnect",
        connId: "conn-disconnect",
        context: controlContext(ownerWarn),
      });
      const owner = createTalkClientGatewayControlOwner({
        ...common,
        flushTranscript: async () => {
          writeStarted.resolve();
          if (transition !== "disconnect") {
            await finishWrite.promise;
          }
        },
      });
      await activate(owner, closeProvider);
      let replacement: ControlOwner | undefined;
      if (transition === "replacement") {
        replacement = createTalkClientGatewayControlOwner(common);
        await activate(replacement);
      } else if (transition === "close") {
        void owner.close();
      }
      if (transition !== "disconnect") {
        await providerStarted.promise;
      }
      cleanupTalkConnection(common.connId, log);
      await providerStarted.promise;
      let drained = false;
      const draining = drainGlobalSingletonLifecycleState("restart").then(() => {
        drained = true;
      });
      try {
        expect(() => owner.assertOpen()).toThrow("closed");
        await expect(owner.runAgentConsult({ prompt: "late task" })).rejects.toThrow("closed");
        await nextEventLoopTurn();
        expect(drained).toBe(false);
        if (transition === "disconnect") {
          expect(common.closeLogicalSession).not.toHaveBeenCalled();
        }
        finishProvider.resolve();
        await writeStarted.promise;
        if (transition !== "disconnect") {
          await nextEventLoopTurn();
          expect(drained).toBe(false);
          finishWrite.resolve();
        }
        await draining;
        expect(common.closeLogicalSession).toHaveBeenCalledOnce();
        expect(common.runToolAgentConsult).not.toHaveBeenCalled();
        expect(closeProvider).toHaveBeenCalledOnce();
        if (rejectProvider) {
          expect(ownerWarn).toHaveBeenCalledWith(
            "talk disconnected Gateway control close failed: provider close failed",
          );
          await expect(owner.close()).rejects.toBe(failure);
        } else {
          expect(ownerWarn).not.toHaveBeenCalled();
        }
        expect(log.warn).not.toHaveBeenCalled();
        cleanupTalkConnection(common.connId, log);
        await nextEventLoopTurn();
        expect(closeProvider).toHaveBeenCalledOnce();
        await expect(
          closeTalkClientGatewayControlSession({
            voiceSessionId: common.voiceSessionId,
            sessionKey: sessionTarget.sessionKey,
            connId: common.connId,
          }),
        ).resolves.toBe(false);
      } finally {
        finishProvider.resolve();
        finishWrite.resolve();
        await Promise.allSettled([owner.close(), replacement?.close(), draining]);
      }
    },
  );

  it("replaces only the physical transport while preserving the logical owner and run", async () => {
    const consult = createDeferred<{ text: string }>();
    const runStarted = createDeferred();
    let runSignal: AbortSignal | undefined;
    const runAgentConsult = vi.fn(async (_args: unknown, signal: AbortSignal) => {
      runSignal = signal;
      runStarted.resolve();
      return await consult.promise;
    });
    const {
      owner: first,
      bridge: firstBridge,
      closeProvider: closeFirst,
      options: common,
      appendTranscript,
      closeLogicalSession,
    } = createControlFixture({
      voiceSessionId: "voice-replacement",
      connId: "conn-replacement",
      runToolAgentConsult: runAgentConsult,
      runAgentConsult,
    });
    const secondBridge = { ...firstBridge, submitToolResult: vi.fn() };
    const closeSecond = vi.fn(async () => undefined);
    first.control.bindBridge(firstBridge);
    await activate(first, closeFirst);
    first.control.onTranscript?.("user", "first transport", true);
    first.control.onToolCall?.({
      itemId: "item-replacement",
      callId: "call-replacement",
      name: "openclaw_agent_consult",
      args: { question: "keep running" },
    });
    await runStarted.promise;

    const second = createTalkClientGatewayControlOwner(common);
    second.control.bindBridge(secondBridge);
    await activate(second, closeSecond);
    await vi.waitFor(() => expect(closeFirst).toHaveBeenCalledOnce());
    expect(() => first.control.bindControl?.({ sendUserMessage: vi.fn() })).toThrow("closed");
    first.control.onClose?.("completed");
    first.control.onTranscript?.("user", "stale transport", true);
    second.control.onTranscript?.("user", "second transport", true);

    expect(runSignal?.aborted).toBe(false);
    expect(closeLogicalSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(appendTranscript).toHaveBeenCalledTimes(2));
    const entryIds = appendTranscript.mock.calls.map(([entry]) => entry.entryId);
    expect(entryIds).toEqual([
      expect.stringMatching(/^gateway-[0-9a-f-]+-1$/),
      expect.stringMatching(/^gateway-[0-9a-f-]+-1$/),
    ]);
    expect(entryIds[0]).not.toBe(entryIds[1]);

    consult.resolve({ text: "done" });
    await vi.waitFor(() => expect(closeFirst).toHaveBeenCalledOnce());
    expect(firstBridge.submitToolResult).not.toHaveBeenCalled();
    await second.close();
    expect(() => second.control.bindBridge(secondBridge)).toThrow("closed");
    expect(closeSecond).toHaveBeenCalledOnce();
    expect(closeLogicalSession).toHaveBeenCalledOnce();
  });
});
