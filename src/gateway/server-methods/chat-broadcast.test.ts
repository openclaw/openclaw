import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChatRunState } from "../server-chat-state.js";
import {
  broadcastChatDelta,
  broadcastChatError,
  broadcastChatFinal,
  prepareChatTerminalMessage,
} from "./chat-broadcast.js";
import { fixedStoreOwnershipConfig } from "./sessions-fixed-store.test-support.js";
import type { GatewayRequestContext } from "./types.js";

function createContext(seq = 0, cfg: OpenClawConfig = { agents: { entries: { main: {} } } }) {
  return {
    agentRunSeq: new Map<string, number>([["run-1", seq]]),
    broadcast: vi.fn<GatewayRequestContext["broadcast"]>(),
    nodeSendToSession: vi.fn<GatewayRequestContext["nodeSendToSession"]>(),
    chatRunState: createChatRunState(),
    getRuntimeConfig: () => cfg,
  };
}

it.each([
  ["agent:main:main", "main", ["agent:main:main"], undefined],
  ["global", "work", ["agent:work:global"], undefined],
  [
    "global",
    "ops",
    ["agent:ops:global", "global"],
    fixedStoreOwnershipConfig("/stores/shared.sqlite"),
  ],
] as const)(
  "keeps pending snapshots scoped and retires them with %s",
  async (sessionKey, agentId, keys, config) => {
    const context = createContext(0, config);
    let current = true;
    const request = { context, runId: "run-1", sessionKey, agentId, isCurrent: () => current };

    broadcastChatDelta({ ...request, text: "x".repeat(500_001) });
    const first = context.broadcast.mock.calls[0];
    expect(first?.[1]).toMatchObject({
      state: "delta",
      deltaText: "x".repeat(500_000),
      replace: true,
      seq: 1,
    });
    expect(first?.[2]?.sessionKeys).toEqual(keys);
    expect(context.chatRunState.resolveBuffer("run-1").text).toHaveLength(500_000);

    broadcastChatDelta({ ...request, text: "first\n\nsecond" });
    const second = context.broadcast.mock.calls[1];
    const liveText = second?.[2]?.liveText;
    expect(liveText?.group).toBe(first?.[2]?.liveText?.group);
    expect(liveText?.coalesce?.merge(first?.[1], second?.[1])).toBe(second?.[1]);
    expect(context.chatRunState.resolveBuffer("run-1").text).toBe("first\n\nsecond");

    const preparedMessage = await prepareChatTerminalMessage({
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]] first\n\nsecond" }],
    });
    expect(context.broadcast).toHaveBeenCalledTimes(2);
    expect(context.agentRunSeq.get("run-1")).toBe(2);
    broadcastChatFinal({ terminalEntry: undefined, ...request, preparedMessage });
    const final = context.broadcast.mock.calls[2];
    expect(final?.[1]).toMatchObject({
      state: "final",
      seq: 3,
      sessionKey,
      message: { content: [{ type: "text", text: "[[reply_to_current]] first\n\nsecond" }] },
    });
    if (sessionKey === "global") {
      expect(final?.[1]).toHaveProperty("agentId", agentId);
    }
    expect(final?.[2]?.liveText).toEqual({ group: liveText?.group, settle: true });
    expect(context.nodeSendToSession.mock.calls).toHaveLength(3);
    expect(context.nodeSendToSession.mock.calls.at(-1)).toEqual([
      keys[0],
      "chat",
      final?.[1],
      final?.[2],
    ]);
    expect(context.agentRunSeq.has("run-1")).toBe(false);

    current = false;
    context.chatRunState.clearRun("run-1");
    expect([liveText?.group.aborted, liveText?.isCurrent?.()]).toEqual([true, false]);
    broadcastChatDelta({ ...request, text: "late instruction" });
    expect(context.broadcast).toHaveBeenCalledTimes(3);
  },
);

it("emits canonical error payloads without message or agentId", () => {
  const context = createContext(2);

  broadcastChatError({
    terminalEntry: undefined,
    context,
    runId: "run-1",
    sessionKey: "agent:main:main",
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
});
