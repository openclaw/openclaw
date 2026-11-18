import type { ResolvedConfiguredAcpBinding } from "../acp/persistent-bindings.types.js";
import {
  findChatChannelMeta,
  getChatChannelMeta as getBuiltInChatChannelMeta,
} from "../channels/chat-meta.js";
import type { ChatChannelId } from "../channels/ids.js";
import { emptyChannelConfigSchema } from "../channels/plugins/config-schema.js";
import { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
import { createTextPairingAdapter } from "../channels/plugins/pairing-adapters.js";
import {
  createScopedAccountReplyToModeResolver,
  createTopLevelChannelReplyToModeResolver,
} from "../channels/plugins/threading-helpers.js";
import type {
  ChannelOutboundAdapter,
  ChannelPairingAdapter,
  ChannelSecurityAdapter,
} from "../channels/plugins/types.adapters.js";
import type { ChannelConfigSchema } from "../channels/plugins/types.config.js";
import type {
  ChannelSecurityDmPolicy,
  ChannelThreadingAdapter,
} from "../channels/plugins/types.core.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelMeta } from "../channels/plugins/types.public.js";
import type { ReplyToMode } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { createAttachedChannelResultAdapter } from "./channel-send-result.js";
import { createCachedLazyValueGetter } from "./lazy-value.js";
export type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  OpenClawPluginServiceContextV2,
  OpenClawPluginServiceV2,
  OpenClawPluginServiceV3,
  OpenClawPluginServiceContextV3,
  PluginServiceSessionWorkV1,
  PluginServiceSessionWorkContextV1,
  PluginServiceSchedulerV1,
} from "./core-service.types.js";
export type {
  AgentPromptGuidance,
  AgentPromptGuidanceEntry,
  AgentPromptSurfaceKind,
  AgentHarness,
  AnyAgentTool,
  MediaUnderstandingProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
  PluginCommandContext,
  PluginCommandResult,
  PluginAgentEventEmitParams,
  PluginAgentEventEmitResult,
  PluginAgentEventSubscriptionRegistration,
  PluginAgentTurnPrepareEvent,
  PluginAgentTurnPrepareResult,
  PluginControlUiDescriptor,
  PluginHeartbeatPromptContributionEvent,
  PluginHeartbeatPromptContributionResult,
  PluginJsonValue,
  PluginNextTurnInjection,
  PluginNextTurnInjectionEnqueueResult,
  PluginNextTurnInjectionRecord,
  PluginRunContextGetParams,
  PluginRunContextPatch,
  PluginRuntimeLifecycleRegistration,
  PluginSessionActionContext,
  PluginSessionActionRegistration,
  PluginSessionActionResult,
  PluginSessionAttachmentParams,
  PluginSessionAttachmentResult,
  PluginSessionSchedulerJobHandle,
  PluginSessionSchedulerJobRegistration,
  PluginSessionTurnScheduleParams,
  PluginSessionTurnUnscheduleByTagParams,
  PluginSessionTurnUnscheduleByTagResult,
  PluginSessionExtensionRegistration,
  PluginSessionExtensionProjection,
  PluginToolMetadataRegistration,
  PluginTrustedToolPolicyRegistration,
  PluginLogger,
  ProviderAuthContext,
  ProviderAuthDoctorHintContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAppGuidedSetup,
  ProviderAppGuidedSetupCandidate,
  ProviderAppGuidedSetupContext,
  ProviderAuthResult,
  ProviderAugmentModelCatalogContext,
  ProviderBuildMissingAuthMessageContext,
  ProviderBuildUnknownModelHintContext,
  ProviderBuiltInModelSuppressionContext,
  ProviderBuiltInModelSuppressionResult,
  ProviderCacheTtlEligibilityContext,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderDefaultThinkingPolicyContext,
  ProviderFetchUsageSnapshotContext,
  ProviderModernModelPolicyContext,
  ProviderNormalizeResolvedModelContext,
  ProviderNormalizeToolSchemasContext,
  ProviderPrepareDynamicModelContext,
  ProviderPrepareExtraParamsContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderPrepareRuntimeAuthContextV2,
  ProviderRuntimeAuthModel,
  ProviderPreparedRuntimeAuth,
  ProviderReasoningOutputMode,
  ProviderReasoningOutputModeContext,
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderReplaySessionEntry,
  ProviderReplaySessionState,
  ProviderReplaySessionStateV2,
  ProviderResolveDynamicModelContext,
  ProviderResolveTransportTurnStateContext,
  ProviderResolveWebSocketSessionPolicyContext,
  ProviderResolvedUsageAuth,
  ProviderUsageAuthToken,
  RealtimeTranscriptionProviderPlugin,
  ProviderSanitizeReplayHistoryContext,
  ProviderSanitizeReplayHistoryContextV2,
  ProviderTransportTurnState,
  ProviderToolSchemaDiagnostic,
  ProviderResolveUsageAuthContext,
  ProviderThinkingProfile,
  ProviderThinkingPolicyContext,
  ProviderValidateReplayTurnsContext,
  ProviderWebSocketSessionPolicy,
  ProviderWrapStreamFnContext,
  UnifiedModelCatalogProviderContext,
  UnifiedModelCatalogProviderPlugin,
  SpeechProviderPlugin,
} from "./plugin-entry.js";
export type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogKind,
  UnifiedModelCatalogSource,
} from "@openclaw/model-catalog-core/model-catalog-types";
export type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
export type {
  OpenClawPluginActiveModelContext,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  PluginHookReplyPayloadSendingContext,
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
  PluginHookReplyPayload,
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
  PluginHookReplyDispatchResult,
} from "../plugins/types.js";
export type {
  OpenClawPluginGatewayEventScope,
  OpenClawPluginGatewayEvents,
  OpenClawPluginSessionsChangedEvent,
} from "../plugins/gateway-events.js";
export type {
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
} from "../plugins/memory-state.js";
export type { OpenClawConfig } from "../config/config.js";
export type { OutboundIdentity } from "../infra/outbound/identity.js";
export type { HistoryEntry } from "../auto-reply/reply/history.types.js";
export type { ReplyPayload } from "./reply-payload.js";
export type { AllowlistMatch } from "../channels/allowlist-match.js";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelMeta,
  ChannelSetupInput,
} from "../channels/plugins/types.public.js";
export type { ChatType } from "../channels/chat-type.js";
export type { NormalizedLocation, OutboundLocation } from "../channels/location.js";
export type { ChannelDirectoryEntry } from "../channels/plugins/types.core.js";
export type { ChannelOutboundAdapter } from "../channels/plugins/types.adapters.js";
export type { PollInput } from "../polls.js";
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
export type { ChannelMessageActionContext } from "../channels/plugins/types.public.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type { ChannelConfigUiHint } from "../channels/plugins/types.config.js";
export type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export type { ContextEngineSessionTarget } from "../context-engine/types.js";

export { definePluginEntry } from "./plugin-entry.js";
export {
  buildJsonPluginConfigSchema,
  buildPluginConfigSchema,
  emptyPluginConfigSchema,
} from "../plugins/config-schema.js";
export { KeyedAsyncQueue, enqueueKeyedTask } from "./keyed-async-queue.js";
export { createDedupeCache, resolveGlobalDedupeCache } from "../infra/dedupe.js";
export { generateSecureToken, generateSecureUuid } from "../infra/secure-random.js";
export { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
export {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
  prepareMemorySystemPromptAddition,
} from "../context-engine/delegate.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export {
  buildChannelConfigSchema,
  buildJsonChannelConfigSchema,
  emptyChannelConfigSchema,
} from "../channels/plugins/config-schema.js";
export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export {
  clearAccountEntryFields,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export {
  formatPairingApproveHint,
  parseOptionalDelimitedEntries,
} from "../channels/plugins/helpers.js";
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
export { resolveGatewayPort } from "../config/paths.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export {
  normalizeAtHashSlug,
  normalizeHyphenSlug,
} from "../../packages/normalization-core/src/string-normalization.js";
export { createActionGate } from "../agents/tools/common.js";
export {
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readToolStringParam as readStringParam,
} from "../agents/tools/common.js";
export { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
export { isTrustedProxyAddress, resolveClientIp } from "../gateway/net.js";
export { formatZonedTimestamp } from "../infra/format-time/format-datetime.js";
export { resolveConfiguredAcpBindingRecord } from "../acp/persistent-bindings.resolve.js";

/** Ensure a configured ACP binding has live runtime state before channel delivery uses it. */
export async function ensureConfiguredAcpBindingReady(params: {
  cfg: OpenClawConfig;
  configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const runtime = await import("../acp/persistent-bindings.lifecycle.js");
  return runtime.ensureConfiguredAcpBindingReadyCore(params);
}

export {
  resolveTailnetHostWithRunner,
  resolveTailscaleServeGatewayUrlsWithRunner,
} from "../shared/tailscale-status.js";
export type {
  TailscaleStatusCommandResult,
  TailscaleStatusCommandRunner,
} from "../shared/tailscale-status.js";
export {
  buildAgentSessionKey,
  type RoutePeer,
  type RoutePeerKind,
} from "../routing/resolve-route.js";
export { resolveThreadSessionKeys } from "../routing/session-key.js";

function getChatChannelMetaForSdk(id: ChatChannelId): ChannelMeta {
  return getBuiltInChatChannelMeta(id);
}

export { getChatChannelMetaForSdk as getChatChannelMeta };

export {
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
} from "../channels/plugins/chat-target-prefixes.js";

/** Options for a channel plugin entry that should register a channel capability. */
type ChannelEntryConfigSchema<TPlugin> =
  TPlugin extends ChannelPlugin<unknown>
    ? NonNullable<TPlugin["configSchema"]>
    : ChannelConfigSchema;

type DefineChannelPluginEntryOptions<TPlugin = ChannelPlugin> = {
  id: string;
  name: string;
  description: string;
  plugin: TPlugin;
  configSchema?: ChannelEntryConfigSchema<TPlugin> | (() => ChannelEntryConfigSchema<TPlugin>);
  setRuntime?: (runtime: PluginRuntime) => void;
  registerCliMetadata?: (api: OpenClawPluginApi) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
  registerCapabilities?: (api: OpenClawPluginApi) => void;
};

type DefinedChannelPluginEntry<TPlugin> = {
  id: string;
  name: string;
  description: string;
  configSchema: ChannelConfigSchema;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: TPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

type CreateChannelPluginBaseOptions<TResolvedAccount> = {
  id: ChannelPlugin<TResolvedAccount>["id"];
  meta?: Partial<NonNullable<ChannelPlugin<TResolvedAccount>["meta"]>>;
  setupWizard?: NonNullable<ChannelPlugin<TResolvedAccount>["setupWizard"]>;
  capabilities?: ChannelPlugin<TResolvedAccount>["capabilities"];
  commands?: ChannelPlugin<TResolvedAccount>["commands"];
  doctor?: ChannelPlugin<TResolvedAccount>["doctor"];
  agentPrompt?: ChannelPlugin<TResolvedAccount>["agentPrompt"];
  streaming?: ChannelPlugin<TResolvedAccount>["streaming"];
  reload?: ChannelPlugin<TResolvedAccount>["reload"];
  gatewayMethods?: ChannelPlugin<TResolvedAccount>["gatewayMethods"];
  gatewayMethodDescriptors?: ChannelPlugin<TResolvedAccount>["gatewayMethodDescriptors"];
  configSchema?: ChannelPlugin<TResolvedAccount>["configSchema"];
  config?: ChannelPlugin<TResolvedAccount>["config"];
  security?: ChannelPlugin<TResolvedAccount>["security"];
  setup?: NonNullable<ChannelPlugin<TResolvedAccount>["setup"]>;
  setupContract?: NonNullable<ChannelPlugin<TResolvedAccount>["setupContract"]>;
  groups?: ChannelPlugin<TResolvedAccount>["groups"];
};

type CreatedChannelPluginBase<TResolvedAccount> = Pick<
  ChannelPlugin<TResolvedAccount>,
  "id" | "meta"
> &
  Partial<
    Pick<
      ChannelPlugin<TResolvedAccount>,
      Exclude<keyof CreateChannelPluginBaseOptions<TResolvedAccount>, "id" | "meta">
    >
  >;

/**
 * Canonical entry helper for channel plugins.
 *
 * Registers the channel capability and optionally exposes full-runtime hooks
 * such as tools or gateway handlers outside setup-only registration modes.
 */
export function defineChannelPluginEntry<TPlugin>({
  id,
  name,
  description,
  plugin,
  configSchema,
  setRuntime,
  registerCliMetadata,
  registerFull,
  registerCapabilities,
}: DefineChannelPluginEntryOptions<TPlugin>): DefinedChannelPluginEntry<TPlugin> {
  const getConfigSchema = createCachedLazyValueGetter(configSchema ?? emptyChannelConfigSchema);
  return {
    id,
    name,
    description,
    get configSchema() {
      return getConfigSchema();
    },
    register(api: OpenClawPluginApi) {
      if (api.registrationMode === "cli-metadata") {
        registerCliMetadata?.(api);
        return;
      }
      if (api.registrationMode === "tool-discovery") {
        registerFull?.(api);
        registerCapabilities?.(api);
        return;
      }
      api.registerChannel({ plugin: plugin as ChannelPlugin });
      setRuntime?.(api.runtime);
      if (api.registrationMode === "discovery") {
        registerCliMetadata?.(api);
        registerCapabilities?.(api);
        return;
      }
      if (api.registrationMode !== "full") {
        return;
      }
      registerCliMetadata?.(api);
      registerFull?.(api);
      registerCapabilities?.(api);
    },
    channelPlugin: plugin,
    ...(setRuntime ? { setChannelRuntime: setRuntime } : {}),
  };
}

/**
 * Minimal setup-entry helper for channels that ship a separate `setup-entry.ts`.
 *
 * The setup entry only needs to export `{ plugin }`, but using this helper
 * keeps the shape explicit in examples and generated typings.
 */
export function defineSetupPluginEntry<TPlugin>(plugin: TPlugin) {
  return { plugin };
}

type ChatChannelPluginBase<Plugin> = Omit<Plugin, "capabilities"> &
  Partial<Pick<ChannelPlugin, "capabilities">>;

type ChatChannelSecurityOptions<TResolvedAccount extends { accountId?: string | null }> = {
  dm: {
    channelKey: string;
    resolvePolicy: (account: TResolvedAccount) => string | null | undefined;
    resolveAllowFrom: (account: TResolvedAccount) => Array<string | number> | null | undefined;
    resolveFallbackAccountId?: (account: TResolvedAccount) => string | null | undefined;
    defaultPolicy?: string;
    allowFromPathSuffix?: string;
    policyPathSuffix?: string;
    approveChannelId?: string;
    approveHint?: string;
    normalizeEntry?: (raw: string) => string;
    classifyEntryAuthentication?: ChannelSecurityDmPolicy["classifyEntryAuthentication"];
    inheritSharedDefaultsFromDefaultAccount?: boolean;
  };
  dmRouting?: ChannelSecurityAdapter<TResolvedAccount>["dmRouting"];
  collectWarnings?: ChannelSecurityAdapter<TResolvedAccount>["collectWarnings"];
  collectAuditFindings?: ChannelSecurityAdapter<TResolvedAccount>["collectAuditFindings"];
};

type ChatChannelPairingOptions = {
  text: {
    idLabel: string;
    message: string;
    normalizeAllowEntry?: ChannelPairingAdapter["normalizeAllowEntry"];
    notify: (
      params: Parameters<NonNullable<ChannelPairingAdapter["notifyApproval"]>>[0] & {
        message: string;
      },
    ) => Promise<void> | void;
  };
};

type ChatChannelThreadingReplyModeOptions<TResolvedAccount> =
  | { topLevelReplyToMode: string }
  | {
      scopedAccountReplyToMode: {
        resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TResolvedAccount;
        resolveReplyToMode: (
          account: TResolvedAccount,
          chatType?: string | null,
        ) => ReplyToMode | null | undefined;
        fallback?: ReplyToMode;
      };
    }
  | {
      resolveReplyToMode: NonNullable<ChannelThreadingAdapter["resolveReplyToMode"]>;
    };

type ChatChannelThreadingOptions<TResolvedAccount> =
  ChatChannelThreadingReplyModeOptions<TResolvedAccount> &
    Omit<ChannelThreadingAdapter, "resolveReplyToMode">;

type ChatChannelAttachedOutboundOptions = {
  base: Omit<ChannelOutboundAdapter, "sendText" | "sendMedia" | "sendPoll">;
  attachedResults: Parameters<typeof createAttachedChannelResultAdapter>[0];
};

function resolveChatChannelSecurity<TResolvedAccount extends { accountId?: string | null }>(
  security: ChannelSecurityAdapter<TResolvedAccount> | ChatChannelSecurityOptions<TResolvedAccount>,
): ChannelSecurityAdapter<TResolvedAccount> {
  if (!("dm" in security)) {
    return security;
  }
  return {
    resolveDmPolicy: ({ cfg, accountId, account }) =>
      buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: security.dm.channelKey,
        accountId,
        fallbackAccountId: security.dm.resolveFallbackAccountId?.(account) ?? account.accountId,
        policy: security.dm.resolvePolicy(account),
        allowFrom: security.dm.resolveAllowFrom(account) ?? [],
        defaultPolicy: security.dm.defaultPolicy,
        allowFromPathSuffix: security.dm.allowFromPathSuffix,
        policyPathSuffix: security.dm.policyPathSuffix,
        approveChannelId: security.dm.approveChannelId,
        approveHint: security.dm.approveHint,
        normalizeEntry: security.dm.normalizeEntry,
        classifyEntryAuthentication: security.dm.classifyEntryAuthentication,
        inheritSharedDefaultsFromDefaultAccount:
          security.dm.inheritSharedDefaultsFromDefaultAccount,
      }),
    ...(security.dmRouting ? { dmRouting: security.dmRouting } : {}),
    ...(security.collectWarnings ? { collectWarnings: security.collectWarnings } : {}),
    ...(security.collectAuditFindings
      ? { collectAuditFindings: security.collectAuditFindings }
      : {}),
  };
}

function resolveChatChannelPairing(
  pairing: ChannelPairingAdapter | ChatChannelPairingOptions,
): ChannelPairingAdapter {
  return "text" in pairing ? createTextPairingAdapter(pairing.text) : pairing;
}

function resolveChatChannelThreading<TResolvedAccount>(
  threading: ChannelThreadingAdapter | ChatChannelThreadingOptions<TResolvedAccount>,
): ChannelThreadingAdapter {
  if (!("topLevelReplyToMode" in threading) && !("scopedAccountReplyToMode" in threading)) {
    return threading;
  }

  const resolveReplyToMode =
    "topLevelReplyToMode" in threading
      ? createTopLevelChannelReplyToModeResolver(threading.topLevelReplyToMode)
      : createScopedAccountReplyToModeResolver<TResolvedAccount>(
          threading.scopedAccountReplyToMode,
        );
  return {
    ...threading,
    resolveReplyToMode,
  };
}

function resolveChatChannelOutbound(
  outbound: ChannelOutboundAdapter | ChatChannelAttachedOutboundOptions,
): ChannelOutboundAdapter {
  if (!("attachedResults" in outbound)) {
    return outbound;
  }
  return {
    ...outbound.base,
    ...createAttachedChannelResultAdapter(outbound.attachedResults),
  };
}

/**
 * Build a chat-style channel plugin by composing common security, pairing,
 * threading, and outbound adapters around a channel-specific base.
 */
export function createChatChannelPlugin<
  TResolvedAccount extends { accountId?: string | null },
  Probe = unknown,
  Audit = unknown,
  GatewayVersion extends 1 | 2 = 1,
>(params: {
  base: ChatChannelPluginBase<ChannelPlugin<TResolvedAccount, Probe, Audit, GatewayVersion>>;
  security?:
    | ChannelSecurityAdapter<TResolvedAccount>
    | ChatChannelSecurityOptions<TResolvedAccount>;
  pairing?: ChannelPairingAdapter | ChatChannelPairingOptions;
  threading?: ChannelThreadingAdapter | ChatChannelThreadingOptions<TResolvedAccount>;
  outbound?: ChannelOutboundAdapter | ChatChannelAttachedOutboundOptions;
}): ChannelPlugin<TResolvedAccount, Probe, Audit, GatewayVersion> {
  return {
    ...params.base,
    capabilities: params.base.capabilities ?? { chatTypes: ["direct"] },
    conversationBindings: {
      supportsCurrentConversationBinding: true,
      ...params.base.conversationBindings,
    },
    ...(params.security ? { security: resolveChatChannelSecurity(params.security) } : {}),
    ...(params.pairing ? { pairing: resolveChatChannelPairing(params.pairing) } : {}),
    ...(params.threading ? { threading: resolveChatChannelThreading(params.threading) } : {}),
    ...(params.outbound ? { outbound: resolveChatChannelOutbound(params.outbound) } : {}),
  };
}

/** Create the shared base object for channel plugins that override only selected surfaces. */
export function createChannelPluginBase<TResolvedAccount>(
  params: CreateChannelPluginBaseOptions<TResolvedAccount>,
): CreatedChannelPluginBase<TResolvedAccount> {
  return {
    id: params.id,
    meta: {
      ...findChatChannelMeta(params.id as ChatChannelId),
      ...params.meta,
      id: params.id,
    },
    ...(params.setupWizard ? { setupWizard: params.setupWizard } : {}),
    ...(params.capabilities ? { capabilities: params.capabilities } : {}),
    ...(params.commands ? { commands: params.commands } : {}),
    ...(params.doctor ? { doctor: params.doctor } : {}),
    ...(params.agentPrompt ? { agentPrompt: params.agentPrompt } : {}),
    ...(params.streaming ? { streaming: params.streaming } : {}),
    ...(params.reload ? { reload: params.reload } : {}),
    ...(params.gatewayMethods ? { gatewayMethods: params.gatewayMethods } : {}),
    ...(params.gatewayMethodDescriptors
      ? { gatewayMethodDescriptors: params.gatewayMethodDescriptors }
      : {}),
    ...(params.configSchema ? { configSchema: params.configSchema } : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.security ? { security: params.security } : {}),
    ...(params.groups ? { groups: params.groups } : {}),
    ...(params.setup ? { setup: params.setup } : {}),
    ...(params.setupContract ? { setupContract: params.setupContract } : {}),
  } as CreatedChannelPluginBase<TResolvedAccount>;
}

export type {
  ChannelGatewayContextV2,
  ChannelGatewayAdapterV2,
} from "../channels/plugins/types.adapters.js";

export {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  recoverCurrentThreadSessionId,
  type ChannelOutboundSessionRouteParams,
  type ThreadAwareOutboundSessionRouteThreadSource,
  type ThreadAwareOutboundSessionRouteRecoveryContext,
} from "./thread-aware-outbound-session-route.js";
