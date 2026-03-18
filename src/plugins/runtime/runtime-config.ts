import { loadConfig, writeConfigFile } from "../../config/config.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { getPluginRuntimeCommandScope, PluginCommandScopeError } from "./plugin-command-scope.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeConfig(): PluginRuntime["config"] {
  return {
    loadConfig,
    writeConfigFile: (...args) => {
      const scope = getPluginRuntimeCommandScope();
      if (scope && isInternalMessageChannel(scope.channel)) {
        const scopes = scope.gatewayClientScopes ?? [];
        if (!scopes.includes("operator.admin")) {
          throw new PluginCommandScopeError(
            `/${scope.commandName} requires operator.admin for gateway clients.`,
          );
        }
      }
      return writeConfigFile(...args);
    },
  };
}
