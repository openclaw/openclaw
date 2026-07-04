// crestodian.chat handler tests: session reuse, reset, and action mapping.
import { describe, expect, it, vi } from "vitest";
import { CrestodianChatEngine } from "../../crestodian/chat-engine.js";
import { crestodianHandlers, type CrestodianChatSession } from "./crestodian.js";
import type { GatewayRequestContext } from "./types.js";

type RespondCall = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

function makeRespond() {
  const calls: RespondCall[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  return { calls, respond };
}

function makeContext(sessions: Map<string, CrestodianChatSession>): GatewayRequestContext {
  return { crestodianSessions: sessions } as unknown as GatewayRequestContext;
}

function seededSession(overrides?: Partial<CrestodianChatSession>): CrestodianChatSession {
  return {
    engine: new CrestodianChatEngine({}),
    welcome: "welcome text",
    lastUsedAt: 1,
    ...overrides,
  };
}

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
): Promise<RespondCall> {
  const { calls, respond } = makeRespond();
  await crestodianHandlers["crestodian.chat"]({
    params,
    respond,
    context,
  } as never);
  const call = calls[0];
  if (!call) {
    throw new Error("expected a respond call");
  }
  return call;
}

describe("crestodian.chat", () => {
  it("rejects invalid params", async () => {
    const call = await callChat(makeContext(new Map()), {});
    expect(call.ok).toBe(false);
  });

  it("returns the stored welcome when no message is sent", async () => {
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession()]]);
    const call = await callChat(makeContext(sessions), { sessionId: "s1" });
    expect(call.ok).toBe(true);
    expect(call.payload).toMatchObject({ sessionId: "s1", reply: "welcome text", action: "none" });
  });

  it("routes messages through the session engine", async () => {
    const engine = new CrestodianChatEngine({});
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "did the thing", action: "none" });
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "status" });

    expect(handle).toHaveBeenCalledWith("status");
    expect(call.payload).toMatchObject({ reply: "did the thing", action: "none" });
  });

  it("maps the TUI handoff to an open-agent action for clients", async () => {
    const engine = new CrestodianChatEngine({});
    vi.spyOn(engine, "handle").mockResolvedValue({
      text: "",
      action: "open-tui",
      handoff: { kind: "open-tui" },
    });
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "talk to agent",
    });

    expect(call.payload).toMatchObject({ action: "open-agent" });
    expect((call.payload as { reply: string }).reply).toContain("continue with your agent");
  });

  it("resets a session on request", async () => {
    const engine = new CrestodianChatEngine({});
    const handle = vi.spyOn(engine, "handle");
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);
    // Reset drops the stored session; loading a fresh welcome would hit real
    // discovery, so stub the overview loader on the replacement engine path by
    // asserting the old engine is gone instead.
    const { calls, respond } = makeRespond();
    const context = makeContext(sessions);
    const pending = crestodianHandlers["crestodian.chat"]({
      params: { sessionId: "s1", reset: true },
      respond,
      context,
    } as never);
    await pending;
    expect(handle).not.toHaveBeenCalled();
    expect(sessions.get("s1")?.engine).not.toBe(engine);
    expect(calls[0]?.ok).toBe(true);
  });
});
