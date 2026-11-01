import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { expect } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { PluginRegistry } from "./registry-types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

export function registrationFixture() {
  const { config, registry: builder } = createPluginRegistryFixture();
  const register = (
    fields: Parameters<typeof createPluginRecord>[0],
    hook: Parameters<typeof registerTestPlugin>[0]["register"],
  ) => {
    const record = createPluginRecord(fields);
    registerTestPlugin({ config, registry: builder, record, register: hook });
    return record;
  };
  return {
    config,
    registry: builder.registry,
    register,
    rollback: builder.rollbackPluginGlobalSideEffects,
  };
}

export function expectDiagnostic(
  registry: PluginRegistry,
  diagnostic: Partial<PluginRegistry["diagnostics"][number]>,
) {
  expect(registry.diagnostics).toContainEqual(expect.objectContaining(diagnostic));
}

export function channelFixture(id: string, label = id): ChannelPlugin {
  return {
    id,
    meta: {
      id,
      label,
      selectionLabel: label,
      docsPath: `/channels/${id}`,
      blurb: `${label} channel`,
    },
    capabilities: { chatTypes: ["direct"] },
    config: { listAccountIds: () => [], resolveAccount: () => undefined },
    outbound: { deliveryMode: "direct" },
  };
}
