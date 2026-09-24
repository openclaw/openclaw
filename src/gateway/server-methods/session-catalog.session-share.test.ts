import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
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

it("bounds six Gateway connections and filters the shared refresh at each delivery", async () => {
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
  const invokeNode = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30_000);
    });
    return { sessions: [row] };
  });
  const config = {};
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    nodes: {
      list: async () => ({
        nodes: [
          {
            nodeId: "source",
            connected: true,
            commands: ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"],
          },
        ],
      }),
      invoke: async () => {
        throw new Error("must use service authority");
      },
    },
  });
  let service: OpenClawPluginService | undefined;
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
  const context = { config, logger: api.logger, stateDir: "/unused", invokeNode };
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
    await vi.advanceTimersByTimeAsync(5_000);
    expect(elapsed).toHaveLength(6);
    expect(Math.max(...elapsed)).toBeLessThanOrEqual(5_000);
    expect(invokeNode).toHaveBeenCalledTimes(1);
    for (const call of calls) {
      expect(call.respond).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            hosts: [expect.objectContaining({ pending: true, sessions: [] })],
          }),
        ],
      });
    }
    clients[5]!.connect.scopes = ["operator.read"];
    await vi.advanceTimersByTimeAsync(25_000);
    await done;
    for (const [index, broadcast] of broadcasts.entries()) {
      expect(broadcast).toHaveBeenLastCalledWith(
        "sessions.catalog.host",
        expect.objectContaining({
          catalog: expect.objectContaining({
            hosts: [
              expect.objectContaining({
                sessions: index === 5 ? [] : [expect.objectContaining(row)],
              }),
            ],
          }),
        }),
        new Set([clients[index]!.connId]),
        { dropIfSlow: true },
      );
    }
    console.log(
      JSON.stringify({
        gatewayP99Ms: Math.max(...elapsed),
        invocations: invokeNode.mock.calls.length,
      }),
    );
  } finally {
    await vi.runAllTimersAsync();
    await service?.stop?.(context);
    vi.useRealTimers();
  }
});
