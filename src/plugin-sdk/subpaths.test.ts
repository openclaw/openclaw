import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import type {
  ChannelMessageActionContext as CoreChannelMessageActionContext,
  OpenClawPluginApi as CoreOpenClawPluginApi,
  PluginRuntime as CorePluginRuntime,
} from "openclaw/plugin-sdk/core";
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

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SDK_DIR = resolve(ROOT_DIR, "plugin-sdk");
const sourceCache = new Map<string, string>();
const representativeRuntimeSmokeSubpaths = [
  "channel-runtime",
  "conversation-runtime",
  "core",
  "discord",
  "provider-auth",
  "provider-setup",
  "setup",
  "webhook-ingress",
] as const;

const importPluginSdkSubpath = (specifier: string) => import(/* @vite-ignore */ specifier);

function readPluginSdkSource(subpath: string): string {
  const file = resolve(PLUGIN_SDK_DIR, `${subpath}.ts`);
  const cached = sourceCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const text = readFileSync(file, "utf8");
  sourceCache.set(file, text);
  return text;
}

function isIdentifierCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 36 ||
    code === 95
  );
}

function sourceMentionsIdentifier(source: string, name: string): boolean {
  let fromIndex = 0;
  while (true) {
    const matchIndex = source.indexOf(name, fromIndex);
    if (matchIndex === -1) {
      return false;
    }
    const beforeCode = matchIndex === 0 ? -1 : source.charCodeAt(matchIndex - 1);
    const afterIndex = matchIndex + name.length;
    const afterCode = afterIndex >= source.length ? -1 : source.charCodeAt(afterIndex);
    if (!isIdentifierCode(beforeCode) && !isIdentifierCode(afterCode)) {
      return true;
    }
    fromIndex = matchIndex + 1;
  }
}

function expectSourceMentions(subpath: string, names: readonly string[]) {
  const source = readPluginSdkSource(subpath);
  for (const name of names) {
    expect(sourceMentionsIdentifier(source, name), `${subpath} should mention ${name}`).toBe(true);
  }
}

function expectSourceOmits(subpath: string, names: readonly string[]) {
  const source = readPluginSdkSource(subpath);
  for (const name of names) {
    expect(sourceMentionsIdentifier(source, name), `${subpath} should not mention ${name}`).toBe(
      false,
    );
  }
}

describe("plugin-sdk subpath exports", () => {
  it("keeps the curated public list free of internal implementation subpaths", () => {
    expect(pluginSdkSubpaths).not.toContain("acpx");
    expect(pluginSdkSubpaths).not.toContain("compat");
    expect(pluginSdkSubpaths).not.toContain("device-pair");
    expect(pluginSdkSubpaths).not.toContain("google");
    expect(pluginSdkSubpaths).not.toContain("lobster");
    expect(pluginSdkSubpaths).not.toContain("pairing-access");
    expect(pluginSdkSubpaths).not.toContain("qwen-portal-auth");
    expect(pluginSdkSubpaths).not.toContain("reply-prefix");
    expect(pluginSdkSubpaths).not.toContain("signal-core");
    expect(pluginSdkSubpaths).not.toContain("synology-chat");
    expect(pluginSdkSubpaths).not.toContain("typing");
    expect(pluginSdkSubpaths).not.toContain("whatsapp");
    expect(pluginSdkSubpaths).not.toContain("whatsapp-action-runtime");
    expect(pluginSdkSubpaths).not.toContain("whatsapp-login-qr");
    expect(pluginSdkSubpaths).not.toContain("secret-input-runtime");
    expect(pluginSdkSubpaths).not.toContain("secret-input-schema");
    expect(pluginSdkSubpaths).not.toContain("zai");
    expect(pluginSdkSubpaths).not.toContain("provider-model-definitions");
  });

  it("keeps core focused on generic shared exports", () => {
    expectSourceMentions("core", [
      "emptyPluginConfigSchema",
      "definePluginEntry",
      "defineChannelPluginEntry",
      "defineSetupPluginEntry",
      "createChatChannelPlugin",
      "createChannelPluginBase",
      "isSecretRef",
      "optionalStringEnum",
    ]);
    expectSourceOmits("core", [
      "runPassiveAccountLifecycle",
      "createLoggerBackedRuntime",
      "registerSandboxBackend",
    ]);
  });

  it("re-exports the canonical plugin entry helper from core", async () => {
    const [coreSdk, pluginEntrySdk] = await Promise.all([
      importPluginSdkSubpath("openclaw/plugin-sdk/core"),
      importPluginSdkSubpath("openclaw/plugin-sdk/plugin-entry"),
    ]);
    expect(coreSdk.definePluginEntry).toBe(pluginEntrySdk.definePluginEntry);
  });

  it("keeps generic helper subpaths aligned", () => {
    expectSourceMentions("routing", ["buildAgentSessionKey", "resolveThreadSessionKeys"]);
    expectSourceMentions("reply-payload", [
      "buildMediaPayload",
      "deliverTextOrMediaReply",
      "resolveOutboundMediaUrls",
      "resolvePayloadMediaUrls",
      "sendPayloadMediaSequenceAndFinalize",
      "sendPayloadMediaSequenceOrFallback",
      "sendTextMediaPayload",
      "sendPayloadWithChunkedTextAndMedia",
    ]);
    expectSourceMentions("media-runtime", [
      "createDirectTextMediaOutbound",
      "createScopedChannelMediaMaxBytesResolver",
    ]);
    expectSourceMentions("reply-history", [
      "buildPendingHistoryContextFromMap",
      "clearHistoryEntriesIfEnabled",
      "recordPendingHistoryEntryIfEnabled",
    ]);
    expectSourceOmits("reply-runtime", [
      "buildPendingHistoryContextFromMap",
      "clearHistoryEntriesIfEnabled",
      "recordPendingHistoryEntryIfEnabled",
      "DEFAULT_GROUP_HISTORY_LIMIT",
    ]);
    expectSourceMentions("account-helpers", ["createAccountListHelpers"]);
    expectSourceMentions("device-bootstrap", [
      "approveDevicePairing",
      "issueDeviceBootstrapToken",
      "listDevicePairing",
    ]);
    expectSourceMentions("allowlist-config-edit", [
      "buildDmGroupAccountAllowlistAdapter",
      "createNestedAllowlistOverrideResolver",
    ]);
    expectSourceMentions("allow-from", [
      "addAllowlistUserEntriesFromConfigEntry",
      "buildAllowlistResolutionSummary",
      "canonicalizeAllowlistWithResolvedIds",
      "mapAllowlistResolutionInputs",
      "mergeAllowlist",
      "patchAllowlistUsersInConfigEntries",
      "summarizeMapping",
    ]);
    expectSourceMentions("allow-from", [
      "compileAllowlist",
      "firstDefined",
      "formatAllowlistMatchMeta",
      "isSenderIdAllowed",
      "mergeDmAllowFromSources",
      "resolveAllowlistMatchSimple",
    ]);
    expectSourceMentions("runtime", ["createLoggerBackedRuntime"]);
    expectSourceMentions("discord", [
      "buildDiscordComponentMessage",
      "editDiscordComponentMessage",
      "registerBuiltDiscordComponentMessage",
      "resolveDiscordAccount",
    ]);
    expectSourceMentions("routing", ["normalizeMessageChannel", "resolveGatewayMessageChannel"]);
    expectSourceMentions("conversation-runtime", [
      "recordInboundSession",
      "recordInboundSessionMetaSafe",
      "resolveConversationLabel",
    ]);
    expectSourceMentions("directory-runtime", [
      "createChannelDirectoryAdapter",
      "createRuntimeDirectoryLiveAdapter",
      "listDirectoryEntriesFromSources",
      "listResolvedDirectoryEntriesFromSources",
    ]);
  });

  it("exports infra runtime helpers from the dedicated subpath", async () => {
    const infraRuntimeSdk = await importPluginSdkSubpath("openclaw/plugin-sdk/infra-runtime");
    expect(typeof infraRuntimeSdk.createRuntimeOutboundDelegates).toBe("function");
    expect(typeof infraRuntimeSdk.resolveOutboundSendDep).toBe("function");
  });

  it("exports channel runtime helpers from the dedicated subpath", () => {
    expectSourceOmits("channel-runtime", [
      "applyChannelMatchMeta",
      "createChannelDirectoryAdapter",
      "createEmptyChannelDirectoryAdapter",
      "createArmableStallWatchdog",
      "createDraftStreamLoop",
      "createLoggedPairingApprovalNotifier",
      "createPairingPrefixStripper",
      "createRunStateMachine",
      "createRuntimeDirectoryLiveAdapter",
      "createRuntimeOutboundDelegates",
      "createStatusReactionController",
      "createTextPairingAdapter",
      "createFinalizableDraftLifecycle",
      "DEFAULT_EMOJIS",
      "logAckFailure",
      "logTypingFailure",
      "logInboundDrop",
      "normalizeMessageChannel",
      "removeAckReactionAfterReply",
      "recordInboundSession",
      "recordInboundSessionMetaSafe",
      "resolveInboundSessionEnvelopeContext",
      "resolveMentionGating",
      "resolveMentionGatingWithBypass",
      "resolveOutboundSendDep",
      "resolveConversationLabel",
      "shouldDebounceTextInbound",
      "shouldAckReaction",
      "shouldAckReactionForWhatsApp",
      "toLocationContext",
      "resolveThreadBindingConversationIdFromBindingId",
      "resolveThreadBindingEffectiveExpiresAt",
      "resolveThreadBindingFarewellText",
      "resolveThreadBindingIdleTimeoutMs",
      "resolveThreadBindingIdleTimeoutMsForChannel",
      "resolveThreadBindingIntroText",
      "resolveThreadBindingLifecycle",
      "resolveThreadBindingMaxAgeMs",
      "resolveThreadBindingMaxAgeMsForChannel",
      "resolveThreadBindingSpawnPolicy",
      "resolveThreadBindingThreadName",
      "resolveThreadBindingsEnabled",
      "formatThreadBindingDisabledError",
      "DISCORD_THREAD_BINDING_CHANNEL",
      "MATRIX_THREAD_BINDING_CHANNEL",
      "resolveControlCommandGate",
      "resolveCommandAuthorizedFromAuthorizers",
      "resolveDualTextControlCommandGate",
      "resolveNativeCommandSessionTargets",
      "attachChannelToResult",
      "buildComputedAccountStatusSnapshot",
      "buildMediaPayload",
      "createActionGate",
      "jsonResult",
      "normalizeInteractiveReply",
      "PAIRING_APPROVED_MESSAGE",
      "projectCredentialSnapshotFields",
      "readStringParam",
      "compileAllowlist",
      "formatAllowlistMatchMeta",
      "firstDefined",
      "isSenderIdAllowed",
      "mergeDmAllowFromSources",
      "addAllowlistUserEntriesFromConfigEntry",
      "buildAllowlistResolutionSummary",
      "canonicalizeAllowlistWithResolvedIds",
      "mergeAllowlist",
      "patchAllowlistUsersInConfigEntries",
      "resolveChannelConfigWrites",
      "resolvePayloadMediaUrls",
      "resolveScopedChannelMediaMaxBytes",
      "sendPayloadMediaSequenceAndFinalize",
      "sendPayloadMediaSequenceOrFallback",
      "sendTextMediaPayload",
      "createScopedChannelMediaMaxBytesResolver",
      "runPassiveAccountLifecycle",
      "buildChannelKeyCandidates",
      "buildMessagingTarget",
      "createDirectTextMediaOutbound",
      "createMessageToolButtonsSchema",
      "createMessageToolCardSchema",
      "createScopedAccountReplyToModeResolver",
      "createStaticReplyToModeResolver",
      "createTopLevelChannelReplyToModeResolver",
      "createUnionActionGate",
      "ensureTargetId",
      "listTokenSourcedAccounts",
      "parseMentionPrefixOrAtUserTarget",
      "requireTargetKind",
      "resolveChannelEntryMatchWithFallback",
      "resolveChannelMatchConfig",
      "resolveReactionMessageId",
      "resolveTargetsWithOptionalToken",
      "appendMatchMetadata",
      "asString",
      "collectIssuesForEnabledAccounts",
      "isRecord",
      "resolveEnabledConfiguredAccountId",
    ]);
  });

  it("keeps channel helper subpaths aligned", () => {
    expectSourceMentions("channel-inbound", [
      "buildMentionRegexes",
      "createChannelInboundDebouncer",
      "createInboundDebouncer",
      "formatInboundEnvelope",
      "formatInboundFromLabel",
      "formatLocationText",
      "logInboundDrop",
      "matchesMentionPatterns",
      "matchesMentionWithExplicit",
      "normalizeMentionText",
      "resolveInboundDebounceMs",
      "resolveEnvelopeFormatOptions",
      "resolveInboundSessionEnvelopeContext",
      "resolveMentionGating",
      "resolveMentionGatingWithBypass",
      "shouldDebounceTextInbound",
      "toLocationContext",
    ]);
    expectSourceOmits("reply-runtime", [
      "buildMentionRegexes",
      "createInboundDebouncer",
      "formatInboundEnvelope",
      "formatInboundFromLabel",
      "matchesMentionPatterns",
      "matchesMentionWithExplicit",
      "normalizeMentionText",
      "resolveEnvelopeFormatOptions",
      "resolveInboundDebounceMs",
    ]);
    expectSourceMentions("channel-setup", [
      "createOptionalChannelSetupSurface",
      "createTopLevelChannelDmPolicy",
    ]);
    expectSourceMentions("channel-actions", [
      "createUnionActionGate",
      "listTokenSourcedAccounts",
      "resolveReactionMessageId",
    ]);
    expectSourceMentions("channel-targets", [
      "applyChannelMatchMeta",
      "buildChannelKeyCandidates",
      "buildMessagingTarget",
      "ensureTargetId",
      "parseMentionPrefixOrAtUserTarget",
      "requireTargetKind",
      "resolveChannelEntryMatchWithFallback",
      "resolveChannelMatchConfig",
      "resolveTargetsWithOptionalToken",
    ]);
    expectSourceMentions("channel-config-helpers", [
      "authorizeConfigWrite",
      "canBypassConfigWritePolicy",
      "formatConfigWriteDeniedMessage",
      "resolveChannelConfigWrites",
    ]);
    expectSourceMentions("channel-feedback", [
      "createStatusReactionController",
      "logAckFailure",
      "logTypingFailure",
      "removeAckReactionAfterReply",
      "shouldAckReaction",
      "shouldAckReactionForWhatsApp",
      "DEFAULT_EMOJIS",
    ]);
    expectSourceMentions("status-helpers", [
      "appendMatchMetadata",
      "asString",
      "collectIssuesForEnabledAccounts",
      "isRecord",
      "resolveEnabledConfiguredAccountId",
    ]);
    expectSourceMentions("channel-actions", [
      "createMessageToolButtonsSchema",
      "createMessageToolCardSchema",
    ]);
    expectSourceMentions("command-auth", [
      "buildCommandTextFromArgs",
      "buildCommandsPaginationKeyboard",
      "buildModelsProviderData",
      "hasControlCommand",
      "listNativeCommandSpecsForConfig",
      "listSkillCommandsForAgents",
      "normalizeCommandBody",
      "resolveCommandAuthorization",
      "resolveCommandAuthorizedFromAuthorizers",
      "resolveControlCommandGate",
      "resolveDualTextControlCommandGate",
      "resolveNativeCommandSessionTargets",
      "resolveStoredModelOverride",
      "shouldComputeCommandAuthorized",
      "shouldHandleTextCommands",
    ]);
    expectSourceOmits("reply-runtime", [
      "hasControlCommand",
      "buildCommandTextFromArgs",
      "buildCommandsPaginationKeyboard",
      "buildModelsProviderData",
      "listNativeCommandSpecsForConfig",
      "listSkillCommandsForAgents",
      "normalizeCommandBody",
      "resolveCommandAuthorization",
      "resolveStoredModelOverride",
      "shouldComputeCommandAuthorized",
      "shouldHandleTextCommands",
    ]);
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

  it("exports channel lifecycle helpers from the dedicated subpath", async () => {
    const channelLifecycleSdk = await importPluginSdkSubpath(
      "openclaw/plugin-sdk/channel-lifecycle",
    );
    expect(typeof channelLifecycleSdk.createDraftStreamLoop).toBe("function");
    expect(typeof channelLifecycleSdk.createFinalizableDraftLifecycle).toBe("function");
    expect(typeof channelLifecycleSdk.runPassiveAccountLifecycle).toBe("function");
    expect(typeof channelLifecycleSdk.createRunStateMachine).toBe("function");
    expect(typeof channelLifecycleSdk.createArmableStallWatchdog).toBe("function");
  });

  it("exports channel pairing helpers from the dedicated subpath", async () => {
    const channelPairingSdk = await importPluginSdkSubpath("openclaw/plugin-sdk/channel-pairing");
    expectSourceMentions("channel-pairing", [
      "createChannelPairingController",
      "createChannelPairingChallengeIssuer",
      "createLoggedPairingApprovalNotifier",
      "createPairingPrefixStripper",
      "createTextPairingAdapter",
    ]);
    expect("createScopedPairingAccess" in channelPairingSdk).toBe(false);
  });

  it("exports channel reply pipeline helpers from the dedicated subpath", async () => {
    const channelReplyPipelineSdk = await importPluginSdkSubpath(
      "openclaw/plugin-sdk/channel-reply-pipeline",
    );
    expectSourceMentions("channel-reply-pipeline", ["createChannelReplyPipeline"]);
    expect("createTypingCallbacks" in channelReplyPipelineSdk).toBe(false);
    expect("createReplyPrefixContext" in channelReplyPipelineSdk).toBe(false);
    expect("createReplyPrefixOptions" in channelReplyPipelineSdk).toBe(false);
  });

  it("keeps source-only helper subpaths aligned", () => {
    expectSourceMentions("channel-send-result", [
      "attachChannelToResult",
      "buildChannelSendResult",
    ]);

    expectSourceMentions("conversation-runtime", [
      "DISCORD_THREAD_BINDING_CHANNEL",
      "MATRIX_THREAD_BINDING_CHANNEL",
      "formatThreadBindingDisabledError",
      "resolveThreadBindingFarewellText",
      "resolveThreadBindingConversationIdFromBindingId",
      "resolveThreadBindingEffectiveExpiresAt",
      "resolveThreadBindingIdleTimeoutMs",
      "resolveThreadBindingIdleTimeoutMsForChannel",
      "resolveThreadBindingIntroText",
      "resolveThreadBindingLifecycle",
      "resolveThreadBindingMaxAgeMs",
      "resolveThreadBindingMaxAgeMsForChannel",
      "resolveThreadBindingSpawnPolicy",
      "resolveThreadBindingThreadName",
      "resolveThreadBindingsEnabled",
      "formatThreadBindingDurationLabel",
      "createScopedAccountReplyToModeResolver",
      "createStaticReplyToModeResolver",
      "createTopLevelChannelReplyToModeResolver",
    ]);

    expectSourceMentions("thread-bindings-runtime", ["resolveThreadBindingLifecycle"]);
    expectSourceMentions("matrix-runtime-shared", ["formatZonedTimestamp"]);
    expectSourceMentions("ssrf-runtime", [
      "closeDispatcher",
      "createPinnedDispatcher",
      "resolvePinnedHostnameWithPolicy",
      "assertHttpUrlTargetsPrivateNetwork",
      "ssrfPolicyFromAllowPrivateNetwork",
    ]);

    expectSourceMentions("provider-setup", [
      "buildVllmProvider",
      "discoverOpenAICompatibleSelfHostedProvider",
    ]);
    expectSourceMentions("provider-auth", [
      "buildOauthProviderAuthResult",
      "generatePkceVerifierChallenge",
      "toFormUrlEncoded",
    ]);
    expectSourceOmits("core", ["buildOauthProviderAuthResult"]);
    expectSourceMentions("provider-models", [
      "applyOpenAIConfig",
      "buildKilocodeModelDefinition",
      "discoverHuggingfaceModels",
    ]);
    expectSourceOmits("provider-models", [
      "buildMinimaxModelDefinition",
      "buildMoonshotProvider",
      "QIANFAN_BASE_URL",
      "resolveZaiBaseUrl",
    ]);

    expectSourceMentions("setup", [
      "DEFAULT_ACCOUNT_ID",
      "createAllowFromSection",
      "createDelegatedSetupWizardProxy",
      "createTopLevelChannelDmPolicy",
      "mergeAllowFromEntries",
    ]);
    expectSourceMentions("lazy-runtime", ["createLazyRuntimeSurface", "createLazyRuntimeModule"]);
    expectSourceMentions("self-hosted-provider-setup", [
      "buildVllmProvider",
      "buildSglangProvider",
      "configureOpenAICompatibleSelfHostedProviderNonInteractive",
    ]);
    expectSourceMentions("ollama-setup", ["buildOllamaProvider", "configureOllamaNonInteractive"]);
    expectSourceMentions("sandbox", ["registerSandboxBackend", "runPluginCommandWithTimeout"]);

    expectSourceMentions("secret-input", [
      "buildSecretInputSchema",
      "buildOptionalSecretInputSchema",
      "normalizeSecretInputString",
    ]);
    expectSourceOmits("config-runtime", [
      "hasConfiguredSecretInput",
      "normalizeResolvedSecretInputString",
      "normalizeSecretInputString",
    ]);

    expectSourceMentions("webhook-ingress", [
      "registerPluginHttpRoute",
      "resolveWebhookPath",
      "readRequestBodyWithLimit",
      "readJsonWebhookBodyOrReject",
      "requestBodyErrorToText",
      "withResolvedWebhookRequestPipeline",
    ]);
    expectSourceMentions("testing", ["removeAckReactionAfterReply", "shouldAckReaction"]);
  });

  it("exports shared core types used by bundled extensions", () => {
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<OpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<PluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<ChannelMessageActionContext>();
  });

  it("keeps core shared types aligned with the channel prelude", () => {
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<SharedOpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<SharedPluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<SharedChannelMessageActionContext>();
  });

  it("resolves representative curated public subpaths", async () => {
    expect(pluginSdkSubpaths.length).toBeGreaterThan(representativeRuntimeSmokeSubpaths.length);
    for (const id of representativeRuntimeSmokeSubpaths) {
      const mod = await importPluginSdkSubpath(`openclaw/plugin-sdk/${id}`);
      expect(typeof mod).toBe("object");
      expect(mod, `subpath ${id} should resolve`).toBeTruthy();
    }
  });
});
