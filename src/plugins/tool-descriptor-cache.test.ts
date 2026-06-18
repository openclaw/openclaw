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

describe("capturePluginToolDescriptor availability validation", () => {
  afterEach(() => {
    resetPluginToolDescriptorCache();
  });

  function makeTool(overrides: Record<string, unknown> = {}) {
    return {
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object" as const, properties: {} },
      ...overrides,
    } as never;
  }

  it("warns when tool has empty availability anyOf group", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      capturePluginToolDescriptor({
        pluginId: "test-plugin",
        tool: makeTool({ availability: { anyOf: [] } }),
        optional: false,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("tool descriptor authoring error (test-plugin/test_tool)"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Empty availability anyOf group"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns when tool has empty availability allOf group", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      capturePluginToolDescriptor({
        pluginId: "test-plugin",
        tool: makeTool({ availability: { allOf: [] } }),
        optional: false,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Empty availability allOf group"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for valid availability expression", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      capturePluginToolDescriptor({
        pluginId: "test-plugin",
        tool: makeTool({ availability: { kind: "always" } }),
        optional: false,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when tool has no availability", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      capturePluginToolDescriptor({
        pluginId: "test-plugin",
        tool: makeTool(),
        optional: false,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for non-expression availability metadata", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      capturePluginToolDescriptor({
        pluginId: "test-plugin",
        tool: makeTool({ availability: { privateMeta: true } }),
        optional: false,
      });
      // Non-expression objects are treated as metadata, not availability expressions
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("preserves availability on the captured descriptor when valid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cached = capturePluginToolDescriptor({
        pluginId: "test-plugin",
        tool: makeTool({ availability: { kind: "always" } }),
        optional: false,
      });
      expect(cached.descriptor.availability).toEqual({ kind: "always" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns when allOf value is not an array", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cached = capturePluginToolDescriptor({
        pluginId: "test-plugin",
        tool: makeTool({ availability: { allOf: "not-an-array" } }),
        optional: false,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Non-array availability group"),
      );
      // Malformed availability must be stripped so the evaluator never sees it
      expect(cached.descriptor.availability).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns when anyOf value is not an array", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cached = capturePluginToolDescriptor({
        pluginId: "test-plugin",
        tool: makeTool({ availability: { anyOf: 123 } }),
        optional: false,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Non-array availability group"),
      );
      expect(cached.descriptor.availability).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for nested availability entries when the top-level shape is valid", () => {
    // The shape guard only validates the top-level group fields.
    // Nested entries inside allOf/anyOf arrays are validated later by the
    // evaluator (if recursively structured), not by this boundary check.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cached = capturePluginToolDescriptor({
        pluginId: "test-plugin",
        tool: makeTool({
          availability: { allOf: [{ kind: "always" }, { kind: "always" }] },
        }),
        optional: false,
      });
      // Top-level allOf is a valid array — no shape warning expected
      const shapeWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("Non-array availability group"),
      );
      expect(shapeWarnings).toHaveLength(0);
      // Descriptor should preserve the valid availability
      expect(cached.descriptor.availability).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
