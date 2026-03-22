import * as allowFromSdk from "openclaw/plugin-sdk/allow-from";
import * as channelActionsSdk from "openclaw/plugin-sdk/channel-actions";
import * as channelConfigHelpersSdk from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  BaseProbeResult as ContractBaseProbeResult,
  BaseTokenResolution as ContractBaseTokenResolution,
  ChannelAgentTool as ContractChannelAgentTool,
  ChannelAccountSnapshot as ContractChannelAccountSnapshot,
  ChannelGroupContext as ContractChannelGroupContext,
  ChannelMessageActionAdapter as ContractChannelMessageActionAdapter,
  ChannelMessageActionContext as ContractChannelMessageActionContext,
  ChannelMessageActionName as ContractChannelMessageActionName,
  ChannelMessageToolDiscovery as ContractChannelMessageToolDiscovery,
  ChannelStatusIssue as ContractChannelStatusIssue,
  ChannelThreadingContext as ContractChannelThreadingContext,
  ChannelThreadingToolContext as ContractChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import * as channelFeedbackSdk from "openclaw/plugin-sdk/channel-feedback";
import * as channelInboundSdk from "openclaw/plugin-sdk/channel-inbound";
import * as channelLifecycleSdk from "openclaw/plugin-sdk/channel-lifecycle";
import * as channelPairingSdk from "openclaw/plugin-sdk/channel-pairing";
import * as channelReplyPipelineSdk from "openclaw/plugin-sdk/channel-reply-pipeline";
import * as channelRuntimeSdk from "openclaw/plugin-sdk/channel-runtime";
import * as channelSendResultSdk from "openclaw/plugin-sdk/channel-send-result";
import * as channelSetupSdk from "openclaw/plugin-sdk/channel-setup";
import * as channelTargetsSdk from "openclaw/plugin-sdk/channel-targets";
import * as commandAuthSdk from "openclaw/plugin-sdk/command-auth";
import * as configRuntimeSdk from "openclaw/plugin-sdk/config-runtime";
import * as conversationRuntimeSdk from "openclaw/plugin-sdk/conversation-runtime";
import * as coreSdk from "openclaw/plugin-sdk/core";
import type {
  ChannelMessageActionContext as CoreChannelMessageActionContext,
  OpenClawPluginApi as CoreOpenClawPluginApi,
  PluginRuntime as CorePluginRuntime,
} from "openclaw/plugin-sdk/core";
import * as directoryRuntimeSdk from "openclaw/plugin-sdk/directory-runtime";
import * as infraRuntimeSdk from "openclaw/plugin-sdk/infra-runtime";
import * as lazyRuntimeSdk from "openclaw/plugin-sdk/lazy-runtime";
import * as matrixRuntimeSharedSdk from "openclaw/plugin-sdk/matrix-runtime-shared";
import * as mediaRuntimeSdk from "openclaw/plugin-sdk/media-runtime";
import * as ollamaSetupSdk from "openclaw/plugin-sdk/ollama-setup";
import * as providerAuthSdk from "openclaw/plugin-sdk/provider-auth";
import * as providerModelsSdk from "openclaw/plugin-sdk/provider-models";
import * as providerSetupSdk from "openclaw/plugin-sdk/provider-setup";
import * as replyHistorySdk from "openclaw/plugin-sdk/reply-history";
import * as replyPayloadSdk from "openclaw/plugin-sdk/reply-payload";
import * as replyRuntimeSdk from "openclaw/plugin-sdk/reply-runtime";
import * as routingSdk from "openclaw/plugin-sdk/routing";
import * as runtimeSdk from "openclaw/plugin-sdk/runtime";
import * as sandboxSdk from "openclaw/plugin-sdk/sandbox";
import * as secretInputSdk from "openclaw/plugin-sdk/secret-input";
import * as selfHostedProviderSetupSdk from "openclaw/plugin-sdk/self-hosted-provider-setup";
import * as setupSdk from "openclaw/plugin-sdk/setup";
import * as ssrfRuntimeSdk from "openclaw/plugin-sdk/ssrf-runtime";
import * as testingSdk from "openclaw/plugin-sdk/testing";
import * as threadBindingsRuntimeSdk from "openclaw/plugin-sdk/thread-bindings-runtime";
import * as webhookIngressSdk from "openclaw/plugin-sdk/webhook-ingress";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChannelMessageActionContext } from "../channels/plugins/types.js";
import type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelAgentTool,
  ChannelAccountSnapshot,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelStatusIssue,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "../channels/plugins/types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import type {
  ChannelMessageActionContext as SharedChannelMessageActionContext,
  OpenClawPluginApi as SharedOpenClawPluginApi,
  PluginRuntime as SharedPluginRuntime,
} from "./channel-plugin-common.js";
import { pluginSdkSubpaths } from "./entrypoints.js";

const importPluginSdkSubpath = (specifier: string) => import(/* @vite-ignore */ specifier);

const bundledExtensionSubpathLoaders = pluginSdkSubpaths.map((id: string) => ({
  id,
  load: () => importPluginSdkSubpath(`openclaw/plugin-sdk/${id}`),
}));

const asExports = (mod: object) => mod as Record<string, unknown>;
const accountHelpersSdk = await import("openclaw/plugin-sdk/account-helpers");
const allowlistEditSdk = await import("openclaw/plugin-sdk/allowlist-config-edit");
const statusHelpersSdk = await import("openclaw/plugin-sdk/status-helpers");

describe("plugin-sdk subpath exports", () => {
  it("keeps the curated public list free of internal implementation subpaths", () => {
    expect(pluginSdkSubpaths).not.toContain("acpx");
    expect(pluginSdkSubpaths).not.toContain("bluebubbles");
    expect(pluginSdkSubpaths).not.toContain("compat");
    expect(pluginSdkSubpaths).not.toContain("device-pair");
    expect(pluginSdkSubpaths).not.toContain("discord");
    expect(pluginSdkSubpaths).not.toContain("feishu");
    expect(pluginSdkSubpaths).not.toContain("google");
    expect(pluginSdkSubpaths).not.toContain("googlechat");
    expect(pluginSdkSubpaths).not.toContain("imessage");
    expect(pluginSdkSubpaths).not.toContain("irc");
    expect(pluginSdkSubpaths).not.toContain("imessage-core");
    expect(pluginSdkSubpaths).not.toContain("line");
    expect(pluginSdkSubpaths).not.toContain("line-core");
    expect(pluginSdkSubpaths).not.toContain("lobster");
    expect(pluginSdkSubpaths).not.toContain("mattermost");
    expect(pluginSdkSubpaths).not.toContain("matrix");
    expect(pluginSdkSubpaths).not.toContain("msteams");
    expect(pluginSdkSubpaths).not.toContain("nextcloud-talk");
    expect(pluginSdkSubpaths).not.toContain("nostr");
    expect(pluginSdkSubpaths).not.toContain("pairing-access");
    expect(pluginSdkSubpaths).not.toContain("qwen-portal-auth");
    expect(pluginSdkSubpaths).not.toContain("reply-prefix");
    expect(pluginSdkSubpaths).not.toContain("signal-core");
    expect(pluginSdkSubpaths).not.toContain("slack");
    expect(pluginSdkSubpaths).not.toContain("synology-chat");
    expect(pluginSdkSubpaths).not.toContain("telegram");
    expect(pluginSdkSubpaths).not.toContain("telegram-core");
    expect(pluginSdkSubpaths).not.toContain("tlon");
    expect(pluginSdkSubpaths).not.toContain("twitch");
    expect(pluginSdkSubpaths).not.toContain("typing");
    expect(pluginSdkSubpaths).not.toContain("voice-call");
    expect(pluginSdkSubpaths).not.toContain("whatsapp");
    expect(pluginSdkSubpaths).not.toContain("whatsapp-action-runtime");
    expect(pluginSdkSubpaths).not.toContain("whatsapp-core");
    expect(pluginSdkSubpaths).not.toContain("whatsapp-login-qr");
    expect(pluginSdkSubpaths).not.toContain("whatsapp-shared");
    expect(pluginSdkSubpaths).not.toContain("secret-input-runtime");
    expect(pluginSdkSubpaths).not.toContain("secret-input-schema");
    expect(pluginSdkSubpaths).not.toContain("zai");
    expect(pluginSdkSubpaths).not.toContain("discord-core");
    expect(pluginSdkSubpaths).not.toContain("provider-model-definitions");
  });

  it("keeps core focused on generic shared exports", () => {
    expect(typeof coreSdk.emptyPluginConfigSchema).toBe("function");
    expect(typeof coreSdk.definePluginEntry).toBe("function");
    expect(typeof coreSdk.defineChannelPluginEntry).toBe("function");
    expect(typeof coreSdk.defineSetupPluginEntry).toBe("function");
    expect(typeof coreSdk.createChannelPluginBase).toBe("function");
    expect(typeof coreSdk.isSecretRef).toBe("function");
    expect(typeof coreSdk.optionalStringEnum).toBe("function");
    expect("runPassiveAccountLifecycle" in asExports(coreSdk)).toBe(false);
    expect("createLoggerBackedRuntime" in asExports(coreSdk)).toBe(false);
    expect("registerSandboxBackend" in asExports(coreSdk)).toBe(false);
  });

  it("exports routing helpers from the dedicated subpath", () => {
    expect(typeof routingSdk.buildAgentSessionKey).toBe("function");
    expect(typeof routingSdk.resolveThreadSessionKeys).toBe("function");
  });

  it("exports reply payload helpers from the dedicated subpath", () => {
    expect(typeof replyPayloadSdk.buildMediaPayload).toBe("function");
    expect(typeof replyPayloadSdk.deliverTextOrMediaReply).toBe("function");
    expect(typeof replyPayloadSdk.resolveOutboundMediaUrls).toBe("function");
    expect(typeof replyPayloadSdk.resolvePayloadMediaUrls).toBe("function");
    expect(typeof replyPayloadSdk.sendPayloadMediaSequenceAndFinalize).toBe("function");
    expect(typeof replyPayloadSdk.sendPayloadMediaSequenceOrFallback).toBe("function");
    expect(typeof replyPayloadSdk.sendTextMediaPayload).toBe("function");
    expect(typeof replyPayloadSdk.sendPayloadWithChunkedTextAndMedia).toBe("function");
  });

  it("exports media runtime helpers from the dedicated subpath", () => {
    expect(typeof mediaRuntimeSdk.createDirectTextMediaOutbound).toBe("function");
    expect(typeof mediaRuntimeSdk.createScopedChannelMediaMaxBytesResolver).toBe("function");
  });

  it("exports reply history helpers from the dedicated subpath", () => {
    expect(typeof replyHistorySdk.buildPendingHistoryContextFromMap).toBe("function");
    expect(typeof replyHistorySdk.clearHistoryEntriesIfEnabled).toBe("function");
    expect(typeof replyHistorySdk.recordPendingHistoryEntryIfEnabled).toBe("function");
    expect("buildPendingHistoryContextFromMap" in asExports(replyRuntimeSdk)).toBe(false);
    expect("clearHistoryEntriesIfEnabled" in asExports(replyRuntimeSdk)).toBe(false);
    expect("recordPendingHistoryEntryIfEnabled" in asExports(replyRuntimeSdk)).toBe(false);
    expect("DEFAULT_GROUP_HISTORY_LIMIT" in asExports(replyRuntimeSdk)).toBe(false);
  });

  it("exports account helper builders from the dedicated subpath", () => {
    expect(typeof accountHelpersSdk.createAccountListHelpers).toBe("function");
  });

  it("exports device bootstrap helpers from the dedicated subpath", async () => {
    const deviceBootstrapSdk = await import("openclaw/plugin-sdk/device-bootstrap");
    expect(typeof deviceBootstrapSdk.approveDevicePairing).toBe("function");
    expect(typeof deviceBootstrapSdk.issueDeviceBootstrapToken).toBe("function");
    expect(typeof deviceBootstrapSdk.listDevicePairing).toBe("function");
  });

  it("exports allowlist edit helpers from the dedicated subpath", () => {
    expect(typeof allowlistEditSdk.buildDmGroupAccountAllowlistAdapter).toBe("function");
    expect(typeof allowlistEditSdk.createNestedAllowlistOverrideResolver).toBe("function");
  });

  it("exports allowlist resolution helpers from the dedicated subpath", () => {
    expect(typeof allowFromSdk.addAllowlistUserEntriesFromConfigEntry).toBe("function");
    expect(typeof allowFromSdk.buildAllowlistResolutionSummary).toBe("function");
    expect(typeof allowFromSdk.canonicalizeAllowlistWithResolvedIds).toBe("function");
    expect(typeof allowFromSdk.mapAllowlistResolutionInputs).toBe("function");
    expect(typeof allowFromSdk.mergeAllowlist).toBe("function");
    expect(typeof allowFromSdk.patchAllowlistUsersInConfigEntries).toBe("function");
    expect(typeof allowFromSdk.summarizeMapping).toBe("function");
  });

  it("exports allow-from matching helpers from the dedicated subpath", () => {
    expect(typeof allowFromSdk.compileAllowlist).toBe("function");
    expect(typeof allowFromSdk.firstDefined).toBe("function");
    expect(typeof allowFromSdk.formatAllowlistMatchMeta).toBe("function");
    expect(typeof allowFromSdk.isSenderIdAllowed).toBe("function");
    expect(typeof allowFromSdk.mergeDmAllowFromSources).toBe("function");
    expect(typeof allowFromSdk.resolveAllowlistMatchSimple).toBe("function");
  });

  it("exports runtime helpers from the dedicated subpath", () => {
    expect(typeof runtimeSdk.createLoggerBackedRuntime).toBe("function");
  });

  it("exports channel identity and session helpers from stronger existing homes", () => {
    expect(typeof routingSdk.normalizeMessageChannel).toBe("function");
    expect(typeof routingSdk.resolveGatewayMessageChannel).toBe("function");
    expect(typeof conversationRuntimeSdk.recordInboundSession).toBe("function");
    expect(typeof conversationRuntimeSdk.recordInboundSessionMetaSafe).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveConversationLabel).toBe("function");
  });

  it("exports directory runtime helpers from the dedicated subpath", () => {
    expect(typeof directoryRuntimeSdk.createChannelDirectoryAdapter).toBe("function");
    expect(typeof directoryRuntimeSdk.createRuntimeDirectoryLiveAdapter).toBe("function");
    expect(typeof directoryRuntimeSdk.listDirectoryEntriesFromSources).toBe("function");
    expect(typeof directoryRuntimeSdk.listResolvedDirectoryEntriesFromSources).toBe("function");
  });

  it("exports infra runtime helpers from the dedicated subpath", () => {
    expect(typeof infraRuntimeSdk.createRuntimeOutboundDelegates).toBe("function");
    expect(typeof infraRuntimeSdk.resolveOutboundSendDep).toBe("function");
  });

  it("exports channel runtime helpers from the dedicated subpath", () => {
    expect("applyChannelMatchMeta" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createChannelDirectoryAdapter" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createEmptyChannelDirectoryAdapter" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createArmableStallWatchdog" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createDraftStreamLoop" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createLoggedPairingApprovalNotifier" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createPairingPrefixStripper" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createRunStateMachine" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createRuntimeDirectoryLiveAdapter" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createRuntimeOutboundDelegates" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createStatusReactionController" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createTextPairingAdapter" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createFinalizableDraftLifecycle" in asExports(channelRuntimeSdk)).toBe(false);
    expect("DEFAULT_EMOJIS" in asExports(channelRuntimeSdk)).toBe(false);
    expect("logAckFailure" in asExports(channelRuntimeSdk)).toBe(false);
    expect("logTypingFailure" in asExports(channelRuntimeSdk)).toBe(false);
    expect("logInboundDrop" in asExports(channelRuntimeSdk)).toBe(false);
    expect("normalizeMessageChannel" in asExports(channelRuntimeSdk)).toBe(false);
    expect("removeAckReactionAfterReply" in asExports(channelRuntimeSdk)).toBe(false);
    expect("recordInboundSession" in asExports(channelRuntimeSdk)).toBe(false);
    expect("recordInboundSessionMetaSafe" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveInboundSessionEnvelopeContext" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveMentionGating" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveMentionGatingWithBypass" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveOutboundSendDep" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveConversationLabel" in asExports(channelRuntimeSdk)).toBe(false);
    expect("shouldDebounceTextInbound" in asExports(channelRuntimeSdk)).toBe(false);
    expect("shouldAckReaction" in asExports(channelRuntimeSdk)).toBe(false);
    expect("shouldAckReactionForWhatsApp" in asExports(channelRuntimeSdk)).toBe(false);
    expect("toLocationContext" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveThreadBindingConversationIdFromBindingId" in asExports(channelRuntimeSdk)).toBe(
      false,
    );
    expect("resolveThreadBindingEffectiveExpiresAt" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveThreadBindingFarewellText" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveThreadBindingIdleTimeoutMs" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveThreadBindingIdleTimeoutMsForChannel" in asExports(channelRuntimeSdk)).toBe(
      false,
    );
    expect("resolveThreadBindingIntroText" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveThreadBindingLifecycle" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveThreadBindingMaxAgeMs" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveThreadBindingMaxAgeMsForChannel" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveThreadBindingSpawnPolicy" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveThreadBindingThreadName" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveThreadBindingsEnabled" in asExports(channelRuntimeSdk)).toBe(false);
    expect("formatThreadBindingDisabledError" in asExports(channelRuntimeSdk)).toBe(false);
    expect("DISCORD_THREAD_BINDING_CHANNEL" in asExports(channelRuntimeSdk)).toBe(false);
    expect("MATRIX_THREAD_BINDING_CHANNEL" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveControlCommandGate" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveCommandAuthorizedFromAuthorizers" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveDualTextControlCommandGate" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveNativeCommandSessionTargets" in asExports(channelRuntimeSdk)).toBe(false);
    expect("attachChannelToResult" in asExports(channelRuntimeSdk)).toBe(false);
    expect("buildComputedAccountStatusSnapshot" in asExports(channelRuntimeSdk)).toBe(false);
    expect("buildMediaPayload" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createActionGate" in asExports(channelRuntimeSdk)).toBe(false);
    expect("jsonResult" in asExports(channelRuntimeSdk)).toBe(false);
    expect("normalizeInteractiveReply" in asExports(channelRuntimeSdk)).toBe(false);
    expect("PAIRING_APPROVED_MESSAGE" in asExports(channelRuntimeSdk)).toBe(false);
    expect("projectCredentialSnapshotFields" in asExports(channelRuntimeSdk)).toBe(false);
    expect("readStringParam" in asExports(channelRuntimeSdk)).toBe(false);
    expect("compileAllowlist" in asExports(channelRuntimeSdk)).toBe(false);
    expect("formatAllowlistMatchMeta" in asExports(channelRuntimeSdk)).toBe(false);
    expect("firstDefined" in asExports(channelRuntimeSdk)).toBe(false);
    expect("isSenderIdAllowed" in asExports(channelRuntimeSdk)).toBe(false);
    expect("mergeDmAllowFromSources" in asExports(channelRuntimeSdk)).toBe(false);
    expect("addAllowlistUserEntriesFromConfigEntry" in asExports(channelRuntimeSdk)).toBe(false);
    expect("buildAllowlistResolutionSummary" in asExports(channelRuntimeSdk)).toBe(false);
    expect("canonicalizeAllowlistWithResolvedIds" in asExports(channelRuntimeSdk)).toBe(false);
    expect("mergeAllowlist" in asExports(channelRuntimeSdk)).toBe(false);
    expect("patchAllowlistUsersInConfigEntries" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveChannelConfigWrites" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolvePayloadMediaUrls" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveScopedChannelMediaMaxBytes" in asExports(channelRuntimeSdk)).toBe(false);
    expect("sendPayloadMediaSequenceAndFinalize" in asExports(channelRuntimeSdk)).toBe(false);
    expect("sendPayloadMediaSequenceOrFallback" in asExports(channelRuntimeSdk)).toBe(false);
    expect("sendTextMediaPayload" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createScopedChannelMediaMaxBytesResolver" in asExports(channelRuntimeSdk)).toBe(false);
    expect("runPassiveAccountLifecycle" in asExports(channelRuntimeSdk)).toBe(false);
    expect("buildChannelKeyCandidates" in asExports(channelRuntimeSdk)).toBe(false);
    expect("buildMessagingTarget" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createDirectTextMediaOutbound" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createMessageToolButtonsSchema" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createMessageToolCardSchema" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createScopedAccountReplyToModeResolver" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createStaticReplyToModeResolver" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createTopLevelChannelReplyToModeResolver" in asExports(channelRuntimeSdk)).toBe(false);
    expect("createUnionActionGate" in asExports(channelRuntimeSdk)).toBe(false);
    expect("ensureTargetId" in asExports(channelRuntimeSdk)).toBe(false);
    expect("listTokenSourcedAccounts" in asExports(channelRuntimeSdk)).toBe(false);
    expect("parseMentionPrefixOrAtUserTarget" in asExports(channelRuntimeSdk)).toBe(false);
    expect("requireTargetKind" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveChannelEntryMatchWithFallback" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveChannelMatchConfig" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveReactionMessageId" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveTargetsWithOptionalToken" in asExports(channelRuntimeSdk)).toBe(false);
    expect("appendMatchMetadata" in asExports(channelRuntimeSdk)).toBe(false);
    expect("asString" in asExports(channelRuntimeSdk)).toBe(false);
    expect("collectIssuesForEnabledAccounts" in asExports(channelRuntimeSdk)).toBe(false);
    expect("isRecord" in asExports(channelRuntimeSdk)).toBe(false);
    expect("resolveEnabledConfiguredAccountId" in asExports(channelRuntimeSdk)).toBe(false);
  });

  it("exports inbound channel helpers from the dedicated subpath", () => {
    expect(typeof channelInboundSdk.buildMentionRegexes).toBe("function");
    expect(typeof channelInboundSdk.createChannelInboundDebouncer).toBe("function");
    expect(typeof channelInboundSdk.createInboundDebouncer).toBe("function");
    expect(typeof channelInboundSdk.formatInboundEnvelope).toBe("function");
    expect(typeof channelInboundSdk.formatInboundFromLabel).toBe("function");
    expect(typeof channelInboundSdk.formatLocationText).toBe("function");
    expect(typeof channelInboundSdk.logInboundDrop).toBe("function");
    expect(typeof channelInboundSdk.matchesMentionPatterns).toBe("function");
    expect(typeof channelInboundSdk.matchesMentionWithExplicit).toBe("function");
    expect(typeof channelInboundSdk.normalizeMentionText).toBe("function");
    expect(typeof channelInboundSdk.resolveInboundDebounceMs).toBe("function");
    expect(typeof channelInboundSdk.resolveEnvelopeFormatOptions).toBe("function");
    expect(typeof channelInboundSdk.resolveInboundSessionEnvelopeContext).toBe("function");
    expect(typeof channelInboundSdk.resolveMentionGating).toBe("function");
    expect(typeof channelInboundSdk.resolveMentionGatingWithBypass).toBe("function");
    expect(typeof channelInboundSdk.shouldDebounceTextInbound).toBe("function");
    expect(typeof channelInboundSdk.toLocationContext).toBe("function");
    expect("buildMentionRegexes" in asExports(replyRuntimeSdk)).toBe(false);
    expect("createInboundDebouncer" in asExports(replyRuntimeSdk)).toBe(false);
    expect("formatInboundEnvelope" in asExports(replyRuntimeSdk)).toBe(false);
    expect("formatInboundFromLabel" in asExports(replyRuntimeSdk)).toBe(false);
    expect("matchesMentionPatterns" in asExports(replyRuntimeSdk)).toBe(false);
    expect("matchesMentionWithExplicit" in asExports(replyRuntimeSdk)).toBe(false);
    expect("normalizeMentionText" in asExports(replyRuntimeSdk)).toBe(false);
    expect("resolveEnvelopeFormatOptions" in asExports(replyRuntimeSdk)).toBe(false);
    expect("resolveInboundDebounceMs" in asExports(replyRuntimeSdk)).toBe(false);
  });

  it("exports channel setup helpers from the dedicated subpath", () => {
    expect(typeof channelSetupSdk.createOptionalChannelSetupSurface).toBe("function");
    expect(typeof channelSetupSdk.createTopLevelChannelDmPolicy).toBe("function");
  });

  it("exports channel action helpers from the dedicated subpath", () => {
    expect(typeof channelActionsSdk.createUnionActionGate).toBe("function");
    expect(typeof channelActionsSdk.listTokenSourcedAccounts).toBe("function");
    expect(typeof channelActionsSdk.resolveReactionMessageId).toBe("function");
  });

  it("exports channel target helpers from the dedicated subpath", () => {
    expect(typeof channelTargetsSdk.applyChannelMatchMeta).toBe("function");
    expect(typeof channelTargetsSdk.buildChannelKeyCandidates).toBe("function");
    expect(typeof channelTargetsSdk.buildMessagingTarget).toBe("function");
    expect(typeof channelTargetsSdk.ensureTargetId).toBe("function");
    expect(typeof channelTargetsSdk.parseMentionPrefixOrAtUserTarget).toBe("function");
    expect(typeof channelTargetsSdk.requireTargetKind).toBe("function");
    expect(typeof channelTargetsSdk.resolveChannelEntryMatchWithFallback).toBe("function");
    expect(typeof channelTargetsSdk.resolveChannelMatchConfig).toBe("function");
    expect(typeof channelTargetsSdk.resolveTargetsWithOptionalToken).toBe("function");
  });

  it("exports channel config write helpers from the dedicated subpath", () => {
    expect(typeof channelConfigHelpersSdk.authorizeConfigWrite).toBe("function");
    expect(typeof channelConfigHelpersSdk.canBypassConfigWritePolicy).toBe("function");
    expect(typeof channelConfigHelpersSdk.formatConfigWriteDeniedMessage).toBe("function");
    expect(typeof channelConfigHelpersSdk.resolveChannelConfigWrites).toBe("function");
  });

  it("keeps channel contract types on the dedicated subpath", () => {
    expectTypeOf<ContractBaseProbeResult>().toMatchTypeOf<BaseProbeResult>();
    expectTypeOf<ContractBaseTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
    expectTypeOf<ContractChannelAgentTool>().toMatchTypeOf<ChannelAgentTool>();
    expectTypeOf<ContractChannelAccountSnapshot>().toMatchTypeOf<ChannelAccountSnapshot>();
    expectTypeOf<ContractChannelGroupContext>().toMatchTypeOf<ChannelGroupContext>();
    expectTypeOf<ContractChannelMessageActionAdapter>().toMatchTypeOf<ChannelMessageActionAdapter>();
    expectTypeOf<ContractChannelMessageActionContext>().toMatchTypeOf<ChannelMessageActionContext>();
    expectTypeOf<ContractChannelMessageActionName>().toMatchTypeOf<ChannelMessageActionName>();
    expectTypeOf<ContractChannelMessageToolDiscovery>().toMatchTypeOf<ChannelMessageToolDiscovery>();
    expectTypeOf<ContractChannelStatusIssue>().toMatchTypeOf<ChannelStatusIssue>();
    expectTypeOf<ContractChannelThreadingContext>().toMatchTypeOf<ChannelThreadingContext>();
    expectTypeOf<ContractChannelThreadingToolContext>().toMatchTypeOf<ChannelThreadingToolContext>();
  });

  it("exports channel lifecycle helpers from the dedicated subpath", () => {
    expect(typeof channelLifecycleSdk.createDraftStreamLoop).toBe("function");
    expect(typeof channelLifecycleSdk.createFinalizableDraftLifecycle).toBe("function");
    expect(typeof channelLifecycleSdk.runPassiveAccountLifecycle).toBe("function");
    expect(typeof channelLifecycleSdk.createRunStateMachine).toBe("function");
    expect(typeof channelLifecycleSdk.createArmableStallWatchdog).toBe("function");
  });

  it("exports channel feedback helpers from the dedicated subpath", () => {
    expect(typeof channelFeedbackSdk.createStatusReactionController).toBe("function");
    expect(typeof channelFeedbackSdk.logAckFailure).toBe("function");
    expect(typeof channelFeedbackSdk.logTypingFailure).toBe("function");
    expect(typeof channelFeedbackSdk.removeAckReactionAfterReply).toBe("function");
    expect(typeof channelFeedbackSdk.shouldAckReaction).toBe("function");
    expect(typeof channelFeedbackSdk.shouldAckReactionForWhatsApp).toBe("function");
    expect(typeof channelFeedbackSdk.DEFAULT_EMOJIS).toBe("object");
  });

  it("exports status helper utilities from the dedicated subpath", () => {
    expect(typeof statusHelpersSdk.appendMatchMetadata).toBe("function");
    expect(typeof statusHelpersSdk.asString).toBe("function");
    expect(typeof statusHelpersSdk.collectIssuesForEnabledAccounts).toBe("function");
    expect(typeof statusHelpersSdk.isRecord).toBe("function");
    expect(typeof statusHelpersSdk.resolveEnabledConfiguredAccountId).toBe("function");
  });

  it("exports message tool schema helpers from the dedicated subpath", () => {
    expect(typeof channelActionsSdk.createMessageToolButtonsSchema).toBe("function");
    expect(typeof channelActionsSdk.createMessageToolCardSchema).toBe("function");
  });

  it("exports channel pairing helpers from the dedicated subpath", () => {
    expect(typeof channelPairingSdk.createChannelPairingController).toBe("function");
    expect(typeof channelPairingSdk.createChannelPairingChallengeIssuer).toBe("function");
    expect(typeof channelPairingSdk.createLoggedPairingApprovalNotifier).toBe("function");
    expect(typeof channelPairingSdk.createPairingPrefixStripper).toBe("function");
    expect(typeof channelPairingSdk.createTextPairingAdapter).toBe("function");
    expect("createScopedPairingAccess" in asExports(channelPairingSdk)).toBe(false);
  });

  it("exports channel reply pipeline helpers from the dedicated subpath", () => {
    expect(typeof channelReplyPipelineSdk.createChannelReplyPipeline).toBe("function");
    expect("createTypingCallbacks" in asExports(channelReplyPipelineSdk)).toBe(false);
    expect("createReplyPrefixContext" in asExports(channelReplyPipelineSdk)).toBe(false);
    expect("createReplyPrefixOptions" in asExports(channelReplyPipelineSdk)).toBe(false);
  });

  it("exports command auth helpers from the dedicated subpath", () => {
    expect(typeof commandAuthSdk.buildCommandTextFromArgs).toBe("function");
    expect(typeof commandAuthSdk.buildCommandsPaginationKeyboard).toBe("function");
    expect(typeof commandAuthSdk.buildModelsProviderData).toBe("function");
    expect(typeof commandAuthSdk.hasControlCommand).toBe("function");
    expect(typeof commandAuthSdk.listNativeCommandSpecsForConfig).toBe("function");
    expect(typeof commandAuthSdk.listSkillCommandsForAgents).toBe("function");
    expect(typeof commandAuthSdk.normalizeCommandBody).toBe("function");
    expect(typeof commandAuthSdk.resolveCommandAuthorization).toBe("function");
    expect(typeof commandAuthSdk.resolveCommandAuthorizedFromAuthorizers).toBe("function");
    expect(typeof commandAuthSdk.resolveControlCommandGate).toBe("function");
    expect(typeof commandAuthSdk.resolveDualTextControlCommandGate).toBe("function");
    expect(typeof commandAuthSdk.resolveNativeCommandSessionTargets).toBe("function");
    expect(typeof commandAuthSdk.resolveStoredModelOverride).toBe("function");
    expect(typeof commandAuthSdk.shouldComputeCommandAuthorized).toBe("function");
    expect(typeof commandAuthSdk.shouldHandleTextCommands).toBe("function");
    expect("hasControlCommand" in asExports(replyRuntimeSdk)).toBe(false);
    expect("buildCommandTextFromArgs" in asExports(replyRuntimeSdk)).toBe(false);
    expect("buildCommandsPaginationKeyboard" in asExports(replyRuntimeSdk)).toBe(false);
    expect("buildModelsProviderData" in asExports(replyRuntimeSdk)).toBe(false);
    expect("listNativeCommandSpecsForConfig" in asExports(replyRuntimeSdk)).toBe(false);
    expect("listSkillCommandsForAgents" in asExports(replyRuntimeSdk)).toBe(false);
    expect("normalizeCommandBody" in asExports(replyRuntimeSdk)).toBe(false);
    expect("resolveCommandAuthorization" in asExports(replyRuntimeSdk)).toBe(false);
    expect("resolveStoredModelOverride" in asExports(replyRuntimeSdk)).toBe(false);
    expect("shouldComputeCommandAuthorized" in asExports(replyRuntimeSdk)).toBe(false);
    expect("shouldHandleTextCommands" in asExports(replyRuntimeSdk)).toBe(false);
  });

  it("exports channel send-result helpers from the dedicated subpath", () => {
    expect(typeof channelSendResultSdk.attachChannelToResult).toBe("function");
    expect(typeof channelSendResultSdk.buildChannelSendResult).toBe("function");
  });

  it("exports binding lifecycle helpers from the conversation-runtime subpath", () => {
    expect(typeof conversationRuntimeSdk.DISCORD_THREAD_BINDING_CHANNEL).toBe("string");
    expect(typeof conversationRuntimeSdk.MATRIX_THREAD_BINDING_CHANNEL).toBe("string");
    expect(typeof conversationRuntimeSdk.formatThreadBindingDisabledError).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveThreadBindingFarewellText).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveThreadBindingConversationIdFromBindingId).toBe(
      "function",
    );
    expect(typeof conversationRuntimeSdk.resolveThreadBindingEffectiveExpiresAt).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveThreadBindingIdleTimeoutMs).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveThreadBindingIdleTimeoutMsForChannel).toBe(
      "function",
    );
    expect(typeof conversationRuntimeSdk.resolveThreadBindingIntroText).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveThreadBindingLifecycle).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveThreadBindingMaxAgeMs).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveThreadBindingMaxAgeMsForChannel).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveThreadBindingSpawnPolicy).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveThreadBindingThreadName).toBe("function");
    expect(typeof conversationRuntimeSdk.resolveThreadBindingsEnabled).toBe("function");
    expect(typeof conversationRuntimeSdk.formatThreadBindingDurationLabel).toBe("function");
    expect(typeof conversationRuntimeSdk.createScopedAccountReplyToModeResolver).toBe("function");
    expect(typeof conversationRuntimeSdk.createStaticReplyToModeResolver).toBe("function");
    expect(typeof conversationRuntimeSdk.createTopLevelChannelReplyToModeResolver).toBe("function");
  });

  it("exports narrow binding lifecycle helpers from the dedicated subpath", () => {
    expect(typeof threadBindingsRuntimeSdk.resolveThreadBindingLifecycle).toBe("function");
  });

  it("exports narrow matrix runtime helpers from the dedicated subpath", () => {
    expect(typeof matrixRuntimeSharedSdk.formatZonedTimestamp).toBe("function");
  });

  it("exports narrow ssrf helpers from the dedicated subpath", () => {
    expect(typeof ssrfRuntimeSdk.closeDispatcher).toBe("function");
    expect(typeof ssrfRuntimeSdk.createPinnedDispatcher).toBe("function");
    expect(typeof ssrfRuntimeSdk.resolvePinnedHostnameWithPolicy).toBe("function");
    expect(typeof ssrfRuntimeSdk.assertHttpUrlTargetsPrivateNetwork).toBe("function");
    expect(typeof ssrfRuntimeSdk.ssrfPolicyFromAllowPrivateNetwork).toBe("function");
  });

  it("exports provider setup helpers from the dedicated subpath", () => {
    expect(typeof providerSetupSdk.buildVllmProvider).toBe("function");
    expect(typeof providerSetupSdk.discoverOpenAICompatibleSelfHostedProvider).toBe("function");
  });

  it("exports oauth helpers from provider-auth", () => {
    expect(typeof providerAuthSdk.buildOauthProviderAuthResult).toBe("function");
    expect(typeof providerAuthSdk.generatePkceVerifierChallenge).toBe("function");
    expect(typeof providerAuthSdk.toFormUrlEncoded).toBe("function");
    expect("buildOauthProviderAuthResult" in asExports(coreSdk)).toBe(false);
  });

  it("keeps provider models focused on shared provider primitives", () => {
    expect(typeof providerModelsSdk.applyOpenAIConfig).toBe("function");
    expect(typeof providerModelsSdk.buildKilocodeModelDefinition).toBe("function");
    expect(typeof providerModelsSdk.discoverHuggingfaceModels).toBe("function");
    expect("buildMinimaxModelDefinition" in asExports(providerModelsSdk)).toBe(false);
    expect("buildMoonshotProvider" in asExports(providerModelsSdk)).toBe(false);
    expect("QIANFAN_BASE_URL" in asExports(providerModelsSdk)).toBe(false);
    expect("resolveZaiBaseUrl" in asExports(providerModelsSdk)).toBe(false);
  });

  it("exports shared setup helpers from the dedicated subpath", () => {
    expect(typeof setupSdk.DEFAULT_ACCOUNT_ID).toBe("string");
    expect(typeof setupSdk.createAllowFromSection).toBe("function");
    expect(typeof setupSdk.createDelegatedSetupWizardProxy).toBe("function");
    expect(typeof setupSdk.createTopLevelChannelDmPolicy).toBe("function");
    expect(typeof setupSdk.mergeAllowFromEntries).toBe("function");
  });

  it("exports shared lazy runtime helpers from the dedicated subpath", () => {
    expect(typeof lazyRuntimeSdk.createLazyRuntimeSurface).toBe("function");
    expect(typeof lazyRuntimeSdk.createLazyRuntimeModule).toBe("function");
  });

  it("exports narrow self-hosted provider setup helpers", () => {
    expect(typeof selfHostedProviderSetupSdk.buildVllmProvider).toBe("function");
    expect(typeof selfHostedProviderSetupSdk.buildSglangProvider).toBe("function");
    expect(
      typeof selfHostedProviderSetupSdk.configureOpenAICompatibleSelfHostedProviderNonInteractive,
    ).toBe("function");
  });

  it("exports narrow Ollama setup helpers", () => {
    expect(typeof ollamaSetupSdk.buildOllamaProvider).toBe("function");
    expect(typeof ollamaSetupSdk.configureOllamaNonInteractive).toBe("function");
  });

  it("exports sandbox helpers from the dedicated subpath", () => {
    expect(typeof sandboxSdk.registerSandboxBackend).toBe("function");
    expect(typeof sandboxSdk.runPluginCommandWithTimeout).toBe("function");
  });

  it("exports secret input helpers from the dedicated subpath", () => {
    expect(typeof secretInputSdk.buildSecretInputSchema).toBe("function");
    expect(typeof secretInputSdk.buildOptionalSecretInputSchema).toBe("function");
    expect(typeof secretInputSdk.normalizeSecretInputString).toBe("function");
    expect("hasConfiguredSecretInput" in asExports(configRuntimeSdk)).toBe(false);
    expect("normalizeResolvedSecretInputString" in asExports(configRuntimeSdk)).toBe(false);
    expect("normalizeSecretInputString" in asExports(configRuntimeSdk)).toBe(false);
  });

  it("exports webhook ingress helpers from the dedicated subpath", () => {
    expect(typeof webhookIngressSdk.registerPluginHttpRoute).toBe("function");
    expect(typeof webhookIngressSdk.resolveWebhookPath).toBe("function");
    expect(typeof webhookIngressSdk.readRequestBodyWithLimit).toBe("function");
    expect(typeof webhookIngressSdk.readJsonWebhookBodyOrReject).toBe("function");
    expect(typeof webhookIngressSdk.requestBodyErrorToText).toBe("function");
    expect(typeof webhookIngressSdk.withResolvedWebhookRequestPipeline).toBe("function");
  });

  it("exports shared core types used by bundled extensions", () => {
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<OpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<PluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<ChannelMessageActionContext>();
  });

  it("exports the public testing surface", () => {
    expect(typeof testingSdk.removeAckReactionAfterReply).toBe("function");
    expect(typeof testingSdk.shouldAckReaction).toBe("function");
  });

  it("keeps core shared types aligned with the channel prelude", () => {
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<SharedOpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<SharedPluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<SharedChannelMessageActionContext>();
  });

  it("resolves every curated public subpath", async () => {
    for (const { id, load } of bundledExtensionSubpathLoaders) {
      const mod = await load();
      expect(typeof mod).toBe("object");
      expect(mod, `subpath ${id} should resolve`).toBeTruthy();
    }
  });
});
