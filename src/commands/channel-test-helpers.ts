import { googlechatPlugin } from "../../extensions/googlechat/test-api.js";
import { matrixPlugin, setMatrixRuntime } from "../../extensions/matrix/test-api.js";
import { msteamsPlugin } from "../../extensions/msteams/test-api.js";
import { nostrPlugin } from "../../extensions/nostr/test-api.js";
import { tlonPlugin } from "../../extensions/tlon/test-api.js";
import { whatsappPlugin } from "../../extensions/whatsapp/test-api.js";
import { bundledChannelPlugins } from "../channels/plugins/bundled.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { getChannelSetupWizardAdapter } from "./channel-setup/registry.js";
import type { ChannelSetupWizardAdapter } from "./channel-setup/types.js";
import type { ChannelChoice } from "./onboard-types.js";

type ChannelSetupWizardAdapterPatch = Partial<
  Pick<
    ChannelSetupWizardAdapter,
    | "afterConfigWritten"
    | "configure"
    | "configureInteractive"
    | "configureWhenConfigured"
    | "getStatus"
  >
>;

type PatchedSetupAdapterFields = {
  afterConfigWritten?: ChannelSetupWizardAdapter["afterConfigWritten"];
  configure?: ChannelSetupWizardAdapter["configure"];
  configureInteractive?: ChannelSetupWizardAdapter["configureInteractive"];
  configureWhenConfigured?: ChannelSetupWizardAdapter["configureWhenConfigured"];
  getStatus?: ChannelSetupWizardAdapter["getStatus"];
};

export function setDefaultChannelPluginRegistryForTests(): void {
  setMatrixRuntime({
    state: {
      resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))(),
    },
  } as Parameters<typeof setMatrixRuntime>[0]);
  const channels = [
    ...bundledChannelPlugins,
    matrixPlugin,
    msteamsPlugin,
    nostrPlugin,
    tlonPlugin,
    googlechatPlugin,
    whatsappPlugin,
  ].map((plugin) => ({
    pluginId: plugin.id,
    plugin,
    source: "test" as const,
  })) as unknown as Parameters<typeof createTestRegistry>[0];
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
  if (Object.prototype.hasOwnProperty.call(patch, "afterConfigWritten")) {
    previous.afterConfigWritten = adapter.afterConfigWritten;
    adapter.afterConfigWritten = patch.afterConfigWritten;
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
    if (Object.prototype.hasOwnProperty.call(patch, "afterConfigWritten")) {
      adapter.afterConfigWritten = previous.afterConfigWritten;
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

export const patchChannelOnboardingAdapter = patchChannelSetupWizardAdapter;
