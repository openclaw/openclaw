import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderAuthContext } from "../plugins/provider-authentication.types.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { getTailscalePublishedOrigin } from "./tailscale-published-origin.js";

export const PROVIDER_OAUTH_CALLBACK_PATH = "/oauth/provider/callback";
const CALLBACK_MAX_URL_BYTES = 8 * 1024;

type Authorization = NonNullable<ProviderAuthContext["oauth"]["authorize"]>;
type AuthorizationResult = Awaited<ReturnType<Authorization>>;
type PendingAuthorization = {
  accept: (result: AuthorizationResult) => void;
  reject: (error: Error) => void;
  isCurrent: () => boolean;
};

const pendingAuthorizations = resolveGlobalMap<string, PendingAuthorization>(
  Symbol.for("openclaw.providerBrowserAuthorizations"),
  (pending) => {
    for (const authorization of pending.values()) {
      authorization.reject(new Error("Browser sign-in ended because the Gateway restarted."));
    }
    pending.clear();
  },
);

export class ProviderBrowserSignInUnavailableError extends Error {
  constructor() {
    super(
      "Browser sign-in needs a secure Gateway address reachable from your browser. Enable Gateway Tailscale Serve, then retry /login; or use the CLI sign-in flow.",
    );
  }
}

export function createProviderBrowserAuthSession(params: {
  signal?: AbortSignal;
  openUrl: (url: string) => Promise<void>;
}) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([
    lifetime.signal,
    getGatewayRestartDrainSignal(),
    ...(params.signal ? [params.signal] : []),
  ]);
  let origin: ReturnType<typeof getTailscalePublishedOrigin>;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let expiresAt: number | undefined;
  let authorizationStarted = false;
  const originClosed = () =>
    lifetime.abort(
      new Error("Browser sign-in ended because the Gateway address changed. Retry /login."),
    );
  const assertCurrent = () => {
    signal.throwIfAborted();
    origin?.signal.throwIfAborted();
    if (expiresAt !== undefined && Date.now() >= expiresAt) {
      throw new Error("Browser sign-in expired. Retry /login.");
    }
  };
  const authorize: Authorization = async ({ state, timeoutMs, buildAuthorizationUrl }) => {
    assertCurrent();
    const published = getTailscalePublishedOrigin();
    if (!published) {
      throw new ProviderBrowserSignInUnavailableError();
    }
    if (authorizationStarted || !state || pendingAuthorizations.has(state)) {
      throw new Error("Browser sign-in requires a unique authorization state.");
    }
    authorizationStarted = true;
    origin = published;
    origin.signal.addEventListener("abort", originClosed, { once: true });
    deadline = setTimeout(
      () => lifetime.abort(new Error("Browser sign-in expired. Retry /login.")),
      timeoutMs,
    );
    deadline.unref();
    const callback = createDeferredCore<AuthorizationResult>();
    const callbackExpiresAt = Date.now() + timeoutMs;
    expiresAt = callbackExpiresAt;
    const requestSignal = signal;
    const onAbort = () => callback.reject(requestSignal.reason);
    const pending: PendingAuthorization = {
      accept: callback.resolve,
      reject: callback.reject,
      isCurrent: () =>
        !requestSignal.aborted && Date.now() < callbackExpiresAt && !published.signal.aborted,
    };
    pendingAuthorizations.set(state, pending);
    requestSignal.addEventListener("abort", onAbort, { once: true });
    try {
      const authorizationUrl = new URL(
        buildAuthorizationUrl(new URL(PROVIDER_OAUTH_CALLBACK_PATH, origin.origin).href),
      );
      if (
        authorizationUrl.protocol !== "https:" ||
        authorizationUrl.username ||
        authorizationUrl.password
      ) {
        throw new Error("Provider sign-in requires an HTTPS authorization URL.");
      }
      const [result] = await Promise.all([
        callback.promise,
        Promise.resolve().then(() => params.openUrl(authorizationUrl.href)),
      ]);
      assertCurrent();
      if (!pending.isCurrent()) {
        throw new Error("Browser sign-in expired. Retry /login.");
      }
      return result;
    } finally {
      requestSignal.removeEventListener("abort", onAbort);
      if (pendingAuthorizations.get(state) === pending) {
        pendingAuthorizations.delete(state);
      }
    }
  };
  return {
    authorize,
    signal,
    assertCurrent,
    close: () => {
      clearTimeout(deadline);
      origin?.signal.removeEventListener("abort", originClosed);
      lifetime.abort(new Error("Browser sign-in session closed."));
    },
  };
}

function respond(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Provider sign-in</title><body><main><h1>${message}</h1><p>Return to OpenClaw for the sign-in result.</p></main></body></html>`,
  );
}

export function handleProviderOAuthCallback(req: IncomingMessage, res: ServerResponse): boolean {
  const rawUrl = req.url ?? "/";
  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname !== PROVIDER_OAUTH_CALLBACK_PATH) {
    return false;
  }
  if (req.method !== "GET" || Buffer.byteLength(rawUrl) > CALLBACK_MAX_URL_BYTES) {
    respond(res, 400, "Invalid sign-in response.");
    return true;
  }
  const state = url.searchParams.get("state");
  const pending = state ? pendingAuthorizations.get(state) : undefined;
  if (!state || !pending || !pending.isCurrent()) {
    if (state && pending) {
      pendingAuthorizations.delete(state);
      pending.reject(new Error("Browser sign-in expired. Retry /login."));
    }
    respond(res, 410, "This sign-in link expired or was already used.");
    return true;
  }
  const code = url.searchParams.get("code");
  const denied = url.searchParams.has("error");
  if (
    url.searchParams.getAll("state").length !== 1 ||
    (denied ? Boolean(code) : !code || url.searchParams.getAll("code").length !== 1)
  ) {
    respond(res, 400, "Invalid sign-in response.");
    return true;
  }
  pendingAuthorizations.delete(state);
  if (denied) {
    pending.reject(new Error("Provider sign-in was declined. Retry /login when you are ready."));
    respond(res, 400, "Sign-in was not completed.");
  } else {
    pending.accept({ code: code!, state });
    respond(res, 200, "Sign-in response received.");
  }
  return true;
}
