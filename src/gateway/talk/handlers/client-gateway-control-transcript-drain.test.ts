import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTalkClientGatewayControlOwner } from "../client-gateway-control.js";
import { controlContext, sessionTarget } from "../client-gateway-control.test-support.js";

const unusedConsult = async () => ({ text: "unused" });

it.each(["success", "provider failure", "transcript failure"])(
  "Gateway provider transcript drain: final snapshots precede logical cleanup without reopening actions (%s)",
  async (outcome) => {
    const failure = new Error(outcome);
    const providerStarted = createDeferred();
    const finishProvider = createDeferred();
    const finishWrite = createDeferred();
    const writes: Promise<void>[] = [];
    const saved: string[] = [];
    const appendTranscript = vi.fn((entry: { text: string }) => {
      const write = finishWrite.promise.then(() => void saved.push(entry.text));
      writes.push(write);
      return write;
    });
    const flushTranscript = vi.fn(async () => {
      await Promise.all(writes);
      if (outcome === "transcript failure") {
        throw failure;
      }
    });
    const closeLogicalSession = vi.fn(async () => expect(saved).toEqual(["cancel"]));
    const controlAgentRun = vi.fn(async () => {
      throw new Error("closed voice must not admit control");
    });
    const talkEvents = vi.fn();
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: `voice-provider-drain-${outcome}`,
      connId: `conn-provider-drain-${outcome}`,
      sessionTarget,
      supportsToolCalls: false,
      controlSource: "transcript",
      context: controlContext(vi.fn(), talkEvents),
      runToolAgentConsult: unusedConsult,
      runAgentConsult: unusedConsult,
      controlAgentRun,
      appendTranscript,
      flushTranscript,
      closeLogicalSession,
    });
    await owner.adoptProvider(async () => {
      owner.control.onTranscript?.("user", "cancel", true);
      owner.control.onTranscript?.("assistant", "unfinished fragment", false);
      providerStarted.resolve();
      await finishProvider.promise;
      if (outcome === "provider failure") {
        throw failure;
      }
    });
    owner.activate();
    const closing = owner.close().catch((error: unknown) => error);
    try {
      expect(() => owner.assertOpen()).toThrow("closed");
      await providerStarted.promise;
      expect(appendTranscript).toHaveBeenCalledExactlyOnceWith({
        entryId: expect.any(String),
        role: "user",
        text: "cancel",
      });
      expect([flushTranscript.mock.calls, closeLogicalSession.mock.calls]).toEqual([[], []]);
      finishProvider.resolve();
      await vi.waitFor(() => expect(flushTranscript).toHaveBeenCalledOnce());
      owner.control.onTranscript?.("user", "late after disposal", true);
      expect(closeLogicalSession).not.toHaveBeenCalled();
      finishWrite.resolve();
      expect(await closing).toBe(outcome === "success" ? undefined : failure);
      expect(closeLogicalSession).toHaveBeenCalledOnce();
      expect([controlAgentRun.mock.calls, talkEvents.mock.calls]).toEqual([[], []]);
      owner.control.onTranscript?.("assistant", "late after logical close", true);
      expect(appendTranscript).toHaveBeenCalledOnce();
    } finally {
      finishProvider.resolve();
      finishWrite.resolve();
      await closing;
    }
  },
);
