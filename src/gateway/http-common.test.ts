import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { readJsonBodyOrError, setDefaultSecurityHeaders } from "./http-common.js";
import { makeMockHttpResponse } from "./test-http-response.js";

vi.mock("./hooks.js", () => ({
  readJsonBody: vi.fn().mockResolvedValue({ ok: true, value: {} }),
}));

describe("setDefaultSecurityHeaders", () => {
  it("sets X-Content-Type-Options", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
  });

  it("sets X-Frame-Options to DENY", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
  });

  it("sets Referrer-Policy", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
  });

  it("sets Permissions-Policy", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("sets Strict-Transport-Security when provided", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res, {
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    });
    expect(setHeader).toHaveBeenCalledWith(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("does not set Strict-Transport-Security when not provided", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).not.toHaveBeenCalledWith("Strict-Transport-Security", expect.anything());
  });

  it("does not set Strict-Transport-Security for empty string", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res, { strictTransportSecurity: "" });
    expect(setHeader).not.toHaveBeenCalledWith("Strict-Transport-Security", expect.anything());
  });
});

describe("readJsonBodyOrError", () => {
  function makeReq(contentType?: string): IncomingMessage {
    const headers: Record<string, string> = {};
    if (contentType !== undefined) {
      headers["content-type"] = contentType;
    }
    return { headers } as unknown as IncomingMessage;
  }

  it("rejects non-JSON Content-Type with 415", async () => {
    const { res, end } = makeMockHttpResponse();
    const result = await readJsonBodyOrError(makeReq("text/plain"), res, 1024);
    expect(result).toBeUndefined();
    expect(res.statusCode).toBe(415);
    expect(end).toHaveBeenCalled();
  });

  it("rejects application/x-www-form-urlencoded with 415", async () => {
    const { res } = makeMockHttpResponse();
    const result = await readJsonBodyOrError(
      makeReq("application/x-www-form-urlencoded"),
      res,
      1024,
    );
    expect(result).toBeUndefined();
    expect(res.statusCode).toBe(415);
  });

  it("accepts application/json", async () => {
    const { res } = makeMockHttpResponse();
    const result = await readJsonBodyOrError(makeReq("application/json"), res, 1024);
    expect(result).toEqual({});
  });

  it("accepts application/json with charset parameter", async () => {
    const { res } = makeMockHttpResponse();
    const result = await readJsonBodyOrError(makeReq("application/json; charset=utf-8"), res, 1024);
    expect(result).toEqual({});
  });

  it("accepts missing Content-Type for CLI/script compat", async () => {
    const { res } = makeMockHttpResponse();
    const result = await readJsonBodyOrError(makeReq(), res, 1024);
    expect(result).toEqual({});
  });
});
