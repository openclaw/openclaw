import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createProviderBrowserAuthSession,
  handleProviderOAuthCallback,
  PROVIDER_OAUTH_CALLBACK_PATH,
} from "../provider-browser-auth.js";
import {
  AUTH_TOKEN,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "../server-http.test-harness.js";
import type { GatewayWsBrowserOrigin } from "../server/ws-types.js";
import { prepareTailscalePublishedOrigin } from "../tailscale-published-origin.js";

let clearOrigin: () => void;
beforeEach(() => {
  resetGatewayWorkAdmission();
  clearOrigin = prepareTailscalePublishedOrigin({
    origin: "https://gateway.example",
    mode: "serve",
  });
});
afterEach(() => {
  clearOrigin();
  resetGatewayWorkAdmission();
});

const authorization = {
  state: "login-state",
  timeoutMs: 60_000,
  buildAuthorizationUrl: (redirectUrl: string) => {
    const callbackUrl = new URL(redirectUrl);
    callbackUrl.searchParams.set("state", "login-state");
    return `https://provider.example/authorize?callback_url=${encodeURIComponent(callbackUrl.href)}`;
  },
};

function startLogin(params: { timeoutMs?: number; browserOrigin?: GatewayWsBrowserOrigin } = {}) {
  const opened = createDeferredCore<string>();
  const session = createProviderBrowserAuthSession({
    browserOrigin: params.browserOrigin,
    openUrl: async (url) => opened.resolve(url),
  });
  expect(session.available).toBe(true);
  const result = session.authorize({
    ...authorization,
    timeoutMs: params.timeoutMs ?? authorization.timeoutMs,
  });
  return { session, result, opened: opened.promise };
}

function callback(query: string, method = "GET") {
  const response = createResponse();
  expect(
    handleProviderOAuthCallback(
      createRequest({ path: `${PROVIDER_OAUTH_CALLBACK_PATH}?${query}`, method }),
      response.res,
    ),
  ).toBe(true);
  return response;
}

describe("provider browser sign-in", () => {
  it.each([
    "https://gateway.example",
    "https://work.example:8447",
    "http://localhost:18789",
    "http://127.0.0.1:18789",
    "http://[::1]:18789",
  ])("receives one bound callback through the Gateway for %s", async (origin) => {
    if (origin === "https://work.example:8447") {
      clearOrigin();
    }
    const login = startLogin({
      browserOrigin: {
        origin,
        requestHost: new URL(origin).host,
        isLocalClient: origin.startsWith("http:"),
      },
    });
    const url = new URL(await login.opened);
    expect(new URL(url.searchParams.get("callback_url")!).origin).toBe(origin);
    const hooks = vi.fn(async () => false);
    await withGatewayServer({
      prefix: "provider-browser-login",
      resolvedAuth: AUTH_TOKEN,
      overrides: { handleHooksRequest: hooks },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: `${PROVIDER_OAUTH_CALLBACK_PATH}?state=login-state&code=secret-code`,
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toContain("Sign-in response received");
        expect(response.getBody()).not.toContain("secret-code");
        expect(response.getBody()).not.toContain("login-state");
        expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
        expect(response.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
        expect(hooks).not.toHaveBeenCalled();
      },
    });
    await expect(login.result).resolves.toEqual({ code: "secret-code", state: "login-state" });
    expect(callback("state=login-state&code=secret-code").res.statusCode).toBe(410);
    const retained = login.session.authorize;
    login.session.close();
    await expect(retained(authorization)).rejects.toThrow("closed");
  });

  it("does not consume a pending login for malformed or unrelated responses", async () => {
    const login = startLogin();
    await login.opened;
    for (const query of [
      "state=other&code=wrong",
      "state=login-state",
      "state=login-state&state=other&code=wrong",
      "state=login-state&code=one&code=two",
      "state=login-state&code=one&error=denied",
    ]) {
      expect(callback(query).res.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(callback("state=login-state&code=valid", "POST").res.statusCode).toBe(400);
    expect(callback("state=login-state&code=valid").res.statusCode).toBe(200);
    await expect(login.result).resolves.toEqual({ code: "valid", state: "login-state" });
    login.session.close();
  });

  it("settles a provider denial without exposing provider-controlled text", async () => {
    const login = startLogin();
    await login.opened;
    const rejected = expect(login.result).rejects.toThrow("declined");
    const response = callback(
      "state=login-state&error=denied&error_description=%3Cscript%3Esecret",
    );
    expect(response.res.statusCode).toBe(400);
    expect(response.getBody()).not.toContain("script");
    expect(response.getBody()).not.toContain("secret");
    await rejected;
    login.session.close();
  });

  it.each(["restart", "origin"])("rejects callback completion after %s", async (event) => {
    const login = startLogin();
    await login.opened;
    const rejected = expect(login.result).rejects.toThrow();
    if (event === "restart") {
      markGatewayRestartDraining();
    }
    if (event === "origin") {
      clearOrigin = prepareTailscalePublishedOrigin({
        origin: "https://gateway.example",
        mode: "serve",
      });
    }
    expect(callback("state=login-state&code=stale").res.statusCode).toBe(410);
    await rejected;
    login.session.close();
  });

  it("expires unanswered browser login without consuming a later callback", async () => {
    const login = startLogin({ timeoutMs: 20 });
    await expect(login.result).rejects.toThrow();
    expect(callback("state=login-state&code=late").res.statusCode).toBe(410);
    login.session.close();
  });

  it("rejects an expired callback even before the timeout task runs", async () => {
    const login = startLogin();
    await login.opened;
    const rejected = expect(login.result).rejects.toThrow("expired");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    try {
      expect(callback("state=login-state&code=late").res.statusCode).toBe(410);
      await rejected;
    } finally {
      clock.mockRestore();
      login.session.close();
    }
  });

  it.each([
    { origin: "http://localhost:3000", requestHost: "localhost:18789", isLocalClient: true },
    { origin: "http://localhost:18789", requestHost: "localhost:18789", isLocalClient: false },
    { origin: "https://other.example", requestHost: "gateway.example", isLocalClient: false },
    { origin: "https://work.example:8447", requestHost: "work.example:8448", isLocalClient: false },
    { origin: "https://work.example/path", requestHost: "work.example", isLocalClient: false },
    { origin: "http://192.168.1.2:18789", requestHost: "192.168.1.2:18789", isLocalClient: true },
    { origin: "file://localhost", requestHost: "localhost", isLocalClient: true },
  ])("rejects an unserved or unattested browser return ($origin)", async (browserOrigin) => {
    const openUrl = vi.fn();
    const session = createProviderBrowserAuthSession({ browserOrigin, openUrl });
    expect(session.available).toBe(false);
    await expect(session.authorize(authorization)).rejects.toThrow("secure Gateway address");
    expect(openUrl).not.toHaveBeenCalled();
    session.close();
  });

  it("does not advertise loopback or a guessed browser address", async () => {
    clearOrigin();
    const session = createProviderBrowserAuthSession({ openUrl: vi.fn() });
    await expect(session.authorize(authorization)).rejects.toThrow("secure Gateway address");
    session.close();
  });
});
