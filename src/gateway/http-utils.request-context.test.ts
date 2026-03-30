import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  resolveGatewayRequestContext,
  resolveHttpSenderIsOwner,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";

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

describe("resolveTrustedHttpOperatorScopes", () => {
  it("drops self-asserted scopes for bearer-authenticated requests", () => {
    const scopes = resolveTrustedHttpOperatorScopes(
      createReq({
        authorization: "Bearer secret",
        "x-openclaw-scopes": "operator.admin, operator.write",
      }),
    );

    expect(scopes).toEqual([]);
  });

  it("keeps declared scopes for non-bearer HTTP requests", () => {
    const scopes = resolveTrustedHttpOperatorScopes(
      createReq({
        "x-openclaw-scopes": "operator.admin, operator.write",
      }),
    );

    expect(scopes).toEqual(["operator.admin", "operator.write"]);
  });
});

describe("resolveHttpSenderIsOwner", () => {
  it("requires operator.admin on a trusted HTTP scope-bearing request", () => {
    expect(resolveHttpSenderIsOwner(createReq({ "x-openclaw-scopes": "operator.admin" }))).toBe(
      true,
    );
    expect(resolveHttpSenderIsOwner(createReq({ "x-openclaw-scopes": "operator.write" }))).toBe(
      false,
    );
  });
});
