import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import { loadSelectedProviderAccountCatalog } from "../src/agents/models-config.providers.catalog-context.js";
import { createPreparedAccountCatalogAccess } from "../src/agents/prepared-model-runtime.catalog-auth.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../src/config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createModelAccountConnectService } from "../src/gateway/model-account-connect.js";
import { broadcastChatMetadataChanged } from "../src/gateway/server-chat-metadata-lifecycle.js";
import { createDirectChatContext } from "../src/gateway/server-chat.agent-events.test-helpers.js";
import { callAgentHandler } from "../src/gateway/server-methods/agents-mutate.test-support.js";
import {
  createModelsListTestContext,
  catalogEntry,
  WITHOUT_OPENAI_ENV_AUTH,
} from "../src/gateway/server-methods/models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "../src/gateway/server-methods/models.js";
import { roleConfig } from "../src/gateway/server-methods/sessions-reactions.test-support.js";
import { usersHandlers as usersAuthConnectHandlers } from "../src/gateway/server-methods/users.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../src/gateway/server-model-catalog-auth.js";
import { createOperatorWsClient } from "../src/gateway/server/ws-connection/authenticated-request-dispatch.test-support.js";
import { fetchWithSsrFGuard } from "../src/infra/net/fetch-guard.js";
import { clearLiveCatalogCacheForTests } from "../src/plugin-sdk/provider-catalog-shared.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../src/state/openclaw-state-db-readonly.js";
import {
  connectUserModelAccount,
  listUserProfileAuthLinks,
  readUserModelAuthProfile,
} from "../src/state/user-model-accounts.js";
import { prepareUserProfileCatalog } from "../src/state/user-profile-list.js";
import { ensureProfileForEmail } from "../src/state/user-profiles.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { respondJson } from "./helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "./helpers/promise.js";

const transport = vi.hoisted(() => ({
  endpoint: "",
  preflight: vi.fn<() => Promise<void>>(),
  resolveAuth: vi.fn<() => Promise<unknown>>(),
}));

// mock-isolation: Synthetic selected-account auth avoids host credentials while preserving guarded HTTP dispatch.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: transport.resolveAuth,
  resolveProviderAuthProfileMetadataAsync: async () => ({ accountId: "synthetic-account" }),
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
const resolvedAuth = (selected: string) => ({
  apiKey: credential.token,
  mode: "token",
  profileId: selected,
});
const authenticatedRequest = { path: "/models", authorization: `Bearer ${credential.token}` };
const requests: Array<{ path: string | undefined; authorization: string | undefined }> = [];
let server: Awaited<ReturnType<typeof reserveTestPortListener>>;
let authority = { generationCurrent: true, principal: "owner", authorized: true };

function assertCurrent() {
  if (!authority.authorized || authority.principal !== "owner") {
    throw new Error("Selected personal account authority revoked");
  }
}

function deferDispatch(auth: boolean, selected = profileId) {
  const entered = createDeferred();
  const release = createDeferred();
  const wait = async () => {
    entered.resolve();
    await release.promise;
  };
  if (auth) {
    transport.resolveAuth.mockImplementationOnce(async () => {
      await wait();
      return resolvedAuth(selected);
    });
  } else {
    transport.preflight.mockImplementationOnce(wait);
  }
  return { entered: entered.promise, release: release.resolve };
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
    isCurrent: () => authority.generationCurrent,
    assertCurrent,
  });
}

beforeAll(async () => {
  server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        requests.push({ path: request.url, authorization: request.headers.authorization });
        respondJson(response, { models: [{ slug: "gpt-5.4", visibility: "list" }] });
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
  authority = { generationCurrent: true, principal: "owner", authorized: true };
  transport.preflight.mockReset().mockResolvedValue(undefined);
  transport.resolveAuth.mockReset().mockResolvedValue(resolvedAuth(profileId));
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  vi.stubEnv("OPENAI_API_KEY", "");
  // Hold catalog deadlines while deferred auth/DNS and worker admission settle.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("rejects a foreign principal before resolving credentials", async () => {
  authority.principal = "foreign";
  await expect(load()).rejects.toThrow("authority revoked");
  expect(transport.resolveAuth).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
});

it("sends zero requests when the catalog generation changes during DNS", async () => {
  const gate = deferDispatch(false);
  const settled = load().catch((error: unknown) => error);
  await gate.entered;
  authority.generationCurrent = false;
  gate.release();
  await settled;
  expect(requests).toEqual([]);
});

it("does not revoke unrelated ambient discovery", async () => {
  authority.authorized = false;
  const result = await fetchWithSsrFGuard({
    url: "http://127.0.0.1:" + server.claim.port + "/ambient",
    policy: { allowPrivateNetwork: true },
    capture: false,
  });
  await result.release();
  expect(requests).toEqual([{ path: "/ambient", authorization: undefined }]);
});
it.each([
  ["allowed", false, null, null],
  ["unlink-during-dns", false, "dns", null],
  ["unlink-during-auth", false, "auth", null],
  ["snapshot", false, "snapshot", null],
  ["saved-allowed", true, null, null],
  ["saved-visibility-during-dns", true, "dns", { visibility: "draft" }],
  ["saved-account-during-dns", true, "dns", { authProfileOverride: "openai:changed-account" }],
] as const)(
  "binds models.list discovery to current account and session authority: %s",
  (_scenario, saved, boundary, sessionChange) =>
    withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "catalog-link-authority-",
        prepareProfileCatalog: true,
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
        const viewer = saved ? ensureProfileForEmail("catalog-viewer@example.test") : person;
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const sessionKey = "agent:main:catalog-authority-saved";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: "openai/gpt-5.4",
              models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
            },
          },
          ...roleConfig(saved ? "view" : "none"),
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        if (saved) {
          await replaceSessionEntry(
            { agentId: "main", sessionKey },
            {
              sessionId: "catalog-authority-saved",
              updatedAt: 1,
              visibility: "shared",
              createdActor: { type: "human", source: "profile", id: person.id },
              providerOverride: "openai",
              modelOverride: "gpt-5.4",
              authProfileOverride: selected,
              authProfileOverrideSource: "user",
            },
          );
        }
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
              ...catalogEntry("gpt-5.4", "openai-chatgpt-responses"),
              baseUrl: "https://chatgpt.com/backend-api/codex",
            },
          ],
        });
        const snapshot = {
          ...expectDefined(await readPreparedCatalog(modelContext, "main"), "catalog fixture"),
          accountCatalog: createPreparedAccountCatalogAccess(() => true),
        };
        registerGatewayModelCatalogPrivateAccess(modelContext.loadGatewayModelCatalogSnapshot, {
          readPrepared: async () => snapshot,
          loadDeferred: async () => snapshot,
        });
        const client = {
          ...createOperatorWsClient({
            connId: "catalog-owner-connection",
            clientInfo: { id: "openclaw-control-ui", mode: "webchat" },
            scopes: ["operator.read", "operator.write"],
          }),
          authenticatedUserProfile: {
            profileId: viewer.id,
            displayName: viewer.displayName,
            hasAvatar: false,
            updatedAt: viewer.updatedAt,
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
        const request = (
          method: "models.list" | "users.unlinkAuthProfile",
          params: Record<string, unknown>,
        ) =>
          callAgentHandler(
            expectDefined(
              method === "models.list" ? modelsHandlers[method] : usersAuthConnectHandlers[method],
              "registered handler",
            ),
            method,
            params,
            { context, client },
          );
        transport.resolveAuth.mockResolvedValue(resolvedAuth(selected));
        const allowed = boundary === null;
        const gate =
          boundary === "dns" || boundary === "auth"
            ? deferDispatch(boundary === "auth", selected)
            : undefined;
        const readModels = (params: Record<string, unknown> = {}) =>
          request("models.list", {
            agentId: "main",
            view: "configured",
            refresh: true,
            ...(saved ? { sessionKey } : {}),
            ...params,
          });
        const pending =
          boundary === "snapshot"
            ? withOpenClawStateDatabaseReadSnapshot(readModels)
            : readModels();
        try {
          if (gate) {
            await awaitGateBeforeSettlement(
              gate.entered,
              pending,
              "Catalog completed before dispatch gate",
            );
            if (sessionChange) {
              await upsertSessionEntryCore({ agentId: "main", sessionKey }, sessionChange);
            } else {
              const unlinked = await request("users.unlinkAuthProfile", {
                profileId: person.id,
                provider: "openai",
              });
              expect(unlinked).toHaveBeenCalledWith(true, { links: [] });
              expect(listUserProfileAuthLinks(person.id)).toEqual([]);
              expect(readUserModelAuthProfile(selected)).toBeDefined();
            }
            gate.release();
          }
          if (boundary === "snapshot") {
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
          expect(response.mock.calls[0]?.[0]).toBe(allowed);
          if (allowed) {
            expect(requests).toEqual([authenticatedRequest]);
          } else {
            expect(requests).toHaveLength(0);
            if (saved) {
              return;
            }
            // Unlink removes the default, not the retained credential or an explicit self-owned selection.
            const pinned = await readModels({ authProfileId: selected });
            expect(pinned.mock.calls[0]?.[0]).toBe(true);
            expect(requests).toHaveLength(1);
          }
        } finally {
          gate?.release();
          await pending.catch(() => undefined);
          await service.stop();
        }
      },
    ),
);
