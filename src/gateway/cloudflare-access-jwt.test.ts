import { generateKeyPairSync, sign } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeHttpGatewayConnect } from "./auth.js";

const warnAccess = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger(subsystem: string) {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/cloudflare-access" ? { ...logger, warn: warnAccess } : logger;
    },
  };
});

const teamKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "team-key";
const audience = "gateway-app";
const email = "operator@example.test";
const userHeader = "cf-access-authenticated-user-email";
const assertionHeader = "cf-access-jwt-assertion";
// Shape of a Cloudflare Access certs response recorded on 2026-11-16, with a test key.
const jwk = { ...teamKey.publicKey.export({ format: "jwk" }), kid };

function connect(issuer: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signed = `${encode({ alg: "RS256", kid })}.${encode({
    iss: issuer,
    aud: [audience],
    exp: Math.floor(Date.now() / 1000) + 300,
    email,
  })}`;
  const signature = sign("RSA-SHA256", Buffer.from(signed), teamKey.privateKey);
  const req = new IncomingMessage(new Socket());
  Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
  req.headers = {
    host: "gateway.example.test",
    "x-forwarded-for": "203.0.113.10",
    "x-forwarded-proto": "https",
    [userHeader]: email,
    [assertionHeader]: `${signed}.${signature.toString("base64url")}`,
  };
  return authorizeHttpGatewayConnect({
    auth: {
      mode: "trusted-proxy",
      allowTailscale: false,
      trustedProxy: {
        userHeader,
        requiredHeaders: [assertionHeader],
        allowLoopback: true,
        cloudflareAccessJwt: { issuer, audience },
      },
    },
    req,
    trustedProxies: ["127.0.0.1"],
  });
}

function stubRefresh(refresh: () => Response) {
  const fetchCerts = vi
    .fn(async () => refresh())
    .mockResolvedValueOnce(Response.json({ keys: [jwk] }));
  vi.stubGlobal("fetch", fetchCerts);
  return fetchCerts;
}

const unavailable = () => new Response(null, { status: 503 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  warnAccess.mockClear();
});

describe("Cloudflare Access signing-key cache", () => {
  it.each([
    ["unavailable", unavailable],
    ["empty", () => Response.json({ keys: [] })],
    ["missing-rsa-fields", () => Response.json({ keys: [{ kid, kty: "RSA" }] })],
    ["invalid-exponent", () => Response.json({ keys: [{ ...jwk, e: "AA" }] })],
    [
      "even-modulus",
      () => {
        const n = Buffer.concat([Buffer.from([128]), Buffer.alloc(255)]).toString("base64url");
        return Response.json({ keys: [{ ...jwk, n }] });
      },
    ],
    [
      "weak-rsa-key",
      () => {
        // RS256 requires at least 2048-bit keys (RFC 7518 §3.3).
        const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
        return Response.json({ keys: [{ ...weak.publicKey.export({ format: "jwk" }), kid }] });
      },
    ],
  ] as const)(
    "preserves last-good keys and backoff after a %s certs response",
    async (kind, refresh) => {
      const issuer = `https://${kind}.cloudflareaccess.com`;
      const fetchCerts = stubRefresh(refresh);
      const admitted = { ok: true, method: "trusted-proxy", user: email };
      await expect(connect(issuer)).resolves.toEqual(admitted);
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 });
      await expect(connect(issuer)).resolves.toEqual(admitted);
      await expect(connect(issuer)).resolves.toEqual(admitted);
      expect(fetchCerts).toHaveBeenCalledTimes(2);
    },
  );

  it("warns once after one hour and expires stale keys during refresh backoff", async () => {
    const issuer = "https://stale.cloudflareaccess.com";
    const fetchCerts = stubRefresh(unavailable);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    await expect(connect(issuer)).resolves.toMatchObject({ ok: true });
    vi.setSystemTime(start + 59 * 60_000);
    await expect(connect(issuer)).resolves.toMatchObject({ ok: true });
    expect(warnAccess).not.toHaveBeenCalled();
    vi.setSystemTime(start + 60 * 60_000);
    await expect(connect(issuer)).resolves.toMatchObject({ ok: true });
    expect.soft(warnAccess).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 24 * 60 * 60_000 - 1_000);
    await expect(connect(issuer)).resolves.toMatchObject({ ok: true });
    vi.setSystemTime(start + 24 * 60 * 60_000 + 1_000);
    await expect(connect(issuer)).resolves.toEqual({
      ok: false,
      reason: "trusted_proxy_access_keys_unavailable",
    });
    expect(fetchCerts).toHaveBeenCalledTimes(4);
    expect(warnAccess).toHaveBeenCalledTimes(1);
  });

  it("drops a withdrawn key after a successful refresh", async () => {
    const issuer = "https://withdrawn.cloudflareaccess.com";
    stubRefresh(() => Response.json({ keys: [{ ...jwk, kid: "replacement" }] }));
    await expect(connect(issuer)).resolves.toMatchObject({ ok: true });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 });
    await expect(connect(issuer)).resolves.toEqual({
      ok: false,
      reason: "trusted_proxy_access_invalid",
    });
  });
});
