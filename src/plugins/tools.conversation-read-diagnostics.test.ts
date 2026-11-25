import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePluginTools } from "./tools.js";
import {
  createConfiguredFeishuToolContext,
  createNamedToolEntry,
  createOptionalToolManifest,
  createToolRegistry,
  makeTool,
  type MockRegistryToolEntry,
} from "./tools.optional.test-helpers.js";
import { createToolLoadContext } from "./tools.test-support.js";

function createPreparedFeishuRuntime(
  entries: MockRegistryToolEntry[],
  config: ReturnType<typeof createConfiguredFeishuToolContext>["config"],
) {
  const warn = vi.fn();
  const registry = createToolRegistry(entries);
  const plugins = entries.map((entry) => ({
    ...createOptionalToolManifest(
      entry.pluginId,
      entry.declaredNames ?? (entry.names.length > 0 ? entry.names : ["feishu_chat"]),
      {
        origin: entry.origin as never,
        source: entry.source,
        channels: [],
      },
    ),
    rootDir: path.dirname(entry.source),
    enabledByDefault: true,
  }));
  const metadataSnapshot = {
    plugins,
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    index: {
      plugins: plugins.map((plugin) => ({ pluginId: plugin.id, enabled: true })),
    },
    diagnostics: [],
  };
  const loadContext = createToolLoadContext(config, "/tmp", {
    logger: { info: vi.fn(), warn, error: vi.fn() },
    manifestRegistry: { plugins, diagnostics: [] },
  });
  return {
    warn,
    registry,
    preparedRuntime: {
      loadContext,
      metadataSnapshot: metadataSnapshot as never,
      registry,
    },
  };
}

describe("resolvePluginTools host-restricted conversation-read diagnostics", () => {
  it("warns once per registry when the pre-factory gate excludes feishu_chat in delegated turns", () => {
    const context = createConfiguredFeishuToolContext("delegated");
    const factory = vi.fn(() => makeTool("feishu_chat"));
    const { warn, registry, preparedRuntime } = createPreparedFeishuRuntime(
      [
        createNamedToolEntry("feishu", "feishu_chat", {
          origin: "config",
          source: "/tmp/external-feishu.js",
          factory,
        }),
      ],
      context.config,
    );

    const first = resolvePluginTools({ context, preparedRuntime });
    const second = resolvePluginTools({ context, preparedRuntime });

    expect(first.map((tool) => tool.name)).toEqual([]);
    expect(second.map((tool) => tool.name)).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]).toMatchObject({
      level: "warn",
      pluginId: "feishu",
      source: "/tmp/external-feishu.js",
      message: expect.stringContaining("feishu_chat"),
    });
    expect(registry.diagnostics[0]?.message).toContain("bundled plugin origin");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns once per registry when a non-bundled factory returns feishu_chat in delegated turns", () => {
    const context = createConfiguredFeishuToolContext("delegated");
    const factory = vi.fn(() => [makeTool("feishu_doc"), makeTool("feishu_chat")]);
    const { warn, registry, preparedRuntime } = createPreparedFeishuRuntime(
      [
        createNamedToolEntry("feishu", "feishu_doc", {
          origin: "workspace",
          source: "/tmp/workspace-feishu.js",
          declaredNames: ["feishu_doc", "feishu_chat"],
          factory,
        }),
      ],
      context.config,
    );

    const first = resolvePluginTools({ context, preparedRuntime });
    const second = resolvePluginTools({ context, preparedRuntime });

    expect(first.map((tool) => tool.name)).toEqual(["feishu_doc"]);
    expect(second.map((tool) => tool.name)).toEqual(["feishu_doc"]);
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]).toMatchObject({
      level: "warn",
      pluginId: "feishu",
      source: "/tmp/workspace-feishu.js",
      message: expect.stringContaining("feishu_chat"),
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("emits no exclusion warning for bundled feishu_chat registrations", () => {
    const context = createConfiguredFeishuToolContext("delegated");
    const factory = vi.fn(() => makeTool("feishu_chat"));
    const { warn, registry, preparedRuntime } = createPreparedFeishuRuntime(
      [
        createNamedToolEntry("feishu", "feishu_chat", {
          origin: "bundled",
          source: "/tmp/bundled-feishu.js",
          factory,
        }),
      ],
      context.config,
    );

    const tools = resolvePluginTools({ context, preparedRuntime });

    expect(tools.map((tool) => tool.name)).toEqual(["feishu_chat"]);
    expect(registry.diagnostics).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
