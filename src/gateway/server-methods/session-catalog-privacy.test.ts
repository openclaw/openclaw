import { describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  type SessionCatalogHost,
  type SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  listAdoptedSessionCatalogSessions,
  type SessionCatalogEntrySnapshot,
  type SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { sessionCatalogHandlers } from "./session-catalog.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const nativeSession = (overrides: Partial<SessionCatalogSession> = {}): SessionCatalogSession => ({
  threadId: "published-native",
  status: "stored",
  archived: false,
  canContinue: false,
  canArchive: false,
  ...overrides,
});
const forbidden = expect.objectContaining({ code: ErrorCodes.FORBIDDEN });
const progressRows = (broadcast: ReturnType<typeof vi.fn>) =>
  broadcast.mock.calls[0]?.[1]?.catalog.hosts[0]?.sessions.map(
    (row: { threadId: string }) => row.threadId,
  );
const delivery = () => {
  const signal = createDeferredCore();
  return {
    promise: signal.promise,
    broadcast: vi.fn<GatewayRequestContext["broadcast"]>(() => signal.resolve()),
  };
};

async function withCatalog(
  run: (fixture: Awaited<ReturnType<typeof createCatalog>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
    let fixture: Awaited<ReturnType<typeof createCatalog>> | undefined;
    try {
      fixture = await createCatalog();
      // Deferred providers must not race the response budget while privacy writes settle.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await run(fixture);
    } finally {
      fixture?.projection.dispose();
      setActivePluginRegistry(previousRegistry);
      vi.useRealTimers();
    }
  });
}

async function createCatalog() {
  const caller = ensureProfileForEmail("catalog-caller@example.test");
  const other = ensureProfileForEmail("catalog-other@example.test");
  const config: OpenClawConfig = {
    gateway: {
      roles: {
        default: "writer",
        definitions: {
          writer: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  for (const [id, profileId, source, visibility] of [
    ["foreign", other.id, "profile", "shared"],
    ["owned", caller.id, "profile", "draft"],
    ["collision", caller.id, "channel", "draft"],
  ] as const) {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: `agent:main:${id}` },
      {
        sessionId: id,
        updatedAt: 1,
        visibility,
        pluginOwnerId: "fixture",
        createdVia: source === "profile" ? "operator" : "channel",
        createdActor: { type: "human", source, id: profileId },
      },
    );
  }
  const host: SessionCatalogHost = {
    hostId: "gateway:local",
    label: "Local",
    kind: "gateway",
    connected: true,
    sessions: ["foreign", "owned", "collision"].map((id) => ({
      threadId: id,
      sessionKey: `agent:main:${id}`,
      status: "stored",
      archived: false,
      canContinue: true,
      canArchive: true,
    })),
  };
  const runtime = createPluginRuntime();
  const enumerate = (sessionEntries?: SessionCatalogEntrySnapshot): SessionCatalogHost => {
    const adopted = listAdoptedSessionCatalogSessions({
      agentId: "main",
      config,
      pluginId: "fixture",
      runtime,
      sessionEntries,
      sourceFromEntry: (entry) => ({ hostId: host.hostId, threadId: entry.sessionId }),
    });
    return {
      ...host,
      sessions: host.sessions.map(({ sessionKey: _key, ...session }) => {
        const sessionKey = adopted.get(`${host.hostId}\0${session.threadId}`);
        return sessionKey ? { ...session, sessionKey } : session;
      }),
    };
  };
  const list = vi.fn<SessionCatalogProvider["list"]>(async ({ sessionEntries }) => [
    enumerate(sessionEntries),
  ]);
  const read = vi.fn<SessionCatalogProvider["read"]>(async ({ hostId, threadId }) => ({
    hostId,
    threadId,
    items: [],
  }));
  const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:owned" }));
  const archive = vi.fn(async () => ({ ok: true as const }));
  const deferEnumeration = ({ prepare = false, late = false, publish = true } = {}) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let observed: SessionCatalogHost | undefined;
    let completion: Promise<void> | undefined;
    list.mockImplementation(({ sessionEntries, onHost, waitUntil }) => {
      observed = prepare || late ? enumerate(sessionEntries) : undefined;
      const deliver = () => {
        observed ??= enumerate(sessionEntries);
        if (publish) {
          onHost?.(observed);
        }
        return [observed];
      };
      entered.resolve();
      if (late) {
        completion = release.promise.then(() => {
          deliver();
        });
        waitUntil?.(completion);
        return Promise.resolve([]);
      }
      const result = release.promise.then(deliver);
      completion = result.then(() => {});
      return result;
    });
    return {
      entered,
      release,
      get observed() {
        return observed;
      },
      get completion() {
        return completion;
      },
    };
  };
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({
    pluginId: "fixture",
    source: import.meta.url,
    provider: { id: "fixture", label: "Fixture", list, read, continueSession, archive },
  });
  setActivePluginRegistry(registry);
  const client = (profileId: string) =>
    ({
      connId: profileId,
      connect: { scopes: ["operator.read", "operator.write"] },
      authenticatedUserProfile: { profileId },
    }) as GatewayClient;
  const owner = client(caller.id);
  const foreignOwner = client(other.id);
  const projection = await createSessionRowProjection({ cfg: config, getConfig: () => config });
  const call = async (
    method: "list" | "read" | "continue" | "archive" = "list",
    params: Record<string, unknown> = {},
    requestClient = owner,
    broadcastToConnIds = vi.fn(),
  ) => {
    const respond = vi.fn();
    const context = bindSessionRowProjection(
      { getRuntimeConfig: () => config, broadcastToConnIds } satisfies Pick<
        GatewayRequestContext,
        "getRuntimeConfig" | "broadcastToConnIds"
      >,
      () => projection,
    );
    await withPluginRuntimeGatewayRequestScope(
      { client: requestClient, pluginRegistry: registry, isWebchatConnect: () => false },
      () =>
        sessionCatalogHandlers[`sessions.catalog.${method}`]?.({
          params:
            method === "list"
              ? params
              : {
                  catalogId: "fixture",
                  hostId: host.hostId,
                  threadId: "published-native",
                  ...(method === "archive" ? { confirmNoOtherRunner: true } : {}),
                  ...params,
                },
          client: requestClient,
          respond,
          context,
        } as never),
    );
    return respond;
  };
  const changeForeign = (patch: { visibility?: "draft" | "shared"; incognito?: true }) =>
    upsertSessionEntryCore({ agentId: "main", sessionKey: "agent:main:foreign" }, patch);
  const replaceForeign = async () => {
    const sessionKey = "agent:main:foreign";
    const removed = await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: false,
      expectedSessionId: "foreign",
    });
    expect(removed.deleted).toBe(true);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "replacement",
        updatedAt: 2,
        visibility: "draft",
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: caller.id },
      },
    );
    expect(
      loadSessionEntryReadOnly({ agentId: "main", sessionKey })?.pluginOwnerId,
    ).toBeUndefined();
  };
  return {
    call,
    config,
    registry,
    provider: registry.sessionCatalogs[0]!.provider,
    changeForeign,
    replaceForeign,
    enumerate,
    callerId: caller.id,
    foreignOwner,
    owner,
    host,
    list,
    read,
    continueSession,
    archive,
    projection,
    deferEnumeration,
  };
}

const rows = (respond: ReturnType<typeof vi.fn>) =>
  respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions.map(
    (row: { threadId: string }) => row.threadId,
  );

function expectOwnedRowsOrPending(respond: ReturnType<typeof vi.fn>) {
  expect.soft(respond).toHaveBeenCalledOnce();
  expect.soft(respond.mock.calls[0]?.[0]).toBe(true);
  const catalog = respond.mock.calls[0]?.[1]?.catalogs[0];
  if (catalog?.error) {
    expect.soft(catalog).toMatchObject({
      id: "fixture",
      hosts: [],
      error: { code: "catalog_pending" },
    });
  } else {
    expect.soft(rows(respond)).toEqual(["owned"]);
  }
}

describe("catalog delivery uses current canonical privacy", () => {
  it("lists remote publications without local stores while preserving mixed-request adoption", () =>
    withCatalog(async (fixture) => {
      const { call, list } = fixture;
      const remoteHost: SessionCatalogHost = {
        hostId: "node:source",
        label: "Source",
        kind: "node",
        connected: true,
        sessions: [nativeSession({ threadId: "remote" })],
      };
      fixture.registry.sessionCatalogs.push({
        pluginId: "publication",
        source: import.meta.url,
        provider: {
          id: "publication",
          label: "Publication",
          audience: "session-viewers",
          list: async () => [remoteHost],
          read: fixture.read,
        },
      });
      const unavailable = vi
        .spyOn(sessionAccessor, "listSessionEntriesReadOnly")
        .mockImplementation(() => {
          throw new Error("Local adoption store unavailable");
        });
      try {
        expect(rows(await call("list", { catalogId: "publication" }))).toEqual(["remote"]);
      } finally {
        unavailable.mockRestore();
      }

      const enumeration = fixture.deferEnumeration();
      const { promise: delivered, broadcast } = delivery();
      const pending = call(
        "list",
        { progressId: "mixed-request-adoption" },
        fixture.owner,
        broadcast,
      );
      try {
        await enumeration.entered.promise;
        await fixture.replaceForeign();
        enumeration.release.resolve();
        const [response] = await Promise.all([pending, enumeration.completion, delivered]);
        expect(
          enumeration.observed?.sessions.find((session) => session.threadId === "foreign")
            ?.sessionKey,
        ).toBe("agent:main:foreign");
        expect(list).toHaveBeenCalledOnce();
        expect(broadcast).toHaveBeenCalledOnce();
        expect(broadcast.mock.calls[0]?.[1]).toMatchObject({
          progressId: "mixed-request-adoption",
          agentId: "main",
          catalog: { id: "fixture" },
        });
        // The RPC budget may finish first; progress uses the same current-row privacy projection.
        expect(progressRows(broadcast)).toEqual(["owned"]);
        expectOwnedRowsOrPending(response);
        expect(response.mock.calls[0]?.[1]?.catalogs[1]?.hosts).toEqual([remoteHost]);
      } finally {
        enumeration.release.resolve();
        await Promise.allSettled([pending, enumeration.completion]);
      }
    }));

  it("gates native session-viewers rows and reads without a profile", async () =>
    withCatalog(async ({ call, config, provider, owner, host, list, read }) => {
      provider.audience = "session-viewers";
      config.gateway!.roles!.definitions.writer!.sessions!.others = "view";
      const requestClient = { ...owner, authenticatedUserProfile: undefined };
      const publishedHost: SessionCatalogHost = {
        ...host,
        sessions: [
          nativeSession({
            createdActor: {
              type: "human",
              id: "remote-human",
              label: "Published Person",
              identity: {
                type: "remote",
                pluginId: "fixture",
                domain: "source",
                idKind: "profile",
                id: "remote-human",
              },
            },
          }),
        ],
      };
      list.mockImplementation(async ({ onHost }) => {
        onHost?.(publishedHost);
        return [publishedHost];
      });
      const broadcast = vi.fn();
      const listed = await call("list", { progressId: "published" }, requestClient, broadcast);
      expect.soft(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([]);
      expect.soft(progressRows(broadcast)).toEqual([]);
      const transcript = await call("read", {}, requestClient);
      expect(transcript).toHaveBeenCalledWith(false, undefined, forbidden);
      expect(read).not.toHaveBeenCalled();
    }));

  it("rechecks published read visibility after a role cap changes during provider read", () =>
    withCatalog(async ({ call, config, provider, read }) => {
      provider.audience = "session-viewers";
      const role = config.gateway!.roles!.definitions.writer!;
      role.sessions!.others = "view";
      const entered = createDeferredCore();
      const release = createDeferredCore();
      read.mockImplementation(async ({ hostId, threadId }) => {
        entered.resolve();
        await release.promise;
        return {
          hostId,
          threadId,
          items: [{ type: "userMessage", text: "published transcript" }],
        };
      });
      const pending = call("read");
      await entered.promise;
      role.sessions!.others = "none";
      release.resolve();
      const denied = await pending;
      expect(denied).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.FORBIDDEN,
          message: "session catalog thread is not visible to this caller",
        }),
      );
    }));

  it("never adopts a published source key or grants mutation authority through it", () =>
    withCatalog(async ({ call, provider, host, list, continueSession, archive }) => {
      provider.audience = "session-viewers";
      const createdActor = { type: "agent" as const, id: "publisher", label: "Source Agent" };
      const published = nativeSession({ createdActor });
      list.mockResolvedValue([
        { ...host, sessions: [{ ...published, sessionKey: "agent:main:owned" }] },
      ]);
      const listed = await call();
      expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([published]);
      for (const method of ["continue", "archive"] as const) {
        const result = await call(method);
        expect(result).toHaveBeenCalledWith(false, undefined, forbidden);
      }
      expect(continueSession).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
    }));

  it("keeps caller-bound provider enumeration separate while sharing the same caller's work", () =>
    withCatalog(async ({ call, owner, foreignOwner, host, list }) => {
      const release = createDeferredCore();
      list.mockImplementation(async () => {
        const scoped = getPluginRuntimeGatewayRequestScope()?.client;
        await release.promise;
        return [{ ...host, label: scoped?.connId ?? "missing-scope", sessions: [] }];
      });
      const otherConnection = { ...owner, connId: "other-connection" };
      const admin = {
        ...owner,
        connId: "admin-connection",
        connect: { ...owner.connect, scopes: ["operator.admin"] },
      };
      const callers = [owner, owner, otherConnection, foreignOwner, admin];
      const pending = callers.map((caller) => call("list", {}, caller));
      release.resolve();
      const responses = await Promise.all(pending);
      responses.forEach((respond, index) => {
        expect
          .soft(respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.label)
          .toBe(callers[index]?.connId);
      });
      expect.soft(list).toHaveBeenCalledTimes(4);
      await call();
      expect.soft(list).toHaveBeenCalledTimes(5);
      owner.connect.scopes = ["operator.read"];
      await call();
      expect(list).toHaveBeenCalledTimes(6);
    }));

  it("rechecks provider results after incognito changes and profile linking", async () =>
    withCatalog(async ({ call, changeForeign, list, callerId }) => {
      expect(rows(await call())).toEqual(["foreign", "owned"]);
      await changeForeign({ incognito: true });
      expect.soft(rows(await call())).toEqual(["owned"]);
      expect(list).toHaveBeenCalledTimes(2);
      expect(rows(await call("list", { search: "cold" }))).toEqual(["owned"]);
      expect(list).toHaveBeenCalledTimes(3);
      linkEmail("catalog-other@example.test", callerId);
      expect(rows(await call())).toEqual(["owned"]);
      expect(list).toHaveBeenCalledTimes(4);
    }));

  it("rechecks recorded plugin ownership on each list", () =>
    withCatalog(async ({ call, list }) => {
      expect(rows(await call())).toEqual(["foreign", "owned"]);
      const scope = { agentId: "main", sessionKey: "agent:main:owned" };
      await upsertSessionEntryCore(scope, { pluginOwnerId: "other-plugin" });
      expect(rows(await call())).toEqual(["foreign"]);
      await upsertSessionEntryCore(scope, { pluginOwnerId: "fixture" });
      expect(rows(await call())).toEqual(["foreign", "owned"]);
      expect(list).toHaveBeenCalledTimes(3);
    }));

  it.each([false, true])(
    "retains the original adoption across replacement (late=%s)",
    async (late) =>
      withCatalog(async (fixture) => {
        const { call, changeForeign, replaceForeign, list, owner } = fixture;
        await changeForeign({ visibility: "draft" });
        const enumeration = fixture.deferEnumeration({ late });
        const { promise: delivered, broadcast } = delivery();
        const pending = call("list", { progressId: "replacement" }, owner, broadcast);
        try {
          await enumeration.entered.promise;
          if (late) {
            const initial = await pending;
            expect(initial.mock.calls[0]?.[1]?.catalogs[0]?.hosts).toEqual([]);
          }
          await replaceForeign();
          enumeration.release.resolve();
          const result = await pending;
          await enumeration.completion;
          await delivered;
          // The provider's request snapshot keeps the original adoption even when first read
          // after its await; publication must reject that now-replaced instance independently.
          expect
            .soft(
              enumeration.observed?.sessions.find((session) => session.threadId === "foreign")
                ?.sessionKey,
            )
            .toBe("agent:main:foreign");
          if (!late) {
            expectOwnedRowsOrPending(result);
          }
          expect(list).toHaveBeenCalledOnce();
          expect(broadcast).toHaveBeenCalledOnce();
          expect.soft(progressRows(broadcast)).toEqual(["owned"]);
        } finally {
          enumeration.release.resolve();
          await Promise.allSettled([pending, enumeration.completion]);
        }
      }),
  );

  it("rechecks each follower at progress and final delivery after provider awaits", () =>
    withCatalog(async ({ call, changeForeign, owner, foreignOwner, host, list, provider }) => {
      const entered = createDeferredCore();
      const progress = createDeferredCore();
      const finish = createDeferredCore();
      list.mockImplementation(async ({ sessionEntries, onHost }) => {
        sessionEntries?.entriesForCatalog?.();
        entered.resolve();
        await progress.promise;
        onHost?.(host);
        return [host];
      });
      provider.createListOperation = (params) => {
        let hosts: SessionCatalogHost[] | undefined;
        return {
          async next() {
            if (!hosts) {
              hosts = await list(params);
              return { done: false };
            }
            await finish.promise;
            return { done: true, hosts };
          },
          close() {},
        };
      };
      const callers = [
        { progressId: "leader", client: owner, ...delivery() },
        { progressId: "same-caller", client: owner, ...delivery() },
        { progressId: "follower", client: foreignOwner, ...delivery() },
      ];
      const start = ({ progressId, client, broadcast }: (typeof callers)[number]) =>
        call("list", { progressId }, client, broadcast);
      const pending = [start(callers[0]!)];
      try {
        await entered.promise;
        pending.push(...callers.slice(1).map(start));
        await changeForeign({ visibility: "draft" });
        progress.resolve();
        await Promise.all(callers.map(({ promise }) => promise));
        for (const output of callers) {
          expect(output.broadcast).toHaveBeenCalledOnce();
        }
        expect
          .soft(callers.map(({ broadcast }) => progressRows(broadcast)))
          .toEqual([["owned"], ["owned"], ["foreign"]]);
        await changeForeign({ incognito: true });
        finish.resolve();
        expect.soft((await Promise.all(pending)).map(rows)).toEqual([["owned"], ["owned"], []]);
        expect(list).toHaveBeenCalledTimes(2);
      } finally {
        progress.resolve();
        finish.resolve();
        await Promise.allSettled(pending);
      }
    }));

  it.each([
    { method: "read", change: "privacy" },
    { method: "continue", change: "replacement" },
    { method: "archive", change: "privacy" },
  ] as const)(
    "rechecks $change after enumeration before $method dispatch",
    async ({ method, change }) =>
      withCatalog(async (fixture) => {
        const { call, changeForeign, replaceForeign, read, continueSession, archive } = fixture;
        const enumeration = fixture.deferEnumeration({ prepare: true, publish: false });
        const locator = { threadId: "foreign" };
        const pending = call(method, locator);
        await enumeration.entered.promise;
        await changeForeign({ visibility: "draft" });
        if (change === "replacement") {
          await replaceForeign();
        }
        enumeration.release.resolve();
        const denied = await pending;
        expect.soft(denied).toHaveBeenCalledWith(false, undefined, forbidden);
        const dispatch =
          method === "read" ? read : method === "continue" ? continueSession : archive;
        expect.soft(dispatch).not.toHaveBeenCalled();
        const allowed = await call(method, { ...locator, threadId: "owned" });
        expect(allowed.mock.calls[0]?.[0]).toBe(true);
      }),
  );
});
