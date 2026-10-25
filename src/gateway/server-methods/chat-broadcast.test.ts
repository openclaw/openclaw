import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChatRunState } from "../server-chat-state.js";
import { broadcastChatDelta, broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import { fixedStoreOwnershipConfig } from "./sessions-fixed-store.test-support.js";
import type { GatewayRequestContext } from "./types.js";

function createContext(seq = 0, cfg: OpenClawConfig = { agents: { entries: { main: {} } } }) {
  const agentRunSeq = new Map<string, number>([["run-1", seq]]);
  const context = {
    agentRunSeq,
    broadcast: vi.fn<GatewayRequestContext["broadcast"]>(),
    nodeSendToSession: vi.fn<GatewayRequestContext["nodeSendToSession"]>(),
    chatRunState: createChatRunState(),
    getRuntimeConfig: () => cfg,
  };
  return {
    context,
    request: { context, runId: "run-1", sessionKey: "agent:main:main" },
    deleteSpy: vi.spyOn(agentRunSeq, "delete"),
  };
}

it.each([
  { sessionKey: "agent:main:main", agentId: "main", keys: ["agent:main:main"] },
  { sessionKey: "global", agentId: "work", keys: ["agent:work:global"] },
])(
  "keeps pending snapshots scoped and retires them with $sessionKey",
  ({ sessionKey, agentId, keys }) => {
    const { context, deleteSpy } = createContext();
    let current = true;
    const request = { context, runId: "run-1", sessionKey, agentId, isCurrent: () => current };

    broadcastChatDelta({ ...request, text: "first" });
    const first = context.broadcast.mock.calls[0];
    expect(first?.[1]).toMatchObject({
      state: "delta",
      deltaText: "first",
      replace: true,
      seq: 1,
    });
    expect(first?.[2]?.sessionKeys).toEqual(keys);
    expect(context.nodeSendToSession.mock.calls.map(([key]) => key)).toEqual(keys);
    expect(deleteSpy).not.toHaveBeenCalled();

    broadcastChatDelta({ ...request, text: "first\n\nsecond" });
    const second = context.broadcast.mock.calls[1];
    const liveText = second?.[2]?.liveText;
    expect(liveText?.group).toBe(first?.[2]?.liveText?.group);
    expect(liveText?.coalesce?.merge(first?.[1], second?.[1])).toBe(second?.[1]);
    expect(context.chatRunState.resolveBuffer("run-1").text).toBe("first\n\nsecond");

    broadcastChatFinal({
      terminalEntry: undefined,
      ...request,
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    const final = context.broadcast.mock.calls[2];
    expect(final?.[1]).toMatchObject({ state: "final", seq: 3 });
    expect(final?.[2]?.liveText).toEqual({ group: liveText?.group, settle: true });
    expect(context.nodeSendToSession.mock.calls.at(-1)?.[3]).toBe(final?.[2]);
    expect(deleteSpy).toHaveBeenCalledOnce();

    current = false;
    context.chatRunState.clearRun("run-1");
    expect([liveText?.group.aborted, liveText?.isCurrent?.()]).toEqual([true, false]);
    broadcastChatDelta({ ...request, text: "late instruction" });
    expect(context.broadcast).toHaveBeenCalledTimes(3);
  },
);

it("bounds live command text", () => {
  const { context, request } = createContext();
  broadcastChatDelta({ ...request, text: "x".repeat(500_001), isCurrent: () => true });
  expect(context.chatRunState.resolveBuffer("run-1").text).toHaveLength(500_000);
  expect(context.broadcast.mock.calls[0]?.[1]).toHaveProperty("deltaText.length", 500_000);
});

it("emits canonical error payloads without message or agentId", () => {
  const { context, request } = createContext(2);

  broadcastChatError({
    terminalEntry: undefined,
    ...request,
    agentId: "main",
    errorMessage: "provider unavailable",
  });

  const payload = context.broadcast.mock.calls[0]?.[1];
  expect(payload).toEqual({
    runId: "run-1",
    sessionKey: "agent:main:main",
    seq: 3,
    state: "error",
    errorMessage: "provider unavailable",
  });
  const opts = { sessionKeys: ["agent:main:main"] };
  expect(context.broadcast).toHaveBeenCalledWith("chat", payload, opts);
  expect(context.nodeSendToSession).toHaveBeenCalledWith("agent:main:main", "chat", payload, opts);
  expect(context.nodeSendToSession.mock.calls[0]?.[2]).toBe(payload);
});
it("keeps the bare global subscription for its persisted fixed-store owner", () => {
  const { context } = createContext(0, fixedStoreOwnershipConfig("/stores/shared.sqlite"));

  broadcastChatFinal({
    terminalEntry: undefined,
    context,
    runId: "run-ops-global",
    sessionKey: "global",
    agentId: "ops",
  });

  const { broadcast, nodeSendToSession } = context;
  const opts = { sessionKeys: ["agent:ops:global", "global"] };
  expect(broadcast).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({ agentId: "ops", sessionKey: "global" }),
    opts,
  );
  expect(nodeSendToSession.mock.calls).toEqual([
    ["agent:ops:global", "chat", broadcast.mock.calls[0]?.[1], opts],
  ]);
});
