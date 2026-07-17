import { describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assembleChannelTurnPlan, assembleResolvedChannelTurn } from "./planner.js";

const coreDispatch = vi.hoisted(() => vi.fn());
const coreRecordInboundSession = vi.hoisted(() => vi.fn());
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/state/main/sessions.json"));

vi.mock("../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: coreDispatch,
}));

vi.mock("../../config/sessions/paths.js", () => ({ resolveStorePath }));

vi.mock("../session.js", () => ({ recordInboundSession: coreRecordInboundSession }));

const cfg = { session: { store: "/state/{agentId}/sessions.json" } } as OpenClawConfig;
const ctxPayload = { Body: "hello" } as FinalizedMsgContext;

describe("channel turn planner", () => {
  it("assembles a standard plan with core-owned session and dispatch dependencies", () => {
    const delivery = { deliver: vi.fn() };
    const assembled = assembleChannelTurnPlan({
      cfg,
      channel: "test",
      accountId: "acct",
      route: { agentId: "main", sessionKey: "agent:main:test:peer" },
      ctxPayload,
      delivery,
    });

    expect(resolveStorePath).toHaveBeenCalledWith(cfg.session?.store, { agentId: "main" });
    expect(assembled).toMatchObject({
      cfg,
      channel: "test",
      accountId: "acct",
      agentId: "main",
      routeSessionKey: "agent:main:test:peer",
      storePath: "/state/main/sessions.json",
      ctxPayload,
      delivery,
    });
    expect(assembled.recordInboundSession).toBe(coreRecordInboundSession);
    expect(assembled.dispatchReplyWithBufferedBlockDispatcher).toBe(coreDispatch);
    expect(assembled).not.toHaveProperty("route");
  });

  it("normalizes modern resolved turns", () => {
    const runDispatch = vi.fn(async () => ({ queuedFinal: true }));
    const plan = {
      cfg,
      channel: "test",
      route: { agentId: "worker", sessionKey: "agent:worker:test:peer" },
      ctxPayload,
      runDispatch,
    };

    const assembled = assembleResolvedChannelTurn(plan);
    expect(assembled).toMatchObject({
      channel: "test",
      routeSessionKey: "agent:worker:test:peer",
      storePath: "/state/main/sessions.json",
      ctxPayload,
      runDispatch,
    });
    expect(assembled.recordInboundSession).toBe(coreRecordInboundSession);
  });
});
