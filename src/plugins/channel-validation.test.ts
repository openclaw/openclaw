import { expect, it } from "vitest";
import { getChatChannelMeta } from "../channels/chat-meta.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { channelFixture, registrationFixture } from "./registry-registration.test-support.js";

function createChannelRegistry(pluginId = "demo-plugin", source = "/tmp/demo/index.ts") {
  const { registry, register } = registrationFixture();
  return {
    registry,
    register: (overrides: Partial<ChannelPlugin>) => {
      register({ id: pluginId, source }, (api) =>
        api.registerChannel({ plugin: { ...channelFixture("demo", "Demo"), ...overrides } }),
      );
      return registry.channels[0]?.plugin;
    },
    expectDiagnostic: (message: string, level = "warn") => {
      expect(registry.diagnostics).toEqual([{ level, pluginId, source, message }]);
    },
  };
}

const { label, selectionLabel, docsPath, blurb } = getChatChannelMeta("telegram");
it.each([
  ["telegram", { label, selectionLabel, docsPath, blurb }, false],
  ["external-chat", { ...channelFixture("external-chat").meta, blurb: "" }, true],
] as const)("fills incomplete metadata for %s", (id, meta, exact) => {
  const { register, expectDiagnostic } = createChannelRegistry();
  const normalized = register({ id, meta: { id } as never });
  if (exact) {
    expect({ id: normalized?.id, meta: normalized?.meta }).toEqual({ id, meta });
  } else {
    expect(normalized?.meta).toMatchObject(meta);
  }
  expectDiagnostic(
    `channel "${id}" registered incomplete metadata; filled missing label, selectionLabel, docsPath, blurb`,
  );
});

it("fills official external channel aliases omitted by the runtime plugin", () => {
  const { registry, register } = createChannelRegistry("openclaw-weixin");

  const normalized = register({
    id: "openclaw-weixin",
    meta: channelFixture("openclaw-weixin").meta,
  });

  expect(normalized?.meta.aliases).toEqual(["weixin", "wechat", "微信"]);
  expect(registry.diagnostics).toEqual([]);
});

it("warns and repairs mismatched meta ids", () => {
  const { register, expectDiagnostic } = createChannelRegistry();
  const normalized = register({
    id: "demo",
    meta: { ...channelFixture("demo", "Demo").meta, id: "other-demo" },
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
