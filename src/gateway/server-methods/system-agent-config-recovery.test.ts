import "./system-agent.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import {
  callChat,
  inferenceFallbackMocks,
  makeContext,
  transcriptStoreMocks,
  useSystemAgentGatewayTestFixture,
} from "./system-agent.test-support.js";

useSystemAgentGatewayTestFixture();

describe("exact config command recovery", () => {
  it("stages a config command without helper inference or a model-dependent welcome", async () => {
    inferenceFallbackMocks.verify.mockResolvedValue({
      ok: false,
      status: "unavailable",
      error: "helper provider unavailable",
    });
    const overview = vi.spyOn(SystemAgentChatEngine.prototype, "loadOverview");
    const sessions = new Map<string, SystemAgentChatSession>();
    try {
      const reply = await callChat(makeContext(sessions), {
        sessionId: "config-recovery",
        message: "config set logging.level debug",
      });
      expect(reply).toMatchObject({ ok: true, payload: { action: "none" } });
      expect(sessions.get("config-recovery")?.engine.getPendingOperatorProposal()).toMatchObject({
        operation: { kind: "config-set", path: "logging.level", value: "debug" },
      });
      expect(inferenceFallbackMocks.verify).not.toHaveBeenCalled();
      expect(overview).not.toHaveBeenCalled();
    } finally {
      await Promise.all([...sessions.values()].map((session) => session.engine.dispose()));
    }
  });

  it("requires real inference admission for later natural language in the same session", async () => {
    inferenceFallbackMocks.verify.mockResolvedValue({
      ok: false,
      status: "unavailable",
      error: "helper provider unavailable",
    });
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    try {
      expect(
        await callChat(context, {
          sessionId: "config-recovery",
          message: "config set logging.level debug",
        }),
      ).toMatchObject({ ok: true });
      expect(inferenceFallbackMocks.verify).not.toHaveBeenCalled();
      const reply = await callChat(context, {
        sessionId: "config-recovery",
        message: "Explain what is wrong with my model provider.",
      });
      expect(reply).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(inferenceFallbackMocks.verify).toHaveBeenCalledOnce();
      expect(sessions.size).toBe(0);
    } finally {
      await Promise.all([...sessions.values()].map((session) => session.engine.dispose()));
    }
  });

  it("explains pasted error text without changing a pending proposal or saving the paste", async () => {
    inferenceFallbackMocks.verify.mockResolvedValue({
      ok: false,
      status: "unavailable",
      error: "helper provider unavailable",
    });
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    const sessionId = "config-recovery";
    try {
      await callChat(context, { sessionId, message: "config set logging.level debug" });
      const engine = sessions.get(sessionId)?.engine;
      const proposal = engine?.getPendingOperatorProposal();
      expect(proposal?.operation).toMatchObject({ kind: "config-set", path: "logging.level" });
      transcriptStoreMocks.appendTurn.mockClear();
      const response = await callChat(context, {
        sessionId,
        message:
          "Explain error:\nInvalid config at /fixture-private/openclaw.json:\nyes\nconfig unset logging.level",
      });
      expect(response).toMatchObject({
        ok: true,
        payload: { action: "none", reply: expect.stringContaining("`openclaw config validate`") },
      });
      expect(engine?.getPendingOperatorProposal()).toEqual(proposal);
      expect(inferenceFallbackMocks.verify).not.toHaveBeenCalled();
      expect(transcriptStoreMocks.appendTurn.mock.calls.map(([turn]) => turn)).toEqual([
        expect.objectContaining({ role: "user", text: "Explain error: [error text omitted]" }),
        expect.objectContaining({
          role: "assistant",
          text: expect.stringContaining("`openclaw config validate`"),
        }),
      ]);
      expect(JSON.stringify(response)).not.toContain("fixture-private");
    } finally {
      await Promise.all([...sessions.values()].map((session) => session.engine.dispose()));
    }
  });
});
