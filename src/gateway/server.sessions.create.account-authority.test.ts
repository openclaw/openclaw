import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import { connectUserModelAccount, listUserProfileAuthLinks } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createModelAccountConnectService } from "./model-account-connect.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const model = "openai/gpt-4.1";

async function createFixture(
  scope: "operator.sessions.write" | "operator.write",
  personalAccount: boolean,
) {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = { model: { primary: model } };
  const owner = ensureProfileForEmail("session-creator@example.test");
  const authProfileId = personalAccount
    ? connectUserModelAccount({
        ownerProfileId: owner.id,
        credential: {
          type: "oauth",
          provider: "openai",
          access: "synthetic-session-create-access",
          refresh: "synthetic-session-create-refresh",
          expires: Date.now() + 60_000,
        },
        assertCurrent() {},
      }).authProfileId
    : undefined;
  const client = { ...identifiedClient(owner.id), connId: "session-creator-connection" };
  client.connect.scopes = [scope];
  const clients = new Set([client]);
  const role: GatewayOperatorRoleDefinition = {
    agents: ["main"],
    scopes: [scope],
    sessions: { others: "none" },
  };
  const config = await getGatewayConfigModule();
  config.clearRuntimeConfigSnapshot();
  const cfg = {
    ...config.getRuntimeConfig(),
    gateway: { roles: { default: "creator", definitions: { creator: role } } },
  };
  const context = createDirectChatContext({
    getRuntimeConfig: () => cfg,
    getClientConnIds: (filter) =>
      new Set([...clients].filter((current) => !filter || filter(current)).map((c) => c.connId)),
    loadGatewayModelCatalog: async () => [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
  });
  context.readPreparedGatewayModelCatalog = async () => {
    const catalog = await context.loadGatewayModelCatalogSnapshot();
    return { entries: catalog.entries, routeVariants: catalog.routeVariants };
  };
  await initializeSessionReadContext(context);
  const key = "agent:main:dashboard:account-authority";
  const respond = vi.fn();
  const create = (selection?: string, idempotent = true) =>
    handleGatewayRequest({
      req: {
        type: "req",
        id: "create-account-authority",
        method: "sessions.create",
        params: {
          key,
          ...(selection ? { model: selection } : {}),
          ...(idempotent ? { idempotencyKey: "create-once" } : {}),
        },
      },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
    });
  return { authProfileId, client, clients, context, create, key, owner, respond, role, storePath };
}

test.each([
  { scope: "operator.sessions.write", selection: "none", idempotent: false },
  { scope: "operator.sessions.write", selection: "none", idempotent: true },
  { scope: "operator.sessions.write", selection: "default", idempotent: true },
  { scope: "operator.write", selection: "default", idempotent: true },
  { scope: "operator.write", selection: "explicit", idempotent: true },
] as const)(
  "sessions.create with $scope preserves the $selection account choice (idempotent=$idempotent)",
  async (row) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const fixture = await createFixture(row.scope, row.selection !== "none");
      const links = listUserProfileAuthLinks(fixture.owner.id);
      await fixture.create(
        row.selection === "explicit"
          ? `${model}@${expectDefined(fixture.authProfileId, "owned account")}`
          : undefined,
        row.idempotent,
      );

      expect(fixture.respond.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        expect.objectContaining({ ok: true }),
      ]);
      const entry = loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath });
      expect(entry).toMatchObject({
        createdActor: { type: "human", source: "profile", id: fixture.owner.id },
      });
      expect(entry?.authProfileOverride).toBe(fixture.authProfileId);
      expect(entry?.authProfileOverrideSource).toBe(
        row.selection === "none" ? undefined : row.selection === "explicit" ? "user" : "user-link",
      );
      expect(listUserProfileAuthLinks(fixture.owner.id)).toEqual(links);
    });
  },
);

test.each(["disconnect", "role scope", "connection scope", "profile"] as const)(
  "sessions.create rechecks its session-only account capture after %s changes during preparation",
  async (change) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const fixture = await createFixture("operator.sessions.write", true);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const loadCatalog = fixture.context.loadGatewayModelCatalogSnapshot;
      fixture.context.loadGatewayModelCatalogSnapshot = vi.fn<typeof loadCatalog>(
        async (request) => {
          entered.resolve();
          await release.promise;
          return await loadCatalog(request);
        },
      );
      const request = fixture.create(model);
      try {
        await Promise.race([entered.promise, request]);
        expect(fixture.respond).not.toHaveBeenCalled();
        if (change === "disconnect") {
          fixture.clients.delete(fixture.client);
        } else if (change === "role scope") {
          fixture.role.scopes = ["operator.sessions.read"];
        } else if (change === "connection scope") {
          fixture.client.connect.scopes = ["operator.sessions.read"];
        } else {
          fixture.client.authenticatedUserProfile = identifiedClient(
            ensureProfileForEmail("replacement-creator@example.test").id,
          ).authenticatedUserProfile;
        }
      } finally {
        release.resolve();
        await request;
      }
      expect(fixture.respond.mock.calls[0]?.slice(0, 3)).toEqual([
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      ]);
      expect(
        loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
      ).toBeUndefined();
    });
  },
);

test("session-only creation does not authorize an explicit personal account selection", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const fixture = await createFixture("operator.sessions.write", true);
    await fixture.create(`${model}@${expectDefined(fixture.authProfileId, "owned account")}`);
    expect(fixture.respond.mock.calls[0]?.slice(0, 3)).toEqual([
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    ]);
    expect(
      loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
    ).toBeUndefined();
  });
});

test("raw session-write scopes do not replace recorded session-create admission", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const fixture = await createFixture("operator.sessions.write", false);
    const result = await directSessionReq(
      "sessions.create",
      { key: fixture.key, idempotencyKey: "direct-create" },
      {
        client: fixture.client,
        context: {
          getRuntimeConfig: fixture.context.getRuntimeConfig,
          getClientConnIds: fixture.context.getClientConnIds,
        },
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(
      loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
    ).toBeUndefined();
  });
});

test("session-only creation authority does not permit changing personal defaults", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const fixture = await createFixture("operator.sessions.write", true);
    const links = listUserProfileAuthLinks(fixture.owner.id);
    const service = createModelAccountConnectService({
      getConfig: fixture.context.getRuntimeConfig,
    });
    try {
      for (const [method, params] of [
        [
          "users.selectModelAccount",
          { authProfileId: expectDefined(fixture.authProfileId, "owned account") },
        ],
        ["users.unlinkAuthProfile", { provider: "openai" }],
      ] as const) {
        const result = await directSessionReq(
          method,
          { ...params, profileId: fixture.owner.id },
          {
            client: fixture.client,
            context: {
              getRuntimeConfig: fixture.context.getRuntimeConfig,
              getClientConnIds: fixture.context.getClientConnIds,
              modelAccountConnectService: service,
            },
          },
        );
        expect(result, JSON.stringify(result.error)).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN" },
        });
      }
      expect(listUserProfileAuthLinks(fixture.owner.id)).toEqual(links);
    } finally {
      await service.stop();
    }
  });
});
