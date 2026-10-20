import { expect, it } from "vitest";
import { getChatChannelMeta } from "../channels/chat-meta.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createChannelRegistry(pluginId = "demo-plugin", source = "/tmp/demo/index.ts") {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({ id: pluginId, source });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, registrationMode: "full" });
  return {
    registry: builder.registry,
    register: (overrides: Partial<ChannelPlugin>) => {
      api.registerChannel({ plugin: createChannelPlugin(overrides) });
      return builder.registry.channels[0]?.plugin;
    },
    expectDiagnostic: (message: string, level = "warn") => {
      expect(builder.registry.diagnostics).toEqual([{ level, pluginId, source, message }]);
    },
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

it("fills bundled channel metadata from the canonical core baseline", () => {
  const { register, expectDiagnostic } = createChannelRegistry();
  const normalized = register({
    id: "telegram",
    meta: { id: "telegram" } as never,
  });

  const telegram = getChatChannelMeta("telegram");
  expect(normalized?.meta).toMatchObject({
    label: telegram.label,
    selectionLabel: telegram.selectionLabel,
    docsPath: telegram.docsPath,
    blurb: telegram.blurb,
  });
  expectDiagnostic(
    'channel "telegram" registered incomplete metadata; filled missing label, selectionLabel, docsPath, blurb',
  );
});

it("falls back to the channel id for external channels with incomplete metadata", () => {
  const { register, expectDiagnostic } = createChannelRegistry();
  const normalized = register({
    id: "external-chat",
    meta: { id: "external-chat" } as never,
  });

  expect({ id: normalized?.id, meta: normalized?.meta }).toEqual({
    id: "external-chat",
    meta: {
      id: "external-chat",
      label: "external-chat",
      selectionLabel: "external-chat",
      docsPath: "/channels/external-chat",
      blurb: "",
    },
  });
  expectDiagnostic(
    'channel "external-chat" registered incomplete metadata; filled missing label, selectionLabel, docsPath, blurb',
  );
});

it("fills official external channel aliases omitted by the runtime plugin", () => {
  const { registry, register } = createChannelRegistry(
    "openclaw-weixin",
    "/tmp/openclaw-weixin/index.ts",
  );

  const normalized = register({
    id: "openclaw-weixin",
    meta: {
      id: "openclaw-weixin",
      label: "openclaw-weixin",
      selectionLabel: "openclaw-weixin (long-poll)",
      docsPath: "/channels/openclaw-weixin",
      blurb: "Weixin channel",
    },
  });

  expect(normalized?.meta.aliases).toEqual(["weixin", "wechat", "微信"]);
  expect(registry.diagnostics).toEqual([]);
});

it("warns and repairs mismatched meta ids", () => {
  const { register, expectDiagnostic } = createChannelRegistry();
  const normalized = register({
    id: "demo",
    meta: { ...createChannelPlugin().meta, id: "other-demo" },
  });

  expect(normalized).toMatchObject({ id: "demo", meta: { id: "demo" } });
  expectDiagnostic('channel "demo" meta.id mismatch ("other-demo"); using registered channel id');
});

it("rejects runtime channel registrations without required config helpers", () => {
  const { registry, register, expectDiagnostic } = createChannelRegistry();
  register({ id: "broken-channel", config: undefined as never });

  expect(registry).toMatchObject({ channels: [], channelSetups: [] });
  expectDiagnostic(
    'channel "broken-channel" registration missing required config helpers',
    "error",
  );
});
