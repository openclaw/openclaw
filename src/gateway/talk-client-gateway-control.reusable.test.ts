import { describe, expect, it, vi } from "vitest";
import { createTalkClientGatewayControlOwner } from "./talk-client-gateway-control.js";
import {
  sessionTarget,
  controlContext,
  controlBridge,
} from "./talk-client-gateway-control.test-support.js";

describe("Talk client reusable Gateway consults", () => {
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
