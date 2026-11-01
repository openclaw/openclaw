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
  resolveBrowserAuthOrigin,
} from "../provider-browser-auth.js";
import { createRequest, createResponse } from "../server-http.test-harness.js";
import { prepareTailscalePublishedOrigin } from "../tailscale-published-origin.js";

let clearOrigin: () => void;
let closeSession: () => void;
function publishOrigin() {
  return prepareTailscalePublishedOrigin({ origin: "https://gateway.example", mode: "serve" });
}
beforeEach(() => {
  resetGatewayWorkAdmission();
  clearOrigin = publishOrigin();
});
afterEach(() => {
  vi.restoreAllMocks();
  closeSession?.();
  clearOrigin();
  resetGatewayWorkAdmission();
});

const authorization = {
  state: "login-state",
  timeoutMs: 60_000,
  buildAuthorizationUrl: (redirectUrl: string) =>
    `https://provider.example/authorize?callback_url=${encodeURIComponent(`${redirectUrl}?state=login-state`)}`,
};

function createSession(params: Parameters<typeof createProviderBrowserAuthSession>[0]) {
  const session = createProviderBrowserAuthSession(params);
  closeSession = session.close;
  return session;
}

async function startLogin(timeoutMs = 60_000) {
  const opened = createDeferredCore<string>();
  const session = createSession({
    openUrl: async (url) => opened.resolve(url),
  });
  const result = session.authorize({ ...authorization, timeoutMs });
  return { session, result, opened: await opened.promise };
}

function callback(query: string, method = "GET") {
  const response = createResponse();
  handleProviderOAuthCallback(
    createRequest({ path: `${PROVIDER_OAUTH_CALLBACK_PATH}?${query}`, method }),
    response.res,
  );
  return response;
}

it("does not consume a pending login for malformed or unrelated responses", async () => {
  const login = await startLogin();
  for (const query of [
    "state=other&code=wrong",
    "state=login-state",
    "state=login-state&state=other&code=wrong",
    "state=login-state&code=one&code=two",
    "state=login-state&code=one&error=denied",
    "state=login-state&code=one&iss=https%3A%2F%2Fprovider.example&iss=https%3A%2F%2Fother.example",
  ]) {
    expect(callback(query).res.statusCode).toBeGreaterThanOrEqual(400);
  }
  expect(callback("state=login-state&code=valid", "POST").res.statusCode).toBe(400);
  const response = callback("state=login-state&code=valid");
  expect(response.res.statusCode).toBe(200);
  expect(response.getBody()).not.toMatch(/valid|login-state/);
  expect(response.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
  await expect(login.result).resolves.toEqual({ code: "valid", state: "login-state" });
  const retained = login.session.authorize;
  login.session.close();
  await expect(retained(authorization)).rejects.toThrow("closed");
});

it("preserves the exact issuer from an accepted browser callback", async () => {
  const login = await startLogin();
  const response = callback(
    "state=login-state&code=valid&iss=https%3A%2F%2Fprovider.example%2Ftenant%2F",
  );
  expect(response.res.statusCode).toBe(200);
  await expect(login.result).resolves.toEqual({
    code: "valid",
    state: "login-state",
    iss: "https://provider.example/tenant/",
  });
});

it("settles a provider denial without exposing provider-controlled text", async () => {
  const login = await startLogin();
  const rejected = expect(login.result).rejects.toThrow("declined");
  const response = callback("state=login-state&error=denied&error_description=%3Cscript%3Esecret");
  expect(response.res.statusCode).toBe(400);
  expect(response.getBody()).not.toMatch(/script|secret/);
  await rejected;
});

it.each(["restart", "origin", "timer", "deadline"])("rejects %s callbacks", async (event) => {
  const login = await startLogin(event === "timer" ? 20 : 60_000);
  const message = event === "deadline" ? "expired" : undefined;
  const rejected = expect(login.result).rejects.toThrow(message);
  if (event === "restart") {
    markGatewayRestartDraining();
  }
  if (event === "origin") {
    clearOrigin = publishOrigin();
  }
  if (event === "deadline") {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
  }
  if (event === "timer") {
    await rejected;
  }
  expect(callback("state=login-state&code=stale").res.statusCode).toBe(410);
  await rejected;
});

it.each<[string | undefined, string, boolean, boolean]>([
  ["https://gateway.example", "gateway.example", false, true],
  ["https://work.example:8447", "work.example:8447", false, true],
  ["http://localhost:18789", "localhost:18789", true, true],
  ["http://127.0.0.1:18789", "127.0.0.1:18789", true, true],
  ["http://[::1]:18789", "[::1]:18789", true, true],
  [undefined, "", false, false],
  ["http://localhost:3000", "localhost:18789", true, false],
  ["http://localhost:18789", "localhost:18789", false, false],
  ["https://other.example", "gateway.example", false, false],
  ["https://work.example:8447", "work.example:8448", false, false],
  ["https://work.example/path", "work.example", false, false],
  ["http://192.168.1.2:18789", "192.168.1.2:18789", true, false],
  ["file://localhost", "localhost", true, false],
])("checks served browser origin %s", async (origin, requestHost, isLocalClient, allowed) => {
  if (origin !== "https://gateway.example") {
    clearOrigin();
  }
  const browserOrigin = origin ? { origin, requestHost, isLocalClient } : undefined;
  expect(resolveBrowserAuthOrigin(browserOrigin)?.origin).toBe(allowed ? origin : undefined);
  const openUrl = vi.fn();
  const session = createSession({ browserOrigin, openUrl });
  if (!allowed) {
    await expect(session.authorize(authorization)).rejects.toThrow("secure Gateway address");
    expect(openUrl).not.toHaveBeenCalled();
  }
});

it("requires the initiating browser cookie without consuming another browser's callback", async () => {
  const opened = createDeferredCore<string>();
  const session = createSession({
    openUrl: async (url) => opened.resolve(url),
    browserBinding: { cookieName: "link-browser", cookieValue: "random-browser-proof" },
  });
  const result = session.authorize(authorization);
  await opened.promise;
  for (const cookie of [
    undefined,
    "link-browser=wrong",
    "link-browser=random-browser-proof; link-browser=wrong",
  ]) {
    const response = createResponse();
    handleProviderOAuthCallback(
      createRequest({
        path: PROVIDER_OAUTH_CALLBACK_PATH + "?state=login-state&code=valid",
        method: "GET",
        headers: cookie ? { cookie } : {},
      }),
      response.res,
    );
    expect(response.res.statusCode).toBe(403);
  }
  const response = createResponse();
  handleProviderOAuthCallback(
    createRequest({
      path: PROVIDER_OAUTH_CALLBACK_PATH + "?state=login-state&code=valid",
      method: "GET",
      headers: { cookie: "link-browser=random-browser-proof" },
    }),
    response.res,
  );
  expect(response.res.statusCode).toBe(200);
  await expect(result).resolves.toMatchObject({ code: "valid" });
  expect(callback("state=login-state&code=valid").res.statusCode).toBe(410);
});
