import type {
  ChannelMessagingAdapter,
  ChannelOutboundSessionRoute,
} from "../channels/plugins/types.core.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { getChatChannelMeta } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { buildOutboundBaseSessionKey } from "../infra/outbound/base-session-key.js";
import { emptyPluginConfigSchema } from "../plugins/config-schema.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
  PluginCommandContext,
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
  OpenClawPluginServiceContext,
  ProviderAuthContext,
  ProviderAuthDoctorHintContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthMethod,
  ProviderAuthResult,
  OpenClawPluginCommandDefinition,
  OpenClawPluginDefinition,
  PluginCommandContext,
  PluginLogger,
  PluginInteractiveTelegramHandlerContext,
} from "../plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export { isSecretRef } from "../config/types.secrets.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export type {
  ChannelOutboundSessionRoute,
  ChannelMessagingAdapter,
} from "../channels/plugins/types.core.js";
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
export { delegateCompactionToRuntime } from "../context-engine/delegate.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export {
  formatPairingApproveHint,
  parseOptionalDelimitedEntries,
} from "../channels/plugins/helpers.js";
export { getChatChannelMeta } from "../channels/registry.js";
export {
  channelTargetSchema,
  channelTargetsSchema,
  optionalStringEnum,
  stringEnum,
} from "../agents/schema/typebox.js";
export {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  loadSecretFileSync,
  readSecretFileSync,
  tryReadSecretFileSync,
} from "../infra/secret-file.js";
export type { SecretFileReadOptions, SecretFileReadResult } from "../infra/secret-file.js";

export { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";
export type { GatewayBindUrlResult } from "../shared/gateway-bind-url.js";
export { normalizeAtHashSlug, normalizeHyphenSlug } from "../shared/string-normalization.js";

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

export type ChannelOutboundSessionRouteParams = Parameters<
  NonNullable<ChannelMessagingAdapter["resolveOutboundSessionRoute"]>
>[0];

export function stripChannelTargetPrefix(raw: string, ...providers: string[]): string {
  const trimmed = raw.trim();
  for (const provider of providers) {
    const prefix = `${provider.toLowerCase()}:`;
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return trimmed;
}

export function stripTargetKindPrefix(raw: string): string {
  return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}

export function buildChannelOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: { kind: "direct" | "group" | "channel"; id: string };
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
}): ChannelOutboundSessionRoute {
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer: params.peer,
    chatType: params.chatType,
    from: params.from,
    to: params.to,
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
  };
}

type DefineChannelPluginEntryOptions<TPlugin extends ChannelPlugin = ChannelPlugin> = {
  id: string;
  name: string;
  description: string;
  plugin: TPlugin;
  configSchema?: DefinePluginEntryOptions["configSchema"];
  setRuntime?: (runtime: PluginRuntime) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
};

type DefinePluginEntryOptions = {
  id: string;
  name: string;
  description: string;
  kind?: OpenClawPluginDefinition["kind"];
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  register: (api: OpenClawPluginApi) => void;
};

type DefinedPluginEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind">;

type CreateChannelPluginBaseOptions<TResolvedAccount> = {
  id: ChannelPlugin<TResolvedAccount>["id"];
  meta?: Partial<NonNullable<ChannelPlugin<TResolvedAccount>["meta"]>>;
  setupWizard?: NonNullable<ChannelPlugin<TResolvedAccount>["setupWizard"]>;
  capabilities?: ChannelPlugin<TResolvedAccount>["capabilities"];
  agentPrompt?: ChannelPlugin<TResolvedAccount>["agentPrompt"];
  streaming?: ChannelPlugin<TResolvedAccount>["streaming"];
  reload?: ChannelPlugin<TResolvedAccount>["reload"];
  gatewayMethods?: ChannelPlugin<TResolvedAccount>["gatewayMethods"];
  configSchema?: ChannelPlugin<TResolvedAccount>["configSchema"];
  config?: ChannelPlugin<TResolvedAccount>["config"];
  security?: ChannelPlugin<TResolvedAccount>["security"];
  setup: NonNullable<ChannelPlugin<TResolvedAccount>["setup"]>;
  groups?: ChannelPlugin<TResolvedAccount>["groups"];
};

type CreatedChannelPluginBase<TResolvedAccount> = Pick<
  ChannelPlugin<TResolvedAccount>,
  "id" | "meta" | "setup"
> &
  Partial<
    Pick<
      ChannelPlugin<TResolvedAccount>,
      | "setupWizard"
      | "capabilities"
      | "agentPrompt"
      | "streaming"
      | "reload"
      | "gatewayMethods"
      | "configSchema"
      | "config"
      | "security"
      | "groups"
    >
  >;

function resolvePluginConfigSchema(
  configSchema: DefinePluginEntryOptions["configSchema"] = emptyPluginConfigSchema,
): OpenClawPluginConfigSchema {
  return typeof configSchema === "function" ? configSchema() : configSchema;
}

// Shared generic plugin-entry boilerplate for bundled and third-party plugins.
export function definePluginEntry({
  id,
  name,
  description,
  kind,
  configSchema = emptyPluginConfigSchema,
  register,
}: DefinePluginEntryOptions): DefinedPluginEntry {
  return {
    id,
    name,
    description,
    ...(kind ? { kind } : {}),
    configSchema: resolvePluginConfigSchema(configSchema),
    register,
  };
}

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
  return definePluginEntry({
    id,
    name,
    description,
    configSchema,
    register(api: OpenClawPluginApi) {
      setRuntime?.(api.runtime);
      api.registerChannel({ plugin });
      if (api.registrationMode !== "full") {
        return;
      }
      registerFull?.(api);
    },
  });
}

// Shared setup-entry shape so bundled channels do not duplicate `{ plugin }`.
export function defineSetupPluginEntry<TPlugin>(plugin: TPlugin) {
  return { plugin };
}

// Shared base object for channel plugins that only need to override a few optional surfaces.
export function createChannelPluginBase<TResolvedAccount>(
  params: CreateChannelPluginBaseOptions<TResolvedAccount>,
): CreatedChannelPluginBase<TResolvedAccount> {
  return {
    id: params.id,
    meta: {
      ...getChatChannelMeta(params.id as Parameters<typeof getChatChannelMeta>[0]),
      ...params.meta,
    },
    ...(params.setupWizard ? { setupWizard: params.setupWizard } : {}),
    ...(params.capabilities ? { capabilities: params.capabilities } : {}),
    ...(params.agentPrompt ? { agentPrompt: params.agentPrompt } : {}),
    ...(params.streaming ? { streaming: params.streaming } : {}),
    ...(params.reload ? { reload: params.reload } : {}),
    ...(params.gatewayMethods ? { gatewayMethods: params.gatewayMethods } : {}),
    ...(params.configSchema ? { configSchema: params.configSchema } : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.security ? { security: params.security } : {}),
    ...(params.groups ? { groups: params.groups } : {}),
    setup: params.setup,
  } as CreatedChannelPluginBase<TResolvedAccount>;
}
