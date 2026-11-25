import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOutboundSessionContext } from "./session-context.js";

const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn());

const buildContext = (params: Omit<Parameters<typeof buildOutboundSessionContext>[0], "cfg">) =>
  buildOutboundSessionContext({ cfg: {}, ...params });

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: (...args: unknown[]) => resolveSessionAgentIdMock(...args),
}));

beforeEach(() => {
  resolveSessionAgentIdMock.mockReset();
});

describe("buildOutboundSessionContext", () => {
  it("passes explicit ownership when resolving an unscoped session key", () => {
    resolveSessionAgentIdMock.mockImplementationOnce(({ agentId }: { agentId?: string }) => {
      if (!agentId) {
        throw new Error("missing explicit agent ownership");
      }
      return agentId;
    });

    expect(
      buildOutboundSessionContext({
        cfg: { agents: {} },
        sessionKey: "cron:job-123:failure",
        agentId: "  explicit-agent  ",
      }),
    ).toEqual({ key: "cron:job-123:failure", agentId: "explicit-agent" });
    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "cron:job-123:failure",
      config: { agents: {} },
      agentId: "explicit-agent",
    });
  });

  it("falls back to isGroup when no explicit conversation type is provided", () => {
    expect(buildContext({ sessionKey: "agent:main:generic", isGroup: true })).toEqual({
      key: "agent:main:generic",
      conversationType: "group",
      conversationKind: "group",
    });
    expect(buildContext({ isGroup: false })).toEqual({
      conversationType: "direct",
      conversationKind: "direct",
    });
  });

  it("never derives the audit conversation kind from session-key parsing", () => {
    // A policy key can name an acted-on session that is not the delivery
    // destination; conversationKind must stay unset without declared facts.
    expect(
      buildContext({
        sessionKey: "agent:main:discord:dm:U123",
        policySessionKey: "agent:main:whatsapp:default:direct:+15551234567",
      }),
    ).toEqual({
      key: "agent:main:discord:dm:U123",
      policyKey: "agent:main:whatsapp:default:direct:+15551234567",
      conversationType: "direct",
    });
  });

  it("keeps an explicit conversation type authoritative over a direct fallback", () => {
    expect(buildContext({ conversationType: "channel", isGroup: false })).toEqual({
      conversationType: "group",
      conversationKind: "channel",
    });
  });
});
