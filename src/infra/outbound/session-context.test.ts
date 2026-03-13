import { describe, expect, it, vi } from "vitest";

const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: (...args: unknown[]) => resolveSessionAgentIdMock(...args),
}));

import { buildOutboundSessionContext } from "./session-context.js";

describe("buildOutboundSessionContext", () => {
  it("returns undefined when both session key and agent id are blank", () => {
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        sessionKey: "  ",
        agentId: null,
      }),
    ).toBeUndefined();
    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
  });

  it("derives the agent id from the trimmed session key when no explicit agent is given", () => {
    resolveSessionAgentIdMock.mockReturnValueOnce("derived-agent");

    expect(
      buildOutboundSessionContext({
        cfg: { agents: {} } as never,
        sessionKey: "  session:main:123  ",
      }),
    ).toEqual({
      key: "session:main:123",
      agentId: "derived-agent",
    });
    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "session:main:123",
      config: { agents: {} },
    });
  });

  it("prefers an explicit trimmed agent id over the derived one", () => {
    resolveSessionAgentIdMock.mockReturnValueOnce("derived-agent");

    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        sessionKey: "session:main:123",
        agentId: "  explicit-agent  ",
      }),
    ).toEqual({
      key: "session:main:123",
      agentId: "explicit-agent",
    });
  });
});
