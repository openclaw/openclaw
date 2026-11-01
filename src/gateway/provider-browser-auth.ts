import type { IncomingMessage, ServerResponse } from "node:http";
import { OAUTH_PAGE_CSP } from "../infra/oauth-page-csp.js";
import type { ProviderAuthContext } from "../plugins/provider-authentication.types.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { renderOAuthPage } from "../shared/oauth-page.js";
import { isLoopbackHost } from "./net.js";
import { isGatewayHostBrowserOrigin } from "./origin-check.js";
import type { GatewayWsBrowserOrigin } from "./server/ws-types.js";
import { getTailscalePublishedOrigin } from "./tailscale-published-origin.js";

export const PROVIDER_OAUTH_CALLBACK_PATH = "/oauth/provider/callback";
const CALLBACK_MAX_URL_BYTES = 8 * 1024;

type Authorization = NonNullable<ProviderAuthContext["oauth"]["authorize"]>;
type AuthorizationResult = Awaited<ReturnType<Authorization>>;
type PendingAuthorization = {
  accept: (result: AuthorizationResult) => void;
  reject: (error: Error) => void;
  isCurrent: () => boolean;
  browserBinding?: { cookieName: string; cookieValue: string };
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
      "Browser sign-in needs a secure Gateway address reachable from your browser. Open the dashboard on this Gateway's HTTPS address or its local loopback address, then retry; or use the CLI sign-in flow.",
    );
  }
}

export class ProviderBrowserSignInError extends Error {
  constructor(readonly reason: "declined" | "expired") {
    super(
      reason === "expired"
        ? "Browser sign-in expired. Retry /login."
        : "Provider sign-in was declined. Retry /login when you are ready.",
    );
    this.name = "ProviderBrowserSignInError";
  }
}

export function resolveBrowserAuthOrigin(
  browser: GatewayWsBrowserOrigin | undefined,
  signal: AbortSignal = getGatewayRestartDrainSignal(),
) {
  const published = getTailscalePublishedOrigin();
  if (!browser || browser.origin === published?.origin) {
    return published;
  }
  if (browser.origin && isGatewayHostBrowserOrigin(browser)) {
    const url = new URL(browser.origin);
    // The authenticated browser connection already passed Gateway origin policy.
    // Its served HTTPS origin also covers operator-managed reverse proxies.
    if (
      url.protocol === "https:" ||
      (url.protocol === "http:" && browser.isLocalClient && isLoopbackHost(url.hostname))
    ) {
      return { origin: url.origin, signal };
    }
  }
  return undefined;
}

export function createProviderBrowserAuthSession(params: {
  signal?: AbortSignal;
  openUrl: (url: string) => Promise<void>;
  browserOrigin?: GatewayWsBrowserOrigin;
  /** Bind account-link callbacks to the browser that initiated them. */
  browserBinding?: { cookieName: string; cookieValue: string };
}) {
  const lifetime = new AbortController();
  const browserOriginSignal = params.browserOrigin
    ? resolveBrowserAuthOrigin(params.browserOrigin, lifetime.signal)?.signal
    : undefined;
  const signal = AbortSignal.any([
    lifetime.signal,
    getGatewayRestartDrainSignal(),
    ...(params.signal ? [params.signal] : []),
    ...(browserOriginSignal ? [browserOriginSignal] : []),
  ]);
  let origin: ReturnType<typeof resolveBrowserAuthOrigin>;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let expiresAt: number | undefined;
  const originClosed = () =>
    lifetime.abort(
      new Error("Browser sign-in ended because the Gateway address changed. Retry /login."),
    );
  const assertCurrent = () => {
    signal.throwIfAborted();
    origin?.signal.throwIfAborted();
    if (expiresAt !== undefined && Date.now() >= expiresAt) {
      throw new ProviderBrowserSignInError("expired");
    }
  };
  const authorizePrepared = async <Result = never>({
    timeoutMs,
    prepare,
  }: {
    timeoutMs: number;
    prepare: (
      redirectUrl: string,
    ) =>
      | { state: string; authorizationUrl: string }
      | { result: Result }
      | Promise<{ state: string; authorizationUrl: string } | { result: Result }>;
  }): Promise<AuthorizationResult | Result> => {
    assertCurrent();
    const published = resolveBrowserAuthOrigin(params.browserOrigin, lifetime.signal);
    if (!published) {
      throw new ProviderBrowserSignInUnavailableError();
    }
    if (origin) {
      throw new Error("Browser sign-in requires a unique authorization state.");
    }
    origin = published;
    origin.signal.addEventListener("abort", originClosed, { once: true });
    deadline = setTimeout(
      () => lifetime.abort(new ProviderBrowserSignInError("expired")),
      timeoutMs,
    );
    deadline.unref();
    expiresAt = Date.now() + timeoutMs;
    const prepared = await prepare(new URL(PROVIDER_OAUTH_CALLBACK_PATH, published.origin).href);
    assertCurrent();
    if ("result" in prepared) {
      return prepared.result;
    }
    const { state } = prepared;
    if (!state || pendingAuthorizations.has(state)) {
      throw new Error("Browser sign-in requires a unique authorization state.");
    }
    const callback = createDeferredCore<AuthorizationResult>();
    const callbackExpiresAt = expiresAt;
    const requestSignal = signal;
    const onAbort = () => callback.reject(requestSignal.reason);
    const pending: PendingAuthorization = {
      browserBinding: params.browserBinding,
      accept: callback.resolve,
      reject: callback.reject,
      isCurrent: () =>
        !requestSignal.aborted && Date.now() < callbackExpiresAt && !published.signal.aborted,
    };
    pendingAuthorizations.set(state, pending);
    requestSignal.addEventListener("abort", onAbort, { once: true });
    try {
      const authorizationUrl = new URL(prepared.authorizationUrl);
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
        throw new ProviderBrowserSignInError("expired");
      }
      return result;
    } finally {
      requestSignal.removeEventListener("abort", onAbort);
      if (pendingAuthorizations.get(state) === pending) {
        pendingAuthorizations.delete(state);
      }
    }
  };
  const authorize: Authorization = ({ state, timeoutMs, buildAuthorizationUrl }) =>
    authorizePrepared({
      timeoutMs,
      prepare: (redirectUrl) => ({ state, authorizationUrl: buildAuthorizationUrl(redirectUrl) }),
    });
  return {
    get available() {
      return Boolean(resolveBrowserAuthOrigin(params.browserOrigin, lifetime.signal));
    },
    authorize,
    authorizePrepared,
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
  res.setHeader("Content-Security-Policy", OAUTH_PAGE_CSP);
  res.end(
    renderOAuthPage({
      title: "Provider sign-in",
      heading: message,
      message: "Return to OpenClaw for the sign-in result.",
    }),
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
      pending.reject(new ProviderBrowserSignInError("expired"));
    }
    respond(res, 410, "This sign-in link expired or was already used.");
    return true;
  }
  if (pending.browserBinding) {
    const { cookieName, cookieValue } = pending.browserBinding;
    const values = (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(cookieName + "="));
    if (values.length !== 1 || values[0] !== cookieName + "=" + cookieValue) {
      respond(res, 403, "Return to the browser that started account linking.");
      return true;
    }
  }
  const code = url.searchParams.get("code");
  const denied = url.searchParams.has("error");
  if (
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("iss").length > 1 ||
    (denied ? Boolean(code) : !code?.trim() || url.searchParams.getAll("code").length !== 1)
  ) {
    respond(res, 400, "Invalid sign-in response.");
    return true;
  }
  if (pending.browserBinding) {
    res.setHeader(
      "Set-Cookie",
      pending.browserBinding.cookieName + "=; Path=/; Max-Age=0; SameSite=Lax",
    );
  }
  pendingAuthorizations.delete(state);
  if (denied) {
    pending.reject(new ProviderBrowserSignInError("declined"));
    respond(res, 400, "Sign-in was not completed.");
  } else {
    const iss = url.searchParams.get("iss");
    pending.accept({ code: code!, state, ...(iss === null ? {} : { iss }) });
    respond(res, 200, "Sign-in response received.");
  }
  return true;
}
