import { vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as commandSecretGateway from "../../cli/command-secret-gateway.js";
import * as commandSecretTargets from "../../cli/command-secret-targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
} from "../../gateway/server-methods/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

export function resolvedMessageSecrets(resolvedConfig: OpenClawConfig) {
  return { resolvedConfig, diagnostics: [], targetStatesByPath: {}, hadUnresolvedTargets: false };
}

export function messageGatewayContext(
  getRuntimeConfig: () => OpenClawConfig,
  handler: GatewayRequestHandler,
  overrides: Partial<GatewayRequestContext> = {},
) {
  const methods = createGatewayMethodRegistry([
    {
      name: "message.action",
      owner: { kind: "core", area: "message" },
      scope: "operator.write",
      handler,
    },
  ]);
  return {
    getRuntimeConfig,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    getGatewayMethodRegistry: () => methods,
    trackExecution: <T>(run: () => Promise<T>) => run(),
    ...overrides,
  } as GatewayRequestContext;
}

export function stubMessageSecrets() {
  vi.spyOn(commandSecretTargets, "getScopedChannelsCommandSecretTargets").mockReturnValue({
    targetIds: new Set<string>(),
  });
  vi.spyOn(commandSecretGateway, "resolveCommandSecretRefsViaGateway").mockImplementation(
    async ({ config }) => resolvedMessageSecrets(config),
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
