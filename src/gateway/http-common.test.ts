import { describe, expect, it } from "vitest";
import { setDefaultSecurityHeaders } from "./http-common.js";
import { makeMockHttpResponse } from "./test-http-response.js";

describe("setDefaultSecurityHeaders", () => {
  it("sets X-Content-Type-Options", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
  });

  it("sets Referrer-Policy", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
  });

  it("sets Permissions-Policy", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith("Permissions-Policy", "camera=(), geolocation=()");
  });

  it("allows overriding Permissions-Policy", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res, {
      permissionsPolicy: "camera=(), microphone=(self), geolocation=()",
    });
    expect(setHeader).toHaveBeenCalledWith(
      "Permissions-Policy",
      "camera=(), microphone=(self), geolocation=()",
    );
  });

  it("does not set Permissions-Policy when explicitly disabled", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res, { permissionsPolicy: false });
    expect(setHeader).not.toHaveBeenCalledWith("Permissions-Policy", expect.anything());
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
