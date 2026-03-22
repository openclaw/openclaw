import crypto from "node:crypto";
import {
  buildMctlConnectStatus,
  clearMctlConnectState,
  decodeJwtSubject,
  deleteMctlPendingConnect,
  readMctlCredentials,
  readMctlPendingConnect,
  writeMctlCredentials,
  writeMctlPendingConnect,
} from "../../mctl/oauth-store.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_MCTL_API_BASE = "https://api.mctl.ai";

function resolveMctlApiBase(): string {
  return process.env.MCTL_API_URL?.trim() || DEFAULT_MCTL_API_BASE;
}

function randomBase64Url(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function buildPkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function readRedirectUri(params: Record<string, unknown>): string | null {
  const redirectUri = typeof params.redirectUri === "string" ? params.redirectUri.trim() : "";
  if (!redirectUri) {
    return null;
  }
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function parseJsonResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`invalid JSON response (${res.status})`);
  }
}

export const mctlHandlers: GatewayRequestHandlers = {
  "mctl.connect.status": async ({ respond }) => {
    const apiBase = resolveMctlApiBase();
    const [credentials, pending] = await Promise.all([
      readMctlCredentials(),
      readMctlPendingConnect(),
    ]);
    respond(true, buildMctlConnectStatus({ apiBase, credentials, pending }), undefined);
  },
  "mctl.connect.start": async ({ params, respond }) => {
    const redirectUri = readRedirectUri(params);
    if (!redirectUri) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "redirectUri must be a valid http(s) URL"),
      );
      return;
    }
    const apiBase = resolveMctlApiBase();
    const registerRes = await fetch(`${apiBase}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "openclaw-control-ui",
        redirect_uris: [redirectUri],
      }),
    });
    const registerBody = (await parseJsonResponse(registerRes)) as {
      client_id?: unknown;
      error_description?: unknown;
      error?: unknown;
    };
    const clientId =
      typeof registerBody.client_id === "string" && registerBody.client_id.trim()
        ? registerBody.client_id.trim()
        : "";
    if (!registerRes.ok || !clientId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          typeof registerBody.error_description === "string"
            ? registerBody.error_description
            : typeof registerBody.error === "string"
              ? registerBody.error
              : `failed to register OAuth client (${registerRes.status})`,
        ),
      );
      return;
    }
    const state = randomBase64Url(24);
    const codeVerifier = randomBase64Url(32);
    const authorizeUrl = new URL(`${apiBase}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", buildPkceChallenge(codeVerifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    await writeMctlPendingConnect({
      version: 1,
      apiBase,
      clientId,
      redirectUri,
      state,
      codeVerifier,
      startedAt: new Date().toISOString(),
    });
    respond(
      true,
      {
        authorizeUrl: authorizeUrl.toString(),
        state,
      },
      undefined,
    );
  },
  "mctl.connect.complete": async ({ params, respond }) => {
    const code = typeof params.code === "string" ? params.code.trim() : "";
    const state = typeof params.state === "string" ? params.state.trim() : "";
    if (!code || !state) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "code and state are required"),
      );
      return;
    }
    const pending = await readMctlPendingConnect();
    if (!pending || pending.state !== state) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing or mismatched pending mctl OAuth state"),
      );
      return;
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: pending.codeVerifier,
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
    });
    const tokenRes = await fetch(`${pending.apiBase}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    const tokenBody = (await parseJsonResponse(tokenRes)) as {
      access_token?: unknown;
      refresh_token?: unknown;
      scope?: unknown;
      expires_in?: unknown;
      error_description?: unknown;
      error?: unknown;
    };
    const accessToken =
      typeof tokenBody.access_token === "string" ? tokenBody.access_token.trim() : "";
    const refreshToken =
      typeof tokenBody.refresh_token === "string" ? tokenBody.refresh_token.trim() : "";
    if (!tokenRes.ok || !accessToken || !refreshToken) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          typeof tokenBody.error_description === "string"
            ? tokenBody.error_description
            : typeof tokenBody.error === "string"
              ? tokenBody.error
              : `failed to exchange authorization code (${tokenRes.status})`,
        ),
      );
      return;
    }
    const expiresIn =
      typeof tokenBody.expires_in === "number" && Number.isFinite(tokenBody.expires_in)
        ? tokenBody.expires_in
        : null;
    const now = Date.now();
    await writeMctlCredentials({
      version: 1,
      apiBase: pending.apiBase,
      clientId: pending.clientId,
      accessToken,
      refreshToken,
      scope: typeof tokenBody.scope === "string" ? tokenBody.scope : "mctl",
      login: decodeJwtSubject(accessToken),
      connectedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: expiresIn ? new Date(now + expiresIn * 1000).toISOString() : null,
    });
    await deleteMctlPendingConnect();
    const credentials = await readMctlCredentials();
    respond(
      true,
      buildMctlConnectStatus({
        apiBase: pending.apiBase,
        credentials,
        pending: null,
      }),
      undefined,
    );
  },
  "mctl.connect.disconnect": async ({ respond }) => {
    const apiBase = resolveMctlApiBase();
    await clearMctlConnectState();
    respond(
      true,
      buildMctlConnectStatus({
        apiBase,
        credentials: null,
        pending: null,
      }),
      undefined,
    );
  },
};
