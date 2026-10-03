import { expectDefined } from "@openclaw/normalization-core";
import { expect, onTestFinished, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as profileAuthority from "../state/user-channel-identity-operations.js";
import { connectUserModelAccount, listUserProfileAuthLinks } from "../state/user-model-accounts.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createModelAccountConnectService,
  ModelAccountConnectAuthorityError,
} from "./model-account-connect.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  prepareSessionModelAccountAccess,
  prepareUserModelAccountAction,
} from "./server-methods/users-model-account-access.js";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const model = "openai/gpt-4.1";

test("prepared model-account authority rechecks without main-thread SQL", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const fixture = await createFixture("operator.write", false);
    const sql = observeMainThreadSql();
    try {
      const action = await prepareUserModelAccountAction(fixture);
      sql.clear();
      for (let index = 0; index < 100; index++) {
        action.assertCurrent();
      }
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

test("rejects an actor replacement while preparing account authority", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const fixture = await createFixture("operator.write", false);
    const replacement = ensureProfileForEmail("replacement@example.test");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const prepare = profileAuthority.prepareUserProfileSelectionAuthority;
    vi.spyOn(profileAuthority, "prepareUserProfileSelectionAuthority").mockImplementationOnce(
      async (...args) => {
        const prepared = await prepare(...args);
        entered.resolve();
        await release.promise;
        return prepared;
      },
    );
    const request = prepareUserModelAccountAction(fixture);
    await entered.promise;
    fixture.client.authenticatedUserProfile = identifiedClient(
      replacement.id,
    ).authenticatedUserProfile;
    release.resolve();
    await expect(request).rejects.toBeInstanceOf(ModelAccountConnectAuthorityError);
  });
});

test.each(["during preparation", "after preparation"] as const)(
  "legacy model-account authority rejects an email relink %s",
  async (phase) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const fixture = await createFixture("operator.write", false);
      linkEmail("retained@example.test", fixture.owner.id);
      const replacement = ensureProfileForEmail("replacement@example.test");
      fixture.client.authenticatedUserId = "session-creator@example.test";
      delete fixture.client.authenticatedUserProfile;
      const relink = () => linkEmail("session-creator@example.test", replacement.id);
      if (phase === "during preparation") {
        const prepare = profileAuthority.prepareUserProfileRoleAuthority;
        vi.spyOn(profileAuthority, "prepareUserProfileRoleAuthority").mockImplementationOnce(
          async (...args) => {
            relink();
            return prepare(...args);
          },
        );
        await expect(prepareUserModelAccountAction(fixture)).rejects.toBeInstanceOf(
          ModelAccountConnectAuthorityError,
        );
      } else {
        const action = await prepareUserModelAccountAction(fixture);
        relink();
        expect(action.assertCurrent).toThrow(ModelAccountConnectAuthorityError);
      }
    });
  },
);

async function createFixture(
  scope: "operator.sessions.write" | "operator.write",
  personalAccount: boolean,
  origin: "human" | "agent" = "human",
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
  if (origin === "agent") {
    const captured = expectDefined(
      await captureGatewayOperatorRunAuthority({ client: { ...client }, context }),
      "admitted operator authority",
    );
    onTestFinished(captured.release);
    client.internal = {
      syntheticClient: true,
      operatorRoleActor: { kind: "operator", profileId: owner.id },
      operatorRunAuthority: captured.authority,
      sessionCreation: {
        via: "operator",
        actor: { type: "human", source: "profile", id: owner.id },
        requesterSessionKey: "agent:main:dashboard:source",
      },
      agentToolCaller: {
        agentId: "main",
        sessionKey: "agent:main:dashboard:source",
        assertCurrent() {},
      },
    };
    delete client.authenticatedUserProfile;
    delete client.authenticatedUserId;
  }
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
  { scope: "operator.sessions.write", selection: "none", idempotent: false, origin: "human" },
  { scope: "operator.sessions.write", selection: "none", idempotent: true, origin: "human" },
  { scope: "operator.sessions.write", selection: "default", idempotent: true, origin: "human" },
  { scope: "operator.write", selection: "explicit", idempotent: true, origin: "human" },
  { scope: "operator.sessions.write", selection: "none", idempotent: true, origin: "agent" },
  { scope: "operator.sessions.write", selection: "default", idempotent: true, origin: "agent" },
  { scope: "operator.write", selection: "default", idempotent: true, origin: "agent" },
] as const)(
  "sessions.create from $origin with $scope preserves the $selection account choice (idempotent=$idempotent)",
  async (row) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const fixture = await createFixture(row.scope, row.selection !== "none", row.origin);
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

test("ordinary tool default authority retains role revocation without main-thread SQL", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const fixture = await createFixture("operator.write", true, "agent");
    const options: GatewayRequestHandlerOptions = {
      ...fixture,
      req: { type: "req", id: "default-authority", method: "sessions.create" },
      params: {},
      isWebchatConnect: () => false,
    };
    const { personalAccountDefaults } = await prepareSessionModelAccountAccess(options, model);
    const action = expectDefined(personalAccountDefaults, "operator default authority");
    expect(action.owner).toBe(fixture.owner.id);
    const sql = observeMainThreadSql();
    try {
      for (let index = 0; index < 100; index++) {
        action.assertCurrent();
      }
      sql.expectIdle();
      fixture.role.scopes = ["operator.read"];
      expect(action.assertCurrent).toThrow(ModelAccountConnectAuthorityError);
      // Restoring a role cannot revive the original revoked source capability.
      fixture.role.scopes = ["operator.write"];
      expect(action.assertCurrent).toThrow(ModelAccountConnectAuthorityError);
    } finally {
      sql.restore();
    }
  });
});

test.each(["copied capability", "unadmitted session scope"] as const)(
  "ordinary tool default use rejects %s",
  async (invalidAuthority) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const fixture = await createFixture("operator.write", true, "agent");
      if (invalidAuthority === "copied capability") {
        const internal = expectDefined(fixture.client.internal, "hosted client");
        internal.operatorRunAuthority = {
          ...expectDefined(internal.operatorRunAuthority, "operator authority"),
        };
      } else {
        fixture.client.connect.scopes = ["operator.sessions.write"];
      }
      await expect(
        prepareSessionModelAccountAccess(
          {
            ...fixture,
            req: { type: "req", id: "invalid-authority", method: "sessions.create" },
            params: {},
            isWebchatConnect: () => false,
          },
          model,
        ),
      ).rejects.toBeInstanceOf(ModelAccountConnectAuthorityError);
    });
  },
);

test("an unqualified synthetic creation does not acquire the operator's default", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const fixture = await createFixture("operator.write", true, "agent");
    delete expectDefined(fixture.client.internal, "hosted client").sessionCreation;
    await fixture.create();
    expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
    const entry = loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath });
    expect(entry).toBeDefined();
    expect(entry?.authProfileOverride).toBeUndefined();
  });
});

test("ordinary tool default use does not authorize personal selection or account management", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const fixture = await createFixture("operator.write", true, "agent");
    const authProfileId = expectDefined(fixture.authProfileId, "owned account");
    const links = listUserProfileAuthLinks(fixture.owner.id);
    await fixture.create(`${model}@${authProfileId}`);
    expect(fixture.respond.mock.calls[0]?.slice(0, 3)).toEqual([
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    ]);
    expect(
      loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
    ).toBeUndefined();
    const service = createModelAccountConnectService({
      getConfig: fixture.context.getRuntimeConfig,
    });
    try {
      for (const [method, params] of [
        ["users.selectModelAccount", { authProfileId }],
        [
          "users.authConnect.start",
          { profileId: fixture.owner.id, provider: "openai", method: "oauth" },
        ],
      ] as const) {
        const result = await directSessionReq(method, params, {
          client: fixture.client,
          context: { ...fixture.context, modelAccountConnectService: service },
        });
        expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      }
      expect(listUserProfileAuthLinks(fixture.owner.id)).toEqual(links);
    } finally {
      await service.stop();
    }
  });
});
