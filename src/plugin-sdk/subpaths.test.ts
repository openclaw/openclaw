import { readFileSync } from "node:fs";
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
function resolvePluginSdkSourceModulePath(specifier: string): string | null {
  if (specifier === "openclaw/plugin-sdk") {
    return resolve(PLUGIN_SDK_DIR, "index.ts");
  }
  const prefix = "openclaw/plugin-sdk/";
  if (!specifier.startsWith(prefix)) {
    return null;
  }
  const subpath = specifier.slice(prefix.length).trim();
  if (!subpath) {
    return null;
  }
  return resolve(PLUGIN_SDK_DIR, `${subpath}.ts`);
}

function resolvePluginSdkDistModuleSuffix(specifier: string): string | null {
  if (specifier === "openclaw/plugin-sdk") {
    return "/dist/plugin-sdk/index.js";
  }
  const prefix = "openclaw/plugin-sdk/";
  if (!specifier.startsWith(prefix)) {
    return null;
  }
  const subpath = specifier.slice(prefix.length).trim();
  if (!subpath) {
    return null;
  }
  return `/dist/plugin-sdk/${subpath}.js`;
}

function normalizeModuleNotFoundPath(value: string): string {
  return value
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function isPackageSelfResolutionFailure(specifier: string, message: string): boolean {
  return /package\.json/i.test(message) && message.includes(`imported from ${specifier}`);
}

function isRequestedDistSubpathMissing(specifier: string, message: string): boolean {
  const distSuffix = resolvePluginSdkDistModuleSuffix(specifier);
  if (!distSuffix) {
    return false;
  }
  return normalizeModuleNotFoundPath(message).includes(
    normalizeModuleNotFoundPath(distSuffix),
  );
}

function shouldFallbackToPluginSdkSource(specifier: string, err: unknown): boolean {
  const rawMessage =
    typeof err === "object" && err !== null && "message" in err
      ? (err as { message?: unknown }).message
      : undefined;
  const message = typeof rawMessage === "string" ? rawMessage : "";
  const code =
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code?: string }).code
      : undefined;
  const moduleNotFound =
    code === "MODULE_NOT_FOUND" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    /Cannot find module/i.test(message);
  if (!moduleNotFound) {
    return false;
  }
  const sourcePath = resolvePluginSdkSourceModulePath(specifier);
  if (!sourcePath) {
    return false;
  }
  return (
    isPackageSelfResolutionFailure(specifier, message) ||
    isRequestedDistSubpathMissing(specifier, message)
  );
}
const importPluginSdkSubpath = async (specifier: string) => {
  try {
    return await import(/* @vite-ignore */ specifier);
  } catch (err) {
    if (!shouldFallbackToPluginSdkSource(specifier, err)) {
      throw err;
    }
    const sourcePath = resolvePluginSdkSourceModulePath(specifier);
    if (!sourcePath) {
      throw err;
    }
    return await import(pathToFileURL(sourcePath).href);
  }
};
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
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function expectSourceMentions(subpath: string, names: readonly string[]) {
  const source = readPluginSdkSource(subpath);
  for (const name of names) {
    expect(source, `${subpath} should mention ${name}`).toMatch(
      new RegExp(`\\b${escapeRegExp(name)}\\b`, "u"),
    );
  }
}
function expectSourceOmits(subpath: string, names: readonly string[]) {
  const source = readPluginSdkSource(subpath);
  for (const name of names) {
    expect(source, `${subpath} should not mention ${name}`).not.toMatch(
      new RegExp(`\\b${escapeRegExp(name)}\\b`, "u"),
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
  it("falls back to source when plugin-sdk self-resolution fails before dist loads", () => {
    const err = Object.assign(
      new Error(
        "Cannot find module '/home/runner/_work/openclaw/openclaw/package.json' imported from openclaw/plugin-sdk/core",
      ),
      { code: "MODULE_NOT_FOUND" },
    );
    expect(shouldFallbackToPluginSdkSource("openclaw/plugin-sdk/core", err)).toBe(true);
  });
  it("falls back to source when the built dist subpath itself is missing", () => {
    const err = Object.assign(
      new Error(
        "Cannot find module 'C:\\runner\\_work\\openclaw\\openclaw\\dist\\plugin-sdk\\core.js'",
      ),
      { code: "MODULE_NOT_FOUND" },
    );
    expect(shouldFallbackToPluginSdkSource("openclaw/plugin-sdk/core", err)).toBe(true);
  });
  it("does not fall back when a dist subpath is present but one of its transitive deps is missing", () => {
    const err = Object.assign(
      new Error(
        "Cannot find module '/home/runner/_work/openclaw/openclaw/dist/plugin-sdk/internal-shared.js' imported from /home/runner/_work/openclaw/openclaw/dist/plugin-sdk/core.js'",
      ),
      { code: "MODULE_NOT_FOUND" },
    );
    expect(shouldFallbackToPluginSdkSource("openclaw/plugin-sdk/core", err)).toBe(false);
  });
  it("exports routing helpers from the dedicated subpath", () => {
    expectSourceMentions("routing", ["buildAgentSessionKey", "resolveThreadSessionKeys"]);
  });
  it("exports reply payload helpers from the dedicated subpath", () => {
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
  });
  it("exports media runtime helpers from the dedicated subpath", () => {
    expectSourceMentions("media-runtime", [
      "createDirectTextMediaOutbound",
      "createScopedChannelMediaMaxBytesResolver",
    ]);
  });
  it("exports reply history helpers from the dedicated subpath", () => {
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
  });
  it("exports account helper builders from the dedicated subpath", () => {
    expectSourceMentions("account-helpers", ["createAccountListHelpers"]);
  });
  it("exports device bootstrap helpers from the dedicated subpath", () => {
    expectSourceMentions("device-bootstrap", [
      "approveDevicePairing",
      "issueDeviceBootstrapToken",
      "listDevicePairing",
    ]);
  });
  it("exports allowlist edit helpers from the dedicated subpath", () => {
    expectSourceMentions("allowlist-config-edit", [
      "buildDmGroupAccountAllowlistAdapter",
      "createNestedAllowlistOverrideResolver",
    ]);
  });
  it("exports allowlist resolution helpers from the dedicated subpath", () => {
    expectSourceMentions("allow-from", [
      "addAllowlistUserEntriesFromConfigEntry",
      "buildAllowlistResolutionSummary",
      "canonicalizeAllowlistWithResolvedIds",
      "mapAllowlistResolutionInputs",
      "mergeAllowlist",
      "patchAllowlistUsersInConfigEntries",
      "summarizeMapping",
    ]);
  });
  it("exports allow-from matching helpers from the dedicated subpath", () => {
    expectSourceMentions("allow-from", [
      "compileAllowlist",
      "firstDefined",
      "formatAllowlistMatchMeta",
      "isSenderIdAllowed",
      "mergeDmAllowFromSources",
      "resolveAllowlistMatchSimple",
    ]);
  });
  it("exports runtime helpers from the dedicated subpath", () => {
    expectSourceMentions("runtime", ["createLoggerBackedRuntime"]);
  });
  it("exports Discord component helpers from the dedicated subpath", () => {
    expectSourceMentions("discord", [
      "buildDiscordComponentMessage",
      "editDiscordComponentMessage",
      "registerBuiltDiscordComponentMessage",
      "resolveDiscordAccount",
    ]);
  });
  it("exports channel identity and session helpers from stronger existing homes", () => {
    expectSourceMentions("routing", ["normalizeMessageChannel", "resolveGatewayMessageChannel"]);
    expectSourceMentions("conversation-runtime", [
      "recordInboundSession",
      "recordInboundSessionMetaSafe",
      "resolveConversationLabel",
    ]);
  });
  it("exports directory runtime helpers from the dedicated subpath", () => {
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
  it("exports inbound channel helpers from the dedicated subpath", () => {
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
  });
  it("exports channel setup helpers from the dedicated subpath", () => {
    expectSourceMentions("channel-setup", [
      "createOptionalChannelSetupSurface",
      "createTopLevelChannelDmPolicy",
    ]);
  });
  it("exports channel action helpers from the dedicated subpath", () => {
    expectSourceMentions("channel-actions", [
      "createUnionActionGate",
      "listTokenSourcedAccounts",
      "resolveReactionMessageId",
    ]);
  });
  it("exports channel target helpers from the dedicated subpath", () => {
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
  });
  it("exports channel config write helpers from the dedicated subpath", () => {
    expectSourceMentions("channel-config-helpers", [
      "authorizeConfigWrite",
      "canBypassConfigWritePolicy",
      "formatConfigWriteDeniedMessage",
      "resolveChannelConfigWrites",
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
  it("exports channel feedback helpers from the dedicated subpath", () => {
    expectSourceMentions("channel-feedback", [
      "createStatusReactionController",
      "logAckFailure",
      "logTypingFailure",
      "removeAckReactionAfterReply",
      "shouldAckReaction",
      "shouldAckReactionForWhatsApp",
      "DEFAULT_EMOJIS",
    ]);
  });
  it("exports status helper utilities from the dedicated subpath", () => {
    expectSourceMentions("status-helpers", [
      "appendMatchMetadata",
      "asString",
      "collectIssuesForEnabledAccounts",
      "isRecord",
      "resolveEnabledConfiguredAccountId",
    ]);
  });
  it("exports message tool schema helpers from the dedicated subpath", () => {
    expectSourceMentions("channel-actions", [
      "createMessageToolButtonsSchema",
      "createMessageToolCardSchema",
    ]);
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
  it("exports command auth helpers from the dedicated subpath", () => {
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
  it("exports channel send-result helpers from the dedicated subpath", () => {
    expectSourceMentions("channel-send-result", [
      "attachChannelToResult",
      "buildChannelSendResult",
    ]);
  });
  it("exports binding lifecycle helpers from the conversation-runtime subpath", () => {
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
  });
  it("exports narrow binding lifecycle helpers from the dedicated subpath", () => {
    expectSourceMentions("thread-bindings-runtime", ["resolveThreadBindingLifecycle"]);
  });
  it("exports narrow matrix runtime helpers from the dedicated subpath", () => {
    expectSourceMentions("matrix-runtime-shared", ["formatZonedTimestamp"]);
  });
  it("exports narrow ssrf helpers from the dedicated subpath", () => {
    expectSourceMentions("ssrf-runtime", [
      "closeDispatcher",
      "createPinnedDispatcher",
      "resolvePinnedHostnameWithPolicy",
      "assertHttpUrlTargetsPrivateNetwork",
      "ssrfPolicyFromAllowPrivateNetwork",
    ]);
  });
  it("exports provider setup helpers from the dedicated subpath", () => {
    expectSourceMentions("provider-setup", [
      "buildVllmProvider",
      "discoverOpenAICompatibleSelfHostedProvider",
    ]);
  });
  it("exports oauth helpers from provider-auth", () => {
    expectSourceMentions("provider-auth", [
      "buildOauthProviderAuthResult",
      "generatePkceVerifierChallenge",
      "toFormUrlEncoded",
    ]);
    expectSourceOmits("core", ["buildOauthProviderAuthResult"]);
  });
  it("keeps provider models focused on shared provider primitives", () => {
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
  });
  it("exports shared setup helpers from the dedicated subpath", () => {
    expectSourceMentions("setup", [
      "DEFAULT_ACCOUNT_ID",
      "createAllowFromSection",
      "createDelegatedSetupWizardProxy",
      "createTopLevelChannelDmPolicy",
      "mergeAllowFromEntries",
    ]);
  });
  it("exports shared lazy runtime helpers from the dedicated subpath", () => {
    expectSourceMentions("lazy-runtime", ["createLazyRuntimeSurface", "createLazyRuntimeModule"]);
  });
  it("exports narrow self-hosted provider setup helpers", () => {
    expectSourceMentions("self-hosted-provider-setup", [
      "buildVllmProvider",
      "buildSglangProvider",
      "configureOpenAICompatibleSelfHostedProviderNonInteractive",
    ]);
  });
  it("exports narrow Ollama setup helpers", () => {
    expectSourceMentions("ollama-setup", ["buildOllamaProvider", "configureOllamaNonInteractive"]);
  });
  it("exports sandbox helpers from the dedicated subpath", () => {
    expectSourceMentions("sandbox", ["registerSandboxBackend", "runPluginCommandWithTimeout"]);
  });
  it("exports secret input helpers from the dedicated subpath", () => {
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
  });
  it("exports webhook ingress helpers from the dedicated subpath", () => {
    expectSourceMentions("webhook-ingress", [
      "registerPluginHttpRoute",
      "resolveWebhookPath",
      "readRequestBodyWithLimit",
      "readJsonWebhookBodyOrReject",
      "requestBodyErrorToText",
      "withResolvedWebhookRequestPipeline",
    ]);
  });
  it("exports shared core types used by bundled extensions", () => {
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<OpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<PluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<ChannelMessageActionContext>();
  });
  it("exports the public testing surface", () => {
    expectSourceMentions("testing", ["removeAckReactionAfterReply", "shouldAckReaction"]);
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
