import { describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../manifest-registry.js";
import type { PluginRegistry, PluginToolRegistration } from "../registry-types.js";
import {
  excludeHostRestrictedConversationReadRegistration,
  excludeHostRestrictedConversationReadTool,
  isBundledConversationReadToolRegistration,
  listHostRestrictedConversationReadToolsForRegistration,
} from "./conversation-read-tools.js";

function makeEntry(overrides: Partial<PluginToolRegistration> = {}): PluginToolRegistration {
  return {
    pluginId: "feishu",
    factory: () => null,
    names: ["feishu_chat"],
    optional: false,
    source: "/tmp/external-feishu.js",
    origin: "config",
    ...overrides,
  };
}

function makeRegistry(): PluginRegistry {
  return { diagnostics: [] } as unknown as PluginRegistry;
}

function makeManifest(origin: PluginManifestRecord["origin"]): PluginManifestRecord {
  return { id: "feishu", origin } as unknown as PluginManifestRecord;
}

describe("host-restricted conversation-read tool diagnostics", () => {
  it("lists restricted tools from produced names and falls back to declaredNames", () => {
    expect(
      listHostRestrictedConversationReadToolsForRegistration(
        makeEntry({ names: ["feishu_doc"], declaredNames: ["feishu_doc", "feishu_chat"] }),
      ),
    ).toEqual([]);
    expect(
      listHostRestrictedConversationReadToolsForRegistration(
        makeEntry({ names: [], declaredNames: ["feishu_doc", "feishu_chat"] }),
      ),
    ).toEqual(["feishu_chat"]);
  });

  it("requires both registration and manifest origins to be bundled", () => {
    expect(
      isBundledConversationReadToolRegistration({
        entry: makeEntry({ origin: "bundled" }),
        manifestPlugin: makeManifest("bundled"),
      }),
    ).toBe(true);
    expect(
      isBundledConversationReadToolRegistration({
        entry: makeEntry({ origin: "bundled" }),
        manifestPlugin: makeManifest("config"),
      }),
    ).toBe(false);
  });

  it("records a bounded warning once per registry on pre-factory registration exclusion", () => {
    const registry = makeRegistry();
    const entry = makeEntry({ origin: "config", source: "/tmp/external-feishu.js" });
    const manifestPlugin = makeManifest("config");
    const warn = vi.fn();

    expect(
      excludeHostRestrictedConversationReadRegistration({
        restrict: true,
        registry,
        entry,
        manifestPlugin,
        warn,
      }),
    ).toBe(true);
    expect(
      excludeHostRestrictedConversationReadRegistration({
        restrict: true,
        registry,
        entry,
        manifestPlugin,
        warn,
      }),
    ).toBe(true);

    expect(registry.diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "feishu",
        source: "/tmp/external-feishu.js",
        message:
          "plugin tool excluded in delegated turn (feishu: feishu_chat): conversation-read tools require bundled plugin origin (registration=config, manifest=config)",
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("records a bounded warning once per registry on post-factory tool exclusion", () => {
    const registry = makeRegistry();
    const entry = makeEntry({
      names: ["feishu_doc"],
      origin: "workspace",
      source: "/tmp/workspace-feishu.js",
    });
    const manifestPlugin = makeManifest("workspace");
    const warn = vi.fn();

    expect(
      excludeHostRestrictedConversationReadTool({
        restrict: true,
        registry,
        entry,
        toolName: "feishu_doc",
        manifestPlugin,
        warn,
      }),
    ).toBe(false);
    expect(
      excludeHostRestrictedConversationReadTool({
        restrict: true,
        registry,
        entry,
        toolName: "feishu_chat",
        manifestPlugin,
        warn,
      }),
    ).toBe(true);
    expect(
      excludeHostRestrictedConversationReadTool({
        restrict: true,
        registry,
        entry,
        toolName: "feishu_chat",
        manifestPlugin,
        warn,
      }),
    ).toBe(true);

    expect(registry.diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "feishu",
        source: "/tmp/workspace-feishu.js",
        message:
          "plugin tool excluded in delegated turn (feishu: feishu_chat): conversation-read tools require bundled plugin origin (registration=workspace, manifest=workspace)",
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("emits no diagnostic when restriction is inactive", () => {
    const registry = makeRegistry();
    const entry = makeEntry({ origin: "bundled" });
    const manifestPlugin = makeManifest("bundled");
    const warn = vi.fn();

    expect(
      excludeHostRestrictedConversationReadRegistration({
        restrict: false,
        registry,
        entry,
        manifestPlugin,
        warn,
      }),
    ).toBe(false);
    expect(
      excludeHostRestrictedConversationReadTool({
        restrict: false,
        registry,
        entry,
        toolName: "feishu_chat",
        manifestPlugin,
        warn,
      }),
    ).toBe(false);
    expect(registry.diagnostics).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
