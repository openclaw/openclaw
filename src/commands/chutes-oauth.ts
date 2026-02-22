import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import type { ChutesOAuthAppConfig } from "../agents/chutes-oauth.js";
import {
  CHUTES_AUTHORIZE_ENDPOINT,
  exchangeChutesCodeForTokens,
  generateChutesPkce,
  parseOAuthCallbackInput,
} from "../agents/chutes-oauth.js";
import { isLoopbackHost } from "../gateway/net.js";

type OAuthPrompt = {
  message: string;
  placeholder?: string;
};

function parseManualOAuthInput(
  input: string,
  expectedState: string,
): { code: string; state: string } {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    throw new Error("Missing OAuth redirect URL or authorization code.");
  }

  // Support pasting either:
  // - Full redirect URL (preferred; validates state)
  // - Raw authorization code (legacy/manual copy flows)
  const looksLikeRedirect =
    /^https?:\/\//i.test(trimmed) || trimmed.includes("://") || trimmed.includes("?");
  if (!looksLikeRedirect) {
    return { code: trimmed, state: expectedState };
  }

  const parsed = parseOAuthCallbackInput(trimmed, expectedState);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  if (parsed.state !== expectedState) {
    throw new Error("Invalid OAuth state");
  }
  return parsed;
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject }
}

function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
}): string {
  const qs = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: params.scopes.join(" "),
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
  });
  return `${CHUTES_AUTHORIZE_ENDPOINT}?${qs.toString()}`;
}

async function waitForLocalCallback(params: {
  redirectUri: string;
  expectedState: string;
  timeoutMs: number;
  onProgress?: (message: string) => void;
  onListening?: (address: { hostname: string; port: number }) => void;
}): Promise<{ code: string; state: string }> {
  const redirectUrl = new URL(params.redirectUri);
  if (redirectUrl.protocol !== "http:") {
    throw new Error(`Chutes OAuth redirect URI must be http:// (got ${params.redirectUri})`);
  }
  const hostname = redirectUrl.hostname || "127.0.0.1";
  if (!isLoopbackHost(hostname)) {
    throw new Error(
      `Chutes OAuth redirect hostname must be loopback (got ${hostname}). Use http://127.0.0.1:<port>/...`,
    );
  }
  const port = redirectUrl.port ? Number.parseInt(redirectUrl.port, 10) : 80;
  const expectedPath = redirectUrl.pathname || "/";

  return await new Promise<{ code: string; state: string }>((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", redirectUrl.origin);
        if (requestUrl.pathname !== expectedPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }

        const code = requestUrl.searchParams.get("code")?.trim();
        const state = requestUrl.searchParams.get("state")?.trim();

        if (!code) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Missing code");
          return;
        }
        if (!state || state !== params.expectedState) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Invalid state");
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          [
            "<!doctype html>",
            "<html><head><meta charset='utf-8' /></head>",
            "<body><h2>Chutes OAuth complete</h2>",
            "<p>You can close this window and return to OpenClaw.</p></body></html>",
          ].join(""),
        );
        if (timeout) {
          clearTimeout(timeout);
        }
        server.close();
        resolve({ code, state });
      } catch (err) {
        if (timeout) {
          clearTimeout(timeout);
        }
        server.close();
        reject(err);
      }
    });

    server.once("error", (err) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      server.close();
      reject(err);
    });
    server.listen(port, hostname, () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        params.onListening?.({ hostname: addr.address, port: addr.port });
      }
      params.onProgress?.(`Waiting for OAuth callback on ${redirectUrl.origin}${expectedPath}…`);
    });

    timeout = setTimeout(() => {
      try {
        server.close();
      } catch {}
      reject(new Error("OAuth callback timeout"));
    }, params.timeoutMs);
  });
}

export async function loginChutes(params: {
  app: ChutesOAuthAppConfig;
  manual?: boolean;
  timeoutMs?: number;
  createPkce?: typeof generateChutesPkce;
  createState?: () => string;
  onAuth: (event: { url: string }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onListening?: (address: { hostname: string; port: number }) => void;
  fetchFn?: typeof fetch;
}): Promise<OAuthCredentials> {
  const createPkce = params.createPkce ?? generateChutesPkce;
  const createState = params.createState ?? (() => randomBytes(16).toString("hex"));

  const { verifier, challenge } = createPkce();
  const state = createState();
  const timeoutMs = params.timeoutMs ?? 3 * 60 * 1000;

  const url = buildAuthorizeUrl({
    clientId: params.app.clientId,
    redirectUri: params.app.redirectUri,
    scopes: params.app.scopes,
    state,
    challenge,
  });

  let codeAndState: { code: string; state: string };
  if (params.manual) {
    await params.onAuth({ url });
    params.onProgress?.("Waiting for redirect URL…");
    const input = await params.onPrompt({
      message: "Paste the redirect URL (or authorization code)",
      placeholder: `${params.app.redirectUri}?code=...&state=...`,
    });
    codeAndState = parseManualOAuthInput(input, state);
  } else {
    const { promise: readyPromise, resolve: resolveReady } = createDeferred<void>();

    const callback = waitForLocalCallback({
      redirectUri: params.app.redirectUri,
      expectedState: state,
      timeoutMs,
      onProgress: params.onProgress,
      onListening: (address) => {
        params.onListening?.(address);
        resolveReady();
      },
    }).catch(async () => {
      resolveReady();
      params.onProgress?.("OAuth callback not detected; paste redirect URL…");
      const input = await params.onPrompt({
        message: "Paste the redirect URL (or authorization code)",
        placeholder: `${params.app.redirectUri}?code=...&state=...`,
      });
      return parseManualOAuthInput(input, state);
    });

    await readyPromise;
    await params.onAuth({ url });
    codeAndState = await callback;
  }

  params.onProgress?.("Exchanging code for tokens…");
  return await exchangeChutesCodeForTokens({
    app: params.app,
    code: codeAndState.code,
    codeVerifier: verifier,
    fetchFn: params.fetchFn,
  });
}
