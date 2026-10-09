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
import { sessionCatalogHandlers } from "./session-catalog.js";
import {
  createSessionMutationTestClient,
  createSessionMutationTestContext,
} from "./sessions-mutations.owner.test-support.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let nextCatalog = 0;
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
    setRuntimeConfigSnapshot(fixture.config);
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
    ...(restricted
      ? {
          gateway: {
            roles: {
              default: "reader",
              definitions: {
                reader: {
                  sessions: { others: "view" as const },
                  agents: "*" as const,
                  scopes: ["operator.read", "operator.write"],
                },
              },
            },
          },
        }
      : {}),
  };
  const id = ++nextCatalog;
  const client = createSessionMutationTestClient(
    ensureProfileForEmail("catalog-import@example.test").id,
  );
  client.connect.scopes = restricted ? ["operator.read", "operator.write"] : ["operator.admin"];
  const other = createSessionMutationTestClient(
    ensureProfileForEmail("other-importer@example.test").id,
  );
  const nativeKey = `agent:main:native-adopted-${id}`;
  const seedNative = () =>
    upsertSessionEntryCore(
      { agentId: "main", sessionKey: nativeKey },
      {
        sessionId: "native-source",
        updatedAt: 1,
        pluginOwnerId: "fixture",
        createdVia: "operator",
        createdActor: {
          type: "human",
          source: "profile",
          id: client.authenticatedUserProfile!.profileId,
        },
      },
    );
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
      {
        hostId: "node:fixture",
        label: "Fixture node",
        kind: "node",
        connected: true,
        sessions: [
          {
            threadId: `thread-${id}`,
            sourceHomeId: "home-a",
            sessionKey: nativeKey,
            name: "Native source",
            status: "stored",
            archived: false,
            canContinue: true,
            canArchive: false,
          },
        ],
      },
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
    const entry = loadSessionEntryReadOnly({ agentId: "main", sessionKey });
    return entry
      ? transcriptRuntime.readVisibleSessionTranscriptMessageEntries({
          agentId: "main",
          sessionKey,
          sessionId: entry.sessionId,
        })
      : [];
  };
  const transcript = () => transcriptFor(key);
  const precreate = async (owner = client) => {
    const created = await sessionCreation.createGatewaySession({
      cfg: config,
      agentId: "main",
      key,
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      creation: {
        via: "operator",
        actor: {
          type: "human",
          source: "profile",
          id: owner.authenticatedUserProfile!.profileId,
        },
      },
    });
    expect(created.ok).toBe(true);
    await projection.ensureMaterialized();
    await projection.prepareMembership();
  };
  return {
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
  it("imports and re-imports without waiting on model catalog publication", async () => {
    await withCatalog(async (fixture) => {
      const loadCatalog = vi
        .spyOn(fixture.context, "loadGatewayModelCatalogSnapshot")
        .mockImplementation(() => new Promise(() => {}));
      expect(await fixture.call()).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ created: true, importedItems: 2 }),
      );
      const selection = {
        providerOverride: "openai",
        modelOverride: "gpt-4.1",
        thinkingLevel: "low",
        contextWindow: "large",
      };
      await upsertSessionEntryCore({ agentId: "main", sessionKey: fixture.key }, selection);
      expect(await fixture.call()).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ created: false, importedItems: 0 }),
      );
      expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key })).toMatchObject(
        selection,
      );
      expect(loadCatalog).not.toHaveBeenCalled();
      expect(JSON.stringify(await fixture.transcript())).toContain("Synthetic imported question");
    });
  });

  it("keeps a copied draft hidden from another viewer until publication and preserves publication on re-import", async () => {
    await withCatalog(async (fixture) => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: fixture.nativeKey },
        { visibility: "draft" },
      );
      expect(await fixture.call()).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ created: true, importedItems: 2 }),
      );
      expect(
        loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key })?.visibility,
      ).toBe("draft");
      const listFor = (client: GatewayClient) =>
        listProjectedSessions({
          projection: fixture.projection,
          context: fixture.context,
          client,
          opts: { agentId: "main" },
        });
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
      expect((await listFor(fixture.client)).sessions).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: fixture.key })]),
      );
      expect((await listFor(fixture.other)).sessions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ key: fixture.key })]),
      );
      expect((await canReadHistory(fixture.client)).allowed).toBe(true);
      const hiddenHistory = await canReadHistory(fixture.other);
      expect(hiddenHistory.allowed).toBe(false);
      expect(hiddenHistory.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );

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
      expect(await fixture.call()).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ created: false, importedItems: 1 }),
      );
      expect(
        loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key })?.visibility,
      ).toBe("shared");
      expect(await fixture.transcript()).toHaveLength(4);
      expect((await listFor(fixture.other)).sessions).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: fixture.key })]),
      );
      expect((await canReadHistory(fixture.other)).allowed).toBe(true);
    }, true);
  });

  it("creates and syncs an ordinary durable session through real creation, projection, and transcript owners", async () => {
    await withCatalog(async (fixture) => {
      expect(await fixture.call()).toHaveBeenCalledWith(true, {
        sessionKey: fixture.key,
        importedItems: 2,
        totalItems: 2,
        complete: true,
        created: true,
      });
      const first = await fixture.transcript();
      expect(first).toHaveLength(3);
      expect(JSON.stringify(first)).toContain("Synthetic imported question");
      expect(JSON.stringify(first)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
      expect(
        loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key })?.displayName,
      ).toBe("Preserved investigation");
      fixture.locator.displayName = "Changed source title";
      expect(await fixture.call()).toHaveBeenCalledWith(true, {
        sessionKey: fixture.key,
        importedItems: 0,
        totalItems: 2,
        complete: true,
        created: false,
      });
      expect(await fixture.transcript()).toEqual(first);
      fixture.source.push({ type: "agentMessage", text: "A later preserved reply" });
      expect(await fixture.call()).toHaveBeenCalledWith(true, {
        sessionKey: fixture.key,
        importedItems: 1,
        totalItems: 3,
        complete: true,
        created: false,
      });
      expect(await fixture.transcript()).toHaveLength(4);
      const entry = loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key });
      expect(entry?.displayName).toBe("Preserved investigation");
      expect(entry?.visibility).toBe("draft");
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
    });
  });

  it("cancels a stalled Gateway copy without durable artifacts and succeeds on retry", async () => {
    await withCatalog(async (fixture) => {
      fixture.provider.copyToGatewaySession = vi.fn(async () => ({
        displayName: "Copied catalog session",
        preferredModel: "openai/gpt-5.6-sol",
      }));
      const sessionKeys = () =>
        listSessionEntriesCore({ agentId: "main" })
          .map(({ sessionKey }) => sessionKey)
          .toSorted();
      const before = sessionKeys();
      let releasePreparedCatalog!: (snapshot: typeof fixture.readyModelCatalogSnapshot) => void;
      const stalledPreparedCatalog = new Promise<typeof fixture.readyModelCatalogSnapshot>(
        (resolve) => {
          releasePreparedCatalog = resolve;
        },
      );
      let markPreparedCatalogReadStarted!: () => void;
      const preparedCatalogReadStarted = new Promise<void>((resolve) => {
        markPreparedCatalogReadStarted = resolve;
      });
      const readPreparedModelCatalog = vi.fn(async () => {
        markPreparedCatalogReadStarted();
        return await stalledPreparedCatalog;
      });
      fixture.setPreparedModelCatalogReader(readPreparedModelCatalog);

      const controller = new AbortController();
      const cancelledCall = fixture.call(
        "sessions.catalog.continue",
        fixture.client,
        controller.signal,
      );
      await preparedCatalogReadStarted;
      expect(fixture.provider.copyToGatewaySession).toHaveBeenCalledOnce();
      expect(readPreparedModelCatalog).toHaveBeenCalledOnce();
      controller.abort(new Error("request closed"));
      expect(await cancelledCall).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.UNAVAILABLE, retryable: true }),
      );
      expect(sessionKeys()).toEqual(before);
      expect(fixture.read).not.toHaveBeenCalled();

      releasePreparedCatalog(fixture.readyModelCatalogSnapshot);
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
      const transcript = await fixture.transcriptFor(sessionKey);
      expect(JSON.stringify(transcript)).toContain("Synthetic imported question");
      expect(JSON.stringify(transcript)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
      expect((await listSessionStateEventsSince(sessionKey, "main", 0)).events).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "adopted" })]),
      );
    });
  });

  it.each([undefined, "   "])(
    "uses a generic title instead of the host label when displayName is %j",
    async (displayName) => {
      await withCatalog(async (fixture) => {
        fixture.locator.displayName = displayName;
        expect(await fixture.call()).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ created: true, importedItems: 2 }),
        );
        expect(
          loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key })?.displayName,
        ).toBe("Imported Claude session");
      });
    },
  );

  it("appends to a pre-existing import target while its ordinary projection publications advance", async () => {
    await withCatalog(async (fixture) => {
      await fixture.precreate();

      expect(await fixture.call()).toHaveBeenCalledWith(true, {
        sessionKey: fixture.key,
        importedItems: 2,
        totalItems: 2,
        complete: true,
        created: false,
      });
      expect(await fixture.transcript()).toHaveLength(3);
    });
  });

  it.each(["owner", "other"] as const)(
    "respects existing-target write access in a restricted multi-user Gateway (%s target)",
    async (targetOwner) => {
      await withCatalog(async (fixture) => {
        await fixture.precreate(targetOwner === "owner" ? fixture.client : fixture.other!);
        const response = await fixture.call();
        if (targetOwner === "owner") {
          expect(response).toHaveBeenCalledWith(true, {
            sessionKey: fixture.key,
            importedItems: 2,
            totalItems: 2,
            complete: true,
            created: false,
          });
          expect(await fixture.transcript()).toHaveLength(3);
        } else {
          expect(response).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              message: "session is shared for this connection",
            }),
          );
          expect(await fixture.transcript()).toEqual([]);
        }
      }, true);
    },
  );

  it("forbids a restricted caller who cannot read the source without creating a session", async () => {
    await withCatalog(async (fixture) => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: fixture.nativeKey },
        { visibility: "draft" },
      );
      expect(await fixture.call("sessions.catalog.import", fixture.other)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(fixture.read).not.toHaveBeenCalled();
      expect(
        loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key }),
      ).toBeUndefined();
      expect(await fixture.transcript()).toEqual([]);
    }, true);
  });

  it("rejects source sharing revocation after history read before creating the destination", async () => {
    await withCatalog(async (fixture) => {
      const createGatewaySession = sessionCreation.createGatewaySession;
      const create = vi
        .spyOn(sessionCreation, "createGatewaySession")
        .mockImplementationOnce(async (params) => {
          expect(fixture.read).toHaveBeenCalledOnce();
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: fixture.nativeKey },
            {
              visibility: "draft",
              createdActor: {
                type: "human",
                source: "profile",
                id: fixture.other.authenticatedUserProfile!.profileId,
              },
            },
          );
          await fixture.projection.ensureMaterialized();
          await fixture.projection.prepareMembership();
          return createGatewaySession(params);
        });
      const response = await fixture.call();
      expect(create).toHaveBeenCalledOnce();
      expect(response).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("source visibility changed") }),
      );
      expect(
        loadSessionEntryReadOnly({ agentId: "main", sessionKey: fixture.key }),
      ).toBeUndefined();
      expect(await fixture.transcript()).toEqual([]);
    }, true);
  });

  it("rejects remaining re-import appends when source visibility is revoked mid-append", async () => {
    await withCatalog(async (fixture) => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: fixture.nativeKey },
        {
          createdActor: {
            type: "human",
            source: "profile",
            id: fixture.other.authenticatedUserProfile!.profileId,
          },
        },
      );
      expect(await fixture.call()).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ importedItems: 2 }),
      );
      fixture.source.push(
        { id: "later-1", type: "agentMessage", text: "First later reply" },
        { id: "later-2", type: "agentMessage", text: "Revoked later reply" },
      );
      let revoked = false;
      const withWriteLock = transcriptRuntime.withSessionTranscriptWriteLock;
      vi.spyOn(transcriptRuntime, "withSessionTranscriptWriteLock").mockImplementation(
        (params, run) =>
          withWriteLock(params, (transcript) =>
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
      expect(response).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("source visibility changed") }),
      );
      const transcript = await fixture.transcript();
      expect(transcript).toHaveLength(4);
      expect(JSON.stringify(transcript)).toContain("First later reply");
      expect(JSON.stringify(transcript)).not.toContain("Revoked later reply");
    }, true);
  });
});
