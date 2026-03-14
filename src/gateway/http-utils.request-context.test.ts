import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { InvalidGatewayAgentIdError, resolveGatewayRequestContext } from "./http-utils.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("resolveGatewayRequestContext", () => {
  it("uses normalized x-openclaw-message-channel when enabled", () => {
    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-message-channel": " Custom-Channel " }),
      model: "openclaw",
      sessionPrefix: "openai",
      defaultMessageChannel: "webchat",
      useMessageChannelHeader: true,
    });

    expect(result.messageChannel).toBe("custom-channel");
  });

  it("uses default messageChannel when header support is disabled", () => {
    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-message-channel": "custom-channel" }),
      model: "openclaw",
      sessionPrefix: "openresponses",
      defaultMessageChannel: "webchat",
      useMessageChannelHeader: false,
    });

    expect(result.messageChannel).toBe("webchat");
  });

  it("includes session prefix and user in generated session key", () => {
    const result = resolveGatewayRequestContext({
      req: createReq(),
      model: "openclaw",
      user: "alice",
      sessionPrefix: "openresponses",
      defaultMessageChannel: "webchat",
    });

    expect(result.sessionKey).toContain("openresponses-user:alice");
  });

  it("defaults to main when no explicit agent is selected", () => {
    const result = resolveGatewayRequestContext({
      req: createReq(),
      model: "openclaw",
      sessionPrefix: "openai",
      defaultMessageChannel: "webchat",
      knownAgentIds: ["alpha", "beta"],
    });

    expect(result.agentId).toBe("main");
    expect(result.sessionKey).toMatch(/^agent:main:/);
  });

  it("uses a known header-selected agent id", () => {
    const result = resolveGatewayRequestContext({
      req: createReq({ "x-openclaw-agent": " Beta " }),
      model: "openclaw",
      sessionPrefix: "openai",
      defaultMessageChannel: "webchat",
      knownAgentIds: ["alpha", "beta"],
    });

    expect(result.agentId).toBe("beta");
    expect(result.sessionKey).toMatch(/^agent:beta:/);
  });

  it("rejects unknown header-selected agent ids", () => {
    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-agent-id": "ghost" }),
        model: "openclaw",
        sessionPrefix: "openai",
        defaultMessageChannel: "webchat",
        knownAgentIds: ["alpha", "beta"],
      }),
    ).toThrowError(InvalidGatewayAgentIdError);
    expect(() =>
      resolveGatewayRequestContext({
        req: createReq({ "x-openclaw-agent-id": "ghost" }),
        model: "openclaw",
        sessionPrefix: "openai",
        defaultMessageChannel: "webchat",
        knownAgentIds: ["alpha", "beta"],
      }),
    ).toThrow(/Unknown agent id "ghost"/);
  });

  it("rejects unknown model-selected agent ids", () => {
    expect(() =>
      resolveGatewayRequestContext({
        req: createReq(),
        model: "agent:ghost",
        sessionPrefix: "openresponses",
        defaultMessageChannel: "webchat",
        knownAgentIds: ["alpha", "beta"],
      }),
    ).toThrowError(InvalidGatewayAgentIdError);
    expect(() =>
      resolveGatewayRequestContext({
        req: createReq(),
        model: "agent:ghost",
        sessionPrefix: "openresponses",
        defaultMessageChannel: "webchat",
        knownAgentIds: ["alpha", "beta"],
      }),
    ).toThrow(/Unknown agent id "ghost"/);
  });
});
