import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./oauth-tls-preflight.js";

describe("runOpenAIOAuthTlsPreflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when OpenAI auth endpoint is reachable", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 400 }));
    const result = await runOpenAIOAuthTlsPreflight({ fetchImpl, timeoutMs: 20 });
    expect(result).toEqual({ ok: true });
  });

  it("classifies TLS trust failures from fetch cause code", async () => {
    const tlsFetchImpl = vi.fn(async () => {
      const cause = new Error("unable to get local issuer certificate") as Error & {
        code?: string;
      };
      cause.code = "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
      throw new TypeError("fetch failed", { cause });
    });
    const result = await runOpenAIOAuthTlsPreflight({ fetchImpl: tlsFetchImpl, timeoutMs: 20 });
    expect(result).toMatchObject({
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    });
  });
});

describe("formatOpenAIOAuthTlsPreflightFix", () => {
  it("includes remediation commands for TLS failures", () => {
    const text = formatOpenAIOAuthTlsPreflightFix({
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate",
    });
    expect(text).toContain("brew postinstall ca-certificates");
    expect(text).toContain("brew postinstall openssl@3");
  });
});
