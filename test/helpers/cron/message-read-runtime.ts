import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import * as runtimePlugins from "../../../src/agents/runtime-plugins.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { createPluginRegistry } from "../../../src/plugins/registry.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../src/plugins/runtime.js";
import { createPluginRuntime } from "../../../src/plugins/runtime/index.js";
import { createPluginRecord } from "../../../src/plugins/status.test-fixtures.js";
import type { CliBackendPlugin } from "../../../src/plugins/types.js";
import { loadBundledPluginFacade } from "../../../src/test-utils/bundled-plugin-public-surface.js";

export async function installScheduledMessageReadRuntime(params: {
  cfg: OpenClawConfig;
  childPath: string;
  nativeCreatorAccountId?: string;
  cleanup: Array<() => void | Promise<void>>;
}): Promise<() => Promise<void>> {
  const [{ buildAnthropicCliBackend }, { discordPlugin }] = await Promise.all([
    loadBundledPluginFacade<{ buildAnthropicCliBackend: () => CliBackendPlugin }>({
      pluginId: "anthropic",
      artifactBasename: "api.js",
    }),
    loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
      pluginId: "discord",
      artifactBasename: "api.js",
    }),
  ]);
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  for (const id of ["anthropic", "discord"]) {
    const record = createPluginRecord({ id, origin: "global", trustedOfficialInstall: true });
    owner.registry.plugins.push(record);
    const api = owner.createApi(record, { config: params.cfg, registrationMode: "full" });
    if (id === "discord") {
      api.registerChannel({ plugin: { ...discordPlugin, status: undefined } });
    } else {
      const backend = buildAnthropicCliBackend();
      api.registerCliBackend({
        ...backend,
        config: { ...backend.config, command: params.childPath },
      });
    }
  }
  setActivePluginRegistry(owner.registry);
  params.cleanup.push(() => resetPluginRuntimeStateForTest());
  let stopBindingManager = async () => {};
  if (params.nativeCreatorAccountId) {
    // Minimal Gateway startup omits channel monitors; the simulated inbound creator
    // still needs the channel's real binding owner, without starting its transport.
    const plugin = expectDefined(
      owner.registry.channels.find((entry) => entry.plugin.id === "discord")?.plugin,
      "registered Discord channel",
    );
    const createManager = expectDefined(
      plugin.conversationBindings?.createManager,
      "Discord binding manager",
    );
    const manager = await createManager({
      cfg: params.cfg,
      accountId: params.nativeCreatorAccountId,
    });
    let stopping: Promise<void> | undefined;
    stopBindingManager = () => (stopping ??= Promise.resolve().then(() => manager.stop()));
    params.cleanup.push(stopBindingManager);
  }
  // Both acquisition paths borrow the same real registrations; prepared-runtime ownership stays real.
  vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle").mockImplementation(
    (_params, onPrimaryRegistry) => {
      onPrimaryRegistry?.(owner.registry);
      return owner.registry;
    },
  );
  vi.spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry").mockResolvedValue({
    registry: owner.registry,
    primaryRegistry: owner.registry,
  });
  return stopBindingManager;
}
