import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { resolveGatewayRequestContext } from "./http-utils.js";

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
});
