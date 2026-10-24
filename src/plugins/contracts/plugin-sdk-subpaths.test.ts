// Plugin SDK subpath tests cover documented SDK subpath exports and package aliases.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Contract from "openclaw/plugin-sdk/channel-contract";
import type * as Core from "openclaw/plugin-sdk/core";
import type * as Reply from "openclaw/plugin-sdk/reply-runtime";
import * as ts from "typescript/ast";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { createNativeTypeScriptParser } from "../../../scripts/lib/native-typescript.mts";
import {
  buildPluginSdkPackageExports,
  deprecatedPublicPluginSdkEntrypoints,
  packagedPrivatePluginSdkRuntimeEntrypoints,
  pluginSdkEntrypoints,
  privateLocalOnlyPluginSdkEntrypoints,
  publicPluginSdkSubpaths as pluginSdkSubpaths,
} from "../../../scripts/lib/plugin-sdk-entries.mts";
import type * as Channel from "../../channels/plugins/types.public.js";
import * as channelActionsDirectSdk from "../../plugin-sdk/channel-actions.js";
import * as channelOutboundDirectSdk from "../../plugin-sdk/channel-outbound.js";
import type * as Shared from "../../plugin-sdk/channel-plugin-common.js";
import * as coreDirectSdk from "../../plugin-sdk/core.js";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../../test-utils/repo-files.js";
import type { PluginRuntime } from "../runtime/types.js";
import type { OpenClawPluginApi } from "../types.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const PLUGIN_SDK_DIR = resolve(SRC_ROOT, "plugin-sdk");
const sourceCache = new Map<string, string>();
const repoTsFilesCache = new Map<string, string[]>();
const representativeRuntimeSmokeSubpaths = [
  "channel-runtime-context",
  "conversation-runtime",
] as const;
const PUBLIC_SDK_TEST_HELPER_SUBPATHS = identifiers(`
  agent-runtime-test-contracts channel-contract-testing channel-target-testing
  channel-test-helpers plugin-test-api plugin-test-contracts plugin-test-runtime
  provider-http-test-mocks provider-test-contracts test-env test-fixtures test-live
  test-live-auth test-media-generation test-media-understanding test-node-mocks
`);
const PUBLIC_SDK_TEST_HELPER_SUBPATHS_WITH_TOP_LEVEL_MOCKS = ["provider-http-test-mocks"] as const;

const importSdk = async (subpath: string) => import(`openclaw/plugin-sdk/${subpath}`);

type BrowserHelperContract = {
  subpath: string;
  mentions: readonly string[];
  omits: readonly string[];
  expectedExports: readonly string[];
};

const BROWSER_HELPER_CONTRACTS: readonly BrowserHelperContract[] = [
  {
    subpath: "browser-control-auth",
    mentions: identifiers(`
      loadBundledPluginPublicSurfaceModuleSyncCore resolveBrowserControlAuth
      shouldAutoGenerateBrowserAuth ensureBrowserControlAuth
    `),
    omits: identifiers(`
      resolveGatewayAuth writeConfigFile generateBrowserControlToken
      ensureGatewayStartupAuth
    `),
    expectedExports: identifiers(`
      BrowserControlAuth ensureBrowserControlAuth resolveBrowserControlAuth
      shouldAutoGenerateBrowserAuth
    `),
  },
  {
    subpath: "browser-profiles",
    mentions: [
      "loadBundledPluginPublicSurfaceModuleSyncCore",
      "resolveBrowserConfig",
      "resolveProfile",
    ],
    omits: identifiers(`
      resolveBrowserSsrFPolicy ensureDefaultProfile ensureDefaultUserBrowserProfile
      normalizeHexColor
    `),
    expectedExports: identifiers(`
      DEFAULT_AI_SNAPSHOT_MAX_CHARS DEFAULT_BROWSER_ACTION_TIMEOUT_MS
      DEFAULT_BROWSER_DEFAULT_PROFILE_NAME DEFAULT_BROWSER_EVALUATE_ENABLED
      DEFAULT_OPENCLAW_BROWSER_COLOR DEFAULT_OPENCLAW_BROWSER_ENABLED
      DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME DEFAULT_UPLOAD_DIR ResolvedBrowserConfig
      ResolvedBrowserProfile ResolvedBrowserTabCleanupConfig resolveBrowserConfig
      resolveProfile
    `),
  },
];

function identifiers(names: string): string[] {
  return names.trim().split(/\s+/u);
}

function readCachedSource(absolutePath: string): string {
  const cached = sourceCache.get(absolutePath);
  if (cached !== undefined) {
    return cached;
  }
  const text = readFileSync(absolutePath, "utf8");
  sourceCache.set(absolutePath, text);
  return text;
}

function readPluginSdkSource(subpath: string): string {
  return readCachedSource(resolve(PLUGIN_SDK_DIR, `${subpath}.ts`));
}

function readRepoSource(relativePath: string): string {
  return readCachedSource(resolve(REPO_ROOT, relativePath));
}

function collectNamedExportsFromSource(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/gms)) {
    for (const segment of (match[1] ?? "").split(",")) {
      const name = segment.trim().replace(/^type\s+/u, "");
      if (name) {
        names.add(name.match(/\s+as\s+([A-Za-z_$][\w$]*)$/u)?.[1] ?? name);
      }
    }
  }
  const declarations =
    /\bexport\s+(?:(?:declare\s+)?(?:async\s+)?function|(?:declare\s+)?const|type(?=\s+[A-Za-z_$][\w$]*\s*=)|interface|class)\s+([A-Za-z_$][\w$]*)/gu;
  for (const match of source.matchAll(declarations)) {
    if (match[1]) {
      names.add(match[1]);
    }
  }
  return [...names].toSorted();
}

function createSourceFile(absolutePath: string): ts.SourceFile {
  return parser.parseSourceFile(absolutePath, readCachedSource(absolutePath));
}

function resolveTypeScriptModuleSource(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const resolved = resolve(dirname(fromFile), specifier);
  if (resolved.endsWith(".js")) {
    return `${resolved.slice(0, -3)}.ts`;
  }
  if (resolved.endsWith(".ts")) {
    return resolved;
  }
  return `${resolved}.ts`;
}

function collectReexportedSourceFiles(entrypointPath: string): string[] {
  const visited = new Set<string>();

  function visit(filePath: string) {
    if (visited.has(filePath)) {
      return;
    }
    visited.add(filePath);
    const sourceFile = createSourceFile(filePath);
    for (const statement of sourceFile.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const target = resolveTypeScriptModuleSource(filePath, statement.moduleSpecifier.text);
      if (target) {
        visit(target);
      }
    }
  }

  visit(entrypointPath);
  return [...visited].toSorted();
}

function topLevelVitestModuleMockLines(filePath: string): number[] {
  const sourceFile = createSourceFile(filePath);
  const lines: number[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
      continue;
    }
    const expression = statement.expression.expression;
    if (
      !ts.isPropertyAccessExpression(expression) ||
      !ts.isIdentifier(expression.expression) ||
      expression.expression.text !== "vi"
    ) {
      continue;
    }
    if (!["mock", "doMock", "unmock", "doUnmock"].includes(expression.name.text)) {
      continue;
    }
    lines.push(sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1);
  }
  return lines;
}

function expectNamedExportParity(params: BrowserHelperContract) {
  for (const dir of ["src/plugin-sdk", "extensions/browser"]) {
    const file = `${dir}/${params.subpath}.ts`;
    expect(collectNamedExportsFromSource(readRepoSource(file)), `${file} exports changed`).toEqual([
      ...params.expectedExports,
    ]);
  }
}

function listRepoTsFiles(dir: string): string[] {
  const cached = repoTsFilesCache.get(dir);
  if (cached !== undefined) {
    return cached;
  }
  const trackedFiles = listGitTrackedFiles({
    repoRoot: REPO_ROOT,
    pathspecs: toRepoRelativePath(REPO_ROOT, dir),
  });
  expect(trackedFiles, "boundary scans require a Git checkout").not.toBeNull();
  const files = (trackedFiles ?? [])
    .filter((line) => line.endsWith(".ts") && !/\/(?:dist|node_modules)\//u.test(line))
    .map((line) => resolve(REPO_ROOT, ...line.split("/")));
  repoTsFilesCache.set(dir, files);
  return files;
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
    .filter((file) => params.pattern.test(readCachedSource(file)))
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .toSorted();
}

function sourceMentionsIdentifier(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, "u").test(source);
}

function expectSourceMentions(subpath: string, names: readonly string[]) {
  expectSourceNames({ [subpath]: names }, true);
}

function expectSourceOmits(subpath: string, names: readonly string[]) {
  expectSourceNames({ [subpath]: names }, false);
}

function expectSourceNames(
  contracts: Record<string, string | readonly string[]>,
  present: boolean,
) {
  for (const [subpath, value] of Object.entries(contracts)) {
    const names = typeof value === "string" ? identifiers(value) : value;
    const source = readPluginSdkSource(subpath);
    const violations = names.filter((name) => sourceMentionsIdentifier(source, name) !== present);
    expect(violations, `${subpath} ${present ? "missing" : "leaked"} exports`).toStrictEqual([]);
  }
}

function expectSourceContains(subpath: string, snippet: string) {
  expect(readPluginSdkSource(subpath)).toContain(snippet);
}

function expectSourceOmitsSnippet(subpath: string, snippet: string) {
  expect(readPluginSdkSource(subpath)).not.toContain(snippet);
}

function expectRepoSourceOmitsSnippet(relativePath: string, snippet: string) {
  expect(readRepoSource(relativePath)).not.toContain(snippet);
}

function expectSourceOmitsImportPattern(subpath: string, specifier: string) {
  const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = readPluginSdkSource(subpath);
  expect(source).not.toMatch(new RegExp(`\\bfrom\\s+["']${escapedSpecifier}["']`, "u"));
  expect(source).not.toMatch(new RegExp(`\\bimport\\(\\s*["']${escapedSpecifier}["']\\s*\\)`, "u"));
}

function expectBrowserFacadeSourceContract(contract: BrowserHelperContract) {
  expectSourceMentions(contract.subpath, contract.mentions);
  expectSourceContains(contract.subpath, `artifactBasename: "${contract.subpath}.js"`);
  expectSourceOmits(contract.subpath, contract.omits);
}

function isGeneratedBundledFacadeSubpath(subpath: string): boolean {
  const source = readPluginSdkSource(subpath);
  return (
    source.startsWith("// Manual facade.") &&
    sourceMentionsIdentifier(source, "loadBundledPluginPublicSurfaceModuleSyncCore")
  );
}

describe("plugin-sdk subpath exports", () => {
  let deprecatedChannelRuntimeMatches: string[] = [];

  beforeAll(() => {
    deprecatedChannelRuntimeMatches = findRepoFilesContaining({
      roots: [
        resolve(REPO_ROOT, "src"),
        resolve(REPO_ROOT, "extensions"),
        resolve(REPO_ROOT, "test"),
      ],
      pattern:
        /(?:from\s+|import\s+(?:type\s+)?|import\s*\(\s*)["']openclaw\/plugin-sdk\/channel-runtime(?=["'])/u,
      exclude: ["src/plugins/compat/registry.ts", "src/plugins/sdk-alias.test.ts"],
    });
  });

  it("keeps the public entrypoint catalog, package exports, and support-status docs aligned", () => {
    const docs = readFileSync(resolve(REPO_ROOT, "docs/plugins/sdk-subpaths.md"), "utf8");
    const packageExports = buildPluginSdkPackageExports();
    const documentedSubpaths = new Set(
      [...docs.matchAll(/`plugin-sdk\/([a-z0-9-]+)`/gu)].map((match) => match[1]),
    );

    expect(docs).toContain("scripts/lib/plugin-sdk-entrypoints.json");
    expect(docs).toContain("scripts/lib/plugin-sdk-private-local-only-subpaths.json");
    expect(docs).toContain("scripts/lib/plugin-sdk-deprecated-public-subpaths.json");
    expect(docs).toContain("selected private-local entries");

    for (const subpath of pluginSdkSubpaths) {
      expect(packageExports).toHaveProperty(`./plugin-sdk/${subpath}`, {
        types: `./dist/plugin-sdk/${subpath}.d.ts`,
        default: `./dist/plugin-sdk/${subpath}.js`,
      });
    }
    const packagedPrivateSubpaths = new Set(packagedPrivatePluginSdkRuntimeEntrypoints);
    for (const subpath of privateLocalOnlyPluginSdkEntrypoints) {
      const packageExport = packageExports[`./plugin-sdk/${subpath}`];
      if (packagedPrivateSubpaths.has(subpath)) {
        expect(packageExport).toEqual({ default: `./dist/plugin-sdk/${subpath}.js` });
      } else {
        expect(packageExport).toBeUndefined();
      }
    }
    for (const subpath of deprecatedPublicPluginSdkEntrypoints) {
      expect(pluginSdkSubpaths).toContain(subpath);
    }
    for (const subpath of documentedSubpaths) {
      expect(pluginSdkEntrypoints).toContain(subpath);
    }
  });

  it("keeps the curated public list free of internal implementation subpaths", () => {
    for (const deniedSubpath of identifiers(`
      acpx device-pair lobster pairing-access provider-model-definitions qa-channel
      qa-channel-protocol reply-prefix secret-input-schema signal-core synology-chat
      typing whatsapp whatsapp-action-runtime whatsapp-login-qr zai
    `)) {
      expect(pluginSdkSubpaths).not.toContain(deniedSubpath);
    }
  });

  it("keeps removed bundled-channel aliases out of the public sdk list", () => {
    const removedChannelAliases = new Set(["signal", "slack", "telegram", "whatsapp"]);
    const banned = pluginSdkSubpaths.filter((subpath) => removedChannelAliases.has(subpath));
    expect(banned).toStrictEqual([]);
  });

  it("keeps generated bundled-channel facades out of the public sdk list", () => {
    const bannedPrefixes = ["discord", "signal", "slack", "telegram", "whatsapp"];
    const banned = pluginSdkSubpaths.filter((subpath) =>
      bannedPrefixes.some(
        (prefix) =>
          (subpath === prefix ||
            subpath.startsWith(`${prefix}-`) ||
            subpath.startsWith(`${prefix}.`)) &&
          isGeneratedBundledFacadeSubpath(subpath),
      ),
    );
    expect(banned).toStrictEqual([]);
  });

  it("keeps browser compatibility helper subpaths as thin facades", () => {
    for (const contract of BROWSER_HELPER_CONTRACTS) {
      expectBrowserFacadeSourceContract(contract);
    }
  });

  it("keeps browser helper facade exports aligned with extension public wrappers", () => {
    for (const contract of BROWSER_HELPER_CONTRACTS) {
      expectNamedExportParity(contract);
    }
  });

  it("keeps helper subpaths aligned", () => {
    // Shipped exports are checked through the TypeScript graph by plugin-sdk:surface:check.
    // Keep only additions outside that inventory and negative ownership boundaries here.
    expectSourceNames(
      {
        "expect-runtime": "expectDefined",
        "approval-reference-runtime": "buildApprovalResolutionRef",
        "channel-secret-tts-runtime": "collectNestedChannelTtsAssignments",
        "provider-web-search-contract": `
        createWebSearchProviderContractFields enablePluginInConfig getScopedCredentialValue
        resolveProviderWebSearchPluginConfig setScopedCredentialValue
        setProviderWebSearchPluginConfigValue WebSearchProviderPlugin
      `,
        "provider-web-search-config-contract": `
        getScopedCredentialValue resolveProviderWebSearchPluginConfig setScopedCredentialValue
        setProviderWebSearchPluginConfigValue WebSearchProviderPlugin
      `,
        "provider-web-fetch-contract": "enablePluginInConfig WebFetchProviderPlugin",
        "tool-payload": "extractToolPayload ToolPayloadCarrier",
        "memory-core-host-engine-foundation": [
          'from "../../packages/memory-host-sdk/src/host/fs-utils.js"',
        ],
        "memory-core-host-engine-curated": "extractProjectKeysFromCuratedEntry",
        "memory-core-host-engine-fs": ["resolveUserPath", 'from "../infra/fs-safe.js"'],
        "memory-core-host-engine-schema": "ensureMemoryIndexSchema loadSqliteVecExtension",
        "memory-core-host-runtime-core":
          "SILENT_REPLY_TOKEN resolveMemorySearchConfig MemoryPluginRuntime",
        "memory-core-host-runtime-cli": "defaultRuntime withManager withProgressTotals",
        "memory-core-host-runtime-files": "MemorySearchResult",
        "plugin-test-runtime": `
        registerSingleProviderPlugin registerProviderPlugin createRuntimeEnv
        createPluginSetupWizardStatus runProviderCatalog
      `,
        "agent-runtime-test-contracts": `
        AUTH_PROFILE_RUNTIME_CONTRACT DELIVERY_NO_REPLY_RUNTIME_CONTRACT createParameterFreeTool
        QUEUED_USER_MESSAGE_MARKER
      `,
        "channel-test-helpers": "formatEnvelopeTimestamp expectPairingReplyText",
        "provider-test-contracts": "expectPassthroughReplayPolicy runRealtimeSttLiveTest",
        "test-env": "withEnv withServer withTempHome createMockIncomingRequest withFetchPreconnect",
        "test-live": `
        createSingleUserPromptMessage isLiveTestEnabled isBillingErrorMessage
        isModelNotFoundErrorMessage
      `,
        "test-live-auth":
          "collectProviderApiKeys getShellEnvAppliedKeys maybeLoadShellEnvForGenerationProviders",
        "test-media-understanding": "createRequestCaptureJsonFetch installPinnedHostnameTestHooks",
        "test-media-generation": `
        encodePngRgba parseProviderModelMap resolveConfiguredLiveMusicModels
        resolveConfiguredLiveVideoModels
      `,
        "test-fixtures": `
        createCliRuntimeCapture importFreshModule bundledPluginRoot createSandboxTestContext
        makeAgentAssistantMessage peekSystemEvents typedCases
      `,
        "test-node-mocks":
          "mockNodeBuiltinModule mockNodeChildProcessExecFile mockNodeChildProcessSpawnSync",
        "channel-target-testing": "installCommonResolveTargetErrorCases ResolveTargetFn",
        "provider-http-test-mocks": "getProviderHttpMocks installProviderHttpMockCleanup",
      },
      true,
    );
    expectSourceNames(
      {
        "expect-runtime": "first last",
        core: "runPassiveAccountLifecycle createLoggerBackedRuntime registerSandboxBackend",
        "approval-reference-runtime":
          "resolveApprovalOverGateway withOperatorApprovalsGatewayClient",
        "reply-runtime": `
        buildPendingHistoryContextFromMap clearHistoryEntriesIfEnabled
        recordPendingHistoryEntryIfEnabled DEFAULT_GROUP_HISTORY_LIMIT requestedSessionId
        resumeRequestedSession
      `,
        "channel-secret-basic-runtime": "collectNestedChannelTtsAssignments",
        "channel-secret-tts-runtime":
          "collectSimpleChannelFieldAssignments collectConditionalChannelFieldAssignments",
        "provider-web-search-contract": `
        buildSearchCacheKey withTrustedWebSearchEndpoint writeCachedSearchPayload
        resolveCitationRedirectUrl
      `,
        "provider-web-search-config-contract": `
        enablePluginInConfig buildSearchCacheKey withTrustedWebSearchEndpoint writeCachedSearchPayload
        resolveCitationRedirectUrl
      `,
        "provider-web-fetch-contract":
          "withTrustedWebToolsEndpoint readResponseText resolveCacheTtlMs wrapExternalContent",
        "tool-payload": "createAnthropicToolPayloadCompatibilityWrapper extractToolSend",
        "memory-core-host-engine-foundation": [
          'from "../../packages/memory-host-sdk/src/engine-foundation.js"',
        ],
        "memory-core-host-runtime-core": [
          'export * from "../../packages/memory-host-sdk/src/runtime-core.js";',
          "recordMemoryArtifactWriteProvenance",
        ],
        "memory-core-host-runtime-files": [
          'export * from "../../packages/memory-host-sdk/src/runtime-files.js";',
        ],
        "test-env": `
        collectProviderApiKeys createRequestCaptureJsonFetch isLiveTestEnabled
        resolveConfiguredLiveVideoModels
      `,
      },
      false,
    );
  });

  it("keeps public SDK test helper subpaths free of top-level Vitest module mocks outside opt-in mock helpers", () => {
    const optInMockSubpaths = new Set<string>(PUBLIC_SDK_TEST_HELPER_SUBPATHS_WITH_TOP_LEVEL_MOCKS);
    const violations = PUBLIC_SDK_TEST_HELPER_SUBPATHS.filter(
      (subpath) => !optInMockSubpaths.has(subpath),
    )
      .flatMap((subpath) =>
        collectReexportedSourceFiles(resolve(PLUGIN_SDK_DIR, `${subpath}.ts`)).flatMap((file) =>
          topLevelVitestModuleMockLines(file).map(
            (line) => `${file.slice(REPO_ROOT.length + 1)}:${line}`,
          ),
        ),
      )
      .toSorted();

    expect(violations).toStrictEqual([]);
  });

  it("lists repo source candidates from git without walking SDK boundary roots", () => {
    try {
      expectNoReaddirSyncDuring(() => {
        repoTsFilesCache.clear();
        const files = listRepoTsFiles(resolve(REPO_ROOT, "src"));

        expect(files.length).toBeGreaterThan(0);
        expect(files.every((file) => file.endsWith(".ts"))).toBe(true);
      });
    } finally {
      repoTsFilesCache.clear();
    }
  });

  it("keeps the deprecated channel-runtime shim unused in repo imports", () => {
    expect(deprecatedChannelRuntimeMatches).toStrictEqual([]);
  });

  it("keeps deprecated channel route key aliases behind compatibility shims", () => {
    const matches = findRepoFilesContaining({
      roots: [
        resolve(REPO_ROOT, "src"),
        resolve(REPO_ROOT, "extensions"),
        resolve(REPO_ROOT, "test"),
      ],
      pattern: /\b(?:channelRouteIdentityKey|channelRouteKey)\b/u,
      exclude: [
        "src/plugin-sdk/channel-route.ts",
        "src/plugin-sdk/channel-route.test.ts",
        "src/plugins/compat/registry.ts",
        "src/plugins/compat/registry.test.ts",
        "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
      ],
    });
    expect(matches).toStrictEqual([]);
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
    expect(matches).toStrictEqual([]);
  });

  it("keeps channel runtime helpers on focused subpaths", () => {
    expectSourceNames(
      {
        "channel-targets": `
        applyChannelMatchMeta buildChannelKeyCandidates buildMessagingTarget ChannelId
        createAllowedChatSenderMatcher ensureTargetId normalizeChannelId parseChatAllowTargetPrefixes
        parseMentionPrefixOrAtUserTarget parseChatTargetPrefixesOrThrow requireTargetKind
        resolveChannelEntryMatchWithFallback resolveChannelMatchConfig
        resolveServicePrefixedAllowTarget resolveServicePrefixedChatTarget
        resolveServicePrefixedOrChatAllowTarget resolveServicePrefixedTarget
        resolveTargetsWithOptionalToken
      `,
        "channel-config-writes": "resolveChannelConfigWrites",
        "thread-bindings-runtime":
          "registerSessionBindingAdapter unregisterSessionBindingAdapter SessionBindingAdapter",
        "provider-setup": `
        applyProviderDefaultModel defineSelfHostedOpenAICompatibleProvider
        discoverOpenAICompatibleLocalModels discoverOpenAICompatibleSelfHostedProvider
      `,
        "provider-model-shared": `
        DEFAULT_CONTEXT_TOKENS normalizeModelCompat cloneFirstTemplateModel
        resolveFamilyForwardCompatModel
      `,
        "provider-catalog-shared":
          "buildSingleProviderApiKeyCatalog buildManifestProviderCatalogFamily",
        "agent-harness": ["./agent-harness-runtime.js"],
        sandbox: "registerSandboxBackend runPluginCommandWithTimeout",
        "provider-http": `
        assertOkOrThrowHttpError normalizeBaseUrl postJsonRequest postTranscriptionRequest
        requireTranscriptionText
      `,
      },
      true,
    );
    expectSourceNames(
      {
        "channel-runtime-context": `
        applyChannelMatchMeta createChannelDirectoryAdapter createEmptyChannelDirectoryAdapter
        createArmableStallWatchdog createDraftStreamLoop createLoggedPairingApprovalNotifier
        createPairingPrefixStripper createChannelRunQueue createRunStateMachine
        createRuntimeDirectoryLiveAdapter createRuntimeOutboundDelegates
        createStatusReactionController createTextPairingAdapter createFinalizableDraftLifecycle
        DEFAULT_EMOJIS logAckFailure logTypingFailure logInboundDrop normalizeMessageChannel
        removeAckReactionAfterReply recordInboundSession recordInboundSessionMetaSafe
        resolveInboundSessionEnvelopeContext resolveInboundMentionDecision resolveMentionGating
        resolveMentionGatingWithBypass resolveOutboundSendDep resolveConversationLabel
        shouldDebounceTextInbound shouldAckReaction toLocationContext
        resolveThreadBindingConversationIdFromBindingId resolveThreadBindingEffectiveExpiresAt
        resolveThreadBindingFarewellText resolveThreadBindingIdleTimeoutMs
        resolveThreadBindingIdleTimeoutMsForChannel resolveThreadBindingIntroText
        resolveThreadBindingLifecycle resolveThreadBindingMaxAgeMs
        resolveThreadBindingMaxAgeMsForChannel resolveThreadBindingSpawnPolicy
        resolveThreadBindingThreadName resolveThreadBindingsEnabled formatThreadBindingDisabledError
        resolveControlCommandGate resolveCommandAuthorizedFromAuthorizers
        resolveDualTextControlCommandGate resolveNativeCommandSessionTargets attachChannelToResult
        buildComputedAccountStatusSnapshot buildMediaPayload createActionGate jsonResult
        normalizeInteractiveReply PAIRING_APPROVED_MESSAGE projectCredentialSnapshotFields
        readStringParam compileAllowlist formatAllowlistMatchMeta firstDefined isSenderIdAllowed
        mergeDmAllowFromSources addAllowlistUserEntriesFromConfigEntry buildAllowlistResolutionSummary
        canonicalizeAllowlistWithResolvedIds mergeAllowlist patchAllowlistUsersInConfigEntries
        resolvePayloadMediaUrls resolveScopedChannelMediaMaxBytes sendPayloadMediaSequenceAndFinalize
        sendPayloadMediaSequenceOrFallback sendTextMediaPayload
        createScopedChannelMediaMaxBytesResolver runPassiveAccountLifecycle buildChannelKeyCandidates
        buildMessagingTarget createDirectTextMediaOutbound createScopedAccountReplyToModeResolver
        createStaticReplyToModeResolver createTopLevelChannelReplyToModeResolver createUnionActionGate
        ensureTargetId listTokenSourcedAccounts parseMentionPrefixOrAtUserTarget requireTargetKind
        resolveChannelEntryMatchWithFallback resolveChannelMatchConfig resolveReactionMessageId
        resolveTargetsWithOptionalToken appendMatchMetadata asString collectIssuesForEnabledAccounts
        isRecord resolveEnabledConfiguredAccountId
      `,
        "reply-runtime": `
        buildMentionRegexes formatInboundEnvelope formatInboundFromLabel matchesMentionPatterns
        matchesMentionWithExplicit normalizeMentionText resolveEnvelopeFormatOptions hasControlCommand
        buildCommandTextFromArgs buildCommandsPaginationKeyboard buildModelsProviderData
        listNativeCommandSpecsForConfig listSkillCommandsForAgents normalizeCommandBody
        resolveCommandAuthorization resolveStoredModelOverride shouldComputeCommandAuthorized
        shouldHandleTextCommands
      `,
        "provider-setup": `
        buildOllamaProvider configureOllamaNonInteractive ensureOllamaModelPulled
        promptAndConfigureOllama promptAndConfigureVllm buildVllmProvider buildSglangProvider
        OLLAMA_DEFAULT_BASE_URL OLLAMA_DEFAULT_MODEL VLLM_DEFAULT_BASE_URL
      `,
        core: "buildOauthProviderAuthResult",
        "provider-model-shared":
          "applyOpenAIConfig buildKilocodeModelDefinition discoverHuggingfaceModels",
        "provider-catalog-shared": "buildDeepSeekProvider buildVeniceProvider",
        speech: `
        buildElevenLabsSpeechProvider buildMicrosoftSpeechProvider buildOpenAISpeechProvider edgeTTS
        elevenLabsTTS inferEdgeExtension openaiTTS OPENAI_TTS_MODELS OPENAI_TTS_VOICES
      `,
        "media-understanding": `
        deepgramMediaUnderstandingProvider groqMediaUnderstandingProvider assertOkOrThrowHttpError
        postJsonRequest postTranscriptionRequest
      `,
        "image-generation": `
        buildFalImageGenerationProvider buildGoogleImageGenerationProvider
        buildOpenAIImageGenerationProvider
      `,
      },
      false,
    );

    // The load-only WhatsApp bridge lives in the barrel for published
    // pre-#121257 artifacts; the owner file stays free of channel policy.
    expectRepoSourceOmitsSnippet("src/channels/ack-reactions.ts", "shouldAckReactionForWhatsApp");
    expectRepoSourceOmitsSnippet("src/channels/ack-reactions.ts", "WhatsAppAckReactionMode");

    expectSourceOmitsImportPattern("provider-setup", "./vllm.js");
    expectSourceOmitsImportPattern("provider-setup", "./sglang.js");

    expectSourceOmitsSnippet("agent-runtime", "./sglang.js");
    expectSourceOmitsSnippet("agent-runtime", "./vllm.js");
    expectSourceOmitsSnippet("agent-runtime", "../../extensions/");
    expectRepoSourceOmitsSnippet("extensions/xai/model-id.ts", "./xai.js");
    expectRepoSourceOmitsSnippet("extensions/xai/model-id.ts", "./facade-runtime.js");
    expectRepoSourceOmitsSnippet("extensions/xai/model-id.ts", "../../extensions/");
  });

  it("keeps shared plugin-sdk types aligned", () => {
    expectTypeOf<Contract.BaseProbeResult>().toMatchTypeOf<Channel.BaseProbeResult>();
    expectTypeOf<Contract.BaseTokenResolution>().toMatchTypeOf<Channel.BaseTokenResolution>();
    expectTypeOf<Contract.ChannelAgentTool>().toMatchTypeOf<Channel.ChannelAgentTool>();
    expectTypeOf<Contract.ChannelAccountSnapshot>().toMatchTypeOf<Channel.ChannelAccountSnapshot>();
    expectTypeOf<Contract.ChannelGroupContext>().toMatchTypeOf<Channel.ChannelGroupContext>();
    expectTypeOf<Contract.ChannelMessageActionAdapter>().toMatchTypeOf<Channel.ChannelMessageActionAdapter>();
    expectTypeOf<Contract.ChannelMessageActionContext>().toMatchTypeOf<Channel.ChannelMessageActionContext>();
    expectTypeOf<Contract.ChannelMessageActionName>().toMatchTypeOf<Channel.ChannelMessageActionName>();
    expectTypeOf<Contract.ChannelMessageToolDiscovery>().toMatchTypeOf<Channel.ChannelMessageToolDiscovery>();
    expectTypeOf<Contract.ChannelStatusIssue>().toMatchTypeOf<Channel.ChannelStatusIssue>();
    expectTypeOf<Contract.ChannelThreadingContext>().toMatchTypeOf<Channel.ChannelThreadingContext>();
    expectTypeOf<Contract.ChannelThreadingToolContext>().toMatchTypeOf<Channel.ChannelThreadingToolContext>();
    expectTypeOf<Core.OpenClawPluginApi>().toMatchTypeOf<OpenClawPluginApi>();
    expectTypeOf<Core.PluginRuntime>().toMatchTypeOf<PluginRuntime>();
    expectTypeOf<Core.ChannelMessageActionContext>().toMatchTypeOf<Channel.ChannelMessageActionContext>();
    expectTypeOf<Core.OpenClawPluginApi>().toMatchTypeOf<Shared.OpenClawPluginApi>();
    expectTypeOf<Core.PluginRuntime>().toMatchTypeOf<Shared.PluginRuntime>();
    expectTypeOf<Core.ChannelMessageActionContext>().toMatchTypeOf<Shared.ChannelMessageActionContext>();
    type PrivateResumeOptionKeys = Extract<
      keyof Reply.GetReplyOptions,
      "requestedSessionId" | "resumeRequestedSession"
    >;
    expectTypeOf<PrivateResumeOptionKeys>().toEqualTypeOf<never>();
    type ReplyRuntimeAppendBeforeDeliverOptions = Parameters<
      NonNullable<Reply.ReplyDispatcher["appendBeforeDeliver"]>
    >[1];
    expectTypeOf<ReplyRuntimeAppendBeforeDeliverOptions>().toEqualTypeOf<
      Reply.ReplyDispatchBeforeDeliverOptions | undefined
    >();
  });

  it("keeps the supported root SDK contract importable through core", async () => {
    const coreSdk = await importSdk("core");

    expect(coreSdk.definePluginEntry).toBe(coreDirectSdk.definePluginEntry);
    expect(coreSdk.optionalStringEnum).toBe(coreDirectSdk.optionalStringEnum);
    expect(coreSdk.prepareMemorySystemPromptAddition).toBe(
      coreDirectSdk.prepareMemorySystemPromptAddition,
    );
  });

  it("keeps focused SDK subpaths importable", async () => {
    const channelActionsSdk = await importSdk("channel-actions");
    const pluginEntrySdk = await importSdk("plugin-entry");
    const channelOutboundSdk = await importSdk("channel-outbound");
    const channelPairingSdk = await importSdk("channel-pairing");
    const representativeModules = [];
    for (const id of representativeRuntimeSmokeSubpaths) {
      representativeModules.push(await importSdk(id));
    }

    expect(pluginEntrySdk.definePluginEntry).toBe(coreDirectSdk.definePluginEntry);
    expect(channelActionsSdk.optionalStringEnum).toBe(channelActionsDirectSdk.optionalStringEnum);
    expect(channelActionsSdk.stringEnum).toBe(channelActionsDirectSdk.stringEnum);
    expectSourceMentions("error-runtime", [
      "formatUncaughtError",
      "isApprovalNotFoundError",
      "PlatformMessageNotDispatchedError",
    ]);

    expectSourceMentions(
      "channel-pairing",
      identifiers(`
      createChannelPairingController createChannelPairingChallengeIssuer
      createLoggedPairingApprovalNotifier createPairingPrefixStripper
      readChannelAllowFromStoreSync createTextPairingAdapter
    `),
    );
    expect("createScopedPairingAccess" in channelPairingSdk).toBe(false);

    expectSourceMentions(
      "channel-outbound",
      identifiers(`
      createChannelMessageReplyPipeline createTypingCallbacks createReplyPrefixContext
      createReplyPrefixOptions resolveChannelMessageSourceReplyDeliveryMode
    `),
    );

    for (const name of [
      "createDraftStreamLoop",
      "createFinalizableDraftLifecycle",
      "createChannelRunQueue",
      "runPassiveAccountLifecycle",
      "createRunStateMachine",
      "createArmableStallWatchdog",
      "createTypingCallbacks",
      "createReplyPrefixContext",
      "createReplyPrefixOptions",
      "resolveChannelMessageSourceReplyDeliveryMode",
    ] as const) {
      expect(channelOutboundSdk[name], name).toBe(channelOutboundDirectSdk[name]);
    }

    expect(pluginSdkSubpaths.length).toBeGreaterThan(representativeRuntimeSmokeSubpaths.length);
    for (const [index, id] of representativeRuntimeSmokeSubpaths.entries()) {
      const mod = representativeModules[index];
      expect(typeof mod).toBe("object");
      expect(Object.keys(mod as object).length, `subpath ${id} should resolve`).toBeGreaterThan(0);
    }
  });

  it("keeps deprecated public SDK shims importable during migrations", async () => {
    expect(deprecatedPublicPluginSdkEntrypoints.length).toBeGreaterThan(0);

    for (const subpath of deprecatedPublicPluginSdkEntrypoints) {
      const mod = await importSdk(subpath);
      expect(typeof mod, `deprecated subpath ${subpath} should resolve`).toBe("object");
    }
  });
});
