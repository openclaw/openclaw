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
function caller(
  config: Parameters<typeof call>[2] = {},
  client: Parameters<typeof call>[3] = { connId: "requester" },
) {
  return {
    list: (params: unknown, context = {}) =>
      call("sessions.catalog.list", params, config, client, context),
    start: (params: unknown, context = {}) =>
      startCall("sessions.catalog.list", params, config, client, context),
  };
}
const catalog = (id: string, hosts: SessionCatalogHost[]) => expect.objectContaining({ id, hosts });
const expectCatalogs = (respond: ReturnType<typeof startCall>["respond"], ...catalogs: unknown[]) =>
  expect(respond).toHaveBeenCalledWith(true, { catalogs });

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

      const respond = await caller({}, { connId: "requester", connect: {} }).list(
        { progressId: "progress-1", ...(withdrawn ? { allowPartialResults: true } : {}) },
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
      expectCatalogs(respond, catalog("codex", withdrawn ? [] : [host]));
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
    const rpc = caller(config);
    const leader = rpc.start(
      { progressId: "leader-progress", agentId: "main" },
      { broadcastToConnIds: leaderBroadcast },
    );
    const follower = rpc.start(
      { progressId: "follower-progress", agentId: "main" },
      { broadcastToConnIds: followerBroadcast },
    );
    const otherAgent = startCall("sessions.catalog.list", { agentId: "research" }, config);
    const otherParams = startCall(
      "sessions.catalog.list",
      { search: "other", agentId: "main" },
      config,
    );
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
      for (const { respond } of pending) {
        expectCatalogs(respond, catalog("codex", [host]));
      }
      const settledBroadcast = vi.fn();
      await rpc.list(
        { progressId: "settled-progress", agentId: "main" },
        {
          broadcastToConnIds: settledBroadcast,
        },
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
      await Promise.allSettled([...pending.map(({ completion }) => completion), ...publications]);
      now.mockRestore();
      enabled.mockReset();
      warn.mockReset();
      setDiagnosticsEnabledForProcess(previousDiagnostics);
    }
  });

  it.each([
    [{}, true, false],
    [{ progressId: "legacy" }, true, false],
    [{ allowPartialResults: true, progressId: "live" }, true, true],
    [{ allowPartialResults: true, progressId: "live" }, false, false],
    [{ allowPartialResults: true, progressId: "live", hostIds: ["node:fast"] }, true, false],
    [
      { allowPartialResults: true, progressId: "live", cursors: { "node:fast": "page" } },
      true,
      false,
    ],
  ] as const)(
    "negotiates partial results for %j (connected=%s, partial=%s)",
    async (request, connected, partial) => {
      const release = createDeferredCore();
      const list = vi.fn<SessionCatalogProvider["list"]>(async () => {
        await release.promise;
        return [];
      });
      install(provider("fixture", { list }));
      const rpc = caller();
      const context = { isConnectionActive: () => connected };
      const progressive = rpc.start({ catalogId: "fixture", ...request }, context);
      const complete = rpc.start(
        { catalogId: "fixture", ...request, allowPartialResults: false },
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
      const pending = caller().start(
        { allowPartialResults: true, progressId: "live" },
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
        expectCatalogs(pending.respond, catalog("fixture", [local, fresh]), catalog("sibling", []));
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
    const rpc = caller();
    const request = { catalogId: "fixture", search: "held" };
    const leader = rpc.start(request);
    const pending = [leader];
    try {
      await started.promise;
      for (let index = 0; index < 128; index += 1) {
        const respond = await rpc.list({ catalogId: "completed", search: `completed-${index}` });
        expectCatalogs(respond, catalog("completed", []));
      }
      pending.push(rpc.start(request));
      release.resolve();
      await Promise.all(pending.map(({ completion }) => completion));
      for (const { respond } of pending) {
        expectCatalogs(respond, catalog("fixture", []));
      }
      expect(list.mock.calls.filter(([params]) => params.search === "held")).toHaveLength(1);
      await rpc.list(request);
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
      const rpc = caller(config, client);
      const original = rpc.start(
        { progressId: "before-delete" },
        {
          broadcastToConnIds,
        },
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
        expectCatalogs(original.respond, expect.objectContaining({ hosts: [host] }));

        const refreshed = await rpc.list(
          { progressId: "after-delete" },
          {
            broadcastToConnIds: vi.fn(),
          },
        );
        expectCatalogs(refreshed, expect.objectContaining({ hosts: [{ ...host, sessions: [] }] }));
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
        const original = caller(config, {
          connId: "old",
          connectionSignal: connection.signal,
        }).list(
          { progressId: "original" },
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
        await caller(config, { connId: "new" }).list(
          { progressId: "replacement" },
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
