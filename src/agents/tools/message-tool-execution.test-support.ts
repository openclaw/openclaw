import { vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as commandSecretGateway from "../../cli/command-secret-gateway.js";
import * as commandSecretTargets from "../../cli/command-secret-targets.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

export function stubMessageSecrets() {
  vi.spyOn(commandSecretTargets, "getScopedChannelsCommandSecretTargets").mockReturnValue({
    targetIds: new Set<string>(),
  });
  vi.spyOn(commandSecretGateway, "resolveCommandSecretRefsViaGateway").mockImplementation(
    async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }),
  );
}

export function registerMessageChannel(plugin: ChannelPlugin, origin?: "bundled") {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: plugin.id, source: "test", plugin, ...(origin ? { origin } : {}) },
    ]),
  );
}

export function messageSource(channel: string, target: string, messageId?: string) {
  return {
    currentChannelProvider: channel,
    currentChannelId: target,
    currentMessagingTarget: target,
    ...(messageId === undefined ? {} : { currentMessageId: messageId }),
  };
}
