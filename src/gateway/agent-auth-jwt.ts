import { createHmac, timingSafeEqual } from "node:crypto";

interface JwtHeader {
  alg: string;
  typ?: string;
}

export interface AgentJwtClaims {
  sub: string;
  workspace_id: string;
  agent_id: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  jti?: string;
}

const JWT_ALGORITHM = "HS256";

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function jwtConfig() {
  const secret = process.env.OPENCLAW_AGENT_JWT_SECRET;
  if (!secret) {
    return null;
  }

  return {
    secret,
    ttlSeconds: parseNumber(process.env.OPENCLAW_AGENT_JWT_TTL_SECONDS, 60 * 60 * 48),
    issuer: process.env.OPENCLAW_AGENT_JWT_ISSUER ?? "openclaw",
    audience: process.env.OPENCLAW_AGENT_JWT_AUDIENCE ?? "openclaw-gateway",
  };
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual requires same-length buffers; length check first is safe
  // because we only return false here (no secret-dependent branch timing leak).
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Returns true if OPENCLAW_AGENT_JWT_SECRET is configured. */
export function isAgentJwtConfigured(): boolean {
  return Boolean(process.env.OPENCLAW_AGENT_JWT_SECRET);
}

/**
 * Signs a JWT for an agent self-request (HS256, 48-hour TTL by default).
 * Returns null if OPENCLAW_AGENT_JWT_SECRET is not set.
 */
export function signAgentJwt(claims: {
  sub: string;
  agentId: string;
  workspaceId: string;
}): string | null {
  const config = jwtConfig();
  if (!config) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const payload: AgentJwtClaims = {
    sub: claims.sub,
    workspace_id: claims.workspaceId,
    agent_id: claims.agentId,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
  };

  const header: JwtHeader = { alg: JWT_ALGORITHM, typ: "JWT" };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = signPayload(config.secret, signingInput);

  return `${signingInput}.${signature}`;
}

/**
 * Verifies an agent JWT: checks HS256 signature, expiry, issuer, and audience.
 * Returns the decoded claims on success, or null on any failure.
 */
export function verifyAgentJwt(token: string): AgentJwtClaims | null {
  if (!token) {
    return null;
  }
  const config = jwtConfig();
  if (!config) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) {
    return null;
  }

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(config.secret, signingInput);
  if (!safeCompare(signature, expectedSig)) {
    return null;
  }

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) {
    return null;
  }

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const workspaceId = typeof claims.workspace_id === "string" ? claims.workspace_id : null;
  const agentId = typeof claims.agent_id === "string" ? claims.agent_id : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !workspaceId || !agentId || !iat || !exp) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) {
    return null;
  }

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (issuer && issuer !== config.issuer) {
    return null;
  }
  if (audience && audience !== config.audience) {
    return null;
  }

  return {
    sub,
    workspace_id: workspaceId,
    agent_id: agentId,
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}
