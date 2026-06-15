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

import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  buildPluginToolDescriptorCacheKey,
  capturePluginToolDescriptor,
  createPluginToolDescriptorConfigCacheKeyMemo,
  resetPluginToolDescriptorCache,
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
  it("preserves availability expressions attached to plugin tools", () => {
    const tool = {
      name: "cron",
      label: "cron",
      description: "cron tool",
      parameters: { type: "object", properties: {} },
      availability: { anyOf: [] },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as AnyAgentTool & { availability: { anyOf: [] } };

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
    });

    expect(captured.descriptor.availability).toEqual({ anyOf: [] });
  });

  it("ignores availability metadata that is not a planner expression shape", () => {
    const tool = {
      name: "cron",
      description: "cron tool",
      parameters: { type: "object", properties: {} },
      availability: { privateMetadata: true, version: 2 },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as AnyAgentTool;

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
    });

    expect(captured.descriptor.availability).toBeUndefined();
  });

  it("preserves malformed availability allOf for planner diagnostics", () => {
    const tool = {
      name: "cron",
      description: "cron tool",
      parameters: { type: "object", properties: {} },
      availability: { allOf: "not-array" },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as AnyAgentTool;

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
    });

    expect(captured.descriptor.availability).toEqual({ allOf: "not-array" });
  });

  it("preserves malformed availability anyOf for planner diagnostics", () => {
    const tool = {
      name: "cron",
      description: "cron tool",
      parameters: { type: "object", properties: {} },
      availability: { anyOf: "not-array" },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as AnyAgentTool;

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
    });

    expect(captured.descriptor.availability).toEqual({ anyOf: "not-array" });
  });

  it("preserves malformed availability allOf entries for planner diagnostics", () => {
    const tool = {
      name: "cron",
      description: "cron tool",
      parameters: { type: "object", properties: {} },
      availability: { allOf: [{ notAnExpression: true }] },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as AnyAgentTool;

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
    });

    expect(captured.descriptor.availability).toEqual({ allOf: [{ notAnExpression: true }] });
  });

  it("preserves config signal without path for planner diagnostics", () => {
    const tool = {
      name: "cron",
      description: "cron tool",
      parameters: { type: "object", properties: {} },
      availability: { kind: "config" },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as AnyAgentTool;

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
    });

    expect(captured.descriptor.availability).toEqual({ kind: "config" });
  });

  it("preserves auth signal without providerId for planner diagnostics", () => {
    const tool = {
      name: "cron",
      description: "cron tool",
      parameters: { type: "object", properties: {} },
      availability: { kind: "auth" },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as AnyAgentTool;

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
    });

    expect(captured.descriptor.availability).toEqual({ kind: "auth" });
  });

  it("preserves unknown signal kind for planner diagnostics", () => {
    const tool = {
      name: "cron",
      description: "cron tool",
      parameters: { type: "object", properties: {} },
      availability: { kind: "unknown-kind" },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as AnyAgentTool;

    const captured = capturePluginToolDescriptor({
      pluginId: "demo",
      tool,
      optional: false,
    });

    expect(captured.descriptor.availability).toEqual({ kind: "unknown-kind" });
  });
});
