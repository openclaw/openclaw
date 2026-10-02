import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTalkClientGatewayControlOwner } from "../client-gateway-control.js";
import { controlContext, sessionTarget } from "../client-gateway-control.test-support.js";

describe("Gateway provider transcript drain", () => {
  it.each([false, true])(
    "drains final provider snapshots before logical close without reopening actions (provider rejects: %s)",
    async (rejectProvider) => {
      const providerStarted = createDeferred();
      const finishProvider = createDeferred();
      const finishWrite = createDeferred();
      const writes: Promise<void>[] = [];
      const saved: string[] = [];
      const appendTranscript = vi.fn(
        (entry: { entryId: string; role: "user" | "assistant"; text: string }) => {
          const write = finishWrite.promise.then(() => {
            saved.push(entry.text);
          });
          writes.push(write);
          return write;
        },
      );
      const flushTranscript = vi.fn(async () => {
        await Promise.all(writes);
      });
      const closeLogicalSession = vi.fn(async () => {
        expect(saved).toEqual(["cancel"]);
      });
      const controlAgentRun = vi.fn(async () => {
        throw new Error("closed voice must not admit control");
      });
      const talkEvents: Array<{ type: string; payload: unknown }> = [];
      const owner = createTalkClientGatewayControlOwner({
        voiceSessionId: `voice-provider-drain-${rejectProvider}`,
        sessionTarget,
        connId: `conn-provider-drain-${rejectProvider}`,
        supportsToolCalls: false,
        controlSource: "transcript",
        context: controlContext(vi.fn(), (event) => talkEvents.push(event)),
        runToolAgentConsult: vi.fn(async () => ({ text: "unused" })),
        runAgentConsult: vi.fn(async () => ({ text: "unused" })),
        controlAgentRun,
        appendTranscript,
        flushTranscript,
        closeLogicalSession,
      });
      const providerFailure = new Error("provider dispose failed");
      await owner.adoptProvider(async () => {
        owner.control.onTranscript?.("user", "cancel", true);
        owner.control.onTranscript?.("assistant", "unfinished fragment", false);
        providerStarted.resolve();
        await finishProvider.promise;
        if (rejectProvider) {
          throw providerFailure;
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
          confirmation: null,
        });
        expect(flushTranscript).not.toHaveBeenCalled();
        expect(closeLogicalSession).not.toHaveBeenCalled();
        finishProvider.resolve();
        await vi.waitFor(() => expect(flushTranscript).toHaveBeenCalledOnce());
        owner.control.onTranscript?.("user", "late after disposal", true);
        expect(appendTranscript).toHaveBeenCalledOnce();
        expect(closeLogicalSession).not.toHaveBeenCalled();
        finishWrite.resolve();
        expect(await closing).toBe(rejectProvider ? providerFailure : undefined);
        expect(closeLogicalSession).toHaveBeenCalledOnce();
        expect(controlAgentRun).not.toHaveBeenCalled();
        expect(talkEvents).toEqual([]);
        owner.control.onTranscript?.("assistant", "late after logical close", true);
        expect(appendTranscript).toHaveBeenCalledOnce();
      } finally {
        finishProvider.resolve();
        finishWrite.resolve();
        await closing;
      }
    },
  );

  it("reports transcript drain failure after finishing logical cleanup", async () => {
    const failure = new Error("transcript write failed");
    const closeLogicalSession = vi.fn(async () => undefined);
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-transcript-close-error",
      sessionTarget,
      connId: "conn-transcript-close-error",
      context: controlContext(),
      runToolAgentConsult: vi.fn(async () => ({ text: "unused" })),
      runAgentConsult: vi.fn(async () => ({ text: "unused" })),
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => {
        throw failure;
      }),
      closeLogicalSession,
    });
    await owner.adoptProvider(async () => undefined);
    owner.activate();
    await expect(owner.close()).rejects.toBe(failure);
    expect(closeLogicalSession).toHaveBeenCalledOnce();
  });
});
