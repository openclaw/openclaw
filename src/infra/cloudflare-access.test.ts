import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCloudflareAccessVerifier } from "./cloudflare-access.js";

// Generate a test RSA keypair for signing JWTs
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Export as JWK for the mock JWKS endpoint
const publicJwk = crypto.createPublicKey(publicKey).export({ format: "jwk" }) as {
  kty: string;
  n: string;
  e: string;
};

const TEST_KID = "test-key-1";
const TEST_TEAM_DOMAIN = "myteam";
const TEST_ISSUER = `https://${TEST_TEAM_DOMAIN}.cloudflareaccess.com`;
const TEST_AUDIENCE = "test-aud-tag";

function base64UrlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createTestJwt(opts: {
  email?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  kid?: string;
}): Promise<string> {
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: opts.kid ?? TEST_KID,
  };

  const payload = {
    email: opts.email ?? "user@example.com",
    sub: "user-123",
    iss: opts.iss ?? TEST_ISSUER,
    aud: opts.aud ?? TEST_AUDIENCE,
    exp: opts.exp ?? Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(privateKey);

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function createMockFetch(): typeof globalThis.fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/cdn-cgi/access/certs")) {
      return new Response(
        JSON.stringify({
          keys: [
            {
              kty: publicJwk.kty,
              kid: TEST_KID,
              alg: "RS256",
              use: "sig",
              n: publicJwk.n,
              e: publicJwk.e,
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("cloudflare-access verifier", () => {
  it("verifies a valid JWT and returns user email", async () => {
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEST_TEAM_DOMAIN,
      audience: TEST_AUDIENCE,
      fetchFn: createMockFetch(),
    });

    const token = await createTestJwt({});
    const result = await verifier.verify(token);

    expect(result).not.toBeNull();
    expect(result!.email).toBe("user@example.com");
  });

  it("rejects expired JWT", async () => {
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEST_TEAM_DOMAIN,
      audience: TEST_AUDIENCE,
      fetchFn: createMockFetch(),
    });

    const token = await createTestJwt({
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const result = await verifier.verify(token);

    expect(result).toBeNull();
  });

  it("rejects JWT with wrong issuer", async () => {
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEST_TEAM_DOMAIN,
      audience: TEST_AUDIENCE,
      fetchFn: createMockFetch(),
    });

    const token = await createTestJwt({
      iss: "https://evil.cloudflareaccess.com",
    });
    const result = await verifier.verify(token);

    expect(result).toBeNull();
  });

  it("rejects JWT with wrong audience when audience is configured", async () => {
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEST_TEAM_DOMAIN,
      audience: TEST_AUDIENCE,
      fetchFn: createMockFetch(),
    });

    const token = await createTestJwt({
      aud: "wrong-audience",
    });
    const result = await verifier.verify(token);

    expect(result).toBeNull();
  });

  it("accepts any audience when audience is not configured", async () => {
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEST_TEAM_DOMAIN,
      fetchFn: createMockFetch(),
    });

    const token = await createTestJwt({
      aud: "any-audience",
    });
    const result = await verifier.verify(token);

    expect(result).not.toBeNull();
    expect(result!.email).toBe("user@example.com");
  });

  it("rejects malformed token", async () => {
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEST_TEAM_DOMAIN,
      fetchFn: createMockFetch(),
    });

    const result = await verifier.verify("not.a.valid.jwt");
    expect(result).toBeNull();
  });

  it("rejects token with unknown kid", async () => {
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEST_TEAM_DOMAIN,
      fetchFn: createMockFetch(),
    });

    const token = await createTestJwt({ kid: "unknown-key-id" });
    const result = await verifier.verify(token);

    expect(result).toBeNull();
  });

  it("rejects JWT with tampered signature", async () => {
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEST_TEAM_DOMAIN,
      audience: TEST_AUDIENCE,
      fetchFn: createMockFetch(),
    });

    const token = await createTestJwt({});
    // Tamper with the signature
    const parts = token.split(".");
    parts[2] = base64UrlEncode(crypto.randomBytes(256));
    const tampered = parts.join(".");

    const result = await verifier.verify(tampered);
    expect(result).toBeNull();
  });

  it("rejects JWT with no email claim", async () => {
    const verifier = createCloudflareAccessVerifier({
      teamDomain: TEST_TEAM_DOMAIN,
      fetchFn: createMockFetch(),
    });

    // Create a token with no email
    const header = {
      alg: "RS256",
      typ: "JWT",
      kid: TEST_KID,
    };
    const payload = {
      sub: "service-token",
      iss: TEST_ISSUER,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };
    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(signingInput);
    const signature = sign.sign(privateKey);
    const token = `${signingInput}.${base64UrlEncode(signature)}`;

    const result = await verifier.verify(token);
    expect(result).toBeNull();
  });
});
