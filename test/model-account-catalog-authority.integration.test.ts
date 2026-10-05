import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import { loadSelectedProviderAccountCatalog } from "../src/agents/models-config.providers.catalog-context.js";
import { createPreparedAccountCatalogAccess } from "../src/agents/prepared-model-runtime.catalog-auth.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createModelAccountConnectService } from "../src/gateway/model-account-connect.js";
import { broadcastChatMetadataChanged } from "../src/gateway/server-chat-metadata-lifecycle.js";
import { createDirectChatContext } from "../src/gateway/server-chat.agent-events.test-helpers.js";
import {
  createModelsListTestContext,
  WITHOUT_OPENAI_ENV_AUTH,
} from "../src/gateway/server-methods/models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "../src/gateway/server-methods/models.js";
import type {
  GatewayRequestHandlerOptions,
  RespondFn,
} from "../src/gateway/server-methods/types.js";
import { usersAuthConnectHandlers } from "../src/gateway/server-methods/users-auth-connect.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../src/gateway/server-model-catalog-auth.js";
import { fetchWithSsrFGuard } from "../src/infra/net/fetch-guard.js";
import { clearLiveCatalogCacheForTests } from "../src/plugin-sdk/provider-catalog-shared.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../src/state/openclaw-state-db-readonly.js";
import {
  connectUserModelAccount,
  listUserProfileAuthLinks,
  readUserModelAuthProfile,
} from "../src/state/user-model-accounts.js";
import { ensureProfileForEmail } from "../src/state/user-profiles.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { createDeferred } from "./helpers/promise.js";

const transport = vi.hoisted(() => ({
  endpoint: "",
  preflight: vi.fn<() => Promise<void>>(),
  resolveAuth: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: transport.resolveAuth,
  resolveProviderAuthProfileMetadata: () => ({ accountId: "synthetic-account" }),
}));

// Only the destination and DNS fixture change. Acquisition, guarded fetch,
// dispatcher preparation, redirects, and the physical HTTP request stay real.
vi.mock("../src/plugin-sdk/ssrf-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugin-sdk/ssrf-runtime.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        url: transport.endpoint,
        capture: false,
        policy: { allowPrivateNetwork: true },
        lookupFn: async () => {
          await transport.preflight();
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }),
  };
});

const profileId =
  "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
const credential = { provider: "openai", type: "token", token: "synthetic-account-token" } as const;
const requests: Array<{ path: string | undefined; authorization: string | undefined }> = [];
let server: Awaited<ReturnType<typeof reserveTestPortListener>>;
let generationCurrent = true;
let principal = "owner";
let authorized = true;

function assertCurrent() {
  if (!authorized || principal !== "owner") {
    throw new Error("Selected personal account authority revoked");
  }
}

function load() {
  return loadSelectedProviderAccountCatalog({
    provider: buildOpenAIProvider(),
    providerId: "openai",
    profileId,
    authStore: { version: 1, profiles: { [profileId]: credential } },
    config: {},
    agentDir: "/unused/catalog-authority-agent",
    workspaceDir: "/unused/catalog-authority-workspace",
    isCurrent: () => generationCurrent,
    assertCurrent,
  });
}

beforeAll(async () => {
  server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        requests.push({ path: request.url, authorization: request.headers.authorization });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ models: [{ slug: "gpt-5.4", visibility: "list" }] }));
      }),
  });
  transport.endpoint = "http://catalog-authority.test:" + server.claim.port + "/models";
});
afterAll(async () => {
  await server.releaseListener();
  await server.claim.release();
});
beforeEach(() => {
  clearLiveCatalogCacheForTests();
  requests.length = 0;
  generationCurrent = true;
  principal = "owner";
  authorized = true;
  transport.preflight.mockReset().mockResolvedValue(undefined);
  transport.resolveAuth.mockReset().mockResolvedValue({
    apiKey: credential.token,
    mode: "token",
    profileId,
  });
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  vi.stubEnv("OPENAI_API_KEY", "");
  // Hold catalog deadlines while deferred auth/DNS and worker admission settle.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("selected account catalog physical dispatch", () => {
  it.each(["owner", "foreign"])(
    "dispatches credentials only for the authorized principal: %s",
    async (requester) => {
      principal = requester;
      if (requester === "foreign") {
        await expect(load()).rejects.toThrow("authority revoked");
        expect(transport.resolveAuth).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
      } else {
        expect(await load()).toMatchObject([{ provider: "openai", profileId, status: "ready" }]);
        expect(requests).toEqual([
          { path: "/models", authorization: "Bearer synthetic-account-token" },
        ]);
      }
    },
  );

  it.each(["auth", "transport", "generation"])(
    "sends zero requests when revoked during deferred %s",
    async (boundary) => {
      const entered = createDeferred();
      const release = createDeferred();
      if (boundary === "auth") {
        transport.resolveAuth.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { apiKey: credential.token, mode: "token", profileId };
        });
      } else {
        transport.preflight.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
        });
      }
      const result = load();
      const settled = result.catch((error: unknown) => error);
      await entered.promise;
      if (boundary === "generation") {
        generationCurrent = false;
      } else {
        authorized = false;
      }
      release.resolve();
      await settled;
      expect(requests).toEqual([]);
      if (boundary !== "generation") {
        await expect(result).rejects.toThrow("authority revoked");
      }
    },
  );

  it("does not revoke unrelated ambient discovery", async () => {
    authorized = false;
    const result = await fetchWithSsrFGuard({
      url: "http://127.0.0.1:" + server.claim.port + "/ambient",
      policy: { allowPrivateNetwork: true },
      capture: false,
    });
    await result.release();
    expect(requests).toEqual([{ path: "/ambient", authorization: undefined }]);
  });
});

describe("Gateway automatic account dispatch authority", () => {
  it.each(["allowed", "unlink-during-dns", "unlink-during-auth", "snapshot"] as const)(
    "binds ordinary models.list to its real default link: %s",
    async (scenario) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "catalog-link-authority-",
          agentEnv: "main",
          env: WITHOUT_OPENAI_ENV_AUTH,
        },
        async (state) => {
          const person = ensureProfileForEmail("catalog-authority@example.test");
          const selected = connectUserModelAccount({
            ownerProfileId: person.id,
            credential,
            assertCurrent() {},
          }).authProfileId;
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                model: "openai/gpt-5.4",
                models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
              },
            },
            gateway: {
              roles: {
                default: "reader",
                definitions: {
                  reader: {
                    agents: "*",
                    scopes: ["operator.read", "operator.write"],
                    sessions: { others: "none" },
                  },
                },
              },
            },
          };
          await state.writeConfig(cfg);
          const registry = createEmptyPluginRegistry();
          registry.providers.push({
            pluginId: "openai",
            source: "fixture",
            provider: buildOpenAIProvider(),
          });
          registry.agentHarnesses.push({
            pluginId: "codex",
            source: "fixture",
            harness: {
              id: "codex",
              label: "Codex",
              supports: () => ({ supported: true }),
              runAttempt: vi.fn(),
            },
          });
          const modelContext = createModelsListTestContext({
            cfg,
            agentDir: state.agentDir("main"),
            workspaceDir: state.workspaceDir,
            pluginRegistry: registry,
            catalog: [
              {
                id: "gpt-5.4",
                name: "Synthetic model",
                provider: "openai",
                api: "openai-chatgpt-responses",
                baseUrl: "https://chatgpt.com/backend-api/codex",
              },
            ],
          });
          const initial = await readPreparedCatalog(modelContext, "main");
          if (!initial) {
            throw new Error("Missing prepared catalog fixture");
          }
          const snapshot = {
            ...initial,
            accountCatalog: createPreparedAccountCatalogAccess(() => true),
          };
          registerGatewayModelCatalogPrivateAccess(modelContext.loadGatewayModelCatalogSnapshot, {
            readPrepared: async () => snapshot,
            loadDeferred: async () => snapshot,
          });
          const client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string } = {
            connId: "catalog-owner-connection",
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              client: {
                id: "openclaw-control-ui",
                version: "test",
                platform: "test",
                mode: "webchat",
              },
              role: "operator",
              scopes: ["operator.read", "operator.write"],
            },
            authenticatedUserProfile: {
              profileId: person.id,
              displayName: person.displayName,
              hasAvatar: false,
              updatedAt: person.updatedAt,
            },
          };
          const context = createDirectChatContext({
            ...modelContext,
            getClientConnIds: (filter) => new Set(!filter || filter(client) ? [client.connId] : []),
          });
          const service = createModelAccountConnectService({
            getConfig: () => cfg,
            onChanged: () => broadcastChatMetadataChanged(context),
          });
          context.modelAccountConnectService = service;
          const request = async (
            method: "models.list" | "users.unlinkAuthProfile",
            params: Record<string, unknown>,
          ) => {
            const respond = vi.fn<RespondFn>();
            const handler =
              method === "models.list" ? modelsHandlers[method] : usersAuthConnectHandlers[method];
            if (!handler) {
              throw new Error("Missing registered handler");
            }
            await handler({
              req: { type: "req", id: "catalog-link-proof", method, params },
              params,
              context,
              client,
              respond,
              isWebchatConnect: () => false,
            });
            return respond;
          };
          const entered = createDeferred();
          const release = createDeferred();
          const resolvedAuth = { apiKey: credential.token, mode: "token", profileId: selected };
          transport.resolveAuth.mockResolvedValue(resolvedAuth);
          if (scenario === "unlink-during-auth") {
            transport.resolveAuth.mockImplementationOnce(async () => {
              entered.resolve();
              await release.promise;
              return resolvedAuth;
            });
          } else if (scenario === "unlink-during-dns") {
            transport.preflight.mockImplementationOnce(async () => {
              entered.resolve();
              await release.promise;
            });
          }
          const readModels = () => request("models.list", { agentId: "main", view: "configured" });
          const pending =
            scenario === "snapshot"
              ? withOpenClawStateDatabaseReadSnapshot(readModels)
              : readModels();
          try {
            if (scenario !== "allowed" && scenario !== "snapshot") {
              await Promise.race([
                entered.promise,
                pending.then(() => {
                  throw new Error("Catalog completed before dispatch gate");
                }),
              ]);
              const unlinked = await request("users.unlinkAuthProfile", {
                profileId: person.id,
                provider: "openai",
              });
              expect(unlinked).toHaveBeenCalledWith(true, { links: [] });
              expect(listUserProfileAuthLinks(person.id)).toEqual([]);
              expect(readUserModelAuthProfile(selected)).toBeDefined();
              release.resolve();
            }
            if (scenario === "snapshot") {
              // Direct handlers reject here; the transport owns the error response.
              await expect(pending).rejects.toThrow(
                "Profile authority requires live state, not a discovery snapshot",
              );
              expect(transport.resolveAuth).not.toHaveBeenCalled();
              expect(requests).toHaveLength(0);
              return;
            }
            const response = await pending;
            expect(transport.resolveAuth).toHaveBeenCalledWith(
              expect.objectContaining({ profileId: selected, lockedProfile: true }),
            );
            if (scenario === "allowed") {
              expect(response.mock.calls[0]?.[0]).toBe(true);
              expect(requests).toHaveLength(1);
            } else {
              expect(requests).toHaveLength(0);
              expect(response.mock.calls[0]?.[0]).toBe(false);
              // Unlink removes the default, not the retained credential or an explicit self-owned selection.
              const pinned = await request("models.list", {
                agentId: "main",
                authProfileId: selected,
                view: "configured",
              });
              expect(pinned.mock.calls[0]?.[0]).toBe(true);
              expect(requests).toHaveLength(1);
            }
          } finally {
            release.resolve();
            await pending.catch(() => undefined);
            await service.stop();
          }
        },
      );
    },
  );
});
