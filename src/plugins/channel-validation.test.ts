// Covers plugin channel validation from manifest metadata.
import { describe, expect, it } from "vitest";
import { getChatChannelMeta } from "../channels/chat-meta.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createChannelRegistry(pluginId = "demo-plugin", source = "/tmp/demo/index.ts") {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({ id: pluginId, source });
  builder.registry.plugins.push(record);
  return {
    registry: builder.registry,
    api: builder.createApi(record, { config: {}, registrationMode: "full" }),
  };
}

function createChannelPlugin(overrides?: Partial<ChannelPlugin>): ChannelPlugin {
  return {
    id: "demo",
    meta: {
      id: "demo",
      label: "Demo",
      selectionLabel: "Demo",
      docsPath: "/channels/demo",
      blurb: "demo channel",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({ accountId: "default" }),
    },
    ...overrides,
  };
}

describe("registered channel metadata", () => {
  it("fills bundled channel metadata from the canonical core baseline", () => {
    const { registry, api } = createChannelRegistry();

    api.registerChannel({
      plugin: createChannelPlugin({
        id: "telegram",
        meta: {
          id: "telegram",
        } as never,
      }),
    });
    const normalized = registry.channels[0]?.plugin;

    const telegram = getChatChannelMeta("telegram");
    expect({
      label: normalized?.meta.label,
      selectionLabel: normalized?.meta.selectionLabel,
      docsPath: normalized?.meta.docsPath,
      blurb: normalized?.meta.blurb,
    }).toEqual({
      label: telegram.label,
      selectionLabel: telegram.selectionLabel,
      docsPath: telegram.docsPath,
      blurb: telegram.blurb,
    });
    expect(registry.diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "demo-plugin",
        source: "/tmp/demo/index.ts",
        message:
          'channel "telegram" registered incomplete metadata; filled missing label, selectionLabel, docsPath, blurb',
      },
    ]);
  });

  it("falls back to the channel id for external channels with incomplete metadata", () => {
    const { registry, api } = createChannelRegistry();

    api.registerChannel({
      plugin: createChannelPlugin({
        id: "external-chat",
        meta: {
          id: "external-chat",
        } as never,
      }),
    });
    const normalized = registry.channels[0]?.plugin;

    expect(normalized?.id).toBe("external-chat");
    expect(normalized?.meta).toEqual({
      id: "external-chat",
      label: "external-chat",
      selectionLabel: "external-chat",
      docsPath: "/channels/external-chat",
      blurb: "",
    });
    expect(registry.diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "demo-plugin",
        source: "/tmp/demo/index.ts",
        message:
          'channel "external-chat" registered incomplete metadata; filled missing label, selectionLabel, docsPath, blurb',
      },
    ]);
  });

  it("fills official external channel aliases omitted by the runtime plugin", () => {
    const { registry, api } = createChannelRegistry(
      "openclaw-weixin",
      "/tmp/openclaw-weixin/index.ts",
    );

    api.registerChannel({
      plugin: createChannelPlugin({
        id: "openclaw-weixin",
        meta: {
          id: "openclaw-weixin",
          label: "openclaw-weixin",
          selectionLabel: "openclaw-weixin (long-poll)",
          docsPath: "/channels/openclaw-weixin",
          blurb: "Weixin channel",
        },
      }),
    });
    const normalized = registry.channels[0]?.plugin;

    expect(normalized?.meta.aliases).toEqual(["weixin", "wechat", "微信"]);
    expect(registry.diagnostics).toEqual([]);
  });

  it("warns and repairs mismatched meta ids", () => {
    const { registry, api } = createChannelRegistry();

    api.registerChannel({
      plugin: createChannelPlugin({
        id: "demo",
        meta: {
          id: "other-demo",
          label: "Demo",
          selectionLabel: "Demo",
          docsPath: "/channels/demo",
          blurb: "demo channel",
        },
      }),
    });
    const normalized = registry.channels[0]?.plugin;

    expect(normalized?.id).toBe("demo");
    expect(normalized?.meta.id).toBe("demo");
    expect(registry.diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "demo-plugin",
        source: "/tmp/demo/index.ts",
        message: 'channel "demo" meta.id mismatch ("other-demo"); using registered channel id',
      },
    ]);
  });

  it("rejects runtime channel registrations without required config helpers", () => {
    const { registry, api } = createChannelRegistry();

    api.registerChannel({
      plugin: createChannelPlugin({
        id: "broken-channel",
        config: undefined as never,
      }),
    });

    expect(registry.channels).toEqual([]);
    expect(registry.channelSetups).toEqual([]);
    expect(registry.diagnostics).toEqual([
      {
        level: "error",
        pluginId: "demo-plugin",
        source: "/tmp/demo/index.ts",
        message: 'channel "broken-channel" registration missing required config helpers',
      },
    ]);
  });
});
