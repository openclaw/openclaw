import type { AuthorizationPolicyHandler } from "../../plugins/authorization-policy.types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

export function installMessageActionPolicy(
  handler: AuthorizationPolicyHandler<"message.action">,
  channelPlugin?:
    | ReturnType<typeof createOutboundTestPlugin>
    | Array<ReturnType<typeof createOutboundTestPlugin>>,
) {
  const channelPlugins = channelPlugin
    ? Array.isArray(channelPlugin)
      ? channelPlugin
      : [channelPlugin]
    : [];
  const registry = createTestRegistry(
    channelPlugins.map((plugin) => ({ pluginId: plugin.id, source: "test", plugin })),
  );
  registry.authorizationPolicies.push({
    pluginId: "message-action-policy-test",
    pluginName: "Message action policy test",
    origin: "workspace",
    source: "test",
    policy: {
      id: "message-action-policy-test",
      description: "Tests prepared message actions",
      handlers: { "message.action": handler },
    },
  });
  setActivePluginRegistry(registry);
}

export function resetMessageActionPolicyRegistry() {
  setActivePluginRegistry(createTestRegistry([]));
}
