import { vi } from "vitest";
import * as runtimePlugins from "../../../src/agents/runtime-plugins.js";
import {
  getLoadedChannelPlugin,
  resolveChannelPluginRegistration,
} from "../../../src/channels/plugins/registry.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { createPluginRegistry } from "../../../src/plugins/registry.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../src/plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../../src/plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../../../src/plugins/runtime/index.js";
import { createPluginRecord } from "../../../src/plugins/status.test-fixtures.js";
import { loadBundledPluginFacade } from "../../../src/test-utils/bundled-plugin-public-surface.js";

// Registry/account inputs are the seam. Owners, registration custody, read grants,
// prepared leases, scheduler admission, tool execution and dispatch stay native.
export async function installScheduledMessageReadRuntime(params: {
  cfg: OpenClawConfig;
  cleanup: Array<() => void | Promise<void>>;
}) {
  const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
    pluginId: "discord",
    artifactBasename: "api.js",
  });
  let scopedConfig = params.cfg;
  const makeOwner = (scoped: boolean) => {
    const owner = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "discord",
      origin: "global",
      trustedOfficialInstall: true,
    });
    owner.registry.plugins.push(record);
    owner.createApi(record, { config: params.cfg, registrationMode: "full" }).registerChannel({
      plugin: {
        ...discordPlugin,
        status: undefined,
        config: {
          ...discordPlugin.config,
          listAccountIds: () =>
            discordPlugin.config.listAccountIds(scoped ? scopedConfig : params.cfg),
        },
      },
    });
    return owner;
  };
  // Do not share registration records: each owner must retain its native custody.
  const root = makeOwner(false);
  const scoped = makeOwner(true);
  setActivePluginRegistry(root.registry);
  params.cleanup.push(() => resetPluginRuntimeStateForTest());
  vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle").mockImplementation(
    (_params, onPrimaryRegistry) => {
      onPrimaryRegistry?.(scoped.registry);
      return scoped.registry;
    },
  );
  vi.spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry").mockResolvedValue({
    registry: scoped.registry,
    primaryRegistry: scoped.registry,
  });
  const readGrantCurrent = (owner: ReturnType<typeof makeOwner>) =>
    withPluginRuntimeRegistryScope(
      owner.registry,
      () =>
        owner.registry.channels
          .find((row) => row.plugin.id === "discord")
          ?.captureReadAuthority?.()?.() === true,
    );
  return {
    select(mode: "scoped-removed" | "both-present") {
      if (!readGrantCurrent(root) || !readGrantCurrent(scoped)) {
        throw new Error("Native read custody unavailable before scenario");
      }
      if (mode === "scoped-removed") {
        scopedConfig = structuredClone(params.cfg);
        if (scopedConfig.channels?.discord?.accounts) {
          delete scopedConfig.channels.discord.accounts.work;
        }
      }
      const facts = withPluginRuntimeRegistryScope(scoped.registry, () => ({
        rootHasWork:
          getLoadedChannelPlugin("discord")?.config.listAccountIds(params.cfg).includes("work") ===
          true,
        scopedHasWork:
          resolveChannelPluginRegistration("discord", { loadedOnly: true })
            ?.plugin.config.listAccountIds(params.cfg)
            .includes("work") === true,
        rootReadCurrent: readGrantCurrent(root),
        scopedReadCurrent: readGrantCurrent(scoped),
      }));
      if (
        !facts.rootHasWork ||
        facts.scopedHasWork !== (mode === "both-present") ||
        !facts.rootReadCurrent ||
        !facts.scopedReadCurrent
      ) {
        throw new Error("Native registry/account matrix does not match scenario");
      }
      return facts;
    },
  };
}
