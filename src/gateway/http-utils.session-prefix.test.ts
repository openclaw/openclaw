import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { resolveProviderForAgent, resolveSessionKey } from "./http-utils.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("resolveSessionKey session prefix (#53158)", () => {
  it("accepts a provider name as prefix so session keys reflect the actual provider", () => {
    const result = resolveSessionKey({
      req: createReq(),
      agentId: "main",
      prefix: "anthropic",
    });

    expect(result).toMatch(/^agent:main:anthropic:/);
  });

  it("uses explicit session key from header regardless of prefix", () => {
    const result = resolveSessionKey({
      req: createReq({ "x-openclaw-session-key": "agent:main:custom:my-session" }),
      agentId: "main",
      prefix: "anthropic",
    });

    expect(result).toBe("agent:main:custom:my-session");
  });

  it("includes user in session key with provider prefix", () => {
    const result = resolveSessionKey({
      req: createReq(),
      agentId: "main",
      user: "alice",
      prefix: "anthropic",
    });

    expect(result).toContain("anthropic-user:alice");
    expect(result).not.toContain("openai");
  });

  it("different providers produce different prefixes", () => {
    const googleKey = resolveSessionKey({
      req: createReq(),
      agentId: "main",
      user: "alice",
      prefix: "google",
    });

    const openaiKey = resolveSessionKey({
      req: createReq(),
      agentId: "main",
      user: "alice",
      prefix: "openai",
    });

    expect(googleKey).toContain("google-user:alice");
    expect(openaiKey).toContain("openai-user:alice");
    expect(googleKey).not.toEqual(openaiKey);
  });

  it("openresponses endpoint uses its own prefix", () => {
    const result = resolveSessionKey({
      req: createReq(),
      agentId: "main",
      user: "bob",
      prefix: "openresponses",
    });

    expect(result).toContain("openresponses-user:bob");
  });

  it("resolveProviderForAgent resolves provider from config defaults", () => {
    const prefix = resolveProviderForAgent("main", "api");
    expect(prefix).toBe("anthropic");
  });
});
