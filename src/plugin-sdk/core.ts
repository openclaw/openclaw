import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { emptyPluginConfigSchema } from "../plugins/config-schema.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginConfigSchema,
  PluginInteractiveTelegramHandlerContext,
} from "../plugins/types.js";

export type {
  AnyAgentTool,
  MediaUnderstandingProviderPlugin,
  OpenClawPluginConfigSchema,
  ProviderDiscoveryContext,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderAugmentModelCatalogContext,
  ProviderBuiltInModelSuppressionContext,
  ProviderBuiltInModelSuppressionResult,
  ProviderBuildMissingAuthMessageContext,
  ProviderCacheTtlEligibilityContext,
  ProviderDefaultThinkingPolicyContext,
  ProviderFetchUsageSnapshotContext,
  ProviderModernModelPolicyContext,
  ProviderPreparedRuntimeAuth,
  ProviderResolvedUsageAuth,
  ProviderPrepareExtraParamsContext,
  ProviderPrepareDynamicModelContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderResolveUsageAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderNormalizeResolvedModelContext,
  ProviderRuntimeModel,
  SpeechProviderPlugin,
  ProviderThinkingPolicyContext,
  ProviderWrapStreamFnContext,
  OpenClawPluginService,
  ProviderAuthContext,
  ProviderAuthDoctorHintContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthMethod,
  ProviderAuthResult,
  OpenClawPluginCommandDefinition,
  PluginInteractiveTelegramHandlerContext,
} from "../plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "../infra/provider-usage.types.js";
export type { ChannelMessageActionContext } from "../channels/plugins/types.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";
export {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  loadSecretFileSync,
  readSecretFileSync,
  tryReadSecretFileSync,
} from "../infra/secret-file.js";
export type { SecretFileReadOptions, SecretFileReadResult } from "../infra/secret-file.js";

export { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";
export type { GatewayBindUrlResult } from "../shared/gateway-bind-url.js";

export { resolveTailnetHostWithRunner } from "../shared/tailscale-status.js";
export type {
  TailscaleStatusCommandResult,
  TailscaleStatusCommandRunner,
} from "../shared/tailscale-status.js";
export {
  buildAgentSessionKey,
  type RoutePeer,
  type RoutePeerKind,
} from "../routing/resolve-route.js";
export { buildOutboundBaseSessionKey } from "../infra/outbound/base-session-key.js";
export { normalizeOutboundThreadId } from "../infra/outbound/thread-id.js";
export { resolveThreadSessionKeys } from "../routing/session-key.js";

type DefineChannelPluginEntryOptions<TPlugin extends ChannelPlugin = ChannelPlugin> = {
  id: string;
  name: string;
  description: string;
  plugin: TPlugin;
  configSchema?: () => OpenClawPluginConfigSchema;
  setRuntime?: (runtime: PluginRuntime) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
};

// Shared channel-plugin entry boilerplate for bundled and third-party channels.
export function defineChannelPluginEntry<TPlugin extends ChannelPlugin>({
  id,
  name,
  description,
  plugin,
  configSchema = emptyPluginConfigSchema,
  setRuntime,
  registerFull,
}: DefineChannelPluginEntryOptions<TPlugin>) {
  return {
    id,
    name,
    description,
    configSchema: configSchema(),
    register(api: OpenClawPluginApi) {
      setRuntime?.(api.runtime);
      api.registerChannel({ plugin });
      if (api.registrationMode !== "full") {
        return;
      }
      registerFull?.(api);
    },
  };
}

// Shared setup-entry shape so bundled channels do not duplicate `{ plugin }`.
export function defineSetupPluginEntry<TPlugin>(plugin: TPlugin) {
  return { plugin };
}
