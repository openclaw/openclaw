import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { WizardNextResult } from "../../packages/gateway-protocol/src/index.js";
import type { McpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import * as oauthProvider from "../agents/mcp-oauth-provider.js";
import * as oauthStore from "../agents/mcp-oauth-store.js";
import * as oauthCoordinator from "../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { writeConfigFile } from "../config/config.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import { createDeferredCore } from "../shared/deferred.js";
import { whenAdmittedWizardSessionSettled } from "./server-methods/setup-admission.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { rpcReq } from "./test-helpers.server.js";

export type McpAuthEffectEndpoint = {
  tokenLifetimeSeconds: number;
  endpoint?: (request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>;
};

type McpAuthForcedEffectFixture = {
  connection: () => { owner: WebSocket; resourceUrl: string; config: McpServerConfig };
  request: () => GatewayRequestHandlerOptions | undefined;
  identity: () => McpOAuthIdentity;
  begin: () => Promise<{ sessionId: string; state: string }>;
  callback: (state: string) => Promise<Response>;
  terminal: (sessionId: string) => Promise<WizardNextResult>;
  requests: string[];
  effects: McpAuthEffectEndpoint;
};

export function registerMcpAuthForcedEffects(fixture: McpAuthForcedEffectFixture) {
  describe("forced SDK effects", () => {
    const { identity, begin, callback, terminal, requests, effects } = fixture;
    let owner: WebSocket;
    let resourceUrl: string;
    let config: McpServerConfig;
    beforeAll(() => {
      ({ owner, resourceUrl, config } = fixture.connection());
    });
    const restoreEffects: Array<() => void> = [];
    const releaseEffects: Array<() => void> = [];
    let restoreScopes: (() => void) | undefined;
    let changedConfig = false;

    const stored = () => oauthStore.readMcpOAuthStore(identity().storeKey);
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
    const metadata = (issuer = new URL(resourceUrl).origin) => ({
      issuer,
      authorization_endpoint: "https://provider.example/authorize",
      token_endpoint: new URL("/token", resourceUrl).href,
      registration_endpoint: new URL("/register", resourceUrl).href,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    const observeProvider = (
      observe: (provider: ReturnType<typeof oauthProvider.createMcpOAuthClientProvider>) => void,
    ) => {
      const create = oauthProvider.createMcpOAuthClientProvider;
      const spy = vi
        .spyOn(oauthProvider, "createMcpOAuthClientProvider")
        .mockImplementation((params) => {
          const provider = create(params);
          if (params.login) {
            observe(provider);
          }
          return provider;
        });
      restoreEffects.push(() => spy.mockRestore());
    };
    const observeFetch = (observe: {
      request?: (pathname: string, headers: Headers) => void;
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
            observe.request?.(pathname, new Headers(init?.headers));
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
    const start = async () => {
      const sessionId = randomUUID();
      const started = await rpcReq(owner, "mcp.authLogin", { sessionId, serverName: "docs" });
      expect(started, JSON.stringify(started.error)).toMatchObject({
        ok: true,
        payload: { sessionId, done: false, status: "running" },
      });
      return sessionId;
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
    const seed = async () => {
      const started = await begin();
      expect((await callback(started.state)).status).toBe(200);
      expect(await terminal(started.sessionId)).toMatchObject({ status: "done" });
      expect(stored().tokens?.access_token).toBe("fixture-access");
      expect(stored().tokensAuthorizationServerUrl).toBe(new URL(resourceUrl).origin);
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
        if (changedConfig) {
          changedConfig = false;
          await writeConfigFile({
            gateway: { reload: { mode: "off" } },
            mcp: { servers: { docs: config } },
          });
        }
        await oauthCoordinator.clearMcpOAuthCredentials(identity());
      }
    });

    it.each(["resource", "authorization server"] as const)(
      "rejects the real enriched %s discovery save after revocation",
      async (missing) => {
        effects.tokenLifetimeSeconds = 30;
        await seed();
        effects.tokenLifetimeSeconds = 3600;
        const cached = { ...expectDefined(stored().discoveryState, "seed discovery") };
        if (missing === "resource") {
          delete cached.resourceMetadata;
        } else {
          delete cached.authorizationServerMetadata;
        }
        const seedProvider = oauthProvider.createMcpOAuthClientProvider({ identity: identity() });
        await expectDefined(
          seedProvider.saveDiscoveryState?.bind(seedProvider),
          "canonical discovery writer",
        )(cached);
        const before = stored();
        const beforeRequests = requests.length;
        const saves: Parameters<NonNullable<typeof seedProvider.saveDiscoveryState>>[0][] = [];
        observeProvider((provider) => {
          const save = expectDefined(
            provider.saveDiscoveryState?.bind(provider),
            "discovery writer",
          );
          vi.spyOn(provider, "saveDiscoveryState").mockImplementation((value) => {
            saves.push(value);
            revoke();
            return save(value);
          });
        });
        await finishError(await start());
        expect(saves).toHaveLength(1);
        expect(saves[0]?.resourceMetadata).toBeDefined();
        expect(saves[0]?.authorizationServerMetadata).toBeDefined();
        expect(requests.slice(beforeRequests)).toEqual([
          missing === "resource"
            ? "/.well-known/oauth-protected-resource/mcp"
            : "/.well-known/oauth-authorization-server",
        ]);
        expect(stored()).toEqual(before);
        expect(before.pendingAuthorizationChallenge).toBeUndefined();
        expect(expectDefined(before.tokenExpiresAt, "seed expiry")).toBeGreaterThan(Date.now());
      },
    );

    it("rejects the existing metadata-document client ID at its real local save", async () => {
      const clientMetadataUrl = "https://client.example/openclaw.json";
      changedConfig = true;
      await writeConfigFile({
        gateway: { reload: { mode: "off" } },
        mcp: { servers: { docs: { ...config, oauth: { clientMetadataUrl } } } },
      });
      effects.endpoint = (request, response) => {
        if (request.url !== "/.well-known/oauth-authorization-server") {
          return false;
        }
        response.end(
          JSON.stringify({ ...metadata(), client_id_metadata_document_supported: true }),
        );
        return true;
      };
      let attemptedClient: unknown;
      let beforeSave: ReturnType<typeof stored> | undefined;
      let saveCalls = 0;
      observeProvider((provider) => {
        const save = expectDefined(
          provider.saveClientInformation?.bind(provider),
          "client information writer",
        );
        vi.spyOn(provider, "saveClientInformation").mockImplementation((value) => {
          saveCalls++;
          attemptedClient = value;
          beforeSave = stored();
          revoke();
          return save(value);
        });
      });
      const beforeRequests = requests.length;
      await finishError(await start());
      expect(saveCalls).toBe(1);
      expect(attemptedClient).toEqual({ client_id: clientMetadataUrl });
      expect(beforeSave?.discoveryState?.authorizationServerMetadata).toMatchObject({
        client_id_metadata_document_supported: true,
      });
      expect(stored()).toEqual(expectDefined(beforeSave, "pre-client-save store"));
      expect(stored().clientInformation).toBeUndefined();
      expect(stored().tokens).toBeUndefined();
      expect(requests.slice(beforeRequests)).toEqual([
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
      ]);
    });

    const fallbackCells = [
      {
        name: "resource path to root",
        failures: ["/.well-known/oauth-protected-resource/mcp"],
        next: "/.well-known/oauth-protected-resource",
        tenant: false,
      },
      {
        name: "resource root to authorization root",
        failures: [
          "/.well-known/oauth-protected-resource/mcp",
          "/.well-known/oauth-protected-resource",
        ],
        next: "/.well-known/oauth-authorization-server",
        tenant: false,
      },
      {
        name: "authorization root to OIDC",
        failures: ["/.well-known/oauth-authorization-server"],
        next: "/.well-known/openid-configuration",
        tenant: false,
      },
      {
        name: "authorization path to OIDC path",
        failures: ["/.well-known/oauth-authorization-server/tenant"],
        next: "/.well-known/openid-configuration/tenant",
        tenant: true,
      },
      {
        name: "OIDC path to suffix",
        failures: [
          "/.well-known/oauth-authorization-server/tenant",
          "/.well-known/openid-configuration/tenant",
        ],
        next: "/tenant/.well-known/openid-configuration",
        tenant: true,
      },
    ];

    for (const cell of fallbackCells) {
      it.each([false, true])(`${cell.name}, revoke=%s`, async (withdraw) => {
        const stopPath = expectDefined(cell.failures.at(-1), "last failed discovery path");
        const attempts: string[] = [];
        let boundaryCount = 0;
        effects.endpoint = (request, response) => {
          const pathname = new URL(request.url ?? "/", resourceUrl).pathname;
          if (cell.failures.includes(pathname)) {
            response.writeHead(404).end();
            return true;
          }
          if (cell.tenant && pathname.startsWith("/.well-known/oauth-protected-resource")) {
            response.end(
              JSON.stringify({
                resource: resourceUrl,
                authorization_servers: [new URL("/tenant", resourceUrl).href],
              }),
            );
            return true;
          }
          if (pathname === cell.next && pathname.includes("openid-configuration")) {
            response.end(
              JSON.stringify({
                ...metadata(cell.tenant ? new URL("/tenant", resourceUrl).href : undefined),
                jwks_uri: new URL("/jwks", resourceUrl).href,
                subject_types_supported: ["public"],
                id_token_signing_alg_values_supported: ["RS256"],
              }),
            );
            return true;
          }
          return false;
        };
        observeFetch({
          request: (pathname) => {
            attempts.push(pathname);
          },
          response: (pathname, response) => {
            if (pathname === stopPath && response.status === 404) {
              boundaryCount++;
              if (withdraw) {
                revoke();
              }
            }
          },
        });
        const before = stored();
        const beforeRequests = requests.length;
        if (withdraw) {
          await finishError(await start());
          expect(stored()).toEqual(before);
          expect(requests.slice(beforeRequests)).not.toContain(cell.next);
          expect(requests.at(-1)).toBe(stopPath);
        } else {
          await begin();
          expect(requests.slice(beforeRequests)).toContain(cell.next);
          expect(stored().lastAuthorizationUrl).toBeDefined();
        }
        expect(boundaryCount).toBe(1);
        expect(attempts).toContain(cell.next);
      });
    }

    it.each([false, true])(
      "real transport TypeError headerless fallback, revoke=%s",
      async (withdraw) => {
        const target = "/.well-known/oauth-protected-resource/mcp";
        const attempts: Array<{ pathname: string; protocol: string | null }> = [];
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
          request: (pathname, headers) => {
            attempts.push({ pathname, protocol: headers.get("MCP-Protocol-Version") });
          },
          failure: (pathname, error) => {
            if (pathname === target && error instanceof TypeError) {
              transportFailures++;
              if (withdraw) {
                revoke();
              }
            }
          },
        });
        const before = stored();
        if (withdraw) {
          await finishError(await start());
          expect(stored()).toEqual(before);
          expect(wireRequests).toBe(1);
        } else {
          await begin();
          expect(wireRequests).toBe(2);
        }
        expect(transportFailures).toBe(1);
        const resourceAttempts = attempts.filter((attempt) => attempt.pathname === target);
        expect(resourceAttempts).toHaveLength(2);
        expect(resourceAttempts[0]?.protocol).toBeTruthy();
        expect(resourceAttempts[1]?.protocol).toBeNull();
      },
    );

    const refreshCells = [
      { error: "server_error", lifetime: 30 },
      { error: "server_error", lifetime: 0 },
      { error: "transport", lifetime: 30 },
      { error: "unauthorized_client", lifetime: 30 },
    ];
    for (const { error, lifetime } of refreshCells) {
      it.each([false, true])(
        `refresh ${error}, lifetime=${lifetime}, revoke=%s`,
        async (withdraw) => {
          effects.tokenLifetimeSeconds = lifetime;
          await seed();
          effects.tokenLifetimeSeconds = 3600;
          const before = stored();
          expect(before.pendingAuthorizationChallenge).toBeUndefined();
          let requestParams: URLSearchParams | undefined;
          let responseBoundary = 0;
          let transportError: unknown;
          effects.endpoint = async (request, response) => {
            if (request.url !== "/token") {
              return false;
            }
            let body = "";
            for await (const chunk of request) {
              body += chunk;
            }
            requestParams = new URLSearchParams(body);
            if (error === "transport") {
              request.socket.destroy();
              return true;
            }
            response
              .writeHead(error === "server_error" ? 500 : 400)
              .end(JSON.stringify({ error, error_description: "private exchange detail" }));
            return true;
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
            failure: (pathname, failure) => {
              if (pathname === "/token") {
                transportError = failure;
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
            expect(oauthStore.readMcpOAuthPendingAuthorization(started.state)).toBe(
              identity().storeKey,
            );
            expect(stored().lastAuthorizationUrl).toBeDefined();
          } else {
            await finishError(await start());
            expect(stored()).toEqual(before);
          }
          expect(responseBoundary).toBe(1);
          if (error === "transport") {
            expect(transportError).toBeInstanceOf(TypeError);
          } else {
            expect(transportError).toBeUndefined();
          }
          expect(requestParams?.get("grant_type")).toBe("refresh_token");
          expect(requestParams?.get("refresh_token")).toBe(before.tokens?.refresh_token);
          expect(requestParams?.get("client_id")).toBe(before.clientInformation?.client_id);
          expect(requests.slice(beforeRequests)).toEqual(["/token"]);
          expect(stored().tokens).toEqual(before.tokens);
          expect(stored().clientInformation).toEqual(before.clientInformation);
          expect(stored().tokensAuthorizationServerUrl).toBe(before.tokensAuthorizationServerUrl);
          if (lifetime > 0) {
            expect(expectDefined(before.tokenExpiresAt, "seed expiry")).toBeGreaterThan(Date.now());
          } else {
            expect(expectDefined(before.tokenExpiresAt, "seed expiry")).toBeLessThanOrEqual(
              Date.now(),
            );
          }
        },
      );
    }

    it("rejects verifier publication after the real PKCE digest resolves under revoked authority", async () => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      releaseEffects.push(() => release.resolve());
      let digestInput: unknown;
      let verifier: string | undefined;
      let digestCalls = 0;
      let redirectCalls = 0;
      let verifierFailure: unknown;
      observeProvider((provider) => {
        const state = expectDefined(provider.state?.bind(provider), "state owner");
        vi.spyOn(provider, "state").mockImplementation(() => {
          const value = state();
          const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
          const spy = vi
            .spyOn(globalThis.crypto.subtle, "digest")
            .mockImplementationOnce(async (algorithm, data) => {
              digestCalls++;
              digestInput = data;
              const result = await digest(algorithm, data);
              entered.resolve();
              await release.promise;
              return result;
            });
          restoreEffects.push(() => spy.mockRestore());
          return value;
        });
        const save = provider.saveCodeVerifier.bind(provider);
        vi.spyOn(provider, "saveCodeVerifier").mockImplementation((value) => {
          verifier = value;
          try {
            return save(value);
          } catch (error) {
            verifierFailure = error;
            throw error;
          }
        });
        const redirect = provider.redirectToAuthorization.bind(provider);
        vi.spyOn(provider, "redirectToAuthorization").mockImplementation((url) => {
          redirectCalls++;
          return redirect(url);
        });
      });
      const sessionId = await start();
      expect(
        await Promise.race([
          entered.promise.then(() => "digest"),
          session()
            .whenSettled()
            .then(() => "settled-before-digest"),
        ]),
      ).toBe("digest");
      const before = stored();
      const beforeRequests = requests.length;
      revoke();
      release.resolve();
      await finishError(sessionId);
      expect(digestCalls).toBe(1);
      expect(verifierFailure).toBeInstanceOf(Error);
      expect(redirectCalls).toBe(0);
      expect(verifier).toHaveLength(43);
      expect(digestInput).toEqual(
        new TextEncoder().encode(expectDefined(verifier, "SDK verifier")),
      );
      expect(stored()).toEqual(before);
      expect(stored().codeVerifier).toBeUndefined();
      expect(stored().lastAuthorizationUrl).toBeUndefined();
      expect(requests).toHaveLength(beforeRequests);
    });

    it.each([false, true])(
      "fences pending insertion after URL publication, newer CLI=%s",
      async (newerCli) => {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        releaseEffects.push(() => release.resolve());
        let state: string | undefined;
        const cleanupEntered = createDeferredCore();
        const releaseCleanup = createDeferredCore();
        releaseEffects.push(() => releaseCleanup.resolve());
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
        const publishedPending: string[] = [];
        observeProvider((provider) => {
          const redirect = provider.redirectToAuthorization.bind(provider);
          vi.spyOn(provider, "redirectToAuthorization").mockImplementation(async (url) => {
            await redirect(url);
            state = expectDefined(url.searchParams.get("state"), "SDK authorization state");
            entered.resolve();
            await release.promise;
          });
        });
        const insert = oauthStore.writeMcpOAuthPendingAuthorization;
        const spy = vi
          .spyOn(oauthStore, "writeMcpOAuthPendingAuthorization")
          .mockImplementation((...args) => {
            insert(...args);
            if (oauthStore.readMcpOAuthPendingAuthorization(args[1]) !== undefined) {
              publishedPending.push(args[1]);
            }
          });
        restoreEffects.push(() => spy.mockRestore());
        const sessionId = await start();
        expect(
          await Promise.race([
            entered.promise.then(() => "published"),
            session()
              .whenSettled()
              .then(() => "settled-before-publication"),
          ]),
        ).toBe("published");
        const published = stored();
        const rejectedState = expectDefined(state, "published state");
        expect(
          new URL(expectDefined(published.lastAuthorizationUrl, "published URL")).searchParams.get(
            "state",
          ),
        ).toBe(rejectedState);
        expect(published.codeVerifier).toHaveLength(43);
        expect(oauthStore.readMcpOAuthPendingAuthorization(rejectedState)).toBeUndefined();
        const beforeRequests = requests.length;
        revoke();
        release.resolve();
        let replacement: ReturnType<typeof stored> | undefined;
        let replacementState: string | undefined;
        if (newerCli) {
          expect(
            await Promise.race([
              cleanupEntered.promise.then(() => "cleanup"),
              session()
                .whenSettled()
                .then(() => "settled-before-cleanup"),
            ]),
          ).toBe("cleanup");
          const resolved = resolveMcpTransportConfig("docs", config);
          if (resolved?.kind !== "http") {
            throw new Error("Fixture transport unavailable");
          }
          const newer = await oauthCoordinator.startMcpOAuthAuthorization(identity(), resolved, {});
          if (newer.status !== "redirect") {
            throw new Error("New CLI authorization was not published");
          }
          replacementState = newer.state;
          replacement = stored();
          expect(replacementState).not.toBe(rejectedState);
          expect(oauthStore.readMcpOAuthPendingAuthorization(replacementState)).toBe(
            identity().storeKey,
          );
        }
        releaseCleanup.resolve();
        await finishError(sessionId);
        expect(publishedPending).toEqual(replacementState ? [replacementState] : []);
        expect(oauthStore.readMcpOAuthPendingAuthorization(rejectedState)).toBeUndefined();
        expect((await callback(rejectedState)).status).toBe(410);
        if (replacementState) {
          expect(stored()).toEqual(expectDefined(replacement, "newer CLI store"));
          expect(oauthStore.readMcpOAuthPendingAuthorization(replacementState)).toBe(
            identity().storeKey,
          );
        } else {
          expect(stored().codeVerifier).toBeUndefined();
          expect(stored().lastAuthorizationUrl).toBeUndefined();
        }
        expect(stored().tokens).toBeUndefined();
        expect(requests).toHaveLength(beforeRequests);
      },
    );
  });
}
