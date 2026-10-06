import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import * as userModelAccounts from "../../state/user-model-accounts.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { ADMIN_SCOPE, READ_SCOPE, SESSION_READ_SCOPE } from "../operator-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import * as sessionReads from "../session-utils-store.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import {
  connectChatMetadataAccount,
  createChatMetadataHarness,
} from "./chat-metadata-runtime.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

function createPersonalMetadataFixture(
  scopes: GatewayOperatorRoleDefinition["scopes"] = [READ_SCOPE],
) {
  const owner = ensureProfileForEmail("metadata-owner@example.test");
  const authProfileId = connectChatMetadataAccount(owner.id);
  const client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string } = {
    connId: "metadata-owner-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: [...scopes],
    },
    authenticatedUserProfile: {
      profileId: owner.id,
      displayName: owner.displayName,
      hasAvatar: false,
      updatedAt: owner.updatedAt,
    },
  };
  const role: GatewayOperatorRoleDefinition = {
    agents: "*",
    scopes: [...scopes],
    sessions: { others: "none" },
  };
  const config = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, other: {} },
    },
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: role,
          blocked: { agents: [], scopes: [], sessions: { others: "none" } },
        },
      },
    },
  } satisfies OpenClawConfig;
  let currentConfig: OpenClawConfig = config;
  const clients = new Set([client]);
  const metadata = { models: [], swarmEnabled: false };
  const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => metadata);
  const context = createDirectChatContext({
    getRuntimeConfig: () => currentConfig,
    readChatMetadata,
    getClientConnIds: (filter) =>
      new Set(
        [...clients]
          .filter((current) => !filter || filter(current))
          .map((current) => current.connId),
      ),
  });
  const request = async (
    params: Record<string, unknown>,
    overrides: Partial<Pick<GatewayRequestHandlerOptions, "client" | "signal">> = {},
  ) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      chatHistoryHandlers["chat.metadata"],
      "metadata handler",
    )({
      params,
      context,
      client,
      respond,
      req: { type: "req", id: "draft-preview", method: "chat.metadata" },
      isWebchatConnect: () => false,
      ...overrides,
    });
    return respond;
  };
  return {
    owner,
    authProfileId,
    client,
    clients,
    config,
    context,
    role,
    setConfig: (next: OpenClawConfig) => {
      currentConfig = next;
    },
    metadata,
    readChatMetadata,
    request,
  };
}

function dispatchMetadata(
  fixture: Pick<ReturnType<typeof createPersonalMetadataFixture>, "client" | "context">,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const respond = vi.fn<RespondFn>();
  const pending = handleGatewayRequest({
    req: { type: "req", id: "metadata-dispatch", method: "chat.metadata", params },
    client: fixture.client,
    context: fixture.context,
    isWebchatConnect: () => false,
    respond,
    signal,
  });
  return { pending, respond };
}

describe("chat metadata ownership", () => {
  it("serves commands without preparing a catalog when the client reads models separately", async () => {
    const config: OpenClawConfig = { agents: { entries: { main: {} } } };
    const harness = createChatMetadataHarness(config);
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      readChatMetadata: harness.runtime.read,
    });
    const request = async (includeModels?: boolean) => {
      const respond = vi.fn<RespondFn>();
      await expectDefined(
        chatHistoryHandlers["chat.metadata"],
        "metadata handler",
      )({
        params: { agentId: "main", ...(includeModels === false ? { includeModels } : {}) },
        context,
        client: null,
        respond,
        req: { type: "req", id: "commands-only", method: "chat.metadata" },
        isWebchatConnect: () => false,
      });
      return respond;
    };
    try {
      await harness.runtime.refresh();
      const compact = await request(false);
      expect(compact).toHaveBeenCalledWith(true, {
        commands: [{ name: "command-1-1" }],
        swarmEnabled: true,
      });
      expect(harness.buildProjection).not.toHaveBeenCalled();
      const legacy = await request();
      expect(legacy).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          models: [expect.objectContaining({ id: "first" })],
          commands: [{ name: "command-1-1" }],
        }),
      );
    } finally {
      await harness.runtime.stop();
    }
  });

  it("creates and reuses a legacy requester profile through chat.metadata without host SQL", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      ensureProfileForEmail("admitted@example.test");
      const config: OpenClawConfig = { agents: { entries: { main: {} } } };
      const metadata = { models: [], swarmEnabled: false };
      const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(
        async () => metadata,
      );
      const context = createDirectChatContext({ getRuntimeConfig: () => config, readChatMetadata });
      const respond = vi.fn<RespondFn>();
      const client: NonNullable<GatewayRequestHandlerOptions["client"]> = {
        connId: "metadata-legacy-connection",
        authenticatedUserId: "metadata-legacy@example.test",
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
          role: "operator",
          scopes: [READ_SCOPE],
        },
      };
      requireNodeSqlite();
      const sql = observeMainThreadSql();
      try {
        sql.calibrate();
        for (let attempt = 0; attempt < 2; attempt++) {
          await expectDefined(
            chatHistoryHandlers["chat.metadata"],
            "metadata handler",
          )({
            params: { agentId: "main" },
            context,
            client,
            respond,
            req: { type: "req", id: `legacy-profile-${attempt}`, method: "chat.metadata" },
            isWebchatConnect: () => false,
          });
        }
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      const profile = ensureProfileForEmail("metadata-legacy@example.test");
      expect(readChatMetadata).toHaveBeenCalledTimes(2);
      for (const [scope] of readChatMetadata.mock.calls) {
        expect(scope.requesterProfileId).toBe(profile.id);
        expect(scope.assertCurrent).not.toThrow();
      }
      expect(respond.mock.calls).toEqual([
        [true, metadata],
        [true, metadata],
      ]);
    });
  });

  it.each([READ_SCOPE, SESSION_READ_SCOPE])(
    "previews a retained personal account with %s without changing its cleared default",
    async (scope) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const fixture = createPersonalMetadataFixture([scope]);
        const { owner, authProfileId, metadata, readChatMetadata } = fixture;
        userModelAccounts.clearUserProfileAuthLink({ profileId: owner.id, provider: "openai" });
        const before = userModelAccounts.readUserModelAuthProfile(authProfileId);

        const { pending, respond } = dispatchMetadata(fixture, { agentId: "main", authProfileId });
        await pending;

        expect(respond).toHaveBeenCalledWith(true, metadata);
        expect(readChatMetadata).toHaveBeenCalledWith({
          agentId: "main",
          requesterProfileId: owner.id,
          isCurrent: expect.any(Function),
          assertCurrent: expect.any(Function),
          draftAccountSelection: expect.objectContaining({
            owner: owner.id,
            authProfileId,
            assertCurrent: expect.any(Function),
          }),
        });
        expect(userModelAccounts.listUserProfileAuthLinks(owner.id)).toEqual([]);
        expect(userModelAccounts.readUserModelAuthProfile(authProfileId)).toEqual(before);
      });
    },
  );

  it.each([
    "foreign admin",
    "unidentified admin",
    "anonymous",
    "synthetic owner",
    "forged locator",
  ] as const)(
    "rejects a personal draft preview from %s before projecting credentials",
    async (caller) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const { owner, client, authProfileId, readChatMetadata, request } =
          createPersonalMetadataFixture();
        client.connect.scopes = ["operator.admin"];
        let requestedProfile = authProfileId;
        if (caller === "foreign admin") {
          const other = ensureProfileForEmail("metadata-other@example.test");
          client.authenticatedUserProfile = {
            profileId: other.id,
            displayName: other.displayName,
            hasAvatar: false,
            updatedAt: other.updatedAt,
          };
        } else if (caller === "unidentified admin") {
          delete client.authenticatedUserProfile;
        } else if (caller === "synthetic owner") {
          client.internal = { syntheticClient: true };
        } else if (caller === "forged locator") {
          requestedProfile = `personal:${owner.id}:${randomUUID()}`;
        }

        const respond = await request(
          { agentId: "main", authProfileId: requestedProfile },
          caller === "anonymous" ? { client: null } : {},
        );

        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
        expect(readChatMetadata).not.toHaveBeenCalled();
      });
    },
  );

  it("rejects combining a personal draft preview with a persisted session selector", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const { authProfileId, readChatMetadata, request } = createPersonalMetadataFixture();
      const respond = await request({
        agentId: "main",
        sessionKey: "agent:main:existing",
        authProfileId,
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(readChatMetadata).not.toHaveBeenCalled();
    });
  });

  it.each(["disconnect", "role loss", "abort"] as const)(
    "rejects a personal draft preview after %s during the metadata read",
    async (loss) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const { client, clients, authProfileId, config, metadata, readChatMetadata, request } =
          createPersonalMetadataFixture();
        const entered = createDeferred();
        const release = createDeferred();
        const abort = new AbortController();
        readChatMetadata.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return metadata;
        });
        const pending = request({ agentId: "main", authProfileId }, { signal: abort.signal });
        try {
          await Promise.race([entered.promise, pending]);
          expect(readChatMetadata).toHaveBeenCalledOnce();
          if (loss === "disconnect") {
            clients.delete(client);
          } else if (loss === "role loss") {
            config.gateway.roles.definitions.reader.scopes = [];
          } else {
            abort.abort();
          }
        } finally {
          release.resolve();
          await pending;
        }
        const respond = await pending;
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
      });
    },
  );

  it("reads saved and neutral metadata without host SQL or sharing the saved profile", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:locked";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "locked",
          updatedAt: 1,
          authProfileOverride: "test:locked",
          authProfileOverrideSource: "user",
        },
      );
      const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => ({
        commands: [],
        models: [],
        swarmEnabled: false,
      }));
      const respond = vi.fn<RespondFn>();
      const handler = expectDefined(chatHistoryHandlers["chat.metadata"], "metadata handler");
      const context = createDirectChatContext({ readChatMetadata });
      requireNodeSqlite();
      const sql = observeMainThreadSql();
      try {
        sql.calibrate();
        for (const params of [{ agentId: "   ", sessionKey }, { agentId: "main" }]) {
          await handler({
            params,
            context,
            respond,
            req: { type: "req", id: "saved-selection", method: "chat.metadata" },
            client: null,
            isWebchatConnect: () => false,
          });
        }
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      expect(readChatMetadata.mock.calls).toEqual([
        [
          expect.objectContaining({
            agentId: "main",
            sessionKey,
            isCurrent: expect.any(Function),
            sessionEntry: expect.objectContaining({
              authProfileOverride: "test:locked",
              authProfileOverrideSource: "user",
            }),
          }),
        ],
        [
          {
            agentId: "main",
            requesterProfileId: undefined,
            isCurrent: expect.any(Function),
            assertCurrent: expect.any(Function),
          },
        ],
      ]);
      expect(respond).toHaveBeenCalledTimes(2);
      readChatMetadata.mockClear();
      await handler({
        params: { agentId: "other", sessionKey },
        context,
        respond,
        req: { type: "req", id: "mismatched-agent", method: "chat.metadata" },
        client: null,
        isWebchatConnect: () => false,
      });
      expect(readChatMetadata).not.toHaveBeenCalled();
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    });
  });

  it("returns a typed selection error for an ownerless explicit fleet", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
    };
    const respond = vi.fn<RespondFn>();
    const readChatMetadata = vi.fn();

    await expectDefined(
      chatHistoryHandlers["chat.metadata"],
      'chatHistoryHandlers["chat.metadata"] test invariant',
    )({
      params: {},
      respond,
      req: { type: "req", id: "ownerless-fleet", method: "chat.metadata" },
      client: null,
      isWebchatConnect: () => false,
      context: createDirectChatContext({
        getRuntimeConfig: () => config,
        readChatMetadata,
      }),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("has no explicit owner"),
      }),
    );
    expect(readChatMetadata).not.toHaveBeenCalled();
  });
});

describe("chat metadata dispatch authority", () => {
  it.each([
    { name: "ordinary foreign draft", visibility: "draft", incognito: false },
    { name: "foreign incognito session", visibility: "shared", incognito: true },
  ] as const)("denies $name before preparing metadata", async ({ visibility, incognito }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = createPersonalMetadataFixture([SESSION_READ_SCOPE]);
      fixture.role.sessions.others = "view";
      await state.writeConfig(fixture.config);
      const other = ensureProfileForEmail("metadata-foreign@example.test");
      const sessionKey = "agent:main:hidden-metadata";
      const entry: SessionEntry = {
        sessionId: "hidden-metadata",
        updatedAt: 1,
        visibility,
        createdActor: { type: "human", source: "profile", id: other.id },
      };
      if (incognito) {
        entry.incognito = true;
      }
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);

      const { pending, respond } = dispatchMetadata(fixture, { sessionKey });
      await pending;

      expect(respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("not found"),
        }),
      );
      expect(fixture.readChatMetadata).not.toHaveBeenCalled();
    });
  });

  it.each([
    { name: "ordinary shared", visibility: "shared", own: false, admin: false, incognito: false },
    { name: "own draft", visibility: "draft", own: true, admin: false, incognito: false },
    { name: "admin incognito", visibility: "draft", own: false, admin: true, incognito: true },
  ] as const)(
    "reads $name metadata outside the creation agent allowlist",
    async ({ visibility, own, admin, incognito }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = createPersonalMetadataFixture([admin ? ADMIN_SCOPE : SESSION_READ_SCOPE]);
        fixture.role.agents = ["main"];
        fixture.role.sessions.others = "view";
        await state.writeConfig(fixture.config);
        const other = ensureProfileForEmail("metadata-foreign@example.test");
        const sessionKey = "agent:other:visible-metadata";
        const entry: SessionEntry = {
          sessionId: "visible-metadata",
          updatedAt: 1,
          visibility,
          createdActor: {
            type: "human",
            source: "profile",
            id: own ? fixture.owner.id : other.id,
          },
        };
        if (incognito) {
          entry.incognito = true;
        }
        await upsertSessionEntryCore({ agentId: "other", sessionKey }, entry);

        const { pending, respond } = dispatchMetadata(fixture, { sessionKey });
        await pending;

        expect(respond).toHaveBeenCalledExactlyOnceWith(true, fixture.metadata);
        expect(fixture.readChatMetadata).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "other",
            sessionKey,
            sessionEntry: expect.objectContaining({ sessionId: "visible-metadata" }),
          }),
        );
      });
    },
  );

  it.each(["draft", "missing saved row"] as const)(
    "keeps %s metadata readable outside the creation allowlist",
    async (selector) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = createPersonalMetadataFixture([SESSION_READ_SCOPE]);
        fixture.role.agents = ["main"];
        fixture.role.sessions.others = "view";
        await state.writeConfig(fixture.config);
        const { pending, respond } = dispatchMetadata(
          fixture,
          selector === "draft"
            ? { agentId: "other", authProfileId: fixture.authProfileId }
            : { sessionKey: "agent:other:missing-metadata" },
        );
        await pending;

        expect(respond).toHaveBeenCalledExactlyOnceWith(true, fixture.metadata);
        expect(fixture.readChatMetadata).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: "other" }),
        );
      });
    },
  );

  it.each([
    { change: "title", patch: { displayName: "First reply" }, current: true },
    {
      change: "run start",
      patch: { updatedAt: 2, startedAt: 2, status: "running" },
      current: true,
    },
    { change: "ordinary patch", patch: { thinkingLevel: "high" }, current: true },
    { change: "visibility", patch: { visibility: "draft" }, current: false },
    { change: "account", patch: { authProfileOverride: "test:replacement" }, current: false },
    { change: "model", patch: { modelOverride: "replacement" }, current: false },
    { change: "model route", patch: { modelOverrideRouteResolution: "resolved" }, current: false },
    { change: "runtime", patch: { agentRuntimeOverride: "replacement" }, current: false },
    { change: "runtime lock", patch: { modelSelectionLocked: true }, current: false },
    { change: "lifecycle", patch: { lifecycleRevision: "replacement" }, current: false },
  ] satisfies { change: string; patch: Partial<SessionEntry>; current: boolean }[])(
    "revalidates $change changes during metadata preparation",
    async ({ patch, current }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = createPersonalMetadataFixture([SESSION_READ_SCOPE]);
        fixture.role.sessions.others = "view";
        await state.writeConfig(fixture.config);
        const other = ensureProfileForEmail("metadata-foreign@example.test");
        const scope = { agentId: "main", sessionKey: "agent:main:changing-metadata" };
        await upsertSessionEntryCore(scope, {
          sessionId: "changing-metadata",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: other.id },
        });
        const entered = createDeferred();
        const release = createDeferred();
        fixture.readChatMetadata.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return fixture.metadata;
        });
        const { pending, respond } = dispatchMetadata(fixture, { sessionKey: scope.sessionKey });
        const settled = Promise.allSettled([pending]);
        try {
          await Promise.race([entered.promise, pending]);
          expect(fixture.readChatMetadata).toHaveBeenCalledOnce();
          await patchSessionEntryCore(scope, () => patch);
        } finally {
          release.resolve();
          await settled;
        }

        if (current) {
          await pending;
          expect(respond).toHaveBeenCalledExactlyOnceWith(true, fixture.metadata);
        } else {
          await expect(pending).rejects.toBeInstanceOf(
            PreparedModelRuntimePublicationSupersededError,
          );
          expect(respond).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("refuses a missing saved row created during metadata preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = createPersonalMetadataFixture([SESSION_READ_SCOPE]);
      await state.writeConfig(fixture.config);
      const sessionKey = "agent:main:metadata-created-during-read";
      fixture.readChatMetadata.mockImplementationOnce(async () => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "created-during-read",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: fixture.owner.id },
          },
        );
        return fixture.metadata;
      });
      const { pending, respond } = dispatchMetadata(fixture, { sessionKey });
      await expect(pending).rejects.toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
      expect(fixture.readChatMetadata).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    });
  });

  it("does not publish metadata after its logical store alias selects an identical replacement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = createPersonalMetadataFixture([SESSION_READ_SCOPE]);
      const sessionKey = "agent:main:metadata-store-alias";
      const original = state.statePath("original", "catalog.sqlite");
      const replacement = state.statePath("replacement", "catalog.sqlite");
      const alias = state.statePath("selected");
      for (const storePath of [original, replacement]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey, storePath },
          {
            sessionId: "identical-session",
            lifecycleRevision: "identical-lifecycle",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: fixture.owner.id },
          },
        );
      }
      fs.symlinkSync(state.statePath("original"), alias, "junction");
      const config = {
        ...fixture.config,
        session: { store: state.statePath("selected", "catalog.sqlite") },
      };
      fixture.setConfig(config);
      await state.writeConfig(config);
      fixture.readChatMetadata.mockImplementationOnce(async () => {
        fs.unlinkSync(alias);
        fs.symlinkSync(state.statePath("replacement"), alias, "junction");
        return fixture.metadata;
      });
      const { pending, respond } = dispatchMetadata(fixture, { sessionKey });
      await expect(pending).rejects.toThrow();
      expect(fixture.readChatMetadata).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    });
  });

  it.each(["cleanup", "preparation"] as const)(
    "joins preparation and preserves the first %s failure",
    async (firstFailure) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = createPersonalMetadataFixture([SESSION_READ_SCOPE]);
        await state.writeConfig(fixture.config);
        const sessionKey = "agent:main:metadata-cleanup";
        const sibling = { agentId: "main", sessionKey: "agent:main:metadata-cleanup-sibling" };
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "metadata-cleanup",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: fixture.owner.id },
          },
        );
        await upsertSessionEntryCore(sibling, { sessionId: "cleanup-sibling", updatedAt: 1 });
        const gate = createDeferred();
        const cleanupReached = createDeferred();
        const cleanupError = new PreparedModelRuntimePublicationSupersededError(
          "reader cleanup failed",
        );
        const events: string[] = [];
        const preparationError = new Error("private preparation failed");
        let preparation: Promise<typeof fixture.metadata> | undefined;
        let failCleanup = false;
        const original = sessionReads.withGatewaySessionEntry;
        const reader = vi
          .spyOn(sessionReads, "withGatewaySessionEntry")
          .mockImplementation(
            async <T>(
              ...args: Parameters<typeof sessionReads.withGatewaySessionEntry<T>>
            ): Promise<T> => {
              const value = await original<T>(...args);
              if (failCleanup) {
                failCleanup = false;
                if (firstFailure === "preparation") {
                  gate.resolve();
                  await expectDefined(preparation, "private preparation").catch(() => {});
                }
                cleanupReached.resolve();
                throw cleanupError;
              }
              return value;
            },
          );
        fixture.readChatMetadata.mockImplementationOnce(async (scope) =>
          expectDefined(
            scope.withCurrent,
            "saved metadata authority",
          )(() => {
            failCleanup = true;
            preparation = gate.promise.then(() => {
              events.push("preparation settled");
              if (firstFailure === "preparation") {
                throw preparationError;
              }
              scope.assertCurrent?.();
              return fixture.metadata;
            });
            return preparation;
          }),
        );
        const { pending, respond } = dispatchMetadata(fixture, { sessionKey });
        const outcome = pending.catch((error: unknown) => {
          events.push("request failed");
          return error;
        });
        try {
          await awaitGateBeforeSettlement(
            cleanupReached.promise,
            pending,
            "Metadata ended before cleanup failed",
          );
          if (firstFailure === "cleanup") {
            // A separate worker round trip remains usable while the failed reader joins its child.
            await patchSessionEntryCore(sibling, () => ({ label: "still available" }));
            expect(events).toEqual([]);
            expect(respond).not.toHaveBeenCalled();
            gate.resolve();
          }
          expect(await outcome).toBe(
            firstFailure === "preparation" ? preparationError : cleanupError,
          );
          expect(events).toEqual(["preparation settled", "request failed"]);
          expect(respond).not.toHaveBeenCalled();
        } finally {
          gate.resolve();
          await outcome;
          reader.mockRestore();
        }
      });
    },
  );

  it.each(["agent:main:dashboard:incognito-metadata", "dashboard:incognito-metadata"])(
    "retains native account authority for %s",
    async (requestedKey) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = createPersonalMetadataFixture([ADMIN_SCOPE]);
        await state.writeConfig(fixture.config);
        const target = {
          agentId: "main",
          sessionKey: "agent:main:dashboard:incognito-metadata",
          storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
        };
        await upsertSessionEntryCore(target, {
          sessionId: "native-metadata",
          updatedAt: 1,
          incognito: true,
          createdActor: { type: "human", source: "profile", id: fixture.owner.id },
        });
        const params = { agentId: "main", sessionKey: requestedKey };
        fixture.readChatMetadata.mockImplementationOnce(async (scope) => {
          expect(scope.storePath).toBe(target.storePath);
          expect(scope.sessionEntry?.sessionId).toBe("native-metadata");
          return fixture.metadata;
        });
        expect(await fixture.request(params)).toHaveBeenCalledWith(true, fixture.metadata);
        const preparePrivate = vi.fn(() => fixture.metadata);
        fixture.readChatMetadata.mockImplementationOnce(async (scope) => {
          await patchSessionEntryCore(target, () => ({ authProfileOverride: "changed-account" }));
          return expectDefined(scope.withCurrent, "native metadata authority")(preparePrivate);
        });
        await expect(fixture.request(params)).rejects.toBeInstanceOf(
          PreparedModelRuntimePublicationSupersededError,
        );
        expect(preparePrivate).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["role loss", "config replacement", "profile replacement", "abort"] as const)(
    "rejects a neutral draft after %s during metadata preparation",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = createPersonalMetadataFixture([SESSION_READ_SCOPE]);
        await state.writeConfig(fixture.config);
        const entered = createDeferred();
        const release = createDeferred();
        const abort = new AbortController();
        fixture.readChatMetadata.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return fixture.metadata;
        });
        const { pending, respond } = dispatchMetadata(fixture, { agentId: "main" }, abort.signal);
        const settled = Promise.allSettled([pending]);
        try {
          await Promise.race([entered.promise, pending]);
          expect(fixture.readChatMetadata).toHaveBeenCalledOnce();
          if (change === "role loss") {
            setUserProfileRole(fixture.owner.id, "blocked");
            invalidateOperatorRolePolicy(fixture.owner.id);
          } else if (change === "config replacement") {
            const next = structuredClone(fixture.config);
            next.gateway.roles.definitions.reader.agents = [];
            fixture.setConfig(next);
          } else if (change === "profile replacement") {
            const other = ensureProfileForEmail("metadata-replacement@example.test");
            fixture.client.authenticatedUserProfile = {
              profileId: other.id,
              displayName: other.displayName,
              hasAvatar: false,
              updatedAt: other.updatedAt,
            };
          } else {
            abort.abort();
          }
        } finally {
          release.resolve();
          await settled;
        }

        await expect(pending).rejects.toBeInstanceOf(
          PreparedModelRuntimePublicationSupersededError,
        );
        expect(respond).not.toHaveBeenCalled();
      });
    },
  );
});
