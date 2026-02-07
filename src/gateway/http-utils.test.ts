import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  getHeader,
  getBearerToken,
  resolveAgentIdFromHeader,
  resolveAgentIdFromModel,
  resolveAgentIdForRequest,
} from "./http-utils.js";

function mockReq(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("getHeader", () => {
  it("returns string header", () => {
    expect(getHeader(mockReq({ "content-type": "text/plain" }), "Content-Type")).toBe("text/plain");
  });

  it("returns first element of array header", () => {
    expect(getHeader(mockReq({ accept: ["text/html", "application/json"] }), "Accept")).toBe(
      "text/html",
    );
  });

  it("returns undefined for missing header", () => {
    expect(getHeader(mockReq({}), "X-Missing")).toBeUndefined();
  });
});

describe("getBearerToken", () => {
  it("extracts bearer token", () => {
    expect(getBearerToken(mockReq({ authorization: "Bearer abc123" }))).toBe("abc123");
  });

  it("is case-insensitive", () => {
    expect(getBearerToken(mockReq({ authorization: "bearer TOKEN" }))).toBe("TOKEN");
  });

  it("returns undefined for non-bearer auth", () => {
    expect(getBearerToken(mockReq({ authorization: "Basic abc" }))).toBeUndefined();
  });

  it("returns undefined for missing header", () => {
    expect(getBearerToken(mockReq({}))).toBeUndefined();
  });

  it("returns undefined for empty token", () => {
    expect(getBearerToken(mockReq({ authorization: "Bearer " }))).toBeUndefined();
  });
});

describe("resolveAgentIdFromHeader", () => {
  it("reads x-openclaw-agent-id", () => {
    expect(resolveAgentIdFromHeader(mockReq({ "x-openclaw-agent-id": "my-agent" }))).toBe(
      "my-agent",
    );
  });

  it("falls back to x-openclaw-agent", () => {
    expect(resolveAgentIdFromHeader(mockReq({ "x-openclaw-agent": "fallback" }))).toBe("fallback");
  });

  it("returns undefined for missing headers", () => {
    expect(resolveAgentIdFromHeader(mockReq({}))).toBeUndefined();
  });

  it("trims whitespace", () => {
    expect(resolveAgentIdFromHeader(mockReq({ "x-openclaw-agent-id": "  trimmed  " }))).toBe(
      "trimmed",
    );
  });
});

describe("resolveAgentIdFromModel", () => {
  it("extracts from openclaw/agentId", () => {
    expect(resolveAgentIdFromModel("openclaw/my-agent")).toBe("my-agent");
  });

  it("extracts from openclaw:agentId", () => {
    expect(resolveAgentIdFromModel("openclaw:my-agent")).toBe("my-agent");
  });

  it("extracts from agent:agentId", () => {
    expect(resolveAgentIdFromModel("agent:my-agent")).toBe("my-agent");
  });

  it("returns undefined for plain model names", () => {
    expect(resolveAgentIdFromModel("claude-3-opus")).toBeUndefined();
  });

  it("returns undefined for empty/undefined", () => {
    expect(resolveAgentIdFromModel(undefined)).toBeUndefined();
    expect(resolveAgentIdFromModel("")).toBeUndefined();
  });
});

describe("resolveAgentIdForRequest", () => {
  it("prefers header over model", () => {
    const req = mockReq({ "x-openclaw-agent-id": "from-header" });
    expect(resolveAgentIdForRequest({ req, model: "openclaw/from-model" })).toBe("from-header");
  });

  it("falls back to model", () => {
    const req = mockReq({});
    expect(resolveAgentIdForRequest({ req, model: "openclaw/from-model" })).toBe("from-model");
  });

  it("defaults to main", () => {
    const req = mockReq({});
    expect(resolveAgentIdForRequest({ req, model: "claude-3" })).toBe("main");
  });
});
