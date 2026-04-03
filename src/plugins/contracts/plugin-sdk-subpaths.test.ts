import { existsSync, readFileSync, readdirSync } from "node:fs";
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
import * as providerEntrySdk from "openclaw/plugin-sdk/provider-entry";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChannelMessageActionContext } from "../../channels/plugins/types.js";
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
} from "../../channels/plugins/types.js";
import type {
  ChannelMessageActionContext as SharedChannelMessageActionContext,
  OpenClawPluginApi as SharedOpenClawPluginApi,
  PluginRuntime as SharedPluginRuntime,
} from "../../plugin-sdk/channel-plugin-common.js";
import { pluginSdkSubpaths } from "../../plugin-sdk/entrypoints.js";
import type { PluginRuntime } from "../runtime/types.js";
import { resolvePluginSdkAliasFile } from "../sdk-alias.js";
import type { OpenClawPluginApi } from "../types.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const PLUGIN_SDK_DIR = resolve(SRC_ROOT, "plugin-sdk");
const requireFromHere = createRequire(import.meta.url);
const sourceCache = new Map<string, string>();
const representativeRuntimeSmokeSubpaths = ["channel-runtime", "conversation-runtime"] as const;

function resolveImportablePluginSdkSubpathFile(specifier: string): string {
  const subpath = specifier.replace(/^openclaw\/plugin-sdk\//, "");
  const resolvedAlias = resolvePluginSdkAliasFile({
    srcFile: `${subpath}.ts`,
    distFile: `${subpath}.js`,
    moduleUrl: import.meta.url,
  });
  if (resolvedAlias) {
    return resolvedAlias;
  }

  try {
    const resolvedExport = requireFromHere.resolve(specifier);
    if (existsSync(resolvedExport)) {
      return resolvedExport;
    }
  } catch {
    // Fall back to the package export only when the source-checkout alias path cannot be determined.
  }

  throw new Error(`Unable to resolve importable plugin-sdk subpath: ${specifier}`);
}

const importResolvedPluginSdkSubpath = async (specifier: string) =>
  import(pathToFileURL(resolveImportablePluginSdkSubpathFile(specifier)).href);

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

function listRepoTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        return [];
      }
      return listRepoTsFiles(absolute);
    }
    if (!entry.isFile()) {
      return [];
    }
    return absolute.endsWith(".ts") ? [absolute] : [];
  });
}

function findRepoFilesContaining(params: {
  roots: readonly string[];
  pattern: RegExp;
  exclude?: readonly string[];
  excludeFilesMatching?: readonly RegExp[];
}) {
  const excluded = new Set((params.exclude ?? []).map((entry) => resolve(REPO_ROOT, entry)));
  return params.roots
    .flatMap((root) => listRepoTsFiles(root))
    .filter((file) => !excluded.has(file))
    .filter((file) => !(params.excludeFilesMatching ?? []).some((pattern) => pattern.test(file)))
    .filter((file) => params.pattern.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .toSorted();
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

function expectSourceOmitsSnippet(subpath: string, snippet: string) {
  expect(readPluginSdkSource(subpath)).not.toContain(snippet);
}

function expectSourceOmitsImportPattern(subpath: string, specifier: string) {
  const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = readPluginSdkSource(subpath);
  expect(source).not.toMatch(new RegExp(`\\bfrom\\s+["']${escapedSpecifier}["']`, "u"));
  expect(source).not.toMatch(new RegExp(`\\bimport\\(\\s*["']${escapedSpecifier}["']\\s*\\)`, "u"));
}

describe("plugin-sdk subpath exports", () => {
  it("keeps the curated public list free of internal implementation subpaths", () => {
    for (const deniedSubpath of [
      "acpx",
      "device-pair",
      "lobster",
      "pairing-access",
      "provider-model-definitions",
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

  it("keeps removed bundled-channel prefixes out of the public sdk list", () => {
    const bannedPrefixes = ["discord", "signal", "slack", "telegram", "whatsapp"];
    const banned = pluginSdkSubpaths.filter((subpath) =>
      bannedPrefixes.some(
        (prefix) =>
          subpath === prefix ||
          subpath.startsWith(`${prefix}-`) ||
          subpath.startsWith(`${prefix}.`),
      ),
    );
    expect(banned).toEqual([]);
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
    expectSourceMentions("bluebubbles", [
      "normalizeBlueBubblesAcpConversationId",
      "matchBlueBubblesAcpConversation",
      "resolveBlueBubblesConversationIdFromTarget",
      "resolveAckReaction",
      "resolveChannelMediaMaxBytes",
      "collectBlueBubblesStatusIssues",
      "createChannelPairingController",
      "createChannelReplyPipeline",
      "resolveRequestUrl",
      "buildProbeChannelStatusSummary",
      "extractToolSend",
      "createFixedWindowRateLimiter",
      "withResolvedWebhookRequestPipeline",
    ]);
    expectSourceMentions("irc", [
      "createChannelReplyPipeline",
      "chunkTextForOutbound",
      "createChannelPairingController",
      "createLoggerBackedRuntime",
      "ircSetupAdapter",
      "ircSetupWizard",
    ]);
    expectSourceMentions("bluebubbles-policy", [
      "isAllowedBlueBubblesSender",
      "resolveBlueBubblesGroupRequireMention",
      "resolveBlueBubblesGroupToolPolicy",
    ]);
    for (const subpath of [
      "feishu",
      "googlechat",
      "matrix",
      "mattermost",
      "msteams",
      "zalo",
      "zalouser",
    ]) {
      expectSourceMentions(subpath, ["chunkTextForOutbound"]);
    }
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
    expectSourceMentions("channel-actions", ["optionalStringEnum", "stringEnum"]);
    expectSourceMentions("compat", [
      "createPluginRuntimeStore",
      "createScopedChannelConfigAdapter",
      "resolveControlCommandGate",
      "delegateCompactionToRuntime",
    ]);
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
    expectSourceMentions("huggingface", [
      "buildHuggingfaceModelDefinition",
      "buildHuggingfaceProvider",
      "discoverHuggingfaceModels",
      "HUGGINGFACE_MODEL_CATALOG",
      "isHuggingfacePolicyLocked",
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
    expectSourceContains(
      "memory-core-host-runtime-core",
      'export * from "../../packages/memory-host-sdk/src/runtime-core.js";',
    );
    expectSourceContains(
      "memory-core-host-runtime-cli",
      'export * from "../../packages/memory-host-sdk/src/runtime-cli.js";',
    );
    expectSourceContains(
      "memory-core-host-runtime-files",
      'export * from "../../packages/memory-host-sdk/src/runtime-files.js";',
    );
  });

  it("keeps the deprecated channel-runtime shim unused in repo imports", () => {
    const matches = findRepoFilesContaining({
      roots: [
        resolve(REPO_ROOT, "src"),
        resolve(REPO_ROOT, "extensions"),
        resolve(REPO_ROOT, "test"),
      ],
      pattern: /openclaw\/plugin-sdk\/channel-runtime/u,
      exclude: ["src/plugins/sdk-alias.test.ts"],
    });
    expect(matches).toEqual([]);
  });

  it("keeps removed channel-named runtime boundaries out of core imports", () => {
    const matches = findRepoFilesContaining({
      roots: [resolve(REPO_ROOT, "src")],
      pattern:
        /plugins\/runtime\/runtime-(?:discord|imessage|line|signal|slack|telegram|whatsapp)(?:[-.][^"']*)?\.js/u,
      exclude: [
        "src/plugins/runtime/runtime-plugin-boundary.ts",
        "src/plugins/runtime/runtime-web-channel-plugin.ts",
      ],
      excludeFilesMatching: [/\.test\.ts$/u, /\.test-harness\.ts$/u],
    });
    expect(matches).toEqual([]);
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
      "createDirectDmPreCryptoGuardPolicy",
      "createChannelInboundDebouncer",
      "createInboundDebouncer",
      "dispatchInboundDirectDmWithRuntime",
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
        "formatInboundEnvelope",
        "formatInboundFromLabel",
        "matchesMentionPatterns",
        "matchesMentionWithExplicit",
        "normalizeMentionText",
        "resolveEnvelopeFormatOptions",
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
      "ChannelId",
      "createAllowedChatSenderMatcher",
      "ensureTargetId",
      "normalizeChannelId",
      "parseChatAllowTargetPrefixes",
      "parseMentionPrefixOrAtUserTarget",
      "parseChatTargetPrefixesOrThrow",
      "requireTargetKind",
      "resolveChannelEntryMatchWithFallback",
      "resolveChannelMatchConfig",
      "resolveServicePrefixedAllowTarget",
      "resolveServicePrefixedChatTarget",
      "resolveServicePrefixedOrChatAllowTarget",
      "resolveServicePrefixedTarget",
      "resolveTargetsWithOptionalToken",
    ]);
    expectSourceMentions("channel-config-writes", [
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
      "createPreCryptoDirectDmAuthorizer",
      "resolveCommandAuthorization",
      "resolveCommandAuthorizedFromAuthorizers",
      "resolveInboundDirectDmAccessWithRuntime",
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
    expectSourceMentions("direct-dm", [
      "createDirectDmPreCryptoGuardPolicy",
      "createPreCryptoDirectDmAuthorizer",
      "dispatchInboundDirectDmWithRuntime",
      "resolveInboundDirectDmAccessWithRuntime",
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

    expectSourceMentions("thread-bindings-runtime", [
      "resolveThreadBindingFarewellText",
      "resolveThreadBindingLifecycle",
      "registerSessionBindingAdapter",
      "unregisterSessionBindingAdapter",
      "SessionBindingAdapter",
    ]);
    expectSourceMentions("matrix-runtime-shared", ["formatZonedTimestamp"]);
    expectSourceMentions("ssrf-runtime", [
      "closeDispatcher",
      "createPinnedDispatcher",
      "resolvePinnedHostnameWithPolicy",
      "formatErrorMessage",
      "assertHttpUrlTargetsPrivateNetwork",
      "ssrfPolicyFromAllowPrivateNetwork",
    ]);

    expectSourceContract("provider-setup", {
      mentions: [
        "applyProviderDefaultModel",
        "discoverOpenAICompatibleLocalModels",
        "discoverOpenAICompatibleSelfHostedProvider",
      ],
      omits: [
        "buildOllamaProvider",
        "configureOllamaNonInteractive",
        "ensureOllamaModelPulled",
        "promptAndConfigureOllama",
        "promptAndConfigureVllm",
        "buildVllmProvider",
        "buildSglangProvider",
        "OLLAMA_DEFAULT_BASE_URL",
        "OLLAMA_DEFAULT_MODEL",
        "VLLM_DEFAULT_BASE_URL",
      ],
    });
    expectSourceOmitsSnippet("provider-setup", "./ollama-surface.js");
    expectSourceOmitsImportPattern("provider-setup", "./vllm.js");
    expectSourceOmitsImportPattern("provider-setup", "./sglang.js");
    expectSourceMentions("provider-auth", [
      "buildOauthProviderAuthResult",
      "generatePkceVerifierChallenge",
      "readClaudeCliCredentialsCached",
      "toFormUrlEncoded",
    ]);
    expectSourceOmits("core", ["buildOauthProviderAuthResult"]);
    expectSourceContract("provider-model-shared", {
      mentions: ["DEFAULT_CONTEXT_TOKENS", "normalizeModelCompat", "cloneFirstTemplateModel"],
      omits: ["applyOpenAIConfig", "buildKilocodeModelDefinition", "discoverHuggingfaceModels"],
    });
    expectSourceContract("provider-catalog-shared", {
      mentions: ["buildSingleProviderApiKeyCatalog", "buildPairedProviderApiKeyCatalog"],
      omits: ["buildDeepSeekProvider", "buildOpenAICodexProvider", "buildVeniceProvider"],
    });

    expectSourceMentions("setup", [
      "DEFAULT_ACCOUNT_ID",
      "createAllowFromSection",
      "createDelegatedSetupWizardProxy",
      "createTopLevelChannelDmPolicy",
      "mergeAllowFromEntries",
    ]);
    expectSourceMentions("setup-tools", [
      "formatCliCommand",
      "detectBinary",
      "installSignalCli",
      "formatDocsLink",
    ]);
    expectSourceMentions("lazy-runtime", ["createLazyRuntimeSurface", "createLazyRuntimeModule"]);
    expectSourceContract("self-hosted-provider-setup", {
      mentions: [
        "applyProviderDefaultModel",
        "discoverOpenAICompatibleLocalModels",
        "discoverOpenAICompatibleSelfHostedProvider",
        "configureOpenAICompatibleSelfHostedProviderNonInteractive",
      ],
      omits: ["buildVllmProvider", "buildSglangProvider"],
    });
    expectSourceOmitsImportPattern("self-hosted-provider-setup", "./vllm.js");
    expectSourceOmitsImportPattern("self-hosted-provider-setup", "./sglang.js");
    expectSourceOmitsSnippet("agent-runtime", "./sglang.js");
    expectSourceOmitsSnippet("agent-runtime", "./vllm.js");
    expectSourceOmitsSnippet("agent-runtime", "../../extensions/");
    expectSourceOmitsSnippet("xai-model-id", "./xai.js");
    expectSourceOmitsSnippet("xai-model-id", "../../extensions/");
    expectSourceMentions("sandbox", ["registerSandboxBackend", "runPluginCommandWithTimeout"]);

    expectSourceMentions("secret-input", [
      "buildSecretInputSchema",
      "buildOptionalSecretInputSchema",
      "normalizeSecretInputString",
    ]);
    expectSourceMentions("provider-http", [
      "assertOkOrThrowHttpError",
      "normalizeBaseUrl",
      "postJsonRequest",
      "postTranscriptionRequest",
      "requireTranscriptionText",
    ]);
    expectSourceOmits("speech", [
      "buildElevenLabsSpeechProvider",
      "buildMicrosoftSpeechProvider",
      "buildOpenAISpeechProvider",
      "edgeTTS",
      "elevenLabsTTS",
      "inferEdgeExtension",
      "openaiTTS",
      "OPENAI_TTS_MODELS",
      "OPENAI_TTS_VOICES",
    ]);
    expectSourceOmits("media-understanding", [
      "deepgramMediaUnderstandingProvider",
      "groqMediaUnderstandingProvider",
      "assertOkOrThrowHttpError",
      "postJsonRequest",
      "postTranscriptionRequest",
    ]);
    expectSourceOmits("image-generation", [
      "buildFalImageGenerationProvider",
      "buildGoogleImageGenerationProvider",
      "buildOpenAIImageGenerationProvider",
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
      channelActionsSdk,
      globalSingletonSdk,
      textRuntimeSdk,
      huggingfaceSdk,
      pluginEntrySdk,
      channelLifecycleSdk,
      channelPairingSdk,
      channelReplyPipelineSdk,
      ...representativeModules
    ] = await Promise.all([
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/core"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/channel-actions"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/global-singleton"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/text-runtime"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/huggingface"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/plugin-entry"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/channel-lifecycle"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/channel-pairing"),
      importResolvedPluginSdkSubpath("openclaw/plugin-sdk/channel-reply-pipeline"),
      ...representativeRuntimeSmokeSubpaths.map((id) =>
        importResolvedPluginSdkSubpath(`openclaw/plugin-sdk/${id}`),
      ),
    ]);

    expect(coreSdk.definePluginEntry).toBe(pluginEntrySdk.definePluginEntry);
    expect(typeof coreSdk.optionalStringEnum).toBe("function");
    expect(typeof channelActionsSdk.optionalStringEnum).toBe("function");
    expect(typeof channelActionsSdk.stringEnum).toBe("function");
    expect(typeof globalSingletonSdk.resolveGlobalMap).toBe("function");
    expect(typeof globalSingletonSdk.resolveGlobalSingleton).toBe("function");
    expect(typeof globalSingletonSdk.createScopedExpiringIdCache).toBe("function");
    expect(typeof textRuntimeSdk.createScopedExpiringIdCache).toBe("function");
    expect(typeof textRuntimeSdk.resolveGlobalMap).toBe("function");
    expect(typeof textRuntimeSdk.resolveGlobalSingleton).toBe("function");
    expect(typeof huggingfaceSdk.buildHuggingfaceProvider).toBe("function");
    expect(typeof huggingfaceSdk.discoverHuggingfaceModels).toBe("function");
    expect(Array.isArray(huggingfaceSdk.HUGGINGFACE_MODEL_CATALOG)).toBe(true);

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
      "readChannelAllowFromStoreSync",
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

  it("exports single-provider plugin entry helpers from the dedicated subpath", () => {
    expect(typeof providerEntrySdk.defineSingleProviderPluginEntry).toBe("function");
  });
});
