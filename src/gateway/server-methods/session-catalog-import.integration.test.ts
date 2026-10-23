import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  type SessionCatalogTranscriptItem,
  type SessionsCatalogImportParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { listSessionEntriesCore } from "../../config/sessions/session-accessor.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import * as transcriptRuntime from "../../plugin-sdk/session-transcript-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import {
  captureSessionUpstreamLinkReadSource,
  prepareSessionUpstreamLink,
} from "../../sessions/session-upstream-links-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import {
  type PreparedGatewayModelCatalogSnapshot,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { buildSessionCatalogImportKey } from "../session-create-key.js";
import * as sessionCreation from "../session-create-service.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { listProjectedSessions } from "../session-utils-list.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import { catalogHost, catalogSession } from "./session-catalog.fixtures.test-support.js";
import { sessionCatalogHandlers } from "./session-catalog.js";
import {
  createSessionMutationTestClient,
  createSessionMutationTestContext,
} from "./sessions-mutations.owner.test-support.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let nextCatalog = 0;
function expectSuccess(response: ReturnType<typeof vi.fn<RespondFn>>, fields: object) {
  expect(response).toHaveBeenCalledWith(true, expect.objectContaining(fields));
}

function expectFailure(response: ReturnType<typeof vi.fn<RespondFn>>, fields: object) {
  expect(response).toHaveBeenCalledWith(false, undefined, expect.objectContaining(fields));
}
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "catalog-import" });
});
beforeEach(() => state.applyEnv());
afterAll(async () => state.cleanup());

async function withCatalog(
  run: (fixture: Awaited<ReturnType<typeof createCatalog>>) => Promise<void>,
  restricted = false,
) {
  const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
  const fixture = await createCatalog(restricted);
  try {
    await state.writeConfig(fixture.config);
    await run(fixture);
  } finally {
    vi.restoreAllMocks();
    fixture.projection.dispose();
    setActivePluginRegistry(previousRegistry);
  }
}

async function createCatalog(restricted: boolean) {
  const config: OpenClawConfig = {
    plugins: { enabled: false },
  };
  if (restricted) {
    config.gateway = {
      roles: {
        default: "reader",
        definitions: {
          reader: {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    };
  }
  setRuntimeConfigSnapshot(config);
  const id = ++nextCatalog;
  const client = createSessionMutationTestClient(
    ensureProfileForEmail("catalog-import@example.test").id,
  );
  client.connect.scopes = restricted ? ["operator.read", "operator.write"] : ["operator.admin"];
  const other = createSessionMutationTestClient(
    ensureProfileForEmail("other-importer@example.test").id,
  );
  const nativeKey = `agent:main:native-adopted-${id}`;
  const actor = (owner = client) => ({
    type: "human" as const,
    source: "profile" as const,
    id: owner.authenticatedUserProfile!.profileId,
  });
  const entryRef = (sessionKey = key) => ({ agentId: "main", sessionKey });
  const entry = () => loadSessionEntryReadOnly(entryRef());
  const updateNative = (update: Parameters<typeof upsertSessionEntryCore>[1]) =>
    upsertSessionEntryCore(entryRef(nativeKey), update);
  const seedNative = () =>
    updateNative({
      sessionId: "native-source",
      updatedAt: 1,
      pluginOwnerId: "fixture",
      createdVia: "operator",
      createdActor: actor(),
    });
  if (restricted) {
    await seedNative();
  }
  const source: SessionCatalogTranscriptItem[] = [
    { id: "question", type: "userMessage", text: "Synthetic imported question" },
    { type: "agentMessage", text: "Synthetic imported answer" },
  ];
  const read = vi.fn<SessionCatalogProvider["read"]>(
    async ({ hostId, threadId, cursor, limit }) => {
      const offset = cursor ? Number(cursor) : 0;
      const items = source.toReversed().slice(offset, offset + (limit ?? 50));
      const next = offset + items.length;
      return {
        hostId,
        threadId,
        label: "Fixture host label",
        items,
        ...(next < source.length ? { nextCursor: String(next) } : {}),
      };
    },
  );
  const list = vi.fn<SessionCatalogProvider["list"]>(async () => {
    if (!restricted) {
      throw new Error("Unrestricted import must not enumerate the catalog");
    }
    return [
      catalogHost({
        hostId: "node:fixture",
        label: "Fixture node",
        kind: "node",
        sessions: [
          catalogSession(`thread-${id}`, {
            sourceHomeId: "home-a",
            sessionKey: nativeKey,
            name: "Native source",
          }),
        ],
      }),
    ];
  });
  const provider: SessionCatalogProvider = { id: "claude", label: "Claude", list, read };
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({ pluginId: "fixture", source: import.meta.url, provider });
  setActivePluginRegistry(registry);
  const projection = await createSessionRowProjection({ cfg: config, getConfig: () => config });
  prepareGatewayRecipientProfile(client);
  prepareGatewayRecipientProfile(other);
  const readyModelCatalogSnapshot = {
    entries: [],
    routeVariants: [],
    agentId: "main",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    catalogComplete: true,
    config,
    observationConfig: config,
    authModes: {},
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
    authMaterializations: [],
    isCurrent: () => true,
  } satisfies PreparedGatewayModelCatalogSnapshot;
  let readPreparedModelCatalog = async () => readyModelCatalogSnapshot;
  const loadPreparedModelCatalog = async () => readyModelCatalogSnapshot;
  const gatewayModelCatalogLoader: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] =
    loadPreparedModelCatalog;
  registerGatewayModelCatalogPrivateAccess(gatewayModelCatalogLoader, {
    loadDeferred: loadPreparedModelCatalog,
    readPrepared: () => readPreparedModelCatalog(),
  });
  const context = bindSessionRowProjection(
    {
      ...createSessionMutationTestContext(config),
      logGateway: createSubsystemLogger("test/catalog-import"),
      broadcast: vi.fn(),
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: gatewayModelCatalogLoader,
    },
    () => projection,
  );
  const locator: SessionsCatalogImportParams = {
    catalogId: "claude",
    hostId: "node:fixture",
    sourceHomeId: "home-a",
    threadId: `thread-${id}`,
    agentId: "main",
    displayName: "  Preserved investigation  ",
  };
  const key = buildSessionCatalogImportKey("main", locator);
  const call = async (
    method: "sessions.catalog.import" | "sessions.catalog.continue" = "sessions.catalog.import",
    requestClient: GatewayClient = client,
    signal?: AbortSignal,
  ) => {
    const respond = vi.fn<RespondFn>();
    const { displayName: _displayName, ...sourceLocator } = locator;
    await withPluginRuntimeGatewayRequestScope(
      { client: requestClient, pluginRegistry: registry, isWebchatConnect: () => false },
      () =>
        sessionCatalogHandlers[method]!({
          req: { type: "req", id: "catalog-import", method },
          isWebchatConnect: () => false,
          params: method === "sessions.catalog.import" ? locator : sourceLocator,
          client: requestClient,
          respond,
          context,
          ...(signal ? { signal } : {}),
        }),
    );
    return respond;
  };
  const transcriptFor = async (sessionKey: string) => {
    const stored = loadSessionEntryReadOnly(entryRef(sessionKey));
    return stored
      ? transcriptRuntime.readVisibleSessionTranscriptMessageEntries({
          agentId: "main",
          sessionKey,
          sessionId: stored.sessionId,
        })
      : [];
  };
  const transcript = () => transcriptFor(key);
  const expectImport = async (created: boolean, importedItems = 2, totalItems = 2) => {
    expect(await call()).toHaveBeenCalledWith(true, {
      sessionKey: key,
      importedItems,
      totalItems,
      complete: true,
      created,
    });
  };
  const precreate = async (owner = client) => {
    const created = await sessionCreation.createGatewaySession({
      cfg: config,
      agentId: "main",
      key,
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      creation: {
        via: "operator",
        actor: actor(owner),
      },
    });
    expect(created.ok).toBe(true);
    await projection.ensureMaterialized();
    await projection.prepareMembership();
  };
  return {
    actor,
    entry,
    entryRef,
    updateNative,
    expectImport,
    context,
    other,
    nativeKey,
    seedNative,
    precreate,
    config,
    client,
    source,
    provider,
    list,
    read,
    projection,
    locator,
    key,
    call,
    readyModelCatalogSnapshot,
    setPreparedModelCatalogReader: (reader: () => Promise<typeof readyModelCatalogSnapshot>) => {
      readPreparedModelCatalog = reader;
    },
    transcript,
    transcriptFor,
  };
}

describe("sessions.catalog.import with durable Gateway owners", () => {
  it("imports and re-imports without waiting on model catalog publication", () =>
    withCatalog(async (fixture) => {
      const loadCatalog = vi
        .spyOn(fixture.context, "loadGatewayModelCatalogSnapshot")
        .mockImplementation(() => new Promise(() => {}));
      expectSuccess(await fixture.call(), { created: true, importedItems: 2 });
      const selection = {
        providerOverride: "openai",
        modelOverride: "gpt-4.1",
        thinkingLevel: "low",
        contextWindow: "large",
      };
      await upsertSessionEntryCore(fixture.entryRef(), selection);
      expectSuccess(await fixture.call(), { created: false, importedItems: 0 });
      expect(fixture.entry()).toMatchObject(selection);
      expect(loadCatalog).not.toHaveBeenCalled();
      expect(JSON.stringify(await fixture.transcript())).toContain("Synthetic imported question");
    }));

  it("keeps a copied draft hidden from another viewer until publication and preserves publication on re-import", () =>
    withCatalog(async (fixture) => {
      await fixture.updateNative({ visibility: "draft" });
      expectSuccess(await fixture.call(), { created: true, importedItems: 2 });
      expect(fixture.entry()?.visibility).toBe("draft");
      const listFor = (client: GatewayClient) =>
        listProjectedSessions({
          projection: fixture.projection,
          context: fixture.context,
          client,
          opts: { agentId: "main" },
        });
      const listed = expect.arrayContaining([expect.objectContaining({ key: fixture.key })]);
      const canReadHistory = async (client: GatewayClient) => {
        const respond = vi.fn<RespondFn>();
        const read = await prepareChatHistorySessionRead({
          client,
          context: fixture.context,
          method: "chat.history",
          sessionKey: fixture.key,
          respond,
        });
        read?.release();
        return { allowed: Boolean(read), respond };
      };
      expect((await listFor(fixture.client)).sessions).toEqual(listed);
      expect((await listFor(fixture.other)).sessions).not.toEqual(listed);
      expect((await canReadHistory(fixture.client)).allowed).toBe(true);
      const hiddenHistory = await canReadHistory(fixture.other);
      expect(hiddenHistory.allowed).toBe(false);
      expectFailure(hiddenHistory.respond, { code: "INVALID_REQUEST" });

      const respond = vi.fn<RespondFn>();
      await sessionSharingHandlers["session.visibility.set"]!({
        req: { type: "req", id: "publish-import", method: "session.visibility.set" },
        isWebchatConnect: () => false,
        params: { sessionKey: fixture.key, visibility: "shared" },
        client: fixture.client,
        context: fixture.context,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        { ok: true, sessionKey: fixture.key, visibility: "shared" },
        undefined,
      );
      fixture.source.push({
        id: "published-reply",
        type: "agentMessage",
        text: "A published reply",
      });
      expectSuccess(await fixture.call(), { created: false, importedItems: 1 });
      expect(fixture.entry()?.visibility).toBe("shared");
      expect(await fixture.transcript()).toHaveLength(4);
      expect((await listFor(fixture.other)).sessions).toEqual(listed);
      expect((await canReadHistory(fixture.other)).allowed).toBe(true);
    }, true));

  it("creates and syncs an ordinary durable session through real creation, projection, and transcript owners", () =>
    withCatalog(async (fixture) => {
      await fixture.expectImport(true);
      const first = await fixture.transcript();
      expect(first).toHaveLength(3);
      expect(JSON.stringify(first)).toContain("Synthetic imported question");
      expect(JSON.stringify(first)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
      expect(fixture.entry()?.displayName).toBe("Preserved investigation");
      fixture.locator.displayName = "Changed source title";
      await fixture.expectImport(false, 0);
      expect(await fixture.transcript()).toEqual(first);
      fixture.source.push({ type: "agentMessage", text: "A later preserved reply" });
      await fixture.expectImport(false, 1, 3);
      expect(await fixture.transcript()).toHaveLength(4);
      const entry = fixture.entry();
      expect(entry).toMatchObject({ displayName: "Preserved investigation", visibility: "draft" });
      for (const binding of [
        "pluginOwnerId",
        "modelSelectionLocked",
        "cliSessionBindings",
        "execNode",
      ]) {
        expect(entry).not.toHaveProperty(binding);
      }
      expect(fixture.list).not.toHaveBeenCalled();
      expect(fixture.read).not.toHaveBeenCalledWith(
        expect.objectContaining({ displayName: expect.anything() }),
      );
      expect(
        await prepareSessionUpstreamLink(
          captureSessionUpstreamLinkReadSource(),
          fixture.key,
          "main",
        ),
      ).toBeUndefined();
      expect(
        (await listSessionStateEventsSince(fixture.key, "main", 0)).events.filter(
          (event) => event.kind === "imported",
        ),
      ).toMatchObject([
        {
          kind: "imported",
          payload: {
            catalogId: "claude",
            hostId: "node:fixture",
            threadId: fixture.locator.threadId,
            sourceHomeId: "home-a",
          },
        },
      ]);
      await fixture.seedNative();
      const continueSession = vi.fn(async () => ({ sessionKey: fixture.nativeKey }));
      fixture.provider.continueSession = continueSession;
      expect(await fixture.call("sessions.catalog.continue")).toHaveBeenCalledWith(true, {
        sessionKey: fixture.nativeKey,
      });
      expect(continueSession).toHaveBeenCalledOnce();
      expect(fixture.nativeKey).not.toBe(fixture.key);
      expect(await fixture.transcript()).toHaveLength(4);
    }));

  it("cancels a stalled Gateway copy without durable artifacts and succeeds on retry", () =>
    withCatalog(async (fixture) => {
      fixture.provider.copyToGatewaySession = vi.fn(async () => ({
        displayName: "Copied catalog session",
        preferredModel: "openai/gpt-5.6-sol",
      }));
      const sessionKeys = () =>
        listSessionEntriesCore({ agentId: "main" })
          .map(({ sessionKey }) => sessionKey)
          .toSorted();
      const before = sessionKeys();
      const stalledPreparedCatalog = createDeferredCore<typeof fixture.readyModelCatalogSnapshot>();
      const preparedCatalogReadStarted = createDeferredCore();
      const readPreparedModelCatalog = vi.fn(async () => {
        preparedCatalogReadStarted.resolve();
        return await stalledPreparedCatalog.promise;
      });
      fixture.setPreparedModelCatalogReader(readPreparedModelCatalog);

      const controller = new AbortController();
      const cancelledCall = fixture.call(
        "sessions.catalog.continue",
        fixture.client,
        controller.signal,
      );
      await preparedCatalogReadStarted.promise;
      expect(fixture.provider.copyToGatewaySession).toHaveBeenCalledOnce();
      expect(readPreparedModelCatalog).toHaveBeenCalledOnce();
      controller.abort(new Error("request closed"));
      expectFailure(await cancelledCall, { code: ErrorCodes.UNAVAILABLE, retryable: true });
      expect(sessionKeys()).toEqual(before);
      expect(fixture.read).not.toHaveBeenCalled();

      stalledPreparedCatalog.resolve(fixture.readyModelCatalogSnapshot);
      fixture.setPreparedModelCatalogReader(async () => fixture.readyModelCatalogSnapshot);
      const retried = await fixture.call("sessions.catalog.continue");
      expect(retried).toHaveBeenCalledWith(true, {
        sessionKey: expect.stringMatching(/^agent:main:/),
      });
      const response = retried.mock.calls.find(([ok]) => ok)?.[1];
      if (
        !response ||
        typeof response !== "object" ||
        !("sessionKey" in response) ||
        typeof response.sessionKey !== "string"
      ) {
        throw new Error("retry did not return a session key");
      }
      const sessionKey = response.sessionKey;
      expect(sessionKeys()).toEqual([...before, sessionKey].toSorted());
      expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toMatchObject({
        displayName: "Copied catalog session",
      });
      const transcript = JSON.stringify(await fixture.transcriptFor(sessionKey));
      expect(transcript).toContain("Synthetic imported question");
      expect(transcript).toContain("EXTERNAL_UNTRUSTED_CONTENT");
      expect((await listSessionStateEventsSince(sessionKey, "main", 0)).events).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "adopted" })]),
      );
    }));

  it.each([undefined, "   "])(
    "uses a generic title instead of the host label when displayName is %j",
    async (displayName) => {
      await withCatalog(async (fixture) => {
        fixture.locator.displayName = displayName;
        expectSuccess(await fixture.call(), { created: true, importedItems: 2 });
        expect(fixture.entry()?.displayName).toBe("Imported Claude session");
      });
    },
  );

  it.each([
    { restricted: false, targetOwner: "owner" },
    { restricted: true, targetOwner: "owner" },
    { restricted: true, targetOwner: "other" },
  ])(
    "respects existing-target write access (restricted=$restricted, target=$targetOwner)",
    async ({ restricted, targetOwner }) => {
      await withCatalog(async (fixture) => {
        await fixture.precreate(targetOwner === "owner" ? fixture.client : fixture.other!);
        if (targetOwner === "owner") {
          await fixture.expectImport(false);
          expect(await fixture.transcript()).toHaveLength(3);
        } else {
          expectFailure(await fixture.call(), { message: "session is shared for this connection" });
          expect(await fixture.transcript()).toEqual([]);
        }
      }, restricted);
    },
  );

  it("forbids a restricted caller who cannot read the source without creating a session", () =>
    withCatalog(async (fixture) => {
      await fixture.updateNative({ visibility: "draft" });
      expectFailure(await fixture.call("sessions.catalog.import", fixture.other), {
        code: "FORBIDDEN",
      });
      expect(fixture.read).not.toHaveBeenCalled();
      expect(fixture.entry()).toBeUndefined();
      expect(await fixture.transcript()).toEqual([]);
    }, true));

  it("rejects source sharing revocation after history read before creating the destination", () =>
    withCatalog(async (fixture) => {
      const createGatewaySession = sessionCreation.createGatewaySession;
      const create = vi
        .spyOn(sessionCreation, "createGatewaySession")
        .mockImplementationOnce(async (params) => {
          expect(fixture.read).toHaveBeenCalledOnce();
          await fixture.updateNative({
            visibility: "draft",
            createdActor: fixture.actor(fixture.other),
          });
          await fixture.projection.ensureMaterialized();
          await fixture.projection.prepareMembership();
          return createGatewaySession(params);
        });
      const response = await fixture.call();
      expect(create).toHaveBeenCalledOnce();
      expectFailure(response, { message: expect.stringContaining("source visibility changed") });
      expect(fixture.entry()).toBeUndefined();
      expect(await fixture.transcript()).toEqual([]);
    }, true));

  it("rejects remaining re-import appends when source visibility is revoked mid-append", () =>
    withCatalog(async (fixture) => {
      await fixture.updateNative({ createdActor: fixture.actor(fixture.other) });
      expectSuccess(await fixture.call(), { importedItems: 2 });
      fixture.source.push(
        { id: "later-1", type: "agentMessage", text: "First later reply" },
        { id: "later-2", type: "agentMessage", text: "Revoked later reply" },
      );
      let revoked = false;
      const withWrite = transcriptRuntime.withSessionTranscriptWrite;
      vi.spyOn(transcriptRuntime, "withSessionTranscriptWrite").mockImplementation((params, run) =>
        withWrite(params, (transcript) =>
          run({
            ...transcript,
            appendMessage: async (options) => {
              const result = await transcript.appendMessage(options);
              if (
                result?.appended &&
                JSON.stringify(options.message).includes("First later reply")
              ) {
                fixture.config.gateway!.roles!.definitions!.reader!.sessions.others = "none";
                revoked = true;
              }
              return result;
            },
          }),
        ),
      );
      const response = await fixture.call();
      expect(revoked).toBe(true);
      expectFailure(response, { message: expect.stringContaining("source visibility changed") });
      const transcript = await fixture.transcript();
      expect(transcript).toHaveLength(4);
      expect(JSON.stringify(transcript)).toContain("First later reply");
      expect(JSON.stringify(transcript)).not.toContain("Revoked later reply");
    }, true));
});
