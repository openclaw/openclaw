import { describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { broadcastChatFinal } from "./chat-broadcast.js";

function createContext(config: OpenClawConfig) {
  return {
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map<string, number>(),
    getRuntimeConfig: () => config,
  };
}

describe("global chat broadcast compatibility aliases", () => {
  it("keeps the bare global alias for a retained legacy owner", () => {
    const config = retainLegacyDefaultAgentId(
      {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      },
      "ops",
    );
    const context = createContext(config);

    broadcastChatFinal({
      context,
      runId: "run-retained",
      sessionKey: "global",
      agentId: "ops",
    });

    expect(context.broadcast).toHaveBeenCalledWith("chat", expect.anything(), {
      sessionKeys: ["agent:ops:global", "global"],
    });
    expect(context.nodeSendToSession.mock.calls.map(([sessionKey]) => sessionKey)).toEqual([
      "agent:ops:global",
      "global",
    ]);
  });

  it("does not invent a bare global owner for a fresh explicit fleet", () => {
    const context = createContext({
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    });

    broadcastChatFinal({
      context,
      runId: "run-explicit",
      sessionKey: "global",
      agentId: "ops",
    });

    expect(context.broadcast).toHaveBeenCalledWith("chat", expect.anything(), {
      sessionKeys: ["agent:ops:global"],
    });
    expect(context.nodeSendToSession).toHaveBeenCalledOnce();
    expect(context.nodeSendToSession).toHaveBeenCalledWith(
      "agent:ops:global",
      "chat",
      expect.anything(),
    );
  });

  it("matches a retained owner canonically when emitting the bare alias", () => {
    const config = retainLegacyDefaultAgentId(
      { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } },
      "ops",
    );
    const context = createContext(config);

    broadcastChatFinal({
      context,
      runId: "run-normalized",
      sessionKey: "global",
      agentId: "OPS",
    });

    expect(context.broadcast).toHaveBeenCalledWith("chat", expect.anything(), {
      sessionKeys: ["agent:ops:global", "global"],
    });
  });

  it("falls back to the current sole owner when the retained owner departed", () => {
    const config = retainLegacyDefaultAgentId({ agents: { entries: { research: {} } } }, "ops");
    const context = createContext(config);

    broadcastChatFinal({
      context,
      runId: "run-renamed",
      sessionKey: "global",
    });

    expect(context.broadcast).toHaveBeenCalledWith("chat", expect.anything(), {
      sessionKeys: ["agent:research:global", "global"],
    });
  });
});
