import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { catalogLog } from "./session-catalog-log.test-support.js";
import {
  call,
  hoisted,
  markPluginRegistryActive,
  provider,
  resetSessionCatalogTestState,
  startCall,
  type PluginRegistry,
  type SessionCatalogProvider,
} from "./session-catalog.test-helpers.js";

describe("session catalog progress ownership", () => {
  beforeEach(resetSessionCatalogTestState);

  it("streams completed hosts to only the requesting connection", async () => {
    const broadcastToConnIds = vi.fn();
    const host = {
      hostId: "node:fast",
      label: "Fast node",
      kind: "node" as const,
      connected: true,
      nodeId: "fast",
      sessions: [],
    };
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("codex", {
          list: vi.fn(async ({ onHost }) => {
            onHost?.(host);
            return [host];
          }),
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.list",
      { progressId: "progress-1" },
      {},
      { connId: "requester", connect: {} },
      { broadcastToConnIds },
    );

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.catalog.host",
      {
        progressId: "progress-1",
        agentId: "main",
        catalog: expect.objectContaining({ id: "codex", hosts: [host] }),
      },
      new Set(["requester"]),
      { dropIfSlow: true },
    );
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
    });
  });

  it("single-flights identical concurrent lists for one caller and fans progress to active followers", async () => {
    const previousDiagnostics = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const enabled = catalogLog.isEnabled.mockReset().mockReturnValue(true);
    const warn = catalogLog.warn.mockReset().mockImplementation(() => {});
    const { promise: gate, resolve: release } = createDeferredCore();
    const host = {
      hostId: "gateway:local",
      label: "Local",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const late = createDeferredCore();
    const publications: Promise<void>[] = [];
    const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost, waitUntil }) => {
      const publication = late.promise.then(() => onHost?.(host));
      publications.push(publication);
      waitUntil?.(publication);
      await gate;
      onHost?.(host);
      return [host];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = { agents: { list: [{ id: "main" }, { id: "research" }] } };
    const leaderBroadcast = vi.fn();
    const followerBroadcast = vi.fn();
    const sharedClient = { connId: "requester" };
    const leader = startCall(
      "sessions.catalog.list",
      { progressId: "leader-progress", agentId: "main" },
      config,
      sharedClient,
      { broadcastToConnIds: leaderBroadcast },
    );
    const follower = startCall(
      "sessions.catalog.list",
      { progressId: "follower-progress", agentId: "main" },
      config,
      sharedClient,
      { broadcastToConnIds: followerBroadcast },
    );
    const otherAgent = startCall("sessions.catalog.list", { agentId: "research" }, config);
    const otherParams = startCall(
      "sessions.catalog.list",
      { search: "other", agentId: "main" },
      config,
    );

    try {
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
      clock = 1_500;
      release();
      await Promise.all([
        leader.completion,
        follower.completion,
        otherAgent.completion,
        otherParams.completion,
      ]);

      expect(leaderBroadcast).toHaveBeenCalledOnce();
      expect(followerBroadcast).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledTimes(3);
      for (const [message, fields] of warn.mock.calls) {
        expect(message).toBe("slow session catalog provider list");
        expect(fields).toMatchObject({ providerElapsedMs: 1_500, returnedGatewayHostCount: 1 });
      }
      for (const pending of [leader, follower, otherAgent, otherParams]) {
        expect(pending.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
        });
      }
      const settledBroadcast = vi.fn();
      await call(
        "sessions.catalog.list",
        { progressId: "settled-progress", agentId: "main" },
        config,
        sharedClient,
        { broadcastToConnIds: settledBroadcast },
      );
      clock = 5_000;
      late.resolve();
      await Promise.all(publications);
      expect(leaderBroadcast).toHaveBeenCalledTimes(2);
      expect(followerBroadcast).toHaveBeenCalledTimes(2);
      expect(settledBroadcast).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      release();
      late.resolve();
      await Promise.allSettled([
        leader.completion,
        follower.completion,
        otherAgent.completion,
        otherParams.completion,
        ...publications,
      ]);
      now.mockRestore();
      enabled.mockReset();
      warn.mockReset();
      setDiagnosticsEnabledForProcess(previousDiagnostics);
    }
  });

  it.each([
    { request: {}, connected: true, partial: false },
    { request: { progressId: "legacy" }, connected: true, partial: false },
    { request: { allowPartialResults: true, progressId: "live" }, connected: true, partial: true },
    {
      request: { allowPartialResults: true, progressId: "live" },
      connected: false,
      partial: false,
    },
    {
      request: { allowPartialResults: true, progressId: "live", hostIds: ["node:fast"] },
      connected: true,
      partial: false,
    },
    {
      request: { allowPartialResults: true, progressId: "live", cursors: { "node:fast": "page" } },
      connected: true,
      partial: false,
    },
  ])(
    "negotiates partial catalog results for $request (connected=$connected)",
    async ({ request, connected, partial }) => {
      const list = vi.fn<SessionCatalogProvider["list"]>(async () => []);
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      await call(
        "sessions.catalog.list",
        { catalogId: "fixture", ...request },
        {},
        { connId: "requester" },
        { isConnectionActive: () => connected },
      );
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ allowPartialResults: partial }));
    },
  );

  it("does not share a partial list with a caller awaiting a complete response", async () => {
    const release = createDeferredCore();
    const list = vi.fn<SessionCatalogProvider["list"]>(async () => {
      await release.promise;
      return [];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
    const config = {};
    const client = { connId: "requester" };
    const progressive = startCall(
      "sessions.catalog.list",
      { allowPartialResults: true, progressId: "live" },
      config,
      client,
    );
    const complete = startCall("sessions.catalog.list", {}, config, client);
    try {
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    } finally {
      release.resolve();
      await Promise.allSettled([progressive.completion, complete.completion]);
    }
  });

  it.each([false, true])(
    "keeps newer host publications in the aggregate while another provider waits (cold=%s)",
    async (cold) => {
      const sibling = createDeferredCore();
      const publish = createDeferredCore();
      const local = {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway" as const,
        connected: true,
        sessions: [],
      };
      const cached = {
        hostId: "node:slow",
        label: "Cached",
        kind: "node" as const,
        connected: true,
        sessions: [],
      };
      const fresh = { ...cached, label: "Fresh" };
      let publication: Promise<void> | undefined;
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("fixture", {
            list: async ({ onHost, waitUntil }) => {
              publication = publish.promise.then(() => onHost?.(fresh));
              waitUntil?.(publication);
              return cold ? [local, { ...cached, pending: true }] : [local, cached];
            },
          }),
        },
        {
          provider: provider("sibling", {
            list: async () => {
              await sibling.promise;
              return [];
            },
          }),
        },
      ];
      const broadcastToConnIds = vi.fn();
      const pending = startCall(
        "sessions.catalog.list",
        { allowPartialResults: true, progressId: "live" },
        {},
        { connId: "requester" },
        { broadcastToConnIds },
      );
      try {
        await vi.waitFor(() => expect(publication).toBeDefined());
        publish.resolve();
        await publication;
        expect(broadcastToConnIds).toHaveBeenCalledOnce();
        expect(pending.respond).not.toHaveBeenCalled();
        sibling.resolve();
        await pending.completion;
        expect(pending.respond).toHaveBeenCalledWith(true, {
          catalogs: [
            expect.objectContaining({ id: "fixture", hosts: [local, fresh] }),
            expect.objectContaining({ id: "sibling", hosts: [] }),
          ],
        });
      } finally {
        publish.resolve();
        sibling.resolve();
        await Promise.allSettled([pending.completion, publication]);
      }
    },
  );

  it("does not restore a host withdrawn from the provider's final snapshot", async () => {
    const broadcastToConnIds = vi.fn();
    const cached = {
      hostId: "node:removed",
      label: "Removed node",
      kind: "node" as const,
      connected: true,
      sessions: [],
    };
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("fixture", {
          list: async ({ onHost }) => {
            onHost?.(cached);
            return [];
          },
        }),
      },
    ];
    const respond = await call(
      "sessions.catalog.list",
      { progressId: "withdrawn", allowPartialResults: true },
      {},
      { connId: "requester" },
      { broadcastToConnIds },
    );
    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[1]?.catalogs[0]?.error).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "fixture", hosts: [] })],
    });
  });

  it.each([0, 128])(
    "keeps an active list shared after %i distinct lists settle",
    async (completedQueries) => {
      const started = createDeferredCore();
      const release = createDeferredCore();
      const list = vi.fn<SessionCatalogProvider["list"]>(async ({ search }) => {
        if (search === "held") {
          started.resolve();
          await release.promise;
        }
        return [];
      });
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      const config = {};
      const client = { connId: "requester" };
      const request = { catalogId: "fixture", search: "held" };
      const leader = startCall("sessions.catalog.list", request, config, client);
      const pending = [leader];
      try {
        await started.promise;
        for (let index = 0; index < completedQueries; index += 1) {
          const respond = await call(
            "sessions.catalog.list",
            { catalogId: "fixture", search: `completed-${index}` },
            config,
            client,
          );
          expect(respond).toHaveBeenCalledWith(true, {
            catalogs: [expect.objectContaining({ id: "fixture", hosts: [] })],
          });
        }
        pending.push(startCall("sessions.catalog.list", request, config, client));
        release.resolve();
        await Promise.all(pending.map(({ completion }) => completion));
        for (const { respond } of pending) {
          expect(respond).toHaveBeenCalledWith(true, {
            catalogs: [expect.objectContaining({ id: "fixture", hosts: [] })],
          });
        }
        expect(list.mock.calls.filter(([params]) => params.search === "held")).toHaveLength(1);
        await call("sessions.catalog.list", request, config, client);
        expect(list.mock.calls.filter(([params]) => params.search === "held")).toHaveLength(2);
      } finally {
        release.resolve();
        await Promise.allSettled(pending.map(({ completion }) => completion));
      }
    },
  );

  it.each(["settled", "in-flight"] as const)(
    "refreshes %s lists immediately after archiving a session",
    async (listingState) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const gate = createDeferredCore();
      const started = createDeferredCore();
      const late = createDeferredCore();
      const publications: Promise<void>[] = [];
      const broadcastToConnIds = vi.fn();
      const session = {
        threadId: "deleted-thread",
        status: "stored",
        archived: false,
        canContinue: false,
        canArchive: true,
      };
      const host = {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway" as const,
        connected: true,
        sessions: [session],
      };
      let archived = false;
      const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost, waitUntil }) => {
        const resultHost = { ...host, sessions: archived ? [] : [session] };
        const publication = late.promise.then(() => onHost?.(resultHost));
        publications.push(publication);
        waitUntil?.(publication);
        started.resolve();
        await gate.promise;
        return [resultHost];
      });
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("fixture", {
            list,
            archive: async () => {
              archived = true;
              return { ok: true };
            },
          }),
        },
      ];
      const config = {};
      const client = { connId: "requester" };
      const original = startCall(
        "sessions.catalog.list",
        { progressId: "before-delete" },
        config,
        client,
        { broadcastToConnIds },
      );
      try {
        await started.promise;
        if (listingState === "settled") {
          gate.resolve();
          await original.completion;
        }
        const deletion = await call(
          "sessions.catalog.archive",
          {
            catalogId: "fixture",
            hostId: host.hostId,
            threadId: session.threadId,
            confirmNoOtherRunner: true,
          },
          config,
          client,
        );
        expect(deletion).toHaveBeenCalledWith(true, { ok: true });
        late.resolve();
        await publications[0];
        gate.resolve();
        await original.completion;
        expect(original.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [host] })],
        });

        const refreshed = await call(
          "sessions.catalog.list",
          { progressId: "after-delete" },
          config,
          client,
          { broadcastToConnIds: vi.fn() },
        );
        expect(refreshed).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [{ ...host, sessions: [] }] })],
        });
        expect(list).toHaveBeenCalledTimes(2);
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        late.resolve();
        await original.completion;
        await Promise.allSettled(publications);
        now.mockRestore();
      }
    },
  );

  it("retires pending progress when aggregate projection fails", async () => {
    const late = createDeferredCore();
    const broadcastToConnIds = vi.fn();
    let publication: Promise<void> | undefined;
    let signal: AbortSignal | undefined;
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("fixture", {
          list: async (params) => {
            signal = params.signal;
            publication = late.promise.then(() =>
              params.onHost?.({
                hostId: "late",
                label: "Late",
                kind: "node",
                connected: true,
                sessions: [],
              }),
            );
            params.waitUntil?.(publication);
            return [];
          },
        }),
      },
    ];
    const getRuntimeConfig = vi
      .fn()
      .mockReturnValueOnce({})
      .mockImplementation(() => {
        throw new Error("current config unavailable");
      });
    try {
      await expect(
        call(
          "sessions.catalog.list",
          { progressId: "failed" },
          {},
          { connId: "requester" },
          {
            getRuntimeConfig,
            broadcastToConnIds,
          },
        ),
      ).rejects.toThrow("current config unavailable");
      expect(signal?.aborted).toBe(true);
      late.resolve();
      await publication;
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    } finally {
      late.resolve();
      await publication;
    }
  });

  it.each(["registry-reactivation", "gateway-close", "disconnect"] as const)(
    "fences old publications after %s while a replacement request can publish",
    async (retirement) => {
      const releases = [createDeferredCore(), createDeferredCore()];
      const publications: Promise<void>[] = [];
      const connection = new AbortController();
      const gateway = new AbortController();
      const broadcastToConnIds = vi.fn();
      const replacementBroadcast = vi.fn();
      let producerSignal: AbortSignal | undefined;
      const list = vi.fn<SessionCatalogProvider["list"]>(async (params) => {
        producerSignal = params.signal;
        const publication = releases[publications.length]!.promise.then(() =>
          params.onHost?.({
            hostId: "node:late",
            label: "Late",
            kind: "node",
            connected: true,
            sessions: [],
          }),
        );
        publications.push(publication);
        params.waitUntil?.(publication);
        return [];
      });
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      const config = {};
      try {
        await call(
          "sessions.catalog.list",
          { progressId: "original" },
          config,
          { connId: "old", connectionSignal: connection.signal },
          { broadcastToConnIds, requestEntryLifetime: { signal: gateway.signal } },
        );
        if (retirement === "registry-reactivation") {
          markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
        } else if (retirement === "gateway-close") {
          gateway.abort();
        } else {
          connection.abort();
        }
        expect(producerSignal?.aborted).toBe(retirement !== "disconnect");
        await call(
          "sessions.catalog.list",
          { progressId: "replacement" },
          config,
          { connId: "new" },
          { broadcastToConnIds: replacementBroadcast },
        );
        releases[0]!.resolve();
        await publications[0];
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        expect(replacementBroadcast).not.toHaveBeenCalled();
        expect(list).toHaveBeenCalledTimes(2);
        releases[1]!.resolve();
        await publications[1];
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        expect(replacementBroadcast).toHaveBeenCalledOnce();
        expect(replacementBroadcast.mock.calls[0]?.[1]?.progressId).toBe("replacement");
      } finally {
        for (const release of releases) {
          release.resolve();
        }
        await Promise.allSettled(publications);
      }
    },
  );
});
