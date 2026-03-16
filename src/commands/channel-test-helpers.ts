import { requireBundledChannelPlugin } from "../channels/plugins/bundled.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { getChannelSetupWizardAdapter } from "./channel-setup/registry.js";
import type { ChannelSetupWizardAdapter } from "./channel-setup/types.js";
import type { ChannelChoice } from "./onboard-types.js";

type ChannelSetupWizardAdapterPatch = Partial<
  Pick<
    ChannelSetupWizardAdapter,
    "configure" | "configureInteractive" | "configureWhenConfigured" | "getStatus"
  >
>;

type PatchedSetupAdapterFields = {
  configure?: ChannelSetupWizardAdapter["configure"];
  configureInteractive?: ChannelSetupWizardAdapter["configureInteractive"];
  configureWhenConfigured?: ChannelSetupWizardAdapter["configureWhenConfigured"];
  getStatus?: ChannelSetupWizardAdapter["getStatus"];
};

export function setDefaultChannelPluginRegistryForTests(): void {
  const channels = [
    { pluginId: "discord", plugin: requireBundledChannelPlugin("discord"), source: "test" },
    { pluginId: "feishu", plugin: requireBundledChannelPlugin("feishu"), source: "test" },
    { pluginId: "slack", plugin: requireBundledChannelPlugin("slack"), source: "test" },
    { pluginId: "telegram", plugin: requireBundledChannelPlugin("telegram"), source: "test" },
    { pluginId: "whatsapp", plugin: requireBundledChannelPlugin("whatsapp"), source: "test" },
    { pluginId: "signal", plugin: requireBundledChannelPlugin("signal"), source: "test" },
    { pluginId: "imessage", plugin: requireBundledChannelPlugin("imessage"), source: "test" },
  ] as unknown as Parameters<typeof createTestRegistry>[0];
  setActivePluginRegistry(createTestRegistry(channels));
}

export function patchChannelSetupWizardAdapter(
  channel: ChannelChoice,
  patch: ChannelSetupWizardAdapterPatch,
): () => void {
  const adapter = getChannelSetupWizardAdapter(channel);
  if (!adapter) {
    throw new Error(`missing setup adapter for ${channel}`);
  }

  const previous: PatchedSetupAdapterFields = {};

  if (Object.prototype.hasOwnProperty.call(patch, "getStatus")) {
    previous.getStatus = adapter.getStatus;
    adapter.getStatus = patch.getStatus ?? adapter.getStatus;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configure")) {
    previous.configure = adapter.configure;
    adapter.configure = patch.configure ?? adapter.configure;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configureInteractive")) {
    previous.configureInteractive = adapter.configureInteractive;
    adapter.configureInteractive = patch.configureInteractive;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "configureWhenConfigured")) {
    previous.configureWhenConfigured = adapter.configureWhenConfigured;
    adapter.configureWhenConfigured = patch.configureWhenConfigured;
  }

  return () => {
    if (Object.prototype.hasOwnProperty.call(patch, "getStatus")) {
      adapter.getStatus = previous.getStatus!;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configure")) {
      adapter.configure = previous.configure!;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configureInteractive")) {
      adapter.configureInteractive = previous.configureInteractive;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "configureWhenConfigured")) {
      adapter.configureWhenConfigured = previous.configureWhenConfigured;
    }
  };
}
