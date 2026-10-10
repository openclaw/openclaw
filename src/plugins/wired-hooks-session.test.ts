import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";
import { PluginInstanceDrainTimeoutError } from "./plugin-instance-error.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  attachSessionEndTranscriptSource,
  type PluginHookEndedTranscriptReadResult as TranscriptReadResult,
  type PluginHookSessionContext,
} from "./session-end-transcript.js";
import type { PluginHookHandlerMap } from "./types.js";

describe("session hook runner methods", () => {
  const sessionCtx = { sessionId: "abc-123", sessionKey: "agent:main:abc", agentId: "main" };
  const event = { sessionId: sessionCtx.sessionId, messageCount: 1, reason: "reset" as const };
  const emptyTail = { messages: [], totalMessages: 0, truncated: false };
  const readOptions = { maxMessages: 1, maxBytes: 1_024 };

  it("scopes ended transcript access to an admitted session_end handler", async () => {
    let retained: PluginHookSessionContext["endedTranscript"];
    const readTail = vi.fn(async () => ({
      messages: [{ role: "user", content: "remember this" }],
      totalMessages: 1,
      truncated: false,
    }));
    const admitted = vi.fn(async (_event, context) => {
      const transcript = (context as PluginHookSessionContext).endedTranscript;
      expect(transcript?.available).toBe(true);
      if (!transcript?.available) {
        throw new Error("expected ended transcript reader");
      }
      retained = transcript;
      await expect(transcript.readTail({ maxMessages: 10, maxBytes: 4_096 })).resolves.toEqual({
        messages: [{ role: "user", content: "remember this" }],
        totalMessages: 1,
        truncated: false,
      });
    });
    const metadataOnly = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "session_end",
        pluginId: "reader",
        handler: admitted,
        conversationAccessAllowed: true,
      },
      { hookName: "session_end", pluginId: "metadata", handler: metadataOnly },
    ]);
    const context = { ...sessionCtx };
    attachSessionEndTranscriptSource(context, { available: true, readTail });

    await runner.runSessionEnd(event, context);

    expect(metadataOnly).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        endedTranscript: {
          available: false,
          reason: "conversation-access-required",
        },
      }),
    );
    expect(readTail).toHaveBeenCalledOnce();
    expect(retained?.available).toBe(true);
    if (retained?.available) {
      await expect(retained.readTail(readOptions)).rejects.toThrow("no longer active");
    }
  });

  it.each(["pending", "fulfilled"] as const)(
    "rejects a detached %s transcript read after its handler returns",
    async (mode) => {
      const read = createDeferredCore<TranscriptReadResult>();
      let inFlight: Promise<unknown> | undefined;
      const { runner } = createHookRunnerWithRegistry([
        {
          hookName: "session_end",
          handler: (_event, context) => {
            const transcript = (context as PluginHookSessionContext).endedTranscript;
            if (!transcript?.available) {
              throw new Error("expected ended transcript reader");
            }
            inFlight = transcript.readTail(readOptions);
            // Preserve both the async handler and synchronous immediately-fulfilled regression.
            return mode === "pending" ? Promise.resolve() : undefined;
          },
          conversationAccessAllowed: true,
        },
      ]);
      const context = { ...sessionCtx };
      attachSessionEndTranscriptSource(context, {
        available: true,
        readTail: () => read.promise,
      });
      if (mode === "fulfilled") {
        read.resolve({
          messages: [{ role: "user", content: "invocation only" }],
          totalMessages: 1,
          truncated: false,
        });
      }
      await runner.runSessionEnd(event, context);
      read.resolve(emptyTail);
      await expect(inFlight).rejects.toThrow("no longer active");
    },
  );

  it("rejects transcript reads at forced plugin retirement", async () => {
    vi.useFakeTimers();
    const firstRead = createDeferredCore<TranscriptReadResult>();
    const readTail = vi
      .fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValue(emptyTail);
    const entered = createDeferredCore();
    const handlerGate = createDeferredCore();
    let transcript: PluginHookSessionContext["endedTranscript"];
    let inFlight: Promise<unknown> | undefined;
    const { registry, runner } = createHookRunnerWithRegistry([
      {
        hookName: "session_end",
        pluginId: "retiring-reader",
        handler: () => undefined,
        conversationAccessAllowed: true,
      },
    ]);
    const instance = new PluginInstance("retiring-reader", {
      record: registry.plugins[0]!,
      registry,
    });
    const retiringHandler: PluginHookHandlerMap["session_end"] = async (_event, context) => {
      transcript = context.endedTranscript;
      if (!transcript?.available) {
        throw new Error("expected ended transcript reader");
      }
      inFlight = transcript.readTail(readOptions);
      inFlight.catch(() => {});
      entered.resolve();
      await handlerGate.promise;
    };
    registry.typedHooks[0]!.handler = instance.wrap(retiringHandler);
    const context = { ...sessionCtx };
    attachSessionEndTranscriptSource(context, { available: true, readTail });
    const running = runner.runSessionEnd(event, context);
    let disposing: ReturnType<PluginInstance["dispose"]> | undefined;

    try {
      await entered.promise;
      expect(readTail).toHaveBeenCalledOnce();
      if (!transcript?.available) {
        throw new Error("expected ended transcript reader");
      }

      disposing = instance.dispose();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(instance.lifecycle.signal.aborted).toBe(false);
      await expect(transcript.readTail(readOptions)).resolves.toEqual(emptyTail);
      expect(readTail).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(instance.lifecycle.signal.aborted).toBe(true);
      const callsAtRetirement = readTail.mock.calls.length;
      await expect(transcript.readTail(readOptions)).rejects.toThrow("no longer active");
      expect(readTail).toHaveBeenCalledTimes(callsAtRetirement);

      firstRead.resolve(emptyTail);
      await expect(inFlight).rejects.toThrow("no longer active");
      handlerGate.resolve();
      await running;
      const disposal = await disposing!;
      const timeout = disposal.errors[0];
      expect(timeout).toBeInstanceOf(PluginInstanceDrainTimeoutError);
      if (!(timeout instanceof PluginInstanceDrainTimeoutError)) {
        throw new Error("expected forced-retirement settlement");
      }
      await timeout.settled;
    } finally {
      handlerGate.resolve();
      firstRead.resolve(emptyTail);
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.allSettled([running, disposing ?? instance.dispose()]);
      vi.useRealTimers();
    }
  });
});
