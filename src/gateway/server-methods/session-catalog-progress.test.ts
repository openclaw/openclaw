import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { catalogLog } from "./session-catalog-log.test-support.js";
import {
  call,
  hoisted,
  provider,
  resetSessionCatalogTestState,
  startCall,
  type SessionCatalogProvider,
} from "./session-catalog.test-helpers.js";

const localHost = (overrides: Partial<SessionCatalogHost> = {}): SessionCatalogHost => ({
  hostId: "gateway:local",
  label: "Local",
  kind: "gateway",
  connected: true,
  sessions: [],
  ...overrides,
});
const install = (...providers: SessionCatalogProvider[]) => {
  hoisted.activeRegistry.sessionCatalogs = providers.map((catalogProvider) => ({
    provider: catalogProvider,
  }));
};
const listCall = (
  ...args: Parameters<typeof call> extends [unknown, ...infer Rest] ? Rest : never
) => call("sessions.catalog.list", ...args);
const startList = (
  ...args: Parameters<typeof startCall> extends [unknown, ...infer Rest] ? Rest : never
) => startCall("sessions.catalog.list", ...args);
const catalog = (id: string, hosts: SessionCatalogHost[]) => expect.objectContaining({ id, hosts });

describe("session catalog progress ownership", () => {
  beforeEach(resetSessionCatalogTestState);

  it.each([false, true])(
    "streams hosts only to the requester and honors final withdrawal (withdrawn=%s)",
    async (withdrawn) => {
      const broadcastToConnIds = vi.fn();
      const host = localHost({
        hostId: "node:fast",
        label: "Fast node",
        kind: "node",
        nodeId: "fast",
      });
      install(
        provider("codex", {
          list: vi.fn(async ({ onHost }) => {
            onHost?.(host);
            return withdrawn ? [] : [host];
          }),
        }),
      );

      const respond = await listCall(
        { progressId: "progress-1", ...(withdrawn ? { allowPartialResults: true } : {}) },
        {},
        { connId: "requester", connect: {} },
        { broadcastToConnIds },
      );

      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.catalog.host",
        {
          progressId: "progress-1",
          agentId: "main",
          catalog: catalog("codex", [host]),
        },
        new Set(["requester"]),
        { dropIfSlow: true },
      );
      expect(broadcastToConnIds).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[1]?.catalogs[0]?.error).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(true, {
        catalogs: [catalog("codex", withdrawn ? [] : [host])],
      });
    },
  );

  it("single-flights identical concurrent lists for one caller and fans progress to active followers", async () => {
    const previousDiagnostics = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const enabled = catalogLog.isEnabled.mockReset().mockReturnValue(true);
    const warn = catalogLog.warn.mockReset().mockImplementation(() => {});
    const { promise: gate, resolve: release } = createDeferredCore();
    const started = createDeferredCore();
    const host = localHost();
    const late = createDeferredCore();
    const publications: Promise<void>[] = [];
    const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost, waitUntil }) => {
      const publication = late.promise.then(() => onHost?.(host));
      publications.push(publication);
      waitUntil?.(publication);
      started.resolve();
      await gate;
      onHost?.(host);
      return [host];
    });
    install(provider("codex", { list }));
    const config = { agents: { entries: { main: {}, research: {} } } };
    const leaderBroadcast = vi.fn();
    const followerBroadcast = vi.fn();
    const sharedClient = { connId: "requester" };
    const leader = startList(
      { progressId: "leader-progress", agentId: "main" },
      config,
      sharedClient,
      { broadcastToConnIds: leaderBroadcast },
    );
    const follower = startList(
      { progressId: "follower-progress", agentId: "main" },
      config,
      sharedClient,
      { broadcastToConnIds: followerBroadcast },
    );
    const otherAgent = startList({ agentId: "research" }, config);
    const otherParams = startList({ search: "other", agentId: "main" }, config);
    const pending = [leader, follower, otherAgent, otherParams];

    try {
      await started.promise;
      expect(list).toHaveBeenCalledTimes(3);
      clock = 1_500;
      release();
      await Promise.all(pending.map(({ completion }) => completion));

      expect(list).toHaveBeenCalledTimes(3);
      expect(leaderBroadcast).toHaveBeenCalledOnce();
      expect(followerBroadcast).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledTimes(3);
      for (const [message, fields] of warn.mock.calls) {
        expect(message).toBe("slow session catalog provider list");
        expect(fields).toMatchObject({ elapsedMs: 1_500, returnedGatewayHostCount: 1 });
      }
      for (const { respond } of pending) {
        expect(respond).toHaveBeenCalledWith(true, {
          catalogs: [catalog("codex", [host])],
        });
      }
      const settledBroadcast = vi.fn();
      await listCall({ progressId: "settled-progress", agentId: "main" }, config, sharedClient, {
        broadcastToConnIds: settledBroadcast,
      });
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
      await Promise.allSettled([...pending.map(({ completion }) => completion), ...publications]);
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
      const release = createDeferredCore();
      const list = vi.fn<SessionCatalogProvider["list"]>(async () => {
        await release.promise;
        return [];
      });
      install(provider("fixture", { list }));
      const config = {};
      const client = { connId: "requester" };
      const context = { isConnectionActive: () => connected };
      const progressive = startList({ catalogId: "fixture", ...request }, config, client, context);
      const complete = startList(
        { catalogId: "fixture", ...request, allowPartialResults: false },
        config,
        client,
        context,
      );
      try {
        release.resolve();
        await Promise.all([progressive.completion, complete.completion]);
        expect(list).toHaveBeenCalledWith(
          expect.objectContaining({ allowPartialResults: partial }),
        );
        expect(list).toHaveBeenCalledTimes(partial ? 2 : 1);
      } finally {
        release.resolve();
        await Promise.allSettled([progressive.completion, complete.completion]);
      }
    },
  );

  it.each([false, true])(
    "keeps newer host publications in the aggregate while another provider waits (cold=%s)",
    async (cold) => {
      const sibling = createDeferredCore();
      const publish = createDeferredCore();
      const local = localHost();
      const cached = localHost({
        hostId: "node:slow",
        label: "Cached",
        kind: "node",
      });
      const fresh = { ...cached, label: "Fresh" };
      let publication: Promise<void> | undefined;
      install(
        provider("fixture", {
          list: async ({ onHost, waitUntil }) => {
            publication = publish.promise.then(() => onHost?.(fresh));
            waitUntil?.(publication);
            return cold ? [local, { ...cached, pending: true }] : [local, cached];
          },
        }),
        provider("sibling", {
          list: async () => {
            await sibling.promise;
            return [];
          },
        }),
      );
      const broadcastToConnIds = vi.fn();
      const pending = startList(
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
          catalogs: [catalog("fixture", [local, fresh]), catalog("sibling", [])],
        });
      } finally {
        publish.resolve();
        sibling.resolve();
        await Promise.allSettled([pending.completion, publication]);
      }
    },
  );

  it("keeps an active list shared after 128 distinct lists settle", async () => {
    const started = createDeferredCore();
    const release = createDeferredCore();
    const list = vi.fn<SessionCatalogProvider["list"]>(async ({ search }) => {
      if (search === "held") {
        started.resolve();
        await release.promise;
      }
      return [];
    });
    install(provider("fixture", { list }), provider("completed"));
    const config = {};
    const client = { connId: "requester" };
    const request = { catalogId: "fixture", search: "held" };
    const leader = startList(request, config, client);
    const pending = [leader];
    try {
      await started.promise;
      for (let index = 0; index < 128; index += 1) {
        const respond = await listCall(
          { catalogId: "completed", search: `completed-${index}` },
          config,
          client,
        );
        expect(respond).toHaveBeenCalledWith(true, {
          catalogs: [catalog("completed", [])],
        });
      }
      pending.push(startList(request, config, client));
      release.resolve();
      await Promise.all(pending.map(({ completion }) => completion));
      for (const { respond } of pending) {
        expect(respond).toHaveBeenCalledWith(true, {
          catalogs: [catalog("fixture", [])],
        });
      }
      expect(list.mock.calls.filter(([params]) => params.search === "held")).toHaveLength(1);
      await listCall(request, config, client);
      expect(list.mock.calls.filter(([params]) => params.search === "held")).toHaveLength(2);
    } finally {
      release.resolve();
      await Promise.allSettled(pending.map(({ completion }) => completion));
    }
  });

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
      const host = localHost({ sessions: [session] });
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
      install(
        provider("fixture", {
          list,
          archive: async () => {
            archived = true;
            return { ok: true };
          },
        }),
      );
      const config = {};
      const client = { connId: "requester" };
      const original = startList({ progressId: "before-delete" }, config, client, {
        broadcastToConnIds,
      });
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

        const refreshed = await listCall({ progressId: "after-delete" }, config, client, {
          broadcastToConnIds: vi.fn(),
        });
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

  it.each(["gateway-close", "disconnect", "projection-failure"] as const)(
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
          params.onHost?.(localHost({ hostId: "node:late", label: "Late", kind: "node" })),
        );
        publications.push(publication);
        params.waitUntil?.(publication);
        return [];
      });
      install(provider("fixture", { list }));
      const config = {};
      try {
        const getRuntimeConfig = vi
          .fn()
          .mockReturnValueOnce(config)
          .mockImplementation(() => {
            throw new Error("current config unavailable");
          });
        const original = listCall(
          { progressId: "original" },
          config,
          { connId: "old", connectionSignal: connection.signal },
          {
            broadcastToConnIds,
            requestEntryLifetime: { signal: gateway.signal },
            ...(retirement === "projection-failure" ? { getRuntimeConfig } : {}),
          },
        );
        if (retirement === "projection-failure") {
          await expect(original).rejects.toThrow("current config unavailable");
        } else {
          await original;
        }
        if (retirement === "gateway-close") {
          gateway.abort();
        } else if (retirement === "disconnect") {
          connection.abort();
        }
        expect(producerSignal?.aborted).toBe(retirement !== "disconnect");
        await listCall(
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
