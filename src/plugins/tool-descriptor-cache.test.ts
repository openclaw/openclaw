import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveRuntimeConfigCacheKey: vi.fn((value: unknown) => {
    const id =
      value && typeof value === "object" && "id" in value
        ? String((value as { id?: unknown }).id)
        : "config";
    return `config:${id}:${JSON.stringify(value)}`;
  }),
}));

vi.mock("../config/runtime-snapshot.js", () => ({
  resolveRuntimeConfigCacheKey: hoisted.resolveRuntimeConfigCacheKey,
}));

import {
  buildPluginToolDescriptorCacheKey,
  createPluginToolDescriptorConfigCacheKeyMemo,
  getPluginToolDescriptorCacheStatsForTest,
  recordPluginToolDescriptorCacheHit,
  recordPluginToolDescriptorCacheMiss,
  recordPluginToolDescriptorCachePartial,
  resetPluginToolDescriptorCache,
  writeCachedPluginToolDescriptors,
} from "./tool-descriptor-cache.js";

describe("plugin tool descriptor cache keys", () => {
  afterEach(() => {
    hoisted.resolveRuntimeConfigCacheKey.mockClear();
    resetPluginToolDescriptorCache();
  });

  it("memoizes config cache keys across plugin descriptor keys in one resolution pass", () => {
    const config = {
      id: "runtime",
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as never;
    const configCacheKeyMemo = createPluginToolDescriptorConfigCacheKeyMemo();

    for (let index = 0; index < 25; index += 1) {
      buildPluginToolDescriptorCacheKey({
        pluginId: `plugin-${index}`,
        source: `/tmp/plugin-${index}.js`,
        contractToolNames: [`tool_${index}`],
        ctx: {
          config,
          runtimeConfig: config,
          workspaceDir: "/tmp/workspace",
          agentDir: "/tmp/agent",
          agentId: "main",
          sessionKey: "agent:main",
          sessionId: "session",
        },
        currentRuntimeConfig: config,
        configCacheKeyMemo,
      });
    }

    expect(hoisted.resolveRuntimeConfigCacheKey).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct config objects distinct within the memo", () => {
    const firstConfig = { id: "first" } as never;
    const secondConfig = { id: "second" } as never;
    const configCacheKeyMemo = createPluginToolDescriptorConfigCacheKeyMemo();

    const firstKey = buildPluginToolDescriptorCacheKey({
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        config: firstConfig,
        runtimeConfig: firstConfig,
      },
      currentRuntimeConfig: firstConfig,
      configCacheKeyMemo,
    });
    const secondKey = buildPluginToolDescriptorCacheKey({
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        config: secondConfig,
        runtimeConfig: secondConfig,
      },
      currentRuntimeConfig: secondConfig,
      configCacheKeyMemo,
    });

    expect(hoisted.resolveRuntimeConfigCacheKey).toHaveBeenCalledTimes(2);
    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps descriptor keys stable across config bookkeeping writes", () => {
    const firstConfig = {
      id: "runtime",
      meta: { lastTouchedAt: "2026-05-02T10:00:00.000Z" },
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
      wizard: { lastRunAt: "2026-05-02T10:00:00.000Z" },
    } as never;
    const secondConfig = {
      id: "runtime",
      meta: { lastTouchedAt: "2026-05-02T10:00:05.000Z" },
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
      wizard: { lastRunAt: "2026-05-02T10:00:05.000Z" },
    } as never;

    const firstKey = buildPluginToolDescriptorCacheKey({
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        config: firstConfig,
        runtimeConfig: firstConfig,
      },
      currentRuntimeConfig: firstConfig,
    });
    const secondKey = buildPluginToolDescriptorCacheKey({
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        config: secondConfig,
        runtimeConfig: secondConfig,
      },
      currentRuntimeConfig: secondConfig,
    });

    expect(firstKey).toBe(secondKey);
  });

  it("tracks descriptor cache hit/miss/store stats for diagnostics", () => {
    writeCachedPluginToolDescriptors({
      cacheKey: "demo",
      descriptors: [
        {
          optional: false,
          descriptor: {
            name: "demo_tool",
            description: "Demo tool",
            inputSchema: { type: "object", properties: {} },
            owner: { kind: "plugin", pluginId: "demo" },
            executor: { kind: "plugin", pluginId: "demo", toolName: "demo_tool" },
          },
        },
      ],
    });
    recordPluginToolDescriptorCacheHit();
    recordPluginToolDescriptorCacheMiss();
    recordPluginToolDescriptorCachePartial();

    expect(getPluginToolDescriptorCacheStatsForTest()).toEqual({
      hit: 1,
      miss: 1,
      partial: 1,
      store: 1,
      size: 1,
    });

    resetPluginToolDescriptorCache();
    expect(getPluginToolDescriptorCacheStatsForTest()).toEqual({
      hit: 0,
      miss: 0,
      partial: 0,
      store: 0,
      size: 0,
    });
  });
});
