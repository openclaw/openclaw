import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRegistry, type PluginRecord } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import {
  clearGatewaySubagentRuntime,
  createPluginRuntime,
  setGatewaySubagentRuntime,
} from "./runtime/index.js";
import type { PluginRuntime, SubagentSpawnDetachedParams } from "./runtime/types.js";

function createTestLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createPluginRecord(id: string): PluginRecord {
  return {
    id,
    name: id,
    source: `/tmp/${id}.js`,
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}

afterEach(() => {
  clearGatewaySubagentRuntime();
});

describe("plugin registry runtime wrapping", () => {
  it("keeps spawnDetached late-bound after caching the plugin runtime", async () => {
    const pluginId = "voice-call";
    const spawnDetached = vi
      .fn()
      .mockImplementation(async (params: SubagentSpawnDetachedParams) => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginId).toBe(pluginId);
        return {
          runId: "run-detached-1",
          childSessionKey: `${params.requesterSessionKey}:child`,
        };
      });
    const { createApi } = createPluginRegistry({
      logger: createTestLogger(),
      runtime: createPluginRuntime({ allowGatewaySubagentBinding: true }),
    });
    const api = createApi(createPluginRecord(pluginId), {
      config: {} as never,
    });
    const subagent = api.runtime.subagent;

    expect(subagent.spawnDetached).toBeUndefined();

    const gatewaySubagent: PluginRuntime["subagent"] = {
      run: vi.fn(),
      spawnDetached,
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    };
    setGatewaySubagentRuntime(gatewaySubagent);

    const invokeSpawnDetached = subagent.spawnDetached;
    expect(typeof invokeSpawnDetached).toBe("function");

    await expect(
      invokeSpawnDetached!({
        requesterSessionKey: "agent:main:main",
        task: "inspect the queue",
      }),
    ).resolves.toEqual({
      runId: "run-detached-1",
      childSessionKey: "agent:main:main:child",
    });
    expect(spawnDetached).toHaveBeenCalledWith({
      requesterSessionKey: "agent:main:main",
      task: "inspect the queue",
    });
  });
});
