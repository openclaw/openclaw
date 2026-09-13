import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTalkClientGatewayControlOwner } from "./talk-client-gateway-control.js";
import {
  controlBridge,
  controlContext,
  sessionTarget,
} from "./talk-client-gateway-control.test-support.js";
import { createTalkRealtimeRunControlOwner } from "./talk-realtime-run-control.js";
import { cleanupTalkConnection } from "./talk-session-registry.js";
import {
  registerTalkVoiceSession,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "./talk-voice-selection.js";

const statusResult = {
  ok: true,
  mode: "status" as const,
  sessionKey: sessionTarget.canonicalKey,
  active: false,
  message: "No active request.",
  speak: true,
  show: true,
  suppress: false,
};

describe("native Talk control admission", () => {
  it.each(["readiness", "execution"] as const)(
    "answers a live %s failure once",
    async (failure) => {
      const execute = vi.fn(async () => {
        if (failure === "execution") {
          throw new Error("private execution failure");
        }
        return statusResult;
      });
      const ready = vi.fn(async () => {
        if (failure === "readiness") {
          throw new Error("private readiness failure");
        }
      });
      const respond = vi.fn();
      const owner = createTalkRealtimeRunControlOwner({
        controlSource: "delegation",
        hasActiveRun: () => false,
        prepare: () => execute,
        speak: vi.fn(),
        warn: vi.fn(),
      });
      expect(owner.handleDelegationInput?.("status", respond, ready)).toBe("control");
      await owner.close();
      expect(respond).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Please try again."));
      expect(respond.mock.calls[0]?.[0]).not.toContain("private");
      expect(execute).toHaveBeenCalledTimes(failure === "readiness" ? 0 : 1);
    },
  );

  it("does not acquire readiness for task fallthrough or saturated controls and does not retry a throwing result sink", async () => {
    const release = createDeferred();
    const ready = vi.fn(() => release.promise);
    const execute = vi.fn(async () => statusResult);
    const warn = vi.fn();
    const owner = createTalkRealtimeRunControlOwner({
      controlSource: "delegation",
      hasActiveRun: () => false,
      prepare: () => execute,
      speak: vi.fn(),
      warn,
    });
    const overflowReply = vi.fn();
    const throwingReply = vi.fn(() => {
      throw new Error("send failed");
    });
    try {
      expect(owner.handleDelegationInput?.("Check the weather.", vi.fn(), ready)).toBe("consult");
      expect(ready).not.toHaveBeenCalled();
      for (let index = 0; index < 9; index += 1) {
        owner.handleDelegationInput?.("status", index === 0 ? throwingReply : vi.fn(), ready);
      }
      owner.handleDelegationInput?.("cancel", overflowReply, ready);
      expect(ready).toHaveBeenCalledOnce();
      expect(overflowReply).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("queue is full"),
      );
      release.resolve();
      await owner.close();
      expect(ready).toHaveBeenCalledTimes(9);
      expect(execute).toHaveBeenCalledTimes(9);
      expect(throwingReply).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("send failed"));
    } finally {
      release.resolve();
      await owner.close();
    }
  });

  it.each(["close", "replace", "disconnect"] as const)(
    "fences retained native input and awaited replies after %s",
    async (ending) => {
      const result = createDeferred<typeof statusResult>();
      const controlAgentRun = vi.fn(async () => await result.promise);
      let connected = true;
      const common = {
        voiceSessionId: `native-fence-${ending}`,
        connId: `native-fence-${ending}`,
        sessionTarget,
        controlSource: "delegation" as const,
        context: controlContext(),
        assertConnectionOpen: () => {
          if (!connected) {
            throw new Error("disconnected");
          }
        },
        runToolAgentConsult: vi.fn(async () => ({ text: "unexpected task" })),
        runAgentConsult: vi.fn(async () => ({ text: "unexpected task" })),
        appendTranscript: vi.fn(async () => undefined),
        flushTranscript: vi.fn(async () => undefined),
        closeLogicalSession: vi.fn(async () => undefined),
        controlAgentRun,
      };
      const owner = createTalkClientGatewayControlOwner(common);
      const bridge = controlBridge();
      owner.control.bindBridge(bridge);
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();
      let replacement: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      const respond = vi.fn();
      const handleInput = owner.control.handleDelegationInput!;
      try {
        owner.control.onTranscript?.("user", "status", true);
        expect(common.appendTranscript).toHaveBeenCalledOnce();
        expect(controlAgentRun).not.toHaveBeenCalled();
        expect(handleInput("status", respond)).toBe("control");
        await vi.waitFor(() => expect(controlAgentRun).toHaveBeenCalledOnce());
        if (ending === "replace") {
          replacement = createTalkClientGatewayControlOwner(common);
          await replacement.adoptProvider(vi.fn(async () => undefined));
          replacement.activate();
        } else if (ending === "disconnect") {
          connected = false;
        } else {
          void owner.close();
        }
        expect(() => handleInput("Check the weather.", respond)).toThrow(/closed|disconnected/);
        result.resolve(statusResult);
        await owner.close();
        expect(controlAgentRun).toHaveBeenCalledOnce();
        expect(respond).not.toHaveBeenCalled();
        expect(bridge.sendUserMessage).not.toHaveBeenCalled();
        expect(common.runAgentConsult).not.toHaveBeenCalled();
      } finally {
        result.resolve(statusResult);
        await owner.close();
        await replacement?.close();
      }
    },
  );
});

describe("Talk client reusable Gateway consults", () => {
  it.each([
    { ending: "explicit-close", replacing: true, preserveRuns: undefined },
    { ending: "provider-close", replacing: true, preserveRuns: undefined },
    { ending: "explicit-close", replacing: false, preserveRuns: undefined },
    { ending: "provider-close", replacing: false, preserveRuns: undefined },
    { ending: "explicit-close", replacing: true, preserveRuns: false },
  ] as const)(
    "retires function-tool transport after $ending (replacement=$replacing, preserveRuns=$preserveRuns)",
    async ({ ending, replacing, preserveRuns }) => {
      const finish = createDeferred<{ text: string }>();
      const runToolAgentConsult = vi.fn(
        async (_args: unknown, _signal: AbortSignal) => finish.promise,
      );
      const revokeRequesterFinal = vi.fn();
      const runAgentConsult = Object.assign(
        vi.fn(async () => ({ text: "unused" })),
        {
          claimAppend: vi.fn(() => true),
          revokeRequesterFinal,
        },
      );
      const voiceSessionId = `voice-function-tool-${ending}-${replacing}-${preserveRuns}`;
      const connId = `conn-${voiceSessionId}`;
      const closeProvider = vi.fn(async () => undefined);
      const owner = createTalkClientGatewayControlOwner({
        voiceSessionId,
        sessionTarget,
        connId,
        context: controlContext(),
        supportsToolCalls: true,
        runToolAgentConsult,
        runAgentConsult,
        appendTranscript: vi.fn(async () => undefined),
        flushTranscript: vi.fn(async () => undefined),
        closeLogicalSession: vi.fn(async () => undefined),
      });
      const bridge = controlBridge();
      owner.control.bindBridge(bridge);
      await owner.adoptProvider(closeProvider);
      owner.activate();
      const unregister = registerTalkVoiceSession({
        voiceSessionId,
        connId,
        sessionTarget,
        selection: {
          provider: "openai",
          voice: "marin",
          voices: ["marin", "cedar"],
          canChange: true,
        },
        launch: { provider: "openai", model: "gpt-realtime-2.1" },
        providerReady: true,
      });
      let changing: ReturnType<typeof requestTalkVoiceChange> | undefined;
      let authorityCurrent = true;
      try {
        owner.control.onToolCall?.({
          itemId: "item-voice-change",
          callId: "call-voice-change",
          name: "openclaw_agent_consult",
          args: { question: "Change your voice and keep working" },
        });
        await vi.waitFor(() => expect(runToolAgentConsult).toHaveBeenCalledOnce());
        const runSignal = runToolAgentConsult.mock.calls[0]?.[1];
        expect(runSignal?.aborted).toBe(false);
        if (replacing) {
          changing = requestTalkVoiceChange({
            session: resolveTalkVoiceSession({ kind: "client", connId, voiceSessionId }),
            voice: "cedar",
            requesterConnId: connId,
            assertCurrent: () => {
              if (!authorityCurrent) {
                throw new Error("Voice requester retired");
              }
            },
            send: vi.fn(),
          });
          void changing.catch(() => {});
        }
        if (ending === "provider-close") {
          owner.control.onClose?.("completed");
        } else {
          void owner.close({ preserveRuns });
        }
        // Close captures the current replacement before asynchronous teardown yields.
        authorityCurrent = false;
        expect(() => owner.assertOpen()).toThrow("closed");
        expect(() => owner.control.bindBridge(bridge)).toThrow("closed");
        expect(revokeRequesterFinal).toHaveBeenCalledOnce();
        expect(owner.runAgentConsult.claimAppend?.()).toBe(false);
        await nextEventLoopTurn();
        expect(runSignal?.aborted).toBe(!replacing || preserveRuns === false);
        finish.resolve({ text: "Accepted work finished" });
        await owner.close();
        expect(bridge.submitToolResult).not.toHaveBeenCalled();
        expect(closeProvider).toHaveBeenCalledTimes(ending === "provider-close" ? 0 : 1);
      } finally {
        finish.resolve({ text: "Test cleanup" });
        await owner.close();
        unregister();
        cleanupTalkConnection(connId, { warn: vi.fn() });
        await changing?.catch(() => {});
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "keeps an unadopted provider callback reusable after %s",
    async (outcome) => {
      const runToolAgentConsult = vi
        .fn()
        .mockImplementationOnce(async () => {
          if (outcome === "failure") {
            throw new Error("consult failed");
          }
          return { text: "first result" };
        })
        .mockResolvedValueOnce({ text: "second result" });
      const runAgentConsult = Object.assign(
        vi.fn(async () => ({ text: "owned result" })),
        {
          claimAppend: vi.fn(() => true),
          claimFailureAppend: vi.fn(() => true),
        },
      );
      const owner = createTalkClientGatewayControlOwner({
        voiceSessionId: `voice-provider-repeat-${outcome}`,
        sessionTarget,
        connId: `conn-provider-repeat-${outcome}`,
        context: controlContext(),
        runToolAgentConsult,
        runAgentConsult,
        appendTranscript: vi.fn(async () => undefined),
        flushTranscript: vi.fn(async () => undefined),
        closeLogicalSession: vi.fn(async () => undefined),
      });
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();

      try {
        const first = owner.runAgentConsult({ prompt: "first question" });
        if (outcome === "failure") {
          await expect(first).rejects.toThrow("consult failed");
        } else {
          await expect(first).resolves.toEqual({ text: "first result" });
        }
        await expect(owner.runAgentConsult({ prompt: "second question" })).resolves.toEqual({
          text: "second result",
        });
        expect(runToolAgentConsult).toHaveBeenCalledTimes(2);
        expect(runAgentConsult).not.toHaveBeenCalled();
      } finally {
        await owner.close();
      }
    },
  );

  it("uses the non-owning runner for successive provider tool consultations", async () => {
    const bridge = controlBridge();
    const runToolAgentConsult = vi
      .fn()
      .mockResolvedValueOnce({ text: "first result" })
      .mockResolvedValueOnce({ text: "second result" });
    const runAgentConsult = Object.assign(
      vi.fn(async () => ({ text: "owned result" })),
      {
        claimAppend: vi.fn(() => true),
        claimFailureAppend: vi.fn(() => true),
      },
    );
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-tool-repeat",
      sessionTarget,
      connId: "conn-tool-repeat",
      context: controlContext(),
      runToolAgentConsult,
      runAgentConsult,
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession: vi.fn(async () => undefined),
    });
    owner.control.bindBridge(bridge);
    await owner.adoptProvider(vi.fn(async () => undefined));
    owner.activate();

    try {
      for (const [callId, question] of [
        ["call-first", "first question"],
        ["call-second", "second question"],
      ] as const) {
        owner.control.onToolCall?.({
          itemId: `item-${callId}`,
          callId,
          name: "openclaw_agent_consult",
          args: { question },
        });
        await vi.waitFor(() =>
          expect(bridge.submitToolResult).toHaveBeenCalledWith(callId, {
            result: callId === "call-first" ? "first result" : "second result",
          }),
        );
      }

      expect(runToolAgentConsult).toHaveBeenCalledTimes(2);
      expect(runAgentConsult).not.toHaveBeenCalled();
      expect(runAgentConsult.claimAppend).not.toHaveBeenCalled();
    } finally {
      await owner.close();
    }
  });

  it.each(["close", "replace"] as const)(
    "rejects a late browser startup-failure claim after owner %s",
    async (transition) => {
      const claimFailureAppend = vi.fn(() => true);
      const runAgentConsult = Object.assign(
        vi.fn(async () => ({ text: "done" })),
        {
          claimAppend: vi.fn(() => true),
          claimFailureAppend,
        },
      );
      const common = {
        voiceSessionId: "voice-late-failure",
        sessionTarget,
        connId: "conn-late-failure",
        context: controlContext(),
        runToolAgentConsult: vi.fn(async () => ({ text: "done" })),
        runAgentConsult,
        appendTranscript: vi.fn(async () => undefined),
        flushTranscript: vi.fn(async () => undefined),
        closeLogicalSession: vi.fn(async () => undefined),
      };
      const owner = createTalkClientGatewayControlOwner(common);
      let replacement: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();

      try {
        if (transition === "replace") {
          replacement = createTalkClientGatewayControlOwner(common);
          await replacement.adoptProvider(vi.fn(async () => undefined));
          replacement.activate();
        } else {
          await owner.close();
        }
        expect(owner.runAgentConsult.claimFailureAppend?.()).toBe(false);
        expect(claimFailureAppend).toHaveBeenCalledOnce();
      } finally {
        await owner.close();
        await replacement?.close();
      }
    },
  );
});
