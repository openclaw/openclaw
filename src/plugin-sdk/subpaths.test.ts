import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const requireFromHere = createRequire(import.meta.url);
const sourceCache = new Map<string, string>();
const representativeRuntimeSmokeSubpaths = [
  "channel-runtime",
  "conversation-runtime",
  "provider-auth",
  "provider-setup",
  "setup",
  "webhook-ingress",
] as const;

function resolvePluginSdkSourceSpecifier(specifier: string): string {
  const entry =
    specifier === "openclaw/plugin-sdk"
      ? "index"
      : specifier.replace(/^openclaw\/plugin-sdk\//u, "");
  return pathToFileURL(resolve(PLUGIN_SDK_DIR, `${entry}.ts`)).href;
}

async function importResolvedPluginSdkSubpath(specifier: string) {
  let resolved: string;
  try {
    resolved = requireFromHere.resolve(specifier);
  } catch (error) {
    if (specifier.startsWith("openclaw/plugin-sdk")) {
      return import(resolvePluginSdkSourceSpecifier(specifier));
    }
    throw error;
  }
  if (!existsSync(resolved) && resolved.includes("/dist/plugin-sdk/")) {
    // Source-tree unit tests do not always prebuild dist/plugin-sdk/* artifacts.
    return import(resolvePluginSdkSourceSpecifier(specifier));
  }
  return import(pathToFileURL(resolved).href);
}

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
  const missing = names.filter((name) => !sourceMentionsIdentifier(source, name));
  expect(missing, `${subpath} missing exports`).toEqual([]);
}

function expectSourceOmits(subpath: string, names: readonly string[]) {
  const source = readPluginSdkSource(subpath);
  const present = names.filter((name) => sourceMentionsIdentifier(source, name));
  expect(present, `${subpath} leaked exports`).toEqual([]);
}

function expectSourceContract(
  subpath: string,
  params: { mentions?: readonly string[]; omits?: readonly string[] },
) {
  const source = readPluginSdkSource(subpath);
  const missing = (params.mentions ?? []).filter((name) => !sourceMentionsIdentifier(source, name));
  const present = (params.omits ?? []).filter((name) => sourceMentionsIdentifier(source, name));
  expect(missing, `${subpath} missing exports`).toEqual([]);
  expect(present, `${subpath} leaked exports`).toEqual([]);
}

function expectSourceContains(subpath: string, snippet: string) {
  expect(readPluginSdkSource(subpath)).toContain(snippet);
}

describe("plugin-sdk subpath exports", () => {
  it("keeps the curated public list free of internal implementation subpaths", () => {
    for (const deniedSubpath of [
      "acpx",
      "compat",
      "device-pair",
      "google",
      "lobster",
      "pairing-access",
      "provider-model-definitions",
      "qwen-portal-auth",
      "reply-prefix",
      "secret-input-runtime",
      "secret-input-schema",
      "signal-core",
      "synology-chat",
      "typing",
      "whatsapp",
      "whatsapp-action-runtime",
      "whatsapp-login-qr",
      "zai",
    ]) {
      expect(pluginSdkSubpaths).not.toContain(deniedSubpath);
    }
  });

  it("keeps helper subpaths aligned", () => {
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
    expectSourceContract("routing", {
      mentions: [
        "buildAgentSessionKey",
        "resolveThreadSessionKeys",
        "normalizeMessageChannel",
        "resolveGatewayMessageChannel",
      ],
    });
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
    expectSourceContract("reply-runtime", {
      omits: [
        "buildPendingHistoryContextFromMap",
        "clearHistoryEntriesIfEnabled",
        "recordPendingHistoryEntryIfEnabled",
        "DEFAULT_GROUP_HISTORY_LIMIT",
      ],
    });
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
    expectSourceContract("allow-from", {
      mentions: [
        "addAllowlistUserEntriesFromConfigEntry",
        "buildAllowlistResolutionSummary",
        "canonicalizeAllowlistWithResolvedIds",
        "mapAllowlistResolutionInputs",
        "mergeAllowlist",
        "patchAllowlistUsersInConfigEntries",
        "summarizeMapping",
        "compileAllowlist",
        "firstDefined",
        "formatAllowlistMatchMeta",
        "isSenderIdAllowed",
        "mergeDmAllowFromSources",
        "resolveAllowlistMatchSimple",
      ],
    });
    expectSourceMentions("runtime", ["createLoggerBackedRuntime"]);
    expectSourceMentions("discord", [
      "buildDiscordComponentMessage",
      "editDiscordComponentMessage",
      "registerBuiltDiscordComponentMessage",
      "resolveDiscordAccount",
    ]);
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
    expectSourceContract("reply-runtime", {
      omits: [
        "buildMentionRegexes",
        "createInboundDebouncer",
        "formatInboundEnvelope",
        "formatInboundFromLabel",
        "matchesMentionPatterns",
        "matchesMentionWithExplicit",
        "normalizeMentionText",
        "resolveEnvelopeFormatOptions",
        "resolveInboundDebounceMs",
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
      ],
    });
    expectSourceMentions("channel-setup", [
      "createOptionalChannelSetupSurface",
      "createTopLevelChannelDmPolicy",
    ]);
    expectSourceContract("channel-actions", {
      mentions: [
        "createUnionActionGate",
        "listTokenSourcedAccounts",
        "resolveReactionMessageId",
        "createMessageToolButtonsSchema",
        "createMessageToolCardSchema",
      ],
    });
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
    expectSourceMentions("outbound-runtime", [
      "createRuntimeOutboundDelegates",
      "resolveOutboundSendDep",
      "resolveAgentOutboundIdentity",
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
    expectSourceContract("provider-models", {
      mentions: ["applyOpenAIConfig", "buildKilocodeModelDefinition", "discoverHuggingfaceModels"],
      omits: [
        "buildMinimaxModelDefinition",
        "buildMoonshotProvider",
        "QIANFAN_BASE_URL",
        "resolveZaiBaseUrl",
      ],
    });

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

  it("keeps shared plugin-sdk types aligned", () => {
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
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<OpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<PluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<ChannelMessageActionContext>();
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<SharedOpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<SharedPluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<SharedChannelMessageActionContext>();
  });

  it("keeps runtime entry subpaths importable", async () => {
    const [
      coreSdk,
      pluginEntrySdk,
      channelLifecycleSdk,
      channelPairingSdk,
      channelReplyPipelineSdk,
      ...representativeModules
    ] = await Promise.all([
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/core"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/plugin-entry"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/channel-lifecycle"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/channel-pairing"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/channel-reply-pipeline"),
      ...representativeRuntimeSmokeSubpaths.map((id) =>
        importResolvedPluginSdkSubpath(`openclaw/plugin-sdk/${id}`),
      ),
    ]);

    expect(coreSdk.definePluginEntry).toBe(pluginEntrySdk.definePluginEntry);

    expectSourceMentions("infra-runtime", ["createRuntimeOutboundDelegates"]);
    expectSourceContains("infra-runtime", "../infra/outbound/send-deps.js");

    expect(typeof channelLifecycleSdk.createDraftStreamLoop).toBe("function");
    expect(typeof channelLifecycleSdk.createFinalizableDraftLifecycle).toBe("function");
    expect(typeof channelLifecycleSdk.runPassiveAccountLifecycle).toBe("function");
    expect(typeof channelLifecycleSdk.createRunStateMachine).toBe("function");
    expect(typeof channelLifecycleSdk.createArmableStallWatchdog).toBe("function");

    expectSourceMentions("channel-pairing", [
      "createChannelPairingController",
      "createChannelPairingChallengeIssuer",
      "createLoggedPairingApprovalNotifier",
      "createPairingPrefixStripper",
      "createTextPairingAdapter",
    ]);
    expect("createScopedPairingAccess" in channelPairingSdk).toBe(false);

    expectSourceMentions("channel-reply-pipeline", ["createChannelReplyPipeline"]);
    expect("createTypingCallbacks" in channelReplyPipelineSdk).toBe(false);
    expect("createReplyPrefixContext" in channelReplyPipelineSdk).toBe(false);
    expect("createReplyPrefixOptions" in channelReplyPipelineSdk).toBe(false);

    expect(pluginSdkSubpaths.length).toBeGreaterThan(representativeRuntimeSmokeSubpaths.length);
    for (const [index, id] of representativeRuntimeSmokeSubpaths.entries()) {
      const mod = representativeModules[index];
      expect(typeof mod).toBe("object");
      expect(mod, `subpath ${id} should resolve`).toBeTruthy();
    }
  });
});
