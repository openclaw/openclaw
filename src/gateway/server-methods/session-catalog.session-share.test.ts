import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  bindPluginRegistryRuntime,
  hoisted,
  resetSessionCatalogTestState,
  startCall,
  type PluginRegistry,
} from "./session-catalog.test-helpers.js";

const { default: sessionSharePlugin } = await loadBundledPluginFacade<{
  default: { register: (api: OpenClawPluginApi) => void };
}>({ pluginId: "session-share", artifactBasename: "index.js" });

it.each([
  { sourceDelayMs: 5_000, unavailable: false },
  { sourceDelayMs: 30_000, unavailable: true },
])(
  "keeps a $sourceDelayMs ms source off the catalog RPC path",
  async ({ sourceDelayMs, unavailable }) => {
    resetSessionCatalogTestState();
    vi.useFakeTimers();
    const row = {
      threadId: "agent:main:shared",
      name: "Shared session",
      status: "idle",
      archived: false,
      canContinue: false,
      canArchive: false,
    };
    const source = createDeferredCore();
    const refresh = createDeferredCore();
    const invokeNode = vi.fn(async () => {
      await source.promise;
      if (unavailable) {
        throw new Error("Paired node did not respond");
      }
      return { sessions: [row] };
    });
    const config = {};
    const baselineStarted = Date.now();
    const baseline = startCall("sessions.catalog.list", {}, config);
    await baseline.completion;
    const baselineMs = Date.now() - baselineStarted;
    let connected = true;
    const runtime = createPluginRuntimeMock({
      config: { current: () => config },
      nodes: {
        list: async () => ({
          nodes: [
            {
              nodeId: "source",
              connected,
              commands: ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"],
            },
          ],
        }),
        invoke: async () => {
          throw new Error("must use service authority");
        },
      },
    });
    let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
    const api = createTestPluginApi({
      runtime,
      registerService: (registered) => {
        service = registered;
      },
      registerSessionCatalog: (provider) => {
        hoisted.activeRegistry.sessionCatalogs = [{ provider }];
      },
    });
    sessionSharePlugin.register(api);
    const scheduler = createTestPluginServiceScheduler();
    const context = { config, logger: api.logger, stateDir: "/unused", invokeNode, scheduler };
    await service?.start(context);
    bindPluginRegistryRuntime(hoisted.activeRegistry as PluginRegistry, runtime);
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const clients = Array.from({ length: 6 }, (_, index) => ({
      connId: `viewer-${index}`,
      connect: { scopes: ["operator.admin"] },
    }));
    const broadcasts = clients.map(() => vi.fn());
    const elapsed: number[] = [];
    const started = Date.now();
    try {
      const calls = clients.map((client, index) =>
        startCall(
          "sessions.catalog.list",
          { catalogId: "openclaw", progressId: `progress-${index}`, allowPartialResults: true },
          config,
          client,
          { broadcastToConnIds: broadcasts[index] },
        ),
      );
      const done = Promise.all(
        calls.map(async (call) => {
          await call.completion;
          elapsed.push(Date.now() - started);
        }),
      );
      const metadata = startCall(
        "sessions.catalog.list",
        { catalogId: "openclaw", hostIds: ["node:source"] },
        config,
        clients[0],
      );
      await vi.advanceTimersByTimeAsync(49);
      expect(elapsed).toHaveLength(6);
      expect(Math.max(...elapsed)).toBe(baselineMs);
      expect(Math.max(...elapsed)).toBeLessThan(50);
      expect(invokeNode).toHaveBeenCalledTimes(1);
      for (const call of calls) {
        expect(call.respond).toHaveBeenCalledWith(true, {
          catalogs: [
            expect.objectContaining({
              hosts: [
                expect.objectContaining({
                  hostId: "node:source",
                  sessions: [],
                  error: expect.objectContaining({ code: "CATALOG_LOADING" }),
                }),
              ],
            }),
          ],
        });
      }
      expect(metadata.respond).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            hosts: [
              expect.objectContaining({
                error: expect.objectContaining({ code: "CATALOG_LOADING" }),
              }),
            ],
          }),
        ],
      });
      clients[5]!.connect.scopes = ["operator.read"];
      await vi.advanceTimersByTimeAsync(sourceDelayMs - 49);
      source.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await done;
      await metadata.completion;
      for (const [index, broadcast] of broadcasts.entries()) {
        expect(broadcast).toHaveBeenLastCalledWith(
          "sessions.catalog.host",
          expect.objectContaining({
            catalog: expect.objectContaining({
              hosts: [
                expect.objectContaining({
                  sessions: unavailable || index === 5 ? [] : [expect.objectContaining(row)],
                }),
              ],
            }),
          }),
          new Set([clients[index]!.connId]),
          { dropIfSlow: true },
        );
      }
      for (let index = 0; index < 6; index++) {
        const warm = startCall(
          "sessions.catalog.list",
          { catalogId: "openclaw" },
          config,
          clients[0],
        );
        await warm.completion;
        expect(warm.respond).toHaveBeenCalledWith(true, {
          catalogs: [
            expect.objectContaining({
              hosts: [
                expect.objectContaining({
                  sessions: unavailable ? [] : [expect.objectContaining(row)],
                }),
              ],
            }),
          ],
        });
      }
      expect(invokeNode).toHaveBeenCalledTimes(1);
      console.log(
        JSON.stringify({
          clock: "fake",
          baselineMs,
          sourceDelayMs,
          unavailable,
          gatewayP99Ms: Math.max(...elapsed),
          invocations: invokeNode.mock.calls.length,
        }),
      );
      if (!unavailable) {
        const progressiveQuery = {
          catalogId: "openclaw",
          progressId: "progress-0",
          allowPartialResults: true,
        };
        const current = startCall("sessions.catalog.list", progressiveQuery, config, clients[0], {
          broadcastToConnIds: broadcasts[0],
        });
        await current.completion;
        expect(current.respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([row]);
        invokeNode
          .mockRejectedValueOnce(new Error("Paired node did not respond"))
          .mockImplementation(async () => {
            await refresh.promise;
            throw new Error("Paired node did not respond");
          });
        await vi.advanceTimersByTimeAsync(60_005);
        expect(invokeNode).toHaveBeenCalledTimes(3);
        const refreshing = startCall(
          "sessions.catalog.list",
          progressiveQuery,
          config,
          clients[0],
          { broadcastToConnIds: broadcasts[0] },
        );
        await refreshing.completion;
        expect(refreshing.respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]).toMatchObject({
          sessions: [],
          error: { code: "NODE_INVOKE_FAILED" },
        });
        expect(refreshing.respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]).not.toHaveProperty(
          "pending",
        );
        refresh.resolve();
        await vi.advanceTimersByTimeAsync(0);
        for (const errorCode of ["NODE_INVOKE_FAILED", "NODE_OFFLINE"]) {
          connected = errorCode !== "NODE_OFFLINE";
          const expired = startCall(
            "sessions.catalog.list",
            { catalogId: "openclaw" },
            config,
            clients[0],
          );
          await expired.completion;
          expect(expired.respond).toHaveBeenCalledWith(true, {
            catalogs: [
              expect.objectContaining({
                hosts: [
                  expect.objectContaining({
                    sessions: [],
                    error: expect.objectContaining({ code: errorCode }),
                  }),
                ],
              }),
            ],
          });
        }
      }
    } finally {
      scheduler.beginClose();
      source.resolve();
      refresh.resolve();
      try {
        await service?.stop?.(context);
      } finally {
        await scheduler.stop();
      }
      vi.useRealTimers();
    }
  },
);
