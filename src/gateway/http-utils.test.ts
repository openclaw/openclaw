import { describe, expect, it } from "vitest";
import { IncomingMessage } from "node:http";
import {
  getBearerToken,
  getHeader,
  resolveAgentIdForRequest,
  resolveAgentIdFromHeader,
  resolveAgentIdFromModel,
  resolveGatewayRequestContext,
  resolveSessionKey,
} from "./http-utils.js";

describe("getHeader", () => {
  it("should return string header value", () => {
    const req = {
      headers: { "content-type": "application/json" },
    } as IncomingMessage;
    const result = getHeader(req, "Content-Type");
    expect(result).toBe("application/json");
  });

  it("should return first value from array header", () => {
    const req = {
      headers: { "accept": ["application/json", "text/html"] },
    } as IncomingMessage;
    const result = getHeader(req, "Accept");
    expect(result).toBe("application/json");
  });

  it("should return undefined for missing header", () => {
    const req = {
      headers: {},
    } as IncomingMessage;
    const result = getHeader(req, "X-Custom-Header");
    expect(result).toBeUndefined();
  });

  it("should handle case-insensitive header names", () => {
    const req = {
      headers: { "authorization": "Bearer token123" },
    } as IncomingMessage;
    const result = getHeader(req, "Authorization");
    expect(result).toBe("Bearer token123");
  });

  it("should return undefined for undefined header value", () => {
    const req = {
      headers: { "x-empty": undefined },
    } as IncomingMessage;
    const result = getHeader(req, "X-Empty");
    expect(result).toBeUndefined();
  });
});

describe("getBearerToken", () => {
  it("should extract token from Bearer authorization header", () => {
    const req = {
      headers: { "authorization": "Bearer token123" },
    } as IncomingMessage;
    const result = getBearerToken(req);
    expect(result).toBe("token123");
  });

  it("should handle lowercase bearer prefix", () => {
    const req = {
      headers: { "authorization": "bearer token456" },
    } as IncomingMessage;
    const result = getBearerToken(req);
    expect(result).toBe("token456");
  });

  it("should handle mixed case bearer prefix", () => {
    const req = {
      headers: { "authorization": "BeArEr token789" },
    } as IncomingMessage;
    const result = getBearerToken(req);
    expect(result).toBe("token789");
  });

  it("should trim whitespace around token", () => {
    const req = {
      headers: { "authorization": "Bearer   token123   " },
    } as IncomingMessage;
    const result = getBearerToken(req);
    expect(result).toBe("token123");
  });

  it("should return undefined for missing authorization header", () => {
    const req = {
      headers: {},
    } as IncomingMessage;
    const result = getBearerToken(req);
    expect(result).toBeUndefined();
  });

  it("should return undefined for non-Bearer authorization", () => {
    const req = {
      headers: { "authorization": "Basic dXNlcjpwYXNz" },
    } as IncomingMessage;
    const result = getBearerToken(req);
    expect(result).toBeUndefined();
  });

  it("should return undefined for empty token", () => {
    const req = {
      headers: { "authorization": "Bearer   " },
    } as IncomingMessage;
    const result = getBearerToken(req);
    expect(result).toBeUndefined();
  });

  it("should return undefined for Bearer without space", () => {
    const req = {
      headers: { "authorization": "Bearertoken123" },
    } as IncomingMessage;
    const result = getBearerToken(req);
    expect(result).toBeUndefined();
  });
});

describe("resolveAgentIdFromHeader", () => {
  it("should extract agent ID from x-openclaw-agent-id header", () => {
    const req = {
      headers: { "x-openclaw-agent-id": "my-agent" },
    } as IncomingMessage;
    const result = resolveAgentIdFromHeader(req);
    expect(result).toBe("my-agent");
  });

  it("should extract agent ID from x-openclaw-agent header", () => {
    const req = {
      headers: { "x-openclaw-agent": "another-agent" },
    } as IncomingMessage;
    const result = resolveAgentIdFromHeader(req);
    expect(result).toBe("another-agent");
  });

  it("should prefer x-openclaw-agent-id over x-openclaw-agent", () => {
    const req = {
      headers: {
        "x-openclaw-agent-id": "preferred-agent",
        "x-openclaw-agent": "fallback-agent",
      },
    } as IncomingMessage;
    const result = resolveAgentIdFromHeader(req);
    expect(result).toBe("preferred-agent");
  });

  it("should trim whitespace from agent ID", () => {
    const req = {
      headers: { "x-openclaw-agent-id": "  my-agent  " },
    } as IncomingMessage;
    const result = resolveAgentIdFromHeader(req);
    expect(result).toBe("my-agent");
  });

  it("should return undefined for missing headers", () => {
    const req = {
      headers: {},
    } as IncomingMessage;
    const result = resolveAgentIdFromHeader(req);
    expect(result).toBeUndefined();
  });

  it("should return undefined for empty header value", () => {
    const req = {
      headers: { "x-openclaw-agent-id": "" },
    } as IncomingMessage;
    const result = resolveAgentIdFromHeader(req);
    expect(result).toBeUndefined();
  });

  it("should return undefined for whitespace-only header value", () => {
    const req = {
      headers: { "x-openclaw-agent-id": "   " },
    } as IncomingMessage;
    const result = resolveAgentIdFromHeader(req);
    expect(result).toBeUndefined();
  });
});

describe("resolveAgentIdFromModel", () => {
  it("should extract agent ID from openclaw: prefix", () => {
    const result = resolveAgentIdFromModel("openclaw:my-agent");
    expect(result).toBe("my-agent");
  });

  it("should extract agent ID from openclaw/ prefix", () => {
    const result = resolveAgentIdFromModel("openclaw/my-agent");
    expect(result).toBe("my-agent");
  });

  it("should extract agent ID from agent: prefix", () => {
    const result = resolveAgentIdFromModel("agent:my-agent");
    expect(result).toBe("my-agent");
  });

  it("should handle uppercase prefixes", () => {
    const result = resolveAgentIdFromModel("OPENCLAW:my-agent");
    expect(result).toBe("my-agent");
  });

  it("should trim whitespace from model", () => {
    const result = resolveAgentIdFromModel("  openclaw:my-agent  ");
    expect(result).toBe("my-agent");
  });

  it("should return undefined for undefined model", () => {
    const result = resolveAgentIdFromModel(undefined);
    expect(result).toBeUndefined();
  });

  it("should return undefined for empty string", () => {
    const result = resolveAgentIdFromModel("");
    expect(result).toBeUndefined();
  });

  it("should return undefined for whitespace-only string", () => {
    const result = resolveAgentIdFromModel("   ");
    expect(result).toBeUndefined();
  });

  it("should return undefined for invalid format", () => {
    const result = resolveAgentIdFromModel("invalid-format");
    expect(result).toBeUndefined();
  });

  it("should return undefined for agent ID starting with invalid character", () => {
    const result = resolveAgentIdFromModel("openclaw:-invalid");
    expect(result).toBeUndefined();
  });

  it("should extract agent ID with valid characters", () => {
    const result = resolveAgentIdFromModel("openclaw:agent_123-test");
    expect(result).toBe("agent_123-test");
  });
});

describe("resolveAgentIdForRequest", () => {
  it("should return agent ID from header when available", () => {
    const req = {
      headers: { "x-openclaw-agent-id": "header-agent" },
    } as IncomingMessage;
    const result = resolveAgentIdForRequest({ req, model: "openclaw:model-agent" });
    expect(result).toBe("header-agent");
  });

  it("should return agent ID from model when header is not available", () => {
    const req = {
      headers: {},
    } as IncomingMessage;
    const result = resolveAgentIdForRequest({ req, model: "openclaw:model-agent" });
    expect(result).toBe("model-agent");
  });

  it("should return 'main' when neither header nor model provides agent ID", () => {
    const req = {
      headers: {},
    } as IncomingMessage;
    const result = resolveAgentIdForRequest({ req, model: undefined });
    expect(result).toBe("main");
  });

  it("should prefer header over model", () => {
    const req = {
      headers: { "x-openclaw-agent-id": "header-agent" },
    } as IncomingMessage;
    const result = resolveAgentIdForRequest({ req, model: "openclaw:model-agent" });
    expect(result).toBe("header-agent");
  });
});

describe("resolveSessionKey", () => {
  it("should use explicit session key from header when available", () => {
    const req = {
      headers: { "x-openclaw-session-key": "explicit-key" },
    } as IncomingMessage;
    const result = resolveSessionKey({
      req,
      agentId: "test-agent",
      prefix: "test",
    });
    expect(result).toBe("explicit-key");
  });

  it("should generate session key with user when provided", () => {
    const req = {
      headers: {},
    } as IncomingMessage;
    const result = resolveSessionKey({
      req,
      agentId: "test-agent",
      user: "john",
      prefix: "test",
    });
    expect(result).toMatch(/^test-agent:main:test-user:john$/);
  });

  it("should generate session key with UUID when no user", () => {
    const req = {
      headers: {},
    } as IncomingMessage;
    const result = resolveSessionKey({
      req,
      agentId: "test-agent",
      prefix: "test",
    });
    expect(result).toMatch(/^test-agent:main:test:[0-9a-f-]{36}$/);
  });

  it("should trim whitespace from explicit session key", () => {
    const req = {
      headers: { "x-openclaw-session-key": "  explicit-key  " },
    } as IncomingMessage;
    const result = resolveSessionKey({
      req,
      agentId: "test-agent",
      prefix: "test",
    });
    expect(result).toBe("explicit-key");
  });
});

describe("resolveGatewayRequestContext", () => {
  it("should resolve all context values correctly", () => {
    const req = {
      headers: { "x-openclaw-agent-id": "my-agent" },
    } as IncomingMessage;
    const result = resolveGatewayRequestContext({
      req,
      model: undefined,
      sessionPrefix: "test",
      defaultMessageChannel: "default-channel",
    });
    expect(result.agentId).toBe("my-agent");
    expect(result.sessionKey).toMatch(/^my-agent:main:test:/);
    expect(result.messageChannel).toBe("default-channel");
  });

  it("should use message channel from header when enabled", () => {
    const req = {
      headers: {
        "x-openclaw-agent-id": "my-agent",
        "x-openclaw-message-channel": "custom-channel",
      },
    } as IncomingMessage;
    const result = resolveGatewayRequestContext({
      req,
      model: undefined,
      sessionPrefix: "test",
      defaultMessageChannel: "default-channel",
      useMessageChannelHeader: true,
    });
    expect(result.messageChannel).toBe("custom-channel");
  });

  it("should use default message channel when header not enabled", () => {
    const req = {
      headers: {
        "x-openclaw-agent-id": "my-agent",
        "x-openclaw-message-channel": "custom-channel",
      },
    } as IncomingMessage;
    const result = resolveGatewayRequestContext({
      req,
      model: undefined,
      sessionPrefix: "test",
      defaultMessageChannel: "default-channel",
      useMessageChannelHeader: false,
    });
    expect(result.messageChannel).toBe("default-channel");
  });

  it("should normalize message channel from header", () => {
    const req = {
      headers: {
        "x-openclaw-agent-id": "my-agent",
        "x-openclaw-message-channel": "  Custom-Channel  ",
      },
    } as IncomingMessage;
    const result = resolveGatewayRequestContext({
      req,
      model: undefined,
      sessionPrefix: "test",
      defaultMessageChannel: "default-channel",
      useMessageChannelHeader: true,
    });
    expect(result.messageChannel).toBe("custom-channel");
  });

  it("should use user in session key when provided", () => {
    const req = {
      headers: { "x-openclaw-agent-id": "my-agent" },
    } as IncomingMessage;
    const result = resolveGatewayRequestContext({
      req,
      model: undefined,
      user: "alice",
      sessionPrefix: "test",
      defaultMessageChannel: "default-channel",
    });
    expect(result.sessionKey).toMatch(/^my-agent:main:test-user:alice$/);
  });
});
