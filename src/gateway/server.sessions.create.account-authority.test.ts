import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import * as modelCatalogRuntime from "../agents/model-catalog.runtime.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as profileAuthority from "../state/user-channel-identity-operations.js";
import { connectUserModelAccount, listUserProfileAuthLinks } from "../state/user-model-accounts.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ModelAccountConnectAuthorityError } from "./model-account-connect-errors.js";
import { createModelAccountConnectService } from "./model-account-connect.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import { prepareUserModelAccountAction } from "./server-methods/users-model-account-access.js";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const model = "openai/gpt-4.1";
afterEach(() => vi.useRealTimers());

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
  { scope: "operator.sessions.write", selection: "default", idempotent: true },
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

async function createCatalogFixture(withCapturedAuthority = false) {
  const { storePath } = await createSessionStoreDir();
  const owner = ensureProfileForEmail("catalog-wait@example.test");
  const connection = new AbortController();
  const revocation = new AbortController();
  const client: GatewayClient & { connId: string } = {
    ...identifiedClient(owner.id),
    connId: "catalog-wait",
    connectionSignal: connection.signal,
  };
  if (withCapturedAuthority) {
    client.internal = {
      operatorRunAuthority: createAdmittedRunOperatorAuthority({
        profileId: owner.id,
        scopes: client.connect.scopes ?? [],
        signal: revocation.signal,
        assertCurrent: () => revocation.signal.throwIfAborted(),
      }),
    };
  }
  const config = await getGatewayConfigModule();
  config.clearRuntimeConfigSnapshot();
  const cfg = config.getRuntimeConfig();
  const catalog = {
    agentId: "main",
    agentDir: resolveAgentDir(cfg, "main"),
    workspaceDir: resolveAgentWorkspaceDir(cfg, "main"),
    config: cfg,
    catalogComplete: true,
    entries: [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
    routeVariants: [],
  };
  const context = createDirectChatContext({
    getRuntimeConfig: () => cfg,
    getClientConnIds: () => new Set(connection.signal.aborted ? [] : [client.connId]),
    readPreparedGatewayModelCatalog: async () => catalog,
    loadGatewayModelCatalogSnapshot: vi.fn(async () => catalog),
  });
  await initializeSessionReadContext(context);
  const key = "agent:main:dashboard:catalog-wait";
  const respond = vi.fn();
  const create = (selectedModel?: string, idempotencyKey = "catalog-wait") =>
    handleGatewayRequest({
      req: {
        type: "req",
        id: "catalog-wait",
        method: "sessions.create",
        params: { key, ...(selectedModel ? { model: selectedModel } : {}), idempotencyKey },
      },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
    });
  return { storePath, connection, revocation, catalog, context, key, respond, create };
}

test.each(["deadline", "disconnect", "authority revocation"])(
  "sessions.create ends a stalled catalog wait on %s without a late commit",
  async (reason) => {
    const fixture = await createCatalogFixture(reason === "authority revocation");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    vi.mocked(fixture.context.loadGatewayModelCatalogSnapshot).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return fixture.catalog;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const creating = fixture.create("openai/gpt-4.1");
    try {
      await Promise.race([entered.promise, creating]);
      expect(fixture.respond).not.toHaveBeenCalled();
      if (reason === "disconnect") {
        fixture.connection.abort();
      } else if (reason === "authority revocation") {
        fixture.revocation.abort(new Error("Operator authority revoked"));
        expect(fixture.connection.signal.aborted).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(reason === "deadline" ? 20_000 : 0);
      expect(fixture.respond.mock.calls[0]?.slice(0, 3)).toEqual([
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringMatching(/model catalog.*loading.*session.*not created.*retry/i),
        }),
      ]);
      await creating;
      expect(
        loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
      release.resolve();
      await creating;
    }
    expect(
      loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
    ).toBeUndefined();
    if (reason === "deadline") {
      fixture.respond.mockClear();
      await fixture.create("openai/gpt-4.1");
      expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
      expect(
        loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
      ).toMatchObject({ providerOverride: "openai", modelOverride: "gpt-4.1" });
    }
  },
);

test("sessions.create without catalog-dependent fields never waits on catalog publication", async () => {
  const fixture = await createCatalogFixture();
  vi.mocked(fixture.context.loadGatewayModelCatalogSnapshot).mockImplementation(
    () => new Promise(() => {}),
  );
  await fixture.create();
  expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
  expect(fixture.context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  expect(loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath })).toBeDefined();
});

test("sessions.create does not await unused thinking catalog hydration", async () => {
  const fixture = await createCatalogFixture();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const hydration = vi
    .spyOn(modelCatalogRuntime, "loadProviderScopedThinkingCatalog")
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return [];
    });
  const creating = fixture.create("openai/gpt-4.1");
  try {
    expect(
      await Promise.race([creating.then(() => "created"), entered.promise.then(() => "hydrating")]),
    ).toBe("created");
    expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
    expect(
      loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
    ).toBeDefined();
  } finally {
    release.resolve();
    await creating;
    hydration.mockRestore();
  }
});

test.each([-3_600_000, 3_600_000])(
  "sessions.create shares its catalog deadline across reads despite a %s ms clock step",
  async (clockStep) => {
    const fixture = await createCatalogFixture();
    await fixture.create("openai/gpt-4.1", "seed");
    const before = loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath });
    const entered = [createDeferredCore(), createDeferredCore()];
    const release = [createDeferredCore(), createDeferredCore()];
    for (const index of [0, 1]) {
      vi.mocked(fixture.context.loadGatewayModelCatalogSnapshot).mockImplementationOnce(
        async () => {
          entered[index]!.resolve();
          await release[index]!.promise;
          return fixture.catalog;
        },
      );
    }
    fixture.respond.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const creating = fixture.create("openai/gpt-4.1");
    try {
      await Promise.race([entered[0]!.promise, creating]);
      await vi.advanceTimersByTimeAsync(10_000);
      vi.setSystemTime(Date.now() + clockStep);
      release[0]!.resolve();
      await Promise.race([entered[1]!.promise, creating]);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fixture.respond).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.respond.mock.calls[0]?.slice(0, 3)).toEqual([
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
      ]);
      await creating;
      expect(loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath })).toEqual(
        before,
      );
    } finally {
      vi.useRealTimers();
      for (const gate of release) {
        gate.resolve();
      }
      await creating;
    }
  },
);
