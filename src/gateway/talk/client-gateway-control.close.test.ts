import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import type { RealtimeVoiceBridge } from "../../talk/provider-types.js";
import {
  closeTalkClientGatewayControlSession,
  createTalkClientGatewayControlOwner,
} from "./client-gateway-control.js";
import {
  sessionTarget,
  controlContext,
  controlBridge,
} from "./client-gateway-control.test-support.js";
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
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-delegation-detach",
      sessionTarget,
      connId: "conn-delegation-detach",
      context: controlContext(),
      runToolAgentConsult: runAgentConsult,
      runAgentConsult,
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession: vi.fn(async () => undefined),
    });
    await owner.adoptProvider(vi.fn(async () => undefined));
    owner.activate();
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

  it.each([false, true])(
    "joins provider and logical cleanup when the owning client disconnects (provider rejects: %s)",
    async (rejectProvider) => {
      const providerStarted = createDeferred();
      const finishProvider = createDeferred();
      const failure = new Error("provider close failed");
      const closeProvider = vi.fn(async () => {
        providerStarted.resolve();
        await finishProvider.promise;
        if (rejectProvider) {
          throw failure;
        }
      });
      const closeLogicalSession = vi.fn(async () => undefined);
      const ownerWarn = vi.fn();
      const context = controlContext(ownerWarn);
      const log = { warn: vi.fn() };
      const owner = createTalkClientGatewayControlOwner({
        voiceSessionId: "voice-disconnect",
        sessionTarget,
        connId: "conn-disconnect",
        context,
        runToolAgentConsult: vi.fn(async () => ({ text: "done" })),
        runAgentConsult: vi.fn(async () => ({ text: "done" })),
        appendTranscript: vi.fn(async () => undefined),
        flushTranscript: vi.fn(async () => undefined),
        closeLogicalSession,
      });
      await owner.adoptProvider(closeProvider);
      owner.activate();

      cleanupTalkConnection("conn-disconnect", log);
      await providerStarted.promise;
      let drained = false;
      const draining = drainGlobalSingletonLifecycleState("restart").then(() => {
        drained = true;
      });
      try {
        expect(() => owner.assertOpen()).toThrow("closed");
        await nextEventLoopTurn();
        expect(drained).toBe(false);
        expect(closeLogicalSession).not.toHaveBeenCalled();
        finishProvider.resolve();
        await draining;
        expect(closeLogicalSession).toHaveBeenCalledOnce();
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
        cleanupTalkConnection("conn-disconnect", log);
        await nextEventLoopTurn();
        expect(closeProvider).toHaveBeenCalledOnce();
      } finally {
        finishProvider.resolve();
        await Promise.allSettled([owner.close(), draining]);
      }
    },
  );

  it.each(["close", "replacement"] as const)(
    "joins teardown already started by %s when the connection disconnects",
    async (transition) => {
      const providerStarted = createDeferred();
      const finishProvider = createDeferred();
      const writeStarted = createDeferred();
      const finishWrite = createDeferred();
      const common = {
        voiceSessionId: `voice-pending-close-${transition}`,
        sessionTarget,
        connId: `conn-pending-close-${transition}`,
        context: controlContext(),
        runToolAgentConsult: vi.fn(async () => ({ text: "unused" })),
        runAgentConsult: vi.fn(async () => ({ text: "unused" })),
        appendTranscript: vi.fn(async () => undefined),
        closeLogicalSession: vi.fn(async () => undefined),
      };
      const owner = createTalkClientGatewayControlOwner({
        ...common,
        flushTranscript: async () => {
          writeStarted.resolve();
          await finishWrite.promise;
        },
      });
      await owner.adoptProvider(async () => {
        providerStarted.resolve();
        await finishProvider.promise;
      });
      owner.activate();
      let replacement: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      if (transition === "replacement") {
        replacement = createTalkClientGatewayControlOwner({
          ...common,
          flushTranscript: async () => {},
        });
        await replacement.adoptProvider(async () => {});
        replacement.activate();
      } else {
        void owner.close();
      }
      await providerStarted.promise;
      cleanupTalkConnection(common.connId, { warn: vi.fn() });
      let drained = false;
      const draining = drainGlobalSingletonLifecycleState("restart").then(() => {
        drained = true;
      });
      try {
        await expect(owner.runAgentConsult({ prompt: "late task" })).rejects.toThrow("closed");
        await nextEventLoopTurn();
        expect(drained).toBe(false);
        finishProvider.resolve();
        await writeStarted.promise;
        await nextEventLoopTurn();
        expect(drained).toBe(false);
        finishWrite.resolve();
        await draining;
        expect(common.closeLogicalSession).toHaveBeenCalledOnce();
        expect(common.runToolAgentConsult).not.toHaveBeenCalled();
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

  it("finishes logical cleanup when provider teardown fails", async () => {
    const closeLogicalSession = vi.fn(async () => undefined);
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-close-error",
      sessionTarget,
      connId: "conn-close-error",
      context: controlContext(),
      runToolAgentConsult: vi.fn(async () => ({ text: "done" })),
      runAgentConsult: vi.fn(async () => ({ text: "done" })),
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession,
    });
    await owner.adoptProvider(vi.fn(() => Promise.reject(new Error("provider close failed"))));
    owner.activate();

    await expect(owner.close()).rejects.toThrow("provider close failed");
    expect(closeLogicalSession).toHaveBeenCalledOnce();
  });

  it("replaces only the physical transport while preserving the logical owner and run", async () => {
    const consult = createDeferred<{ text: string }>();
    const runStarted = createDeferred();
    let runSignal: AbortSignal | undefined;
    const runAgentConsult = vi.fn(async (_args: unknown, signal: AbortSignal) => {
      runSignal = signal;
      runStarted.resolve();
      return await consult.promise;
    });
    const appendTranscript = vi.fn(
      async (_entry: { entryId: string; role: "user" | "assistant"; text: string }) => undefined,
    );
    const closeLogicalSession = vi.fn(async () => undefined);
    const common = {
      voiceSessionId: "voice-replacement",
      sessionTarget,
      connId: "conn-replacement",
      context: controlContext(),
      runToolAgentConsult: runAgentConsult,
      runAgentConsult,
      appendTranscript,
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession,
    };
    const firstBridge = controlBridge();
    const secondBridge = {
      ...firstBridge,
      submitToolResult: vi.fn(),
    } satisfies RealtimeVoiceBridge;
    const closeFirst = vi.fn(async () => undefined);
    const closeSecond = vi.fn(async () => undefined);
    const first = createTalkClientGatewayControlOwner(common);
    first.control.bindBridge(firstBridge);
    await first.adoptProvider(closeFirst);
    first.activate();
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
    await second.adoptProvider(closeSecond);
    second.activate();
    await vi.waitFor(() => expect(closeFirst).toHaveBeenCalledOnce());
    expect(() => first.control.bindControl?.({ sendUserMessage: vi.fn() })).toThrow("closed");
    first.control.onClose?.("completed");
    first.control.onTranscript?.("user", "stale transport", true);
    second.control.onTranscript?.("user", "second transport", true);

    expect(runSignal?.aborted).toBe(false);
    expect(closeLogicalSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(appendTranscript).toHaveBeenCalledTimes(2));
    const entryIds = appendTranscript.mock.calls.map(([entry]) => entry.entryId);
    expect(entryIds).toHaveLength(2);
    expect(entryIds[0]).toMatch(/^gateway-[0-9a-f-]+-1$/);
    expect(entryIds[1]).toMatch(/^gateway-[0-9a-f-]+-1$/);
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
