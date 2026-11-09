import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  bindPluginRegistryRuntime,
  call,
  hoisted,
  provider,
  resetSessionCatalogTestState,
  type PluginRegistry,
} from "./session-catalog.test-helpers.js";

const { default: sessionSharePlugin } = await loadBundledPluginFacade<{
  default: { register: (api: OpenClawPluginApi) => void };
}>({ pluginId: "session-share", artifactBasename: "index.js" });

describe("session-share node discovery through catalog RPC", () => {
  beforeEach(resetSessionCatalogTestState);

  it("reports discovery failure and recovers without hiding other catalogs", async () => {
    vi.useFakeTimers();
    const config = {};
    const row = {
      threadId: "agent:main:shared",
      name: "Shared session",
      status: "idle",
      archived: false,
      canContinue: false,
      canArchive: false,
    };
    const list = vi.fn<PluginRuntime["nodes"]["list"]>().mockResolvedValue({
      nodes: [
        {
          nodeId: "source",
          connected: true,
          commands: ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"],
        },
      ],
    });
    const invokeNode = vi.fn(async () => ({ sessions: [row] }));
    const runtime = createPluginRuntimeMock({
      config: { current: () => config },
      nodes: { list, invoke: invokeNode },
    });
    let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
    const api = createTestPluginApi({
      runtime,
      registerService: (registered) => {
        service = registered;
      },
      registerSessionCatalog: (registered) => {
        hoisted.activeRegistry.sessionCatalogs.push({ provider: registered });
      },
    });
    sessionSharePlugin.register(api);
    hoisted.activeRegistry.sessionCatalogs.push({ provider: provider("other") });
    bindPluginRegistryRuntime(hoisted.activeRegistry as PluginRegistry, runtime);
    const scheduler = createTestPluginServiceScheduler();
    const context = { config, logger: api.logger, stateDir: "/unused", invokeNode, scheduler };
    try {
      await service?.start(context);
      list.mockRejectedValueOnce(
        new Error("Paired node inventory is unavailable. Reconnect and retry."),
      );
      const failed = await call("sessions.catalog.list", {}, config);
      expect(failed).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            id: "openclaw",
            hosts: [],
            error: {
              code: "catalog_error",
              message: "Paired node inventory is unavailable. Reconnect and retry.",
            },
          }),
          expect.objectContaining({ id: "other", hosts: [] }),
        ],
      });
      expect(failed.mock.calls[0]?.[1]?.catalogs[1]).not.toHaveProperty("error");
      expect(invokeNode).not.toHaveBeenCalled();

      list.mockResolvedValueOnce({ nodes: [] });
      const empty = await call("sessions.catalog.list", {}, config);
      expect(empty.mock.calls[0]?.[1]?.catalogs[0]).toMatchObject({ id: "openclaw", hosts: [] });
      expect(empty.mock.calls[0]?.[1]?.catalogs[0]).not.toHaveProperty("error");

      await call("sessions.catalog.list", {}, config);
      await vi.advanceTimersByTimeAsync(0);
      const recovered = await call("sessions.catalog.list", {}, config);
      expect(recovered.mock.calls[0]?.[1]?.catalogs[0]).toMatchObject({
        id: "openclaw",
        hosts: [{ hostId: "node:source", sessions: [row] }],
      });
      expect(recovered.mock.calls[0]?.[1]?.catalogs[0]).not.toHaveProperty("error");
      expect(invokeNode).toHaveBeenCalledOnce();
    } finally {
      scheduler.beginClose();
      try {
        await service?.stop?.(context);
      } finally {
        await scheduler.stop();
        vi.useRealTimers();
      }
    }
  });
});
