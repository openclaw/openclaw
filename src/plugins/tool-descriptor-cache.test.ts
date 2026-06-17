// Covers plugin tool descriptor cache lifecycle and invalidation.
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
  capturePluginToolDescriptor,
  createPluginToolDescriptorConfigCacheKeyMemo,
  resetPluginToolDescriptorCache,
} from "./tool-descriptor-cache.js";
import type { AnyAgentTool } from "../agents/tools/common.js";

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

  it("varies descriptor keys by active model metadata", () => {
    const base = {
      pluginId: "demo",
      source: "/tmp/demo.js",
      contractToolNames: ["demo"],
      ctx: {
        workspaceDir: "/tmp/workspace",
        agentId: "main",
        activeModel: {
          provider: "openai",
          modelId: "gpt-5.4",
          modelRef: "openai/gpt-5.4",
        },
      },
    };

    const firstKey = buildPluginToolDescriptorCacheKey(base);
    const secondKey = buildPluginToolDescriptorCacheKey({
      ...base,
      ctx: {
        ...base.ctx,
        activeModel: {
          provider: "openrouter",
          modelId: "openrouter/auto",
          modelRef: "openrouter/auto",
        },
      },
    });

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
});

describe("capturePluginToolDescriptor", () => {
  it("preserves tool availability on captured plugin descriptors", () => {
    const tool = {
      name: "needs_secret",
      label: "Needs secret",
      description: "Needs secret description",
      parameters: { type: "object" },
      availability: { kind: "env", name: "OPENCLAW_PLUGIN_SECRET" },
      async execute() {
        return { content: [], details: undefined };
      },
    } satisfies AnyAgentTool & {
      availability: { kind: "env"; name: string };
    };

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
    });

    expect(captured.descriptor.availability).toStrictEqual({
      kind: "env",
      name: "OPENCLAW_PLUGIN_SECRET",
    });
  });

  it("warns during capture when a plugin tool declares an empty availability group", () => {
    const logger = { warn: vi.fn() };
    const tool = {
      name: "broken_tool",
      label: "Broken tool",
      description: "Broken tool description",
      parameters: { type: "object" },
      availability: { anyOf: [] },
      async execute() {
        return { content: [], details: undefined };
      },
    } satisfies AnyAgentTool & {
      availability: { anyOf: [] };
    };

    capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "plugin tool availability diagnostic (demo/broken_tool): Empty availability anyOf group",
    );
  });

  it("ignores malformed non-contract availability group fields during capture", () => {
    const logger = { warn: vi.fn() };
    const tool = {
      name: "incidental_tool",
      label: "Incidental tool",
      description: "Incidental tool description",
      parameters: { type: "object" },
      availability: { anyOf: null },
      async execute() {
        return { content: [], details: undefined };
      },
    } satisfies AnyAgentTool & {
      availability: { anyOf: null };
    };

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
      logger,
    });

    expect(captured.descriptor.availability).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ignores malformed non-contract availability signal fields during capture", () => {
    const logger = { warn: vi.fn() };
    const tool = {
      name: "incidental_signal_tool",
      label: "Incidental signal tool",
      description: "Incidental signal tool description",
      parameters: { type: "object" },
      availability: { kind: "config" },
      async execute() {
        return { content: [], details: undefined };
      },
    } satisfies AnyAgentTool & {
      availability: { kind: "config" };
    };

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
      logger,
    });

    expect(captured.descriptor.availability).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
