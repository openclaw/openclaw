import assert from "node:assert/strict";
import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { PreparedModelRuntimePublicationSupersededError as SupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
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
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { ADMIN_SCOPE, READ_SCOPE, SESSION_READ_SCOPE } from "../operator-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import * as sessionReads from "../session-utils-store.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import {
  chatMetadataCommandFields,
  connectChatMetadataAccount,
  createChatMetadataHarness,
  createOtherAgentChatMetadataFixture,
} from "./chat-metadata-runtime.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

type MetadataFixture = ReturnType<typeof createPersonalMetadataFixture>;

it("serves commands independently of another agent's remembered model list", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createOtherAgentChatMetadataFixture(signal);
    const { config, harness, request, entered, release, pending } = fixture;
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      readChatMetadata: harness.runtime.read,
    });
    const readCommands = async () => {
      const respond = vi.fn<RespondFn>();
      await callMetadata({
        params: { agentId: "main", includeModels: false },
        context,
        respond,
        signal,
      });
      expect(respond).toHaveBeenCalledWith(true, {
        commands: [{ ...chatMetadataCommandFields, name: "command-1-1" }],
        swarmEnabled: true,
        revision: expect.any(String),
      });
    };
    try {
      await harness.runtime.refresh();
      await expect(harness.runtime.readModelsList(request)).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "other-model" })]),
      });
      await readCommands();
      fixture.holdOtherModel("replacement-model");
      await harness.runtime.refresh();
      const models = harness.runtime.readModelsList(request);
      pending.push(models);
      await withinTest(entered.promise, signal);
      const reading = readCommands();
      pending.push(reading);
      await withinTest(reading, signal);
      release.resolve();
      await Promise.all(pending);
      await expect(harness.runtime.readModelsList(request)).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "replacement-model" })]),
      });
    } finally {
      await fixture.stop();
    }
  });
});

function metadataConnect(scopes: GatewayOperatorRoleDefinition["scopes"]) {
  return sharingPolicyClient({ scopes: [...scopes] }).connect;
}

function callMetadata(
  options: Pick<GatewayRequestHandlerOptions, "params" | "context" | "respond"> &
    Partial<Pick<GatewayRequestHandlerOptions, "client" | "signal">>,
) {
  return expectDefined(
    chatHistoryHandlers["chat.metadata"],
    "metadata handler",
  )({
    req: { type: "req", id: "metadata", method: "chat.metadata" },
    client: null,
    isWebchatConnect: () => false,
    ...options,
  });
}

function ownedEntry(
  owner: string,
  sessionId: string,
  fields: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    sessionId,
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: owner },
    ...fields,
  };
}

async function changeDuringMetadata(
  fixture: MetadataFixture,
  params: Record<string, unknown>,
  change: () => void | Promise<unknown>,
  signal?: AbortSignal,
) {
  const entered = createDeferred();
  const release = createDeferred();
  fixture.readChatMetadata.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return fixture.metadata;
  });
  const request = fixture.dispatch(params, signal);
  const settled = Promise.allSettled([request.pending]);
  try {
    await Promise.race([entered.promise, request.pending]);
    expect(fixture.readChatMetadata).toHaveBeenCalledOnce();
    await change();
  } finally {
    release.resolve();
    await settled;
  }
  return request;
}

async function withoutHostSql(run: () => Promise<void>) {
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  try {
    sql.calibrate();
    await run();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

async function expectSuperseded(request: { pending: Promise<unknown>; respond: RespondFn }) {
  const { pending, respond } = request;
  await expect(pending).rejects.toBeInstanceOf(SupersededError);
  expect(respond).not.toHaveBeenCalled();
}

function createPersonalMetadataFixture(
  scopes: GatewayOperatorRoleDefinition["scopes"] = [READ_SCOPE],
) {
  const owner = ensureProfileForEmail("metadata-owner@example.test");
  const authProfileId = connectChatMetadataAccount(owner.id);
  const client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string } = {
    connId: "metadata-owner-connection",
    connect: metadataConnect(scopes),
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
  setRuntimeConfigSnapshot(config);
  let currentConfig: OpenClawConfig = config;
  const metadata = { models: [], swarmEnabled: false };
  const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => metadata);
  const context = createDirectChatContext({
    getRuntimeConfig: () => currentConfig,
    readChatMetadata,
    getClientConnIds: (filter) => new Set(!filter || filter(client) ? [client.connId] : []),
  });
  const request = async (params: Record<string, unknown>) => {
    const respond = vi.fn<RespondFn>();
    await callMetadata({ params, context, client, respond });
    return respond;
  };
  return {
    owner,
    authProfileId,
    client,
    config,
    context,
    role,
    setConfig: (next: OpenClawConfig) => {
      currentConfig = next;
      setRuntimeConfigSnapshot(next);
    },
    metadata,
    readChatMetadata,
    request,
    saveSession(sessionKey: string, fields: Partial<SessionEntry> = {}, ownerId = owner.id) {
      const agentId = expectDefined(sessionKey.split(":")[1], "session agent");
      return upsertSessionEntryCore(
        { agentId, sessionKey },
        ownedEntry(ownerId, sessionKey.split(":").slice(2).join(":"), fields),
      );
    },
    dispatch(params: Record<string, unknown>, signal?: AbortSignal) {
      const respond = vi.fn<RespondFn>();
      const pending = handleGatewayRequest({
        req: { type: "req", id: "metadata-dispatch", method: "chat.metadata", params },
        client,
        context,
        respond,
        signal,
        isWebchatConnect: () => false,
      });
      return { pending, respond };
    },
  };
}

function withMetadataFixture(
  run: (fixture: MetadataFixture, state: OpenClawTestState) => Promise<void>,
  scopes: GatewayOperatorRoleDefinition["scopes"] = [SESSION_READ_SCOPE],
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = createPersonalMetadataFixture(scopes);
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    await run(fixture, state);
  });
}

async function publishFixture(
  fixture: MetadataFixture,
  state: OpenClawTestState,
  role: Partial<GatewayOperatorRoleDefinition> = {},
) {
  Object.assign(fixture.role, role);
  await state.writeConfig(fixture.config);
  setRuntimeConfigSnapshot(fixture.config);
}

describe("chat metadata ownership", () => {
  it.for([
    { includeModels: false, first: "response" },
    { includeModels: true, first: "placement" },
  ] as const)(
    "keeps saved-session placement readiness scoped to includeModels=$includeModels",
    async ({ includeModels, first }, { signal }) => {
      await withMetadataFixture(async (fixture) => {
        const sessionKey = "agent:main:placement-readiness";
        await fixture.saveSession(sessionKey);
        const harness = createChatMetadataHarness(fixture.config);
        let placementPrepared = false;
        fixture.context.readChatMetadata = (scope) => {
          if (includeModels) {
            expect(placementPrepared).toBe(true);
          }
          return harness.runtime.read(scope);
        };
        const placement = createWorkerSessionPlacementStore();
        fixture.context.workerSessionPlacementService = placement;
        const entered = createDeferred();
        const release = createDeferred();
        const getMany = placement.getManyAsync.bind(placement);
        const read = vi.spyOn(placement, "getManyAsync").mockImplementation(async (ids) => {
          entered.resolve();
          await release.promise;
          const result = await getMany(ids);
          placementPrepared = true;
          return result;
        });
        const abort = () => release.resolve();
        signal.addEventListener("abort", abort, { once: true });
        let request: ReturnType<typeof fixture.dispatch> | undefined;
        try {
          await harness.runtime.refresh();
          request = fixture.dispatch({ sessionKey, includeModels }, signal);
          const winner = await Promise.race([
            request.pending.then(() => "response"),
            entered.promise.then(() => "placement"),
          ]);
          expect(winner).toBe(first);
          if (includeModels) {
            expect(request.respond).not.toHaveBeenCalled();
          }
          release.resolve();
          await request.pending;
          expect(request.respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              commands: [{ ...chatMetadataCommandFields, name: "command-1-1" }],
              swarmEnabled: true,
            }),
          );
          const result = request.respond.mock.calls[0]?.[1];
          if (includeModels) {
            expect(result).toHaveProperty("models");
          } else {
            expect(result).not.toHaveProperty("models");
          }
        } finally {
          release.resolve();
          await Promise.allSettled(request ? [request.pending] : []);
          read.mockRestore();
          signal.removeEventListener("abort", abort);
          await harness.runtime.stop();
        }
      });
    },
  );

  it("serves commands without preparing a catalog when the client reads models separately", async () => {
    const config: OpenClawConfig = { agents: { entries: { main: {} } } };
    const harness = createChatMetadataHarness(config);
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      readChatMetadata: harness.runtime.read,
    });
    const request = async (includeModels?: boolean, ifRevision?: string) => {
      const respond = vi.fn<RespondFn>();
      await callMetadata({
        params: {
          agentId: "main",
          ...(includeModels === false ? { includeModels } : {}),
          ...(ifRevision ? { ifRevision } : {}),
        },
        context,
        respond,
      });
      return respond;
    };
    try {
      await harness.runtime.refresh();
      const compact = await request(false);
      expect(compact).toHaveBeenCalledWith(true, {
        commands: [{ ...chatMetadataCommandFields, name: "command-1-1" }],
        swarmEnabled: true,
        revision: expect.any(String),
      });
      const payload = compact.mock.calls[0]?.[1];
      assert(payload && typeof payload === "object" && "revision" in payload);
      const { revision } = payload;
      assert(typeof revision === "string");
      expect(await request(false, revision)).toHaveBeenCalledWith(true, {
        revision,
        unchanged: true,
        swarmEnabled: true,
      });
      harness.setSkillsVersion(2);
      await harness.runtime.refresh();
      expect(await request(false, revision)).toHaveBeenCalledWith(true, {
        commands: [{ ...chatMetadataCommandFields, name: "command-2-1" }],
        swarmEnabled: true,
        revision: expect.not.stringContaining(revision),
      });
      expect(harness.buildProjection).not.toHaveBeenCalled();
      const legacy = await request();
      expect(legacy).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          models: [expect.objectContaining({ id: "first" })],
          commands: [{ ...chatMetadataCommandFields, name: "command-2-1" }],
        }),
      );
    } finally {
      await harness.runtime.stop();
    }
  });

  it("creates and reuses a legacy requester profile through chat.metadata without host SQL", () =>
    withOpenClawTestState({ layout: "state-only" }, async () => {
      ensureProfileForEmail("admitted@example.test");
      const config: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(config);
      const metadata = { models: [], swarmEnabled: false };
      const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(
        async () => metadata,
      );
      const context = createDirectChatContext({ getRuntimeConfig: () => config, readChatMetadata });
      const respond = vi.fn<RespondFn>();
      const client: NonNullable<GatewayRequestHandlerOptions["client"]> = {
        connId: "metadata-legacy-connection",
        authenticatedUserId: "metadata-legacy@example.test",
        connect: metadataConnect([READ_SCOPE]),
      };
      await withoutHostSql(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          await callMetadata({ params: { agentId: "main" }, context, client, respond });
        }
      });
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
    }));

  it("previews a retained personal account with session read scope without changing its cleared default", () =>
    withOpenClawTestState({ layout: "state-only" }, async () => {
      const fixture = createPersonalMetadataFixture([SESSION_READ_SCOPE]);
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const { owner, authProfileId, metadata, readChatMetadata } = fixture;
      userModelAccounts.clearUserProfileAuthLink({ profileId: owner.id, provider: "openai" });
      const before = userModelAccounts.readUserModelAuthProfile(authProfileId);

      const { pending, respond } = fixture.dispatch({ agentId: "main", authProfileId });
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
    }));

  it("rejects combining a personal draft preview with a persisted session selector", () =>
    withOpenClawTestState({ layout: "state-only" }, async () => {
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
    }));

  it("reads saved and neutral metadata without host SQL or sharing the saved profile", () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      await captureRuntimeConfigAsyncReader()();
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
      const metadata = { commands: [], models: [], swarmEnabled: false };
      const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(
        async () => metadata,
      );
      const respond = vi.fn<RespondFn>();
      const context = createDirectChatContext({ readChatMetadata });
      const request = (params: Record<string, unknown>) =>
        callMetadata({ params, context, respond });
      await withoutHostSql(async () => {
        for (const params of [{ agentId: "   ", sessionKey }, { agentId: "main" }]) {
          await request(params);
        }
      });
      expect(respond.mock.calls).toEqual([
        [true, metadata],
        [true, metadata],
      ]);
    }));
});

describe("chat metadata dispatch authority", () => {
  it.each([
    ["ordinary foreign draft", "main", "draft", false, false, false, false],
    ["foreign incognito session", "main", "shared", false, false, true, false],
    ["ordinary shared", "other", "shared", false, false, false, true],
    ["own draft", "other", "draft", true, false, false, true],
    ["admin incognito", "other", "draft", false, true, true, true],
  ] as const)(
    "applies saved-session visibility to %s independently of the creation allowlist",
    (_name, agentId, visibility, own, admin, incognito, visible) =>
      withMetadataFixture(
        async (fixture, state) => {
          await publishFixture(fixture, state, { agents: ["main"], sessions: { others: "view" } });
          const other = ensureProfileForEmail("metadata-foreign@example.test");
          const sessionKey = `agent:${agentId}:visibility-metadata`;
          await fixture.saveSession(
            sessionKey,
            { visibility, ...(incognito ? { incognito } : {}) },
            own ? fixture.owner.id : other.id,
          );

          const { pending, respond } = fixture.dispatch({ sessionKey });
          await pending;

          if (visible) {
            expect(respond).toHaveBeenCalledExactlyOnceWith(true, fixture.metadata);
            expect(fixture.readChatMetadata).toHaveBeenCalledWith(
              expect.objectContaining({
                agentId,
                sessionKey,
                sessionEntry: expect.objectContaining({ sessionId: "visibility-metadata" }),
              }),
            );
          } else {
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              expect.objectContaining({
                code: "INVALID_REQUEST",
                message: expect.stringContaining("not found"),
              }),
            );
            expect(fixture.readChatMetadata).not.toHaveBeenCalled();
          }
        },
        [admin ? ADMIN_SCOPE : SESSION_READ_SCOPE],
      ),
  );

  it.each(["draft", "missing saved row"] as const)(
    "keeps %s metadata readable outside the creation allowlist",
    (selector) =>
      withMetadataFixture(async (fixture, state) => {
        await publishFixture(fixture, state, { agents: ["main"], sessions: { others: "view" } });
        const { pending, respond } = fixture.dispatch(
          selector === "draft"
            ? { agentId: "other", authProfileId: fixture.authProfileId }
            : { sessionKey: "agent:other:missing-metadata" },
        );
        await pending;

        expect(respond).toHaveBeenCalledExactlyOnceWith(true, fixture.metadata);
        expect(fixture.readChatMetadata).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: "other" }),
        );
      }),
  );

  it.each([
    { change: "ordinary patch", patch: { thinkingLevel: "high" }, current: true },
    { change: "model", patch: { modelOverride: "replacement" }, current: false },
    { change: "model route", patch: { modelOverrideRouteResolution: "resolved" }, current: false },
    { change: "runtime", patch: { agentRuntimeOverride: "replacement" }, current: false },
    { change: "runtime lock", patch: { modelSelectionLocked: true }, current: false },
  ] satisfies { change: string; patch: Partial<SessionEntry>; current: boolean }[])(
    "revalidates $change changes during metadata preparation",
    ({ patch, current }) =>
      withMetadataFixture(async (fixture, state) => {
        await publishFixture(fixture, state, { sessions: { others: "view" } });
        const other = ensureProfileForEmail("metadata-foreign@example.test");
        const scope = { agentId: "main", sessionKey: "agent:main:changing-metadata" };
        await fixture.saveSession(scope.sessionKey, { visibility: "shared" }, other.id);
        const { pending, respond } = await changeDuringMetadata(
          fixture,
          { sessionKey: scope.sessionKey },
          () => patchSessionEntryCore(scope, () => patch),
        );

        if (current) {
          await pending;
          expect(respond).toHaveBeenCalledExactlyOnceWith(true, fixture.metadata);
        } else {
          await expectSuperseded({ pending, respond });
        }
      }),
  );

  it("refuses a missing saved row created during metadata preparation", () =>
    withMetadataFixture(async (fixture, state) => {
      await publishFixture(fixture, state);
      const sessionKey = "agent:main:metadata-created-during-read";
      fixture.readChatMetadata.mockImplementationOnce(async () => {
        await fixture.saveSession(sessionKey, { sessionId: "created-during-read" });
        return fixture.metadata;
      });
      await expectSuperseded(fixture.dispatch({ sessionKey }));
      expect(fixture.readChatMetadata).toHaveBeenCalledOnce();
    }));

  it("does not publish metadata after its logical store alias selects an identical replacement", () =>
    withMetadataFixture(async (fixture, state) => {
      const sessionKey = "agent:main:metadata-store-alias";
      const original = state.statePath("original", "catalog.sqlite");
      const replacement = state.statePath("replacement", "catalog.sqlite");
      const alias = state.statePath("selected");
      for (const storePath of [original, replacement]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey, storePath },
          ownedEntry(fixture.owner.id, "identical-session", {
            lifecycleRevision: "identical-lifecycle",
          }),
        );
      }
      fs.symlinkSync(state.statePath("original"), alias, "junction");
      const config = {
        ...fixture.config,
        session: { store: state.statePath("selected", "catalog.sqlite") },
      };
      fixture.setConfig(config);
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      fixture.readChatMetadata.mockImplementationOnce(async () => {
        fs.unlinkSync(alias);
        fs.symlinkSync(state.statePath("replacement"), alias, "junction");
        return fixture.metadata;
      });
      const { pending, respond } = fixture.dispatch({ sessionKey });
      await expect(pending).rejects.toThrow();
      expect(fixture.readChatMetadata).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    }));

  it.each(["cleanup", "preparation"] as const)(
    "joins preparation and preserves the first %s failure",
    (firstFailure) =>
      withMetadataFixture(async (fixture, state) => {
        await publishFixture(fixture, state);
        const sessionKey = "agent:main:metadata-cleanup";
        const sibling = { agentId: "main", sessionKey: "agent:main:metadata-cleanup-sibling" };
        await fixture.saveSession(sessionKey);
        await upsertSessionEntryCore(sibling, { sessionId: "cleanup-sibling", updatedAt: 1 });
        const gate = createDeferred();
        const cleanupReached = createDeferred();
        const cleanupError = new SupersededError("reader cleanup failed");
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
        const { pending, respond } = fixture.dispatch({ sessionKey });
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
      }),
  );

  it.each(["agent:main:dashboard:incognito-metadata", "dashboard:incognito-metadata"])(
    "retains native account authority for %s",
    (requestedKey) =>
      withMetadataFixture(
        async (fixture, state) => {
          await publishFixture(fixture, state);
          const target = {
            agentId: "main",
            sessionKey: "agent:main:dashboard:incognito-metadata",
            storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
          };
          await upsertSessionEntryCore(
            target,
            ownedEntry(fixture.owner.id, "native-metadata", { incognito: true }),
          );
          const params = { agentId: "main", sessionKey: requestedKey };
          fixture.readChatMetadata.mockImplementationOnce(async (scope) => {
            expect(scope).toMatchObject({
              storePath: target.storePath,
              sessionEntry: { sessionId: "native-metadata" },
            });
            return fixture.metadata;
          });
          expect(await fixture.request(params)).toHaveBeenCalledWith(true, fixture.metadata);
          const preparePrivate = vi.fn(() => fixture.metadata);
          fixture.readChatMetadata.mockImplementationOnce(async (scope) => {
            await patchSessionEntryCore(target, () => ({ authProfileOverride: "changed-account" }));
            return expectDefined(scope.withCurrent, "native metadata authority")(preparePrivate);
          });
          await expect(fixture.request(params)).rejects.toBeInstanceOf(SupersededError);
          expect(preparePrivate).not.toHaveBeenCalled();
        },
        [ADMIN_SCOPE],
      ),
  );

  it.each(["role loss", "config replacement", "profile replacement", "abort"] as const)(
    "rejects a neutral draft after %s during metadata preparation",
    (change) =>
      withMetadataFixture(async (fixture, state) => {
        await publishFixture(fixture, state);
        const abort = new AbortController();
        const request = await changeDuringMetadata(
          fixture,
          { agentId: "main" },
          () => {
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
          },
          abort.signal,
        );
        await expectSuperseded(request);
      }),
  );
});
