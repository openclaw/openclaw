import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import * as modelCatalogRuntime from "../agents/model-catalog.runtime.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as profileAuthority from "../state/user-channel-identity-operations.js";
import { connectUserModelAccount, listUserProfileAuthLinks } from "../state/user-model-accounts.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createMentionInbox } from "./mention-inbox.js";
import { ModelAccountConnectAuthorityError } from "./model-account-connect-errors.js";
import { createModelAccountConnectService } from "./model-account-connect.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./server-methods/types.js";
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
const catalogEntries = () => [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }];
const forbidden = { ok: false, error: { code: "FORBIDDEN" } };
afterEach(() => vi.useRealTimers());

function withFixture(
  options: Parameters<typeof createFixture>,
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  return withOpenClawTestState({ layout: "state-only" }, async () =>
    run(await createFixture(...options)),
  );
}

function accountAccess(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return prepareSessionModelAccountAccess(
    {
      ...fixture,
      req: { type: "req", id: "account-authority", method: "sessions.create" },
      params: {},
      isWebchatConnect: () => false,
    },
    model,
  );
}

function directContext(context: GatewayRequestHandlerOptions["context"]) {
  return {
    getRuntimeConfig: context.getRuntimeConfig,
    getClientConnIds: context.getClientConnIds,
  };
}

function sessionCreation(
  client: GatewayClient,
  context: GatewayRequestHandlerOptions["context"],
  key: string,
  storePath: string,
  id: string,
) {
  const respond = vi.fn();
  const entry = () => loadSessionEntry({ sessionKey: key, storePath });
  const expectRejected = (code = "FORBIDDEN", details: Record<string, unknown> = {}) => {
    expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
      false,
      undefined,
      expect.objectContaining({ code, ...details }),
    ]);
    expect(entry()).toBeUndefined();
  };
  const create = (selectedModel?: string, idempotencyKey?: string) =>
    handleGatewayRequest({
      req: {
        type: "req",
        id,
        method: "sessions.create",
        params: {
          key,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
    });
  return { respond, entry, expectRejected, create };
}

function holdCatalog(context: GatewayRequestHandlerOptions["context"]) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const load = expectDefined(
    vi.mocked(context.loadGatewayModelCatalogSnapshot).getMockImplementation(),
    "catalog loader",
  );
  vi.spyOn(context, "loadGatewayModelCatalogSnapshot").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return load(...args);
  });
  return { entered, release };
}

test("rejects an actor replacement while preparing account authority", () =>
  withFixture(["operator.write", false], async (fixture) => {
    const replacement = ensureProfileForEmail("replacement@example.test");
    const prepare = profileAuthority.prepareUserProfileRolePolicyAuthority;
    vi.spyOn(profileAuthority, "prepareUserProfileRolePolicyAuthority").mockImplementationOnce(
      async (...args) => {
        const prepared = await prepare(...args);
        fixture.client.authenticatedUserProfile = identifiedClient(
          replacement.id,
        ).authenticatedUserProfile;
        return prepared;
      },
    );
    await expect(prepareUserModelAccountAction(fixture)).rejects.toBeInstanceOf(
      ModelAccountConnectAuthorityError,
    );
  }));

test.each(["during preparation", "after preparation"] as const)(
  "legacy model-account authority rejects an email relink %s",
  (phase) =>
    withFixture(["operator.write", false], async (fixture) => {
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
    }),
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
    loadGatewayModelCatalog: async () => catalogEntries(),
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
  const request = sessionCreation(client, context, key, storePath, "create-account-authority");
  const create = (selection?: string, idempotent = true) =>
    request.create(selection, idempotent ? "create-once" : undefined);
  return { authProfileId, client, clients, context, key, owner, role, ...request, create };
}

test.each([
  { scope: "operator.sessions.write", selection: "none", idempotent: false, origin: "human" },
  { scope: "operator.sessions.write", selection: "default", idempotent: true, origin: "human" },
  { scope: "operator.write", selection: "explicit", idempotent: true, origin: "human" },
  { scope: "operator.sessions.write", selection: "none", idempotent: true, origin: "agent" },
  { scope: "operator.sessions.write", selection: "default", idempotent: true, origin: "agent" },
  { scope: "operator.write", selection: "default", idempotent: true, origin: "agent" },
] as const)(
  "sessions.create from $origin with $scope preserves the $selection account choice (idempotent=$idempotent)",
  (row) =>
    withFixture([row.scope, row.selection !== "none", row.origin], async (fixture) => {
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
      const entry = fixture.entry();
      expect(entry).toMatchObject({
        createdActor: { type: "human", source: "profile", id: fixture.owner.id },
      });
      expect([entry?.authProfileOverride, entry?.authProfileOverrideSource]).toEqual([
        fixture.authProfileId,
        { none: undefined, explicit: "user", default: "user-link" }[row.selection],
      ]);
      expect(listUserProfileAuthLinks(fixture.owner.id)).toEqual(links);
    }),
);

test.each(["disconnect", "role scope", "connection scope", "profile"] as const)(
  "sessions.create rechecks its session-only account capture after %s changes during preparation",
  (change) =>
    withFixture(["operator.sessions.write", true], async (fixture) => {
      const { entered, release } = holdCatalog(fixture.context);
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
      fixture.expectRejected();
    }),
);

test("session-only creation does not authorize an explicit personal account selection", () =>
  withFixture(["operator.sessions.write", true], async (fixture) => {
    await fixture.create(`${model}@${expectDefined(fixture.authProfileId, "owned account")}`);
    fixture.expectRejected();
  }));

test("sessions.create rejects a session-only creator revoked after initial mention validation", () =>
  withFixture(["operator.sessions.write", false], async (fixture) => {
    const recipientProfile = ensureProfileForEmail("creation-recipient@example.test");
    const recipient = { ...identifiedClient(recipientProfile.id), connId: "creation-recipient" };
    fixture.clients.add(recipient);
    const cfg = fixture.context.getRuntimeConfig();
    const mentionConfig: typeof cfg = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        roles: {
          default: "guest",
          definitions: {
            guest: fixture.role,
            administrator: {
              agents: "*",
              scopes: ["operator.admin"],
              sessions: { others: "write" },
            },
            disabled: { agents: [], scopes: [], sessions: { others: "none" } },
          },
        },
      },
    };
    fixture.context.getRuntimeConfig = () => mentionConfig;
    setUserProfileRole(fixture.owner.id, "guest");
    setUserProfileRole(recipientProfile.id, "administrator");
    const inbox = createMentionInbox({
      scheduler: createTestGatewayScheduler(),
      gatewayInstanceId: "revoked-initial-mention",
      getRuntimeConfig: fixture.context.getRuntimeConfig,
      getClients: () => [...fixture.clients],
      broadcastToConnIds: vi.fn(),
    });
    fixture.context.mentionInbox = inbox;
    const validateRecipients = inbox.validateRecipientsAsync.bind(inbox);
    const validation = vi
      .spyOn(inbox, "validateRecipientsAsync")
      .mockImplementationOnce(async (...args) => {
        const result = await validateRecipients(...args);
        expect(result).toMatchObject({ ok: true });
        setUserProfileRole(fixture.owner.id, "disabled");
        return result;
      });
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "revoked-initial-mention",
          method: "sessions.create",
          params: {
            key: fixture.key,
            message: "@Recipient review this",
            mentions: [{ profileId: recipientProfile.id, start: 0, end: 10 }],
          },
        },
        client: fixture.client,
        context: fixture.context,
        respond: fixture.respond,
        isWebchatConnect: () => true,
      });
      expect(validation).toHaveBeenCalledOnce();
      fixture.expectRejected();
      const history = await directSessionReq<{ messages: unknown[] }>(
        "chat.history",
        { sessionKey: fixture.key },
        { client: recipient, context: directContext(fixture.context) },
      );
      expect(history).toMatchObject({ ok: true, payload: { messages: [] } });
      await inbox.listAsync(recipient, (result) => {
        expect(result).toMatchObject({ ok: true, value: { items: [] } });
      });
    } finally {
      await inbox.dispose();
    }
  }));

test("raw session-write scopes do not replace recorded session-create admission", () =>
  withFixture(["operator.sessions.write", false], async (fixture) => {
    const result = await directSessionReq(
      "sessions.create",
      { key: fixture.key, idempotencyKey: "direct-create" },
      {
        client: fixture.client,
        context: directContext(fixture.context),
      },
    );
    expect(result).toMatchObject(forbidden);
    expect(fixture.entry()).toBeUndefined();
  }));

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
    entries: catalogEntries(),
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
  const request = sessionCreation(client, context, key, storePath, "catalog-wait");
  const create = (selectedModel?: string, idempotencyKey = "catalog-wait") =>
    request.create(selectedModel, idempotencyKey);
  return { storePath, connection, revocation, catalog, context, key, ...request, create };
}

test.each(["deadline", "disconnect", "authority revocation"])(
  "sessions.create ends a stalled catalog wait on %s without a late commit",
  async (reason) => {
    const fixture = await createCatalogFixture(reason === "authority revocation");
    const { entered, release } = holdCatalog(fixture.context);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const creating = fixture.create(model);
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
      fixture.expectRejected("UNAVAILABLE", {
        message: expect.stringMatching(/model catalog.*loading.*session.*not created.*retry/i),
      });
      await creating;
    } finally {
      vi.useRealTimers();
      release.resolve();
      await creating;
    }
    expect(fixture.entry()).toBeUndefined();
    if (reason === "deadline") {
      fixture.respond.mockClear();
      await fixture.create(model);
      expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
      expect(fixture.entry()).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-4.1",
      });
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
  expect(fixture.entry()).toBeDefined();
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
  const creating = fixture.create(model);
  try {
    expect(
      await Promise.race([creating.then(() => "created"), entered.promise.then(() => "hydrating")]),
    ).toBe("created");
    expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
    expect(fixture.entry()).toBeDefined();
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
    await fixture.create(model, "seed");
    const before = fixture.entry();
    const gates = [holdCatalog(fixture.context), holdCatalog(fixture.context)];
    fixture.respond.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const creating = fixture.create(model);
    try {
      await Promise.race([gates[0]!.entered.promise, creating]);
      await vi.advanceTimersByTimeAsync(10_000);
      vi.setSystemTime(Date.now() + clockStep);
      gates[0]!.release.resolve();
      await Promise.race([gates[1]!.entered.promise, creating]);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fixture.respond).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.respond.mock.calls[0]?.slice(0, 3)).toEqual([
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
      ]);
      await creating;
      expect(fixture.entry()).toEqual(before);
    } finally {
      vi.useRealTimers();
      for (const gate of gates) {
        gate.release.resolve();
      }
      await creating;
    }
  },
);

test("ordinary tool default authority retains role revocation without main-thread SQL", () =>
  withFixture(["operator.write", true, "agent"], async (fixture) => {
    const { personalAccountDefaults } = await accountAccess(fixture);
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
  }));

test.each(["copied capability", "unadmitted session scope"] as const)(
  "ordinary tool default use rejects %s",
  (invalidAuthority) =>
    withFixture(["operator.write", true, "agent"], async (fixture) => {
      if (invalidAuthority === "copied capability") {
        const internal = expectDefined(fixture.client.internal, "hosted client");
        internal.operatorRunAuthority = {
          ...expectDefined(internal.operatorRunAuthority, "operator authority"),
        };
      } else {
        fixture.client.connect.scopes = ["operator.sessions.write"];
      }
      await expect(accountAccess(fixture)).rejects.toBeInstanceOf(
        ModelAccountConnectAuthorityError,
      );
    }),
);

test("an unqualified synthetic creation does not acquire the operator's default", () =>
  withFixture(["operator.write", true, "agent"], async (fixture) => {
    delete expectDefined(fixture.client.internal, "hosted client").sessionCreation;
    await fixture.create();
    expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
    const entry = fixture.entry();
    expect(entry).toBeDefined();
    expect(entry?.authProfileOverride).toBeUndefined();
  }));

test.each(["human", "agent"] as const)(
  "%s session creation authority does not permit personal account management",
  (origin) =>
    withFixture(
      [origin === "human" ? "operator.sessions.write" : "operator.write", true, origin],
      async (fixture) => {
        const authProfileId = expectDefined(fixture.authProfileId, "owned account");
        const links = listUserProfileAuthLinks(fixture.owner.id);
        if (origin === "agent") {
          await fixture.create(`${model}@${authProfileId}`);
          fixture.expectRejected();
        }
        const getConfig = fixture.context.getRuntimeConfig;
        const service = createModelAccountConnectService({ getConfig });
        try {
          const requests =
            origin === "human"
              ? ([
                  ["users.selectModelAccount", { authProfileId, profileId: fixture.owner.id }],
                  ["users.unlinkAuthProfile", { provider: "openai", profileId: fixture.owner.id }],
                ] as const)
              : ([
                  ["users.selectModelAccount", { authProfileId }],
                  [
                    "users.authConnect.start",
                    { profileId: fixture.owner.id, provider: "openai", method: "oauth" },
                  ],
                ] as const);
          const context = origin === "human" ? directContext(fixture.context) : fixture.context;
          for (const [method, params] of requests) {
            const result = await directSessionReq(method, params, {
              client: fixture.client,
              context: { ...context, modelAccountConnectService: service },
            });
            expect(result, JSON.stringify(result.error)).toMatchObject(forbidden);
          }
          expect(listUserProfileAuthLinks(fixture.owner.id)).toEqual(links);
        } finally {
          await service.stop();
        }
      },
    ),
);
