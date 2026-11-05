import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardNextResult } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import type { McpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import * as oauthProvider from "../agents/mcp-oauth-provider.js";
import * as oauthStore from "../agents/mcp-oauth-store.js";
import * as oauthCoordinator from "../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import { createDeferredCore } from "../shared/deferred.js";
import { whenAdmittedWizardSessionSettled } from "./server-methods/setup-admission.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type OAuthProvider = Awaited<ReturnType<typeof oauthProvider.createMcpOAuthClientProvider>>;

export type McpAuthEffectEndpoint = {
  tokenLifetimeSeconds: number;
  endpoint?: (request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>;
};

type McpAuthForcedEffectFixture = {
  connection: () => { resourceUrl: string; config: McpServerConfig };
  request: () => GatewayRequestHandlerOptions | undefined;
  identity: () => McpOAuthIdentity;
  begin: () => Promise<{ sessionId: string; state: string }>;
  start: () => Promise<string>;
  callback: (state: string) => Promise<Response>;
  terminal: (sessionId: string) => Promise<WizardNextResult>;
  requests: string[];
  effects: McpAuthEffectEndpoint;
};

export const mcpOAuthMetadata = (resourceUrl: string, issuer = new URL(resourceUrl).origin) => ({
  issuer,
  authorization_endpoint: "https://provider.example/authorize",
  token_endpoint: new URL("/token", resourceUrl).href,
  registration_endpoint: new URL("/register", resourceUrl).href,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
});

export function registerMcpAuthForcedEffects(fixture: McpAuthForcedEffectFixture) {
  describe("forced SDK effects", () => {
    const { identity, begin, start, callback, terminal, requests, effects } = fixture;
    let resourceUrl: string;
    let config: McpServerConfig;
    beforeAll(() => {
      ({ resourceUrl, config } = fixture.connection());
    });
    const restoreEffects: Array<() => void> = [];
    const releaseEffects: Array<() => void> = [];
    let restoreScopes: (() => void) | undefined;

    const stored = () => oauthStore.readMcpOAuthStore(identity().storeKey);
    const pending = (state: string) => oauthStore.readMcpOAuthPendingAuthorization(state);
    const holdEffect = () => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      releaseEffects.push(() => release.resolve());
      return { entered, release };
    };
    const waitForEffect = (entered: PromiseLike<unknown>, label: string) =>
      awaitGateBeforeSettlement(entered, session().whenSettled(), `Settled before ${label}`);

    const invocation = () => expectDefined(fixture.request(), "registered request");
    const session = () =>
      expectDefined(
        invocation().context.wizardSessions.get(String(invocation().params.sessionId)),
        "registered wizard",
      );
    const revoke = () => {
      const client = expectDefined(invocation().client, "registered client");
      if (!restoreScopes) {
        const scopes = client.connect.scopes;
        restoreScopes = () => {
          client.connect.scopes = scopes;
        };
      }
      client.connect.scopes = ["operator.read"];
    };
    const respond = (response: ServerResponse, value: unknown, status = 200) => {
      response.writeHead(status).end(JSON.stringify(value));
      return true;
    };
    const expectAbsent = (
      store: Awaited<ReturnType<typeof stored>>,
      ...keys: (keyof typeof store)[]
    ) => expect(keys.map((key) => store[key])).toEqual(keys.map(() => undefined));
    const observeProvider = (
      observe: (provider: OAuthProvider, login: oauthProvider.McpOAuthLoginLifecycle) => void,
    ) => {
      const create = oauthProvider.createMcpOAuthClientProvider;
      const spy = vi
        .spyOn(oauthProvider, "createMcpOAuthClientProvider")
        .mockImplementation(async (params) => {
          const provider = await create(params);
          if (params.login) {
            observe(provider, params.login);
          }
          return provider;
        });
      restoreEffects.push(() => spy.mockRestore());
    };
    const observeFetch = (observe: {
      response?: (pathname: string, response: Response) => void;
      failure?: (pathname: string, error: unknown) => void;
    }) => {
      const bind = oauthProvider.withMcpOAuthLeaseSignal;
      const spy = vi
        .spyOn(oauthProvider, "withMcpOAuthLeaseSignal")
        .mockImplementation((...args) => {
          const fetch = bind(...args);
          return async (url, init) => {
            const pathname = new URL(url).pathname;
            let response: Response;
            try {
              response = await fetch(url, init);
            } catch (error) {
              observe.failure?.(pathname, error);
              throw error;
            }
            observe.response?.(pathname, response);
            return response;
          };
        });
      restoreEffects.push(() => spy.mockRestore());
    };
    const finishError = async (sessionId: string) => {
      await whenAdmittedWizardSessionSettled(session());
      restoreScopes?.();
      restoreScopes = undefined;
      const result = await terminal(sessionId);
      expect(result.status).toBe("error");
      expect(JSON.stringify(result)).not.toContain("private exchange detail");
      return result;
    };
    const seed = async (lifetime = 3600) => {
      effects.tokenLifetimeSeconds = lifetime;
      const started = await begin();
      expect((await callback(started.state)).status).toBe(200);
      expect(await terminal(started.sessionId)).toMatchObject({ status: "done" });
      expect(await stored()).toMatchObject({
        tokens: { access_token: "fixture-access" },
        tokensAuthorizationServerUrl: new URL(resourceUrl).origin,
      });
      effects.tokenLifetimeSeconds = 3600;
    };

    beforeEach(async () => {
      await oauthCoordinator.clearMcpOAuthCredentials(identity());
    });

    afterEach(async () => {
      const request = fixture.request();
      const active = request?.context.wizardSessions.get(String(request.params.sessionId));
      active?.cancel();
      for (const release of releaseEffects.splice(0)) {
        release();
      }
      try {
        if (active && request) {
          await whenAdmittedWizardSessionSettled(active);
          request.context.purgeWizardSession(String(request.params.sessionId));
        }
      } finally {
        restoreScopes?.();
        restoreScopes = undefined;
        for (const restore of restoreEffects.splice(0).toReversed()) {
          restore();
        }
        effects.endpoint = undefined;
        effects.tokenLifetimeSeconds = 3600;
        await oauthCoordinator.clearMcpOAuthCredentials(identity());
      }
    });

    it("rejects OIDC suffix fallback after revocation", async () => {
      const failures = [
        "/.well-known/oauth-authorization-server/tenant",
        "/.well-known/openid-configuration/tenant",
      ];
      const next = "/tenant/.well-known/openid-configuration";
      const stopPath = failures[1];
      effects.endpoint = (request, response) => {
        const pathname = new URL(request.url ?? "/", resourceUrl).pathname;
        if (failures.includes(pathname)) {
          response.writeHead(404).end();
          return true;
        }
        if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
          return respond(response, {
            resource: resourceUrl,
            authorization_servers: [new URL("/tenant", resourceUrl).href],
          });
        }
        return false;
      };
      observeFetch({
        response: (pathname, response) => {
          if (pathname === stopPath && response.status === 404) {
            revoke();
          }
        },
      });
      const before = await stored();
      const beforeRequests = requests.length;
      await finishError(await start());
      expect(await stored()).toEqual(before);
      expect(requests.slice(beforeRequests)).not.toContain(next);
      expect(requests.at(-1)).toBe(stopPath);
    });

    it("surfaces a real discovery TypeError without a headerless retry after revocation", async () => {
      const target = "/.well-known/oauth-protected-resource/mcp";
      let wireRequests = 0;
      let transportFailures = 0;
      effects.endpoint = (request) => {
        if (request.url !== target) {
          return false;
        }
        wireRequests++;
        if (wireRequests === 1) {
          request.socket.destroy();
          return true;
        }
        return false;
      };
      observeFetch({
        failure: (pathname, error) => {
          if (pathname === target && error instanceof TypeError) {
            transportFailures++;
            revoke();
          }
        },
      });
      const before = await stored();
      const result = await finishError(await start());
      expect(result.error).toContain("Sign-in did not finish");
      expect(result.error).toContain("try again");
      expect(await stored()).toEqual(before);
      expect(wireRequests).toBe(1);
      expect(transportFailures).toBe(1);
    });

    it.each([
      { lifetime: 30, withdraw: false },
      { lifetime: 0, withdraw: false },
      { lifetime: 0, withdraw: true },
    ])("refresh failure: $lifetime seconds, revoke=$withdraw", async ({ lifetime, withdraw }) => {
      await seed(lifetime);
      const before = await stored();
      expect(before.pendingAuthorizationChallenge).toBeUndefined();
      let requestParams: URLSearchParams | undefined;
      let responseBoundary = 0;
      effects.endpoint = async (request, response) => {
        if (request.url !== "/token") {
          return false;
        }
        requestParams = new URLSearchParams(await text(request));
        return respond(
          response,
          { error: "server_error", error_description: "private exchange detail" },
          500,
        );
      };
      observeFetch({
        response: (pathname) => {
          if (pathname === "/token") {
            responseBoundary++;
            if (withdraw) {
              revoke();
            }
          }
        },
      });
      const beforeRequests = requests.length;
      if (lifetime === 0 && !withdraw) {
        const started = await begin();
        expect(await pending(started.state)).toBe(identity().storeKey);
        expect((await stored()).lastAuthorizationUrl).toBeDefined();
      } else {
        await finishError(await start());
        // A dispatched rotating-grant refresh may have been consumed, so it stays fenced.
        expect(await stored()).toEqual({ ...before, refreshClaim: expect.any(String) });
      }
      expect(responseBoundary).toBe(1);
      expect(requestParams?.get("grant_type")).toBe("refresh_token");
      expect(requestParams?.get("refresh_token")).toBe(before.tokens?.refresh_token);
      expect(requestParams?.get("client_id")).toBe(before.clientInformation?.client_id);
      expect(requests.slice(beforeRequests)).toEqual(["/token"]);
      const current = await stored();
      expect([
        current.tokens,
        current.clientInformation,
        current.tokensAuthorizationServerUrl,
      ]).toEqual([before.tokens, before.clientInformation, before.tokensAuthorizationServerUrl]);
      if (lifetime > 0) {
        expect(expectDefined(before.tokenExpiresAt, "seed expiry")).toBeGreaterThan(Date.now());
      } else {
        expect(expectDefined(before.tokenExpiresAt, "seed expiry")).toBeLessThanOrEqual(Date.now());
      }
    });

    it("starts a new sign-in when a lost forced refresh fenced fresh tokens", async () => {
      await seed();
      const before = await stored();
      effects.endpoint = (request, response) =>
        request.url === "/token" && respond(response, { error: "server_error" }, 500);
      await expect(
        oauthCoordinator.resolveMcpOAuthAccessToken({
          identity: identity(),
          rejectedAccessToken: "fixture-access",
        }),
      ).rejects.toThrow();
      expect(await stored()).toEqual({ ...before, refreshClaim: expect.any(String) });
      effects.endpoint = undefined;
      const resolve = () => oauthCoordinator.resolveMcpOAuthAccessToken({ identity: identity() });
      await expect(resolve()).rejects.toThrow("refresh outcome is uncertain");

      const started = await begin();
      expect(await pending(started.state)).toBe(identity().storeKey);
      expect((await callback(started.state)).status).toBe(200);
      expect(await terminal(started.sessionId)).toMatchObject({ status: "done" });
      expect((await stored()).refreshClaim).toBeUndefined();
      await expect(resolve()).resolves.toBe("fixture-access");
    });

    const expectPendingCleared = async (state: string) => {
      const after = await stored();
      expectAbsent(after, "codeVerifier", "lastAuthorizationUrl");
      expect(await pending(state)).toBeUndefined();
      return after;
    };
    const revokeAfterMutation = (kind: "tokens" | "authorizationRedirect") => {
      const mutate = oauthStore.mutateMcpOAuthStore;
      const spy = vi
        .spyOn(oauthStore, "mutateMcpOAuthStore")
        .mockImplementation(async (...args) => {
          const result = await mutate(...args);
          if (args[1].kind === kind) {
            revoke();
          }
          return result;
        });
      restoreEffects.push(() => spy.mockRestore());
    };

    it("rolls back the token write when authority is withdrawn at its commit hook", async () => {
      await seed();
      const before = await stored();
      expect(
        await oauthCoordinator.recordMcpOAuthAuthorizationRequired({
          identity: identity(),
          rejectedAccessToken: "fixture-access",
          scope: "expanded",
        }),
      ).toBe(true);
      const started = await begin();
      observeProvider((_provider, login) => {
        const beforeTokensSaved = login.beforeTokensSaved;
        vi.spyOn(login, "beforeTokensSaved").mockImplementation(() => {
          beforeTokensSaved();
          revoke();
        });
      });
      expect((await callback(started.state)).status).toBe(200);
      const result = await finishError(started.sessionId);
      expect(result.error).toContain("Sign-in did not finish");
      expect(result.error).not.toContain("Authentication saved");
      const after = await expectPendingCleared(started.state);
      expect(after.tokens).toEqual(before.tokens);
      expect(after.tokenExpiresAt).toBe(before.tokenExpiresAt);
      expect(after.tokensAuthorizationServerUrl).toBe(before.tokensAuthorizationServerUrl);
      expect(after.clientInformation).toEqual(before.clientInformation);
      expect(after.pendingAuthorizationChallenge).toMatchObject({ requiresAuthorization: true });
    });

    it("reports saved authentication when authority ends before provider bookkeeping", async () => {
      const started = await begin();
      revokeAfterMutation("tokens");
      expect((await callback(started.state)).status).toBe(200);
      const result = await finishError(started.sessionId);
      expect(result.error).toContain("Authentication saved, but sign-in cleanup did not finish");
      const after = await expectPendingCleared(started.state);
      expect(after.tokens?.access_token).toBe("fixture-access");
      expect(after.tokensAuthorizationServerUrl).toBe(new URL(resourceUrl).origin);
      expect((await callback(started.state)).status).toBe(410);
    });

    it("cleans up a durable redirect when authority ends before provider bookkeeping", async () => {
      revokeAfterMutation("authorizationRedirect");
      let published: oauthProvider.McpOAuthLoginLifecycle["onAuthorizationPublished"] | undefined;
      observeProvider((_provider, login) => {
        published = vi.spyOn(login, "onAuthorizationPublished");
      });
      const result = await finishError(await start());
      expect(result.error).toContain("Sign-in did not finish");
      const publication = vi.mocked(expectDefined(published, "authorization publication hook"));
      const state = expectDefined(
        publication.mock.calls[0]?.[0],
        "acknowledged authorization state",
      );
      const after = await expectPendingCleared(state);
      expectAbsent(after, "tokens", "redirectUrl");
      expect((await callback(state)).status).toBe(410);
    });

    it("rejects verifier publication after the real PKCE digest resolves under revoked authority", async () => {
      const { entered, release } = holdEffect();
      const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
      const verifier = vi.fn((value: string, save: OAuthProvider["saveCodeVerifier"]) =>
        save(value),
      );
      observeProvider((provider) => {
        const state = expectDefined(provider.state?.bind(provider), "state owner");
        vi.spyOn(provider, "state").mockImplementation(async () => {
          const value = await state();
          const spy = vi
            .spyOn(globalThis.crypto.subtle, "digest")
            .mockImplementationOnce(async (algorithm, data) => {
              const result = await digest(algorithm, data);
              entered.resolve();
              await release.promise;
              return result;
            });
          restoreEffects.push(() => spy.mockRestore());
          return value;
        });
        const save = provider.saveCodeVerifier.bind(provider);
        vi.spyOn(provider, "saveCodeVerifier").mockImplementation((value) => verifier(value, save));
      });
      const sessionId = await start();
      await waitForEffect(entered.promise, "digest");
      const before = await stored();
      const beforeRequests = requests.length;
      revoke();
      release.resolve();
      await finishError(sessionId);
      expect(
        verifier.mock.results.findLast((result) => result.type === "throw")?.value,
      ).toBeInstanceOf(Error);
      expect(await stored()).toEqual(before);
      expectAbsent(await stored(), "codeVerifier", "lastAuthorizationUrl");
      expect(requests).toHaveLength(beforeRequests);
    });

    it.each([false, true])("fences pending insertion, newer CLI=%s", async (newerCli) => {
      const { entered, release } = holdEffect();
      let state: string | undefined;
      const { entered: cleanupEntered, release: releaseCleanup } = holdEffect();
      if (newerCli) {
        const cancel = oauthCoordinator.cancelMcpOAuthAuthorization;
        const cleanup = vi
          .spyOn(oauthCoordinator, "cancelMcpOAuthAuthorization")
          .mockImplementation(async (...args) => {
            cleanupEntered.resolve();
            await releaseCleanup.promise;
            return await cancel(...args);
          });
        restoreEffects.push(() => cleanup.mockRestore());
      }
      observeProvider((provider) => {
        const redirect = provider.redirectToAuthorization.bind(provider);
        vi.spyOn(provider, "redirectToAuthorization").mockImplementation(async (url) => {
          await redirect(url);
          state = expectDefined(url.searchParams.get("state"), "SDK authorization state");
          entered.resolve();
          await release.promise;
        });
      });
      const publishedPending: string[] = [];
      const insert = oauthStore.writeMcpOAuthPendingAuthorization;
      const spy = vi
        .spyOn(oauthStore, "writeMcpOAuthPendingAuthorization")
        .mockImplementation(async (...args) => {
          await insert(...args);
          publishedPending.push(args[1]);
        });
      restoreEffects.push(() => spy.mockRestore());
      const sessionId = await start();
      await waitForEffect(entered.promise, "publication");
      const published = await stored();
      const rejectedState = expectDefined(state, "published state");
      expect(
        new URL(expectDefined(published.lastAuthorizationUrl, "published URL")).searchParams.get(
          "state",
        ),
      ).toBe(rejectedState);
      expect(published.codeVerifier).toHaveLength(43);
      expect(await pending(rejectedState)).toBeUndefined();
      const beforeRequests = requests.length;
      revoke();
      release.resolve();
      let replacement: Awaited<ReturnType<typeof stored>> | undefined;
      let replacementState: string | undefined;
      if (newerCli) {
        await waitForEffect(cleanupEntered.promise, "cleanup");
        const resolved = resolveMcpTransportConfig("docs", config);
        if (resolved?.kind !== "http") {
          throw new Error("Fixture transport unavailable");
        }
        const newer = await oauthCoordinator.startMcpOAuthAuthorization(identity(), resolved, {});
        if (newer.status !== "redirect") {
          throw new Error("New CLI authorization was not published");
        }
        replacementState = newer.state;
        replacement = await stored();
        expect(replacementState).not.toBe(rejectedState);
        expect(await pending(replacementState)).toBe(identity().storeKey);
      }
      releaseCleanup.resolve();
      await finishError(sessionId);
      expect(publishedPending).toEqual(replacementState ? [replacementState] : []);
      expect(await pending(rejectedState)).toBeUndefined();
      expect((await callback(rejectedState)).status).toBe(410);
      if (replacementState) {
        expect(await stored()).toEqual(expectDefined(replacement, "newer CLI store"));
        expect(await pending(replacementState)).toBe(identity().storeKey);
      } else {
        expectAbsent(await stored(), "codeVerifier", "lastAuthorizationUrl");
      }
      expect((await stored()).tokens).toBeUndefined();
      expect(requests).toHaveLength(beforeRequests);
    });
  });
}
