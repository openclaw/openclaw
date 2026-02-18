import crypto from "node:crypto";

export type CloudflareAccessUser = {
  email: string;
};

export type CloudflareAccessVerifier = {
  verify(token: string): Promise<CloudflareAccessUser | null>;
};

type JwksKey = {
  kty: string;
  kid: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  use?: string;
};

type JwksResponse = {
  keys: JwksKey[];
};

type JwtHeader = {
  alg: string;
  kid?: string;
  typ?: string;
};

type JwtPayload = {
  email?: string;
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  [key: string]: unknown;
};

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function base64UrlDecode(input: string): Buffer {
  // Replace URL-safe chars and add padding
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const paddedLength = padded.length + ((4 - (padded.length % 4)) % 4);
  return Buffer.from(padded.padEnd(paddedLength, "="), "base64");
}

function decodeJwtPart<T>(part: string): T {
  return JSON.parse(base64UrlDecode(part).toString("utf8")) as T;
}

function jwkToCryptoKeyAlgorithm(jwk: JwksKey): RsaHashedImportParams | EcKeyImportParams {
  if (jwk.kty === "RSA") {
    return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  }
  if (jwk.kty === "EC") {
    const namedCurve = jwk.crv ?? "P-256";
    return { name: "ECDSA", namedCurve };
  }
  throw new Error(`Unsupported JWK key type: ${jwk.kty}`);
}

function verifyAlgorithmForKey(jwk: JwksKey): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  if (jwk.kty === "RSA") {
    return { name: "RSASSA-PKCS1-v1_5" };
  }
  if (jwk.kty === "EC") {
    return { name: "ECDSA", hash: "SHA-256" };
  }
  throw new Error(`Unsupported JWK key type: ${jwk.kty}`);
}

async function importJwk(jwk: JwksKey): Promise<crypto.webcrypto.CryptoKey> {
  const algorithm = jwkToCryptoKeyAlgorithm(jwk);
  // Only pass the fields relevant for key import
  const keyData = {
    kty: jwk.kty,
    alg: jwk.alg,
    use: jwk.use,
    ...(jwk.kty === "RSA" ? { n: jwk.n, e: jwk.e } : {}),
    ...(jwk.kty === "EC" ? { crv: jwk.crv, x: jwk.x, y: jwk.y } : {}),
  };
  return await crypto.subtle.importKey("jwk", keyData, algorithm, false, ["verify"]);
}

/**
 * Create a Cloudflare Access JWT verifier.
 *
 * Fetches JWKS from `https://<teamDomain>.cloudflareaccess.com/cdn-cgi/access/certs`
 * and verifies JWTs using Node's built-in WebCrypto API.
 */
export function createCloudflareAccessVerifier(opts: {
  teamDomain: string;
  audience?: string;
  /** Override fetch for testing. */
  fetchFn?: typeof globalThis.fetch;
}): CloudflareAccessVerifier {
  const issuer = `https://${opts.teamDomain}.cloudflareaccess.com`;
  const jwksUrl = `${issuer}/cdn-cgi/access/certs`;
  const audience = opts.audience;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  let cachedKeys: Map<string, JwksKey> | null = null;
  let cachedAt = 0;

  async function fetchJwks(): Promise<Map<string, JwksKey>> {
    const now = Date.now();
    if (cachedKeys && now - cachedAt < JWKS_CACHE_TTL_MS) {
      return cachedKeys;
    }
    const res = await fetchFn(jwksUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch JWKS from ${jwksUrl}: ${res.status}`);
    }
    const body = (await res.json()) as JwksResponse;
    const keyMap = new Map<string, JwksKey>();
    for (const key of body.keys ?? []) {
      if (key.kid) {
        keyMap.set(key.kid, key);
      }
    }
    cachedKeys = keyMap;
    cachedAt = now;
    return keyMap;
  }

  async function verify(token: string): Promise<CloudflareAccessUser | null> {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return null;
      }

      const header = decodeJwtPart<JwtHeader>(parts[0]);
      const payload = decodeJwtPart<JwtPayload>(parts[1]);

      // Validate issuer
      if (payload.iss !== issuer) {
        return null;
      }

      // Validate expiry
      if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
        return null;
      }

      // Validate audience (if configured)
      if (audience) {
        const aud = payload.aud;
        const audMatch = Array.isArray(aud) ? aud.includes(audience) : aud === audience;
        if (!audMatch) {
          return null;
        }
      }

      // Find the signing key
      let keys = await fetchJwks();
      let jwk = header.kid ? keys.get(header.kid) : undefined;

      // If key not found, refresh JWKS (key rotation)
      if (!jwk && header.kid) {
        cachedKeys = null;
        keys = await fetchJwks();
        jwk = keys.get(header.kid);
      }
      if (!jwk) {
        return null;
      }

      // Verify signature using WebCrypto
      const cryptoKey = await importJwk(jwk);
      const signatureInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      const signature = new Uint8Array(base64UrlDecode(parts[2]));
      const algorithm = verifyAlgorithmForKey(jwk);

      const valid = await crypto.subtle.verify(algorithm, cryptoKey, signature, signatureInput);

      if (!valid) {
        return null;
      }

      const email = typeof payload.email === "string" ? payload.email : undefined;
      if (!email) {
        return null;
      }

      return { email };
    } catch {
      return null;
    }
  }

  return { verify };
}
