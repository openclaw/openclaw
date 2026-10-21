import { expect, it, vi } from "vitest";
import { createChatChannelPlugin } from "../plugin-sdk/channel-core.js";
import {
  channelFixture as createChannelPlugin,
  expectDiagnostic,
} from "./registry-registration.test-support.js";
import { createTestPluginRegistry as createTestRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRecord } from "./status.test-fixtures.js";
import type { OpenClawPluginChannelRegistration, PluginRegistrationMode } from "./types.js";

function fixture(
  fields: Parameters<typeof createPluginRecord>[0],
  registrationMode: PluginRegistrationMode = "setup-only",
) {
  const builder = createTestRegistry();
  const record = createPluginRecord(fields);
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, registrationMode });
  return { registry: builder.registry, record, api };
}

it("rejects conflicted tool registration before reading declarations", () => {
  const builder = createTestRegistry();
  const owner = createPluginRecord({ id: "channel-owner" });
  let declarationReads = 0;
  const conflicting = createPluginRecord({
    id: "conflicting-owner",
    contracts: {
      get tools(): string[] {
        declarationReads += 1;
        throw new Error("conflicted declarations must not be read");
      },
    },
  });
  builder.registry.plugins.push(owner, conflicting);
  builder.createApi(owner, { config: {}, registrationMode: "full" }).registerChannel({
    plugin: createChannelPlugin("shared-channel", "Owner"),
  });
  const api = builder.createApi(conflicting, { config: {}, registrationMode: "full" });
  api.registerChannel({ plugin: createChannelPlugin("shared-channel", "Conflict") });
  expect(() => api.registerTool(() => null, { name: "probe" })).not.toThrow();
  expect(builder.registry.channels.map((entry) => entry.pluginId)).toEqual(["channel-owner"]);
  expect(builder.registry.tools).toEqual([]);
  expect(builder.registry.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    "channel already registered: shared-channel (channel-owner)",
  ]);
  expect(declarationReads).toBe(0);
});

it("rejects invalid channel capabilities at the registrar boundary", () => {
  const { registry, api } = fixture({ id: "incomplete-channel-owner", origin: "global" }, "full");
  const plugin = createChannelPlugin("incomplete-channel", "Incomplete Channel");
  plugin.capabilities = { chatTypes: ["forum"] } as never;

  api.registerChannel({ plugin });
  expect(registry).toMatchObject({ channelSetups: [], channels: [] });
  expect(registry.diagnostics.map((diag) => diag.message)).toContain(
    'channel "incomplete-channel" registration missing or invalid required capabilities.chatTypes',
  );
});

it("rejects disabled workspace registration before reading channel data", () => {
  const { registry, record, api } = fixture({
    id: "workspace-shadow",
    origin: "workspace",
    enabled: false,
  });
  const readPlugin = vi.fn(() => {
    throw new Error("registration plugin getter should not run");
  });
  const registration = Object.defineProperty({} as OpenClawPluginChannelRegistration, "plugin", {
    enumerable: true,
    get: readPlugin,
  });

  expect(() => api.registerChannel(registration)).not.toThrow();

  expect(readPlugin).not.toHaveBeenCalled();
  expect(registry).toMatchObject({ channelSetups: [], channels: [] });
  expect(record.channelIds).toEqual([]);
  expectDiagnostic(registry, {
    level: "warn",
    pluginId: "workspace-shadow",
    message: "channel registration rejected for disabled workspace plugin: workspace-shadow",
  });
});

it("keeps channel registration available for trusted workspace plugins", () => {
  const { registry, record, api } = fixture({
    id: "trusted-workspace-shadow",
    origin: "workspace",
    enabled: true,
  });
  const plugin = createChannelPlugin("telegram", "Trusted Workspace Telegram");
  plugin.capabilities = undefined as never;

  api.registerChannel({ plugin: createChatChannelPlugin({ base: plugin }) });

  expect(registry.channelSetups).toMatchObject([
    {
      pluginId: "trusted-workspace-shadow",
      enabled: true,
      origin: "workspace",
      plugin: { id: "telegram", capabilities: { chatTypes: ["direct"] } },
    },
  ]);
  expect(registry.channels).toHaveLength(0);
  expect(record.channelIds).toEqual(["telegram"]);
});
