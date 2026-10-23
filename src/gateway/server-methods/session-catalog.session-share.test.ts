import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
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

it.each([
  "pending",
  "failed",
  "discovery-failed",
  "discovery-empty",
  "discovery-ineligible",
] as const)(
  "withdraws a warmed source-authorized page during a %s refresh on the same connection",
  async (outcome) => {
    resetSessionCatalogTestState();
    vi.useFakeTimers();
    const row = {
      threadId: "agent:main:revoked",
      name: "Previously authorized source session",
      status: "idle",
      archived: false,
      canContinue: false,
      canArchive: false,
    };
    let release: (() => void) | undefined;
    let sourceAuthorized = true;
    const invokeNode = vi.fn(async () => {
      if (!sourceAuthorized) {
        if (outcome === "failed") {
          throw new Error("Source authorization unavailable");
        }
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { sessions: sourceAuthorized ? [row] : [] };
    });
    const config = {};
    const runtime = createPluginRuntimeMock({
      config: { current: () => config },
      nodes: {
        list: async () => {
          if (!sourceAuthorized && outcome === "discovery-failed") {
            throw new Error("private node discovery details");
          }
          return {
            nodes:
              !sourceAuthorized && outcome === "discovery-empty"
                ? []
                : [
                    {
                      nodeId: "source",
                      connected: true,
                      commands:
                        !sourceAuthorized && outcome === "discovery-ineligible"
                          ? []
                          : ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"],
                    },
                  ],
          };
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
    const client = { connId: "same-viewer", connect: { scopes: ["operator.admin"] } };
    const request = { catalogId: "openclaw" };
    const read = async () => {
      const pending = startCall("sessions.catalog.list", request, config, client);
      await vi.advanceTimersByTimeAsync(2);
      await pending.completion;
      return pending.respond;
    };
    try {
      const warm = await read();
      expect(warm.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
        expect.objectContaining(row),
      ]);
      sourceAuthorized = false;
      const refresh = startCall(
        "sessions.catalog.list",
        { ...request, progressId: "refresh", allowPartialResults: true },
        config,
        client,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await refresh.completion;
      const result = refresh.respond.mock.calls[0]?.[1]?.catalogs[0];
      expect(result.hosts.flatMap((host: { sessions: unknown[] }) => host.sessions)).toEqual([]);
      expect(invokeNode).toHaveBeenCalledTimes(outcome.startsWith("discovery-") ? 1 : 2);
      if (outcome === "discovery-failed") {
        expect(result).toMatchObject({
          hosts: [],
          requiresFreshList: true,
          error: {
            message: "Cannot discover OpenClaw session sources. Refresh the catalog to retry.",
          },
        });
        expect(JSON.stringify(result)).not.toContain("private node discovery details");
      } else if (outcome.startsWith("discovery-")) {
        expect(result.hosts).toEqual([]);
        expect(result.error).toBeUndefined();
      }
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      sourceAuthorized = true;
      const restored = await read();
      expect(restored.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
        expect.objectContaining(row),
      ]);
    } finally {
      release?.();
      scheduler.beginClose();
      try {
        await service?.stop?.(context);
      } finally {
        await scheduler.stop();
      }
      vi.useRealTimers();
    }
  },
);
