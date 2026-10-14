// Covers outbound session context construction for canonical keys, policy keys,
// conversation type inference, requester metadata, and agent derivation.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn());

type SessionContextModule = typeof import("./session-context.js");

let buildOutboundSessionContext: SessionContextModule["buildOutboundSessionContext"];

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: (...args: unknown[]) => resolveSessionAgentIdMock(...args),
}));

beforeAll(async () => {
  ({ buildOutboundSessionContext } = await import("./session-context.js"));
});

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
        cfg: { agents: {} } as never,
        sessionKey: "cron:job-123:failure",
        agentId: "  explicit-agent  ",
      }),
    ).toEqual({
      key: "cron:job-123:failure",
      agentId: "explicit-agent",
    });
    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "cron:job-123:failure",
      config: { agents: {} },
      agentId: "explicit-agent",
    });
  });

  it("falls back to isGroup when no explicit conversation type is provided", () => {
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        sessionKey: "agent:main:generic",
        isGroup: true,
      }),
    ).toEqual({
      key: "agent:main:generic",
      conversationType: "group",
      conversationKind: "group",
    });
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        isGroup: false,
      }),
    ).toEqual({
      conversationType: "direct",
      conversationKind: "direct",
    });
  });

  it("never derives the audit conversation kind from session-key parsing", () => {
    // A policy key can name an acted-on session that is not the delivery
    // destination; conversationKind must stay unset without declared facts.
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
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
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        conversationType: "channel",
        isGroup: false,
      }),
    ).toEqual({
      conversationType: "group",
      conversationKind: "channel",
    });
  });
});
