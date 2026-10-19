import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { createRequest, createResponse } from "../server-http.test-harness.js";
import type { GatewayWsBrowserOrigin } from "../server/ws-types.js";
import { prepareTailscalePublishedOrigin } from "../tailscale-published-origin.js";

let clearOrigin: () => void;
const sessions = new Set<ReturnType<typeof createProviderBrowserAuthSession>>();
beforeEach(() => {
  resetGatewayWorkAdmission();
  clearOrigin = prepareTailscalePublishedOrigin({
    origin: "https://gateway.example",
    mode: "serve",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const session of sessions) {
    session.close();
  }
  sessions.clear();
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

function createSession(params: Parameters<typeof createProviderBrowserAuthSession>[0]) {
  const session = createProviderBrowserAuthSession(params);
  sessions.add(session);
  return session;
}

async function startLogin(
  params: { timeoutMs?: number; browserOrigin?: GatewayWsBrowserOrigin } = {},
) {
  const opened = createDeferredCore<string>();
  const session = createSession({
    browserOrigin: params.browserOrigin,
    openUrl: async (url) => opened.resolve(url),
  });
  expect(session.available).toBe(true);
  const result = session.authorize({
    ...authorization,
    timeoutMs: params.timeoutMs ?? authorization.timeoutMs,
  });
  return { session, result, opened: await opened.promise };
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

it.each([
  "https://gateway.example",
  "https://work.example:8447",
  "http://localhost:18789",
  "http://127.0.0.1:18789",
  "http://[::1]:18789",
])("receives one bound callback for %s", async (origin) => {
  if (origin === "https://work.example:8447") {
    clearOrigin();
  }
  const login = await startLogin({
    browserOrigin: {
      origin,
      requestHost: new URL(origin).host,
      isLocalClient: origin.startsWith("http:"),
    },
  });
  const url = new URL(login.opened);
  expect(new URL(url.searchParams.get("callback_url")!).origin).toBe(origin);
  const response = callback("state=login-state&code=secret-code");
  expect(response.res.statusCode).toBe(200);
  expect(response.getBody()).toContain("Sign-in response received");
  expect(response.getBody()).not.toMatch(/secret-code|login-state/);
  expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  expect(response.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
  await expect(login.result).resolves.toEqual({ code: "secret-code", state: "login-state" });
  expect(callback("state=login-state&code=secret-code").res.statusCode).toBe(410);
  const retained = login.session.authorize;
  login.session.close();
  await expect(retained(authorization)).rejects.toThrow("closed");
});

it("does not consume a pending login for malformed or unrelated responses", async () => {
  const login = await startLogin();
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
});

it("settles a provider denial without exposing provider-controlled text", async () => {
  const login = await startLogin();
  const rejected = expect(login.result).rejects.toThrow("declined");
  const response = callback("state=login-state&error=denied&error_description=%3Cscript%3Esecret");
  expect(response.res.statusCode).toBe(400);
  expect(response.getBody()).not.toMatch(/script|secret/);
  await rejected;
});

it.each(["restart", "origin"])("rejects callback completion after %s", async (event) => {
  const login = await startLogin();
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
});

it("expires unanswered browser login without consuming a later callback", async () => {
  const login = await startLogin({ timeoutMs: 20 });
  await expect(login.result).rejects.toThrow();
  expect(callback("state=login-state&code=late").res.statusCode).toBe(410);
});

it("rejects an expired callback even before the timeout task runs", async () => {
  const login = await startLogin();
  const rejected = expect(login.result).rejects.toThrow("expired");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
  expect(callback("state=login-state&code=late").res.statusCode).toBe(410);
  await rejected;
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
  const session = createSession({ browserOrigin, openUrl });
  expect(session.available).toBe(false);
  await expect(session.authorize(authorization)).rejects.toThrow("secure Gateway address");
  expect(openUrl).not.toHaveBeenCalled();
});

it("does not advertise loopback or a guessed browser address", async () => {
  clearOrigin();
  const session = createSession({ openUrl: vi.fn() });
  await expect(session.authorize(authorization)).rejects.toThrow("secure Gateway address");
});
