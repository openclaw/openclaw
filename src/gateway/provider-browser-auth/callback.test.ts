import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { runProviderPluginAuthMethodUnpersisted } from "../../plugins/provider-auth-method.js";
import type { ProviderAuthContext } from "../../plugins/provider-authentication.types.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createNonExitingRuntime } from "../../runtime.js";
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

function startLogin(params: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const opened = createDeferredCore<string>();
  const session = createProviderBrowserAuthSession({
    signal: params.signal,
    openUrl: async (url) => opened.resolve(url),
  });
  const result = session.authorize({
    state: "login-state",
    timeoutMs: params.timeoutMs ?? 60_000,
    buildAuthorizationUrl: (redirectUrl) => {
      const callbackUrl = new URL(redirectUrl);
      callbackUrl.searchParams.set("state", "login-state");
      return `https://provider.example/authorize?callback_url=${encodeURIComponent(callbackUrl.href)}`;
    },
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
  it("receives one bound callback through the Gateway without admin credentials", async () => {
    const login = startLogin();
    const url = new URL(await login.opened);
    expect(new URL(url.searchParams.get("callback_url")!).origin).toBe("https://gateway.example");
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
    login.session.close();
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

  it.each(["cancel", "restart", "origin"])(
    "rejects callback completion after %s",
    async (event) => {
      const controller = new AbortController();
      const login = startLogin({ signal: controller.signal });
      await login.opened;
      const rejected = expect(login.result).rejects.toThrow();
      if (event === "cancel") {
        controller.abort(new Error("cancelled"));
      }
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
      await expect(
        login.session.authorize({
          state: "retained",
          timeoutMs: 60_000,
          buildAuthorizationUrl: () => "https://provider.example/authorize",
        }),
      ).rejects.toThrow();
    },
  );

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

  it("does not advertise loopback or a guessed browser address", async () => {
    clearOrigin();
    const session = createProviderBrowserAuthSession({ openUrl: vi.fn() });
    await expect(
      session.authorize({
        state: "no-origin",
        timeoutMs: 60_000,
        buildAuthorizationUrl: () => "https://provider.example/authorize",
      }),
    ).rejects.toThrow("secure Gateway address");
    session.close();
  });

  it("forwards caller-owned browser authorization and rejects retained copies after closure", async () => {
    const opened = createDeferredCore<string>();
    const run = vi.fn(async (context: ProviderAuthContext) => {
      const result = await context.oauth.authorize!({
        state: "login-state",
        timeoutMs: 60_000,
        buildAuthorizationUrl: (redirectUrl) =>
          `https://provider.example/authorize?callback=${encodeURIComponent(redirectUrl)}`,
      });
      expect(result.code).toBe("valid");
      return { profiles: [] };
    });
    const browser = createProviderBrowserAuthSession({
      openUrl: async (url) => opened.resolve(url),
    });
    const result = runProviderPluginAuthMethodUnpersisted({
      method: { id: "oauth", label: "Sign in", kind: "oauth", run },
      config: {},
      runtime: createNonExitingRuntime(),
      prompter: createWizardPrompter(),
      isRemote: true,
      signal: browser.signal,
      browserAuthorization: browser.authorize,
    });
    await opened.promise;
    callback("state=login-state&code=valid");
    await expect(result).resolves.toEqual({ profiles: [] });
    browser.close();
    const context = run.mock.calls[0]![0];
    await expect(
      context.oauth.authorize!({
        state: "retained",
        timeoutMs: 60_000,
        buildAuthorizationUrl: () => "https://provider.example/authorize",
      }),
    ).rejects.toThrow("closed");
  });
});
