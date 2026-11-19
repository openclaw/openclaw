import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { activate, createControlFixture } from "./client-control-fixture.test-support.js";
import { controlContext, sessionTarget } from "./client-gateway-control.test-support.js";

const QUESTION = "What is on my calendar today?";
// Longer than the forced-consult fallback window, so a skipped consult stays skipped.
const AFTER_FALLBACK_MS = 400;

function forcedFixture(params: {
  voiceSessionId: string;
  force?: boolean;
  runToolAgentConsult?: (args: unknown, signal: AbortSignal) => Promise<{ text: string }>;
  controlAgentRun?: ReturnType<typeof vi.fn>;
}) {
  const warn = vi.fn();
  const runToolAgentConsult = vi.fn(
    params.runToolAgentConsult ?? (async () => ({ text: "You have two meetings." })),
  );
  const fixture = createControlFixture({
    voiceSessionId: params.voiceSessionId,
    connId: `conn-${params.voiceSessionId}`,
    providerId: "openai",
    controlSource: "transcript",
    supportsToolCalls: true,
    forceAgentConsultOnFinalTranscript: params.force ?? true,
    context: controlContext(warn),
    runToolAgentConsult,
    ...(params.controlAgentRun ? { controlAgentRun: params.controlAgentRun as never } : {}),
  });
  return { ...fixture, warn, runToolAgentConsult };
}

async function start(fixture: ReturnType<typeof forcedFixture>) {
  fixture.owner.control.bindBridge(fixture.bridge);
  await activate(fixture.owner, fixture.closeProvider);
  fixture.owner.control.onReady?.();
}

function nativeConsult(fixture: ReturnType<typeof forcedFixture>, callId: string) {
  fixture.owner.control.onToolCall?.({
    itemId: `item-${callId}`,
    callId,
    name: "openclaw_agent_consult",
    args: { question: QUESTION },
  });
}

describe("Gateway-controlled Talk forced consult routing", () => {
  it.each([true, false])(
    "routes a final user transcript through the agent when forced=%s",
    async (force) => {
      const fixture = forcedFixture({ voiceSessionId: `voice-forced-${force}`, force });
      await start(fixture);
      try {
        fixture.owner.control.onTranscript?.("user", "What is on", false);
        fixture.owner.control.onTranscript?.("user", QUESTION, true);
        if (!force) {
          await delay(AFTER_FALLBACK_MS);
          expect(fixture.runToolAgentConsult).not.toHaveBeenCalled();
          expect(fixture.bridge.sendUserMessage).not.toHaveBeenCalled();
          return;
        }
        await vi.waitFor(() =>
          expect(fixture.bridge.sendUserMessage).toHaveBeenCalledWith(
            expect.stringContaining('Answer: "You have two meetings."'),
          ),
        );
        expect(fixture.runToolAgentConsult).toHaveBeenCalledOnce();
        expect(fixture.runToolAgentConsult.mock.calls[0]?.[0]).toMatchObject({
          question: QUESTION,
        });
        // The answer is spoken, not submitted as a provider tool result.
        expect(fixture.bridge.submitToolResult).not.toHaveBeenCalled();
      } finally {
        await fixture.owner.close();
      }
    },
  );

  it("lets a native consult that arrives inside the fallback window own the request", async () => {
    const fixture = forcedFixture({ voiceSessionId: "voice-native-first" });
    await start(fixture);
    try {
      fixture.owner.control.onTranscript?.("user", QUESTION, true);
      nativeConsult(fixture, "call-native");
      await vi.waitFor(() =>
        expect(fixture.bridge.submitToolResult).toHaveBeenCalledWith("call-native", {
          result: "You have two meetings.",
        }),
      );
      await delay(AFTER_FALLBACK_MS);
      expect(fixture.runToolAgentConsult).toHaveBeenCalledOnce();
      expect(fixture.bridge.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await fixture.owner.close();
    }
  });

  it("answers a late native consult for a started forced consult without a second run", async () => {
    const answer = createDeferred<{ text: string }>();
    const fixture = forcedFixture({
      voiceSessionId: "voice-forced-first",
      runToolAgentConsult: () => answer.promise,
    });
    await start(fixture);
    try {
      fixture.owner.control.onTranscript?.("user", QUESTION, true);
      await vi.waitFor(() => expect(fixture.runToolAgentConsult).toHaveBeenCalledOnce());
      nativeConsult(fixture, "call-late");
      await vi.waitFor(() =>
        expect(fixture.bridge.submitToolResult).toHaveBeenCalledWith(
          "call-late",
          expect.objectContaining({ status: "already_delivered" }),
          { suppressResponse: true },
        ),
      );
      expect(fixture.warn).toHaveBeenCalledWith(
        "talk Gateway control skipped native consult: forced consult in_flight",
      );
      answer.resolve({ text: "You have two meetings." });
      await vi.waitFor(() =>
        expect(fixture.bridge.sendUserMessage).toHaveBeenCalledWith(
          expect.stringContaining("You have two meetings."),
        ),
      );
      expect(fixture.runToolAgentConsult).toHaveBeenCalledOnce();
    } finally {
      answer.resolve({ text: "cleanup" });
      await fixture.owner.close();
    }
  });

  it("cancels a forced consult from a spoken stop without speaking its result", async () => {
    const cancelled = {
      ok: true,
      mode: "cancel" as const,
      sessionKey: sessionTarget.canonicalKey,
      active: true,
      aborted: true,
      message: "Cancelled the active OpenClaw run.",
      speak: true,
      show: true,
      suppress: false,
    };
    const controlAgentRun = vi.fn(async () => cancelled);
    const fixture = forcedFixture({
      voiceSessionId: "voice-forced-cancel",
      controlAgentRun,
      runToolAgentConsult: (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Consult cancelled", "AbortError")),
          );
        }),
    });
    await start(fixture);
    try {
      fixture.owner.control.onTranscript?.("user", QUESTION, true);
      await vi.waitFor(() => expect(fixture.runToolAgentConsult).toHaveBeenCalledOnce());
      fixture.owner.control.onTranscript?.("user", "cancel", true);
      await vi.waitFor(() => expect(controlAgentRun).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(fixture.bridge.sendUserMessage).toHaveBeenCalledOnce());
      await delay(AFTER_FALLBACK_MS);
      // Only the control reply is spoken; "cancel" itself never becomes a consult.
      expect(fixture.bridge.sendUserMessage).toHaveBeenCalledOnce();
      expect(fixture.bridge.sendUserMessage.mock.calls[0]?.[0]).toContain(
        "Cancelled the active OpenClaw run.",
      );
      expect(fixture.runToolAgentConsult).toHaveBeenCalledOnce();
    } finally {
      await fixture.owner.close();
    }
  });
});
