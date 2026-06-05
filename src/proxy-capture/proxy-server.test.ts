// Proxy capture server tests cover request recording and response handling.
import { describe, expect, it } from "vitest";
import { redactHeaders } from "./header-redaction.js";
import { parseConnectTarget } from "./proxy-server.js";

describe("parseConnectTarget", () => {
  it("parses bracketed IPv6 CONNECT targets safely", () => {
    expect(parseConnectTarget("[::1]:8443")).toEqual({
      hostname: "::1",
      port: 8443,
    });
  });

  it("parses unbracketed host:port CONNECT targets", () => {
    expect(parseConnectTarget("api.openai.com:443")).toEqual({
      hostname: "api.openai.com",
      port: 443,
    });
  });

  it("rejects invalid CONNECT ports", () => {
    expect(() => parseConnectTarget("[::1]:99999")).toThrow("Invalid CONNECT target port");
    expect(() => parseConnectTarget("api.openai.com:1e3")).toThrow("Invalid CONNECT target port");
    expect(() => parseConnectTarget("api.openai.com:0x50")).toThrow("Invalid CONNECT target port");
  });
});

describe("redactHeaders", () => {
  it("redacts all exact-match sensitive header names", () => {
    const headers: Record<string, string> = {
      authorization: "Bearer tok_abc123",
      "proxy-authorization": "Basic cHJveHk6cGFzcw==",
      cookie: "sid=session-value",
      "set-cookie": "sid=response-value",
      "x-api-key": "key-12345",
      "api-key": "key-67890",
      apikey: "key-abcde",
      "x-auth-token": "auth-tok-xyz",
      "auth-token": "auth-tok-abc",
      "x-access-token": "access-tok-xyz",
      "access-token": "access-tok-abc",
    };
    const result = redactHeaders(headers);
    for (const name of Object.keys(headers)) {
      expect(result[name]).toBe("[REDACTED]");
    }
  });

  it("preserves non-sensitive headers unchanged", () => {
    const headers = {
      "content-type": "application/json",
      accept: "text/html",
      "cache-control": "no-cache",
      "x-request-id": "req-123",
      host: "api.example.com",
    };
    const result = redactHeaders(headers);
    expect(result).toStrictEqual(headers);
  });

  it("redacts headers matching sensitive fragments", () => {
    const headers: Record<string, string> = {
      "x-custom-api-key": "my-api-key-value",
      "x-my-apikey-header": "my-apikey-value",
      "x-refresh-token": "refresh-tok-abc",
      "x-client-secret": "secret-value",
      "x-db-password": "db-pass-value",
      "x-aws-credential": "aws-cred-value",
      "x-session-id": "sess-id-value",
    };
    const result = redactHeaders(headers);
    for (const name of Object.keys(headers)) {
      expect(result[name]).toBe("[REDACTED]");
    }
  });

  it("matches header names case-insensitively", () => {
    const headers: Record<string, string> = {
      Authorization: "Bearer tok_case",
      COOKIE: "sid=UPPER",
      "X-API-KEY": "key-upper",
      "X-Api-Key": "key-mixed",
      "Set-Cookie": "sid=mixed-case",
      "Proxy-Authorization": "Basic mixed",
    };
    const result = redactHeaders(headers);
    for (const name of Object.keys(headers)) {
      expect(result[name]).toBe("[REDACTED]");
    }
  });

  it("handles empty headers object", () => {
    expect(redactHeaders({})).toStrictEqual({});
  });

  it("preserves undefined header values for non-sensitive headers", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "x-optional": undefined,
      "content-type": "text/plain",
    };
    const result = redactHeaders(headers);
    expect(result["x-optional"]).toBeUndefined();
    expect(result["content-type"]).toBe("text/plain");
  });

  it("redacts sensitive headers with array values", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "set-cookie": ["sid=val1", "token=val2"],
      "content-type": "text/html",
    };
    const result = redactHeaders(headers);
    expect(result["set-cookie"]).toBe("[REDACTED]");
    expect(result["content-type"]).toBe("text/html");
  });

  it("handles mixed sensitive and non-sensitive headers together", () => {
    const headers = {
      host: "api.openai.com",
      authorization: "Bearer sk-abc",
      "content-type": "application/json",
      cookie: "session=xyz",
      accept: "*/*",
      "x-custom-token": "custom-tok",
      "user-agent": "openclaw/1.0",
    };
    const result = redactHeaders(headers);
    expect(result).toStrictEqual({
      host: "api.openai.com",
      authorization: "[REDACTED]",
      "content-type": "application/json",
      cookie: "[REDACTED]",
      accept: "*/*",
      "x-custom-token": "[REDACTED]",
      "user-agent": "openclaw/1.0",
    });
  });

  it("handles header names with leading/trailing whitespace via trim", () => {
    const headers: Record<string, string | undefined> = {
      " authorization ": "Bearer trimmed",
      " content-type ": "application/json",
    };
    const result = redactHeaders(headers);
    expect(result[" authorization "]).toBe("[REDACTED]");
    expect(result[" content-type "]).toBe("application/json");
  });

  it("does not redact fragment-like values in non-matching header names", () => {
    const headers = {
      "x-request-id": "token-like-value-but-safe-header",
      "content-length": "42",
    };
    const result = redactHeaders(headers);
    expect(result["x-request-id"]).toBe("token-like-value-but-safe-header");
    expect(result["content-length"]).toBe("42");
  });
});
