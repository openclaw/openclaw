import { createRemoteJWKSet, jwtVerify } from "jose";

type JwtPayload = Record<string, unknown>;

export type MuxInboundJwtVerifyParams = {
  token: string;
  openclawId: string;
  baseUrl: string;
  nowMs?: number;
};

export type MuxInboundJwtVerifyResult =
  | {
      ok: true;
      payload: JwtPayload;
    }
  | {
      ok: false;
      error: string;
    };

const JWKS_FETCH_TIMEOUT_MS = 5_000;
const JWKS_COOLDOWN_MS = 5 * 60_000;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveJwksUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/.well-known/jwks.json`;
}

function hasScope(value: unknown, expected: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(expected);
}

function getJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksCache.get(jwksUrl);
  if (existing) {
    return existing;
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
  });
  jwksCache.set(jwksUrl, jwks);
  return jwks;
}

export function __resetMuxJwksCacheForTest() {
  jwksCache.clear();
}

export async function verifyMuxInboundJwt(
  params: MuxInboundJwtVerifyParams,
): Promise<MuxInboundJwtVerifyResult> {
  try {
    const jwksUrl = resolveJwksUrl(params.baseUrl);
    const { payload } = await jwtVerify(params.token, getJwks(jwksUrl), {
      audience: "openclaw-mux-inbound",
      subject: params.openclawId,
      clockTolerance: 60,
      currentDate: new Date(params.nowMs ?? Date.now()),
    });

    if (!hasScope((payload as JwtPayload).scope, "mux:inbound")) {
      return { ok: false, error: "jwt scope mismatch" };
    }

    return { ok: true, payload: payload as JwtPayload };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
