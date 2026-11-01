import { expect, vi } from "vitest";
import type { ChannelConfigSchema } from "../channels/plugins/types.config.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "../plugins/types.js";

export function createChannelEntryApi(registrationMode: PluginRegistrationMode): OpenClawPluginApi {
  return {
    registrationMode,
    runtime: { registrationMode } as unknown as PluginRuntime,
    registerChannel: vi.fn(),
    registerTool: vi.fn(),
  } as unknown as OpenClawPluginApi;
}

export function registerChannelEntryTestTool(api: OpenClawPluginApi) {
  api.registerTool(
    {
      name: "channel_tool",
      label: "Channel Tool",
      description: "channel tool",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    },
    { name: "channel_tool" },
  );
}

export function expectLazyChannelSchema(
  createEntry: (factory: () => ChannelConfigSchema) => { configSchema: ChannelConfigSchema },
) {
  const schema = { schema: { type: "object" as const, additionalProperties: false } };
  const factory = vi.fn(() => schema);
  const entry = createEntry(factory);
  expect(factory).not.toHaveBeenCalled();
  expect(entry.configSchema).toBe(schema);
  expect(entry.configSchema).toBe(schema);
  expect(factory).toHaveBeenCalledOnce();
}
