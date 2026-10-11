// Plugin runtime mock helpers build minimal runtime doubles for plugin SDK tests.
import { vi } from "vitest";
import {
  resolveInboundDebounceMs,
  type InboundDebounceCreateParams,
} from "../../auto-reply/inbound-debounce.js";
import { normalizeThinkLevel } from "../../auto-reply/thinking.shared.js";
import {
  createAckReactionHandle,
  removeAckReactionAfterReply,
  removeAckReactionHandleAfterReply,
  shouldAckReaction,
} from "../../channels/ack-reactions.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { createChannelRuntimeContextRegistry } from "../../plugins/runtime/channel-runtime-contexts.js";
import { resolveAgentCatalogCreateTarget } from "../../plugins/runtime/runtime-agent-session-catalog.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "../channel-mention-gating.js";
import { createPluginGatewayRuntimeMock } from "./plugin-runtime-gateway-mock.js";
import { createGenericMock } from "./plugin-runtime-generic-mock.js";
import { createPluginInboundRuntimeMock } from "./plugin-runtime-inbound-mock.js";
import {
  mergePluginRuntimeMockOverrides,
  type PluginRuntimeMockOverrides,
} from "./plugin-runtime-mock-overrides.js";
import { createPluginModelRuntimeMock } from "./plugin-runtime-model-mock.js";
import { createPluginSessionRuntimeMock } from "./plugin-runtime-session-mock.js";
import { createPluginStateRuntimeMock } from "./plugin-runtime-state-mock.js";
import { createPluginSystemRuntimeMock } from "./plugin-runtime-system-mock.js";
import { createPluginThreadBindingsRuntimeMock } from "./plugin-runtime-thread-bindings-mock.js";

type InboundDebounceFlush = ReturnType<InboundDebounceCreateParams<unknown>["onFlush"]>;
type InboundDebounceFlushFactory = Parameters<InboundDebounceCreateParams<unknown>["onFlush"]>[1];

export const createTestInboundDebounceFlush: InboundDebounceFlushFactory = (params) => {
  const source = params.lifecycle;
  const completion = params.dispatch({
    abortSignal: source?.abortSignal ?? new AbortController().signal,
    onAdopted: async () => await source?.onAdopted?.(),
    onDeferred: () => source?.onDeferred?.(),
    onDeferredHeartbeat: () => source?.onDeferredHeartbeat?.(),
    deferredHeartbeatIntervalMs: source?.deferredHeartbeatIntervalMs,
    onAdoptionFinalizing: () => source?.onAdoptionFinalizing?.(),
    onFailed: source?.onFailed ? async (error) => await source.onFailed?.(error) : undefined,
    onAbandoned: async () => await source?.onAbandoned?.(),
  });
  return { admission: completion, completion };
};

const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-6-astra";

export type PluginRuntimeMediaMock = PluginRuntime["channel"]["media"];

const TEST_CONFIG_SNAPSHOT = {
  path: "/tmp/openclaw.json",
  exists: true,
  raw: "{}",
  parsed: {},
  sourceConfig: {},
  resolved: {},
  valid: true,
  runtimeConfig: {},
  config: {},
  issues: [],
  warnings: [],
  legacyIssues: [],
} satisfies ConfigFileSnapshot;

const TEST_SAVED_MEDIA = {
  id: "test-media.jpg",
  path: "/tmp/test-media.jpg",
  size: 0,
  contentType: "image/jpeg",
} satisfies Awaited<ReturnType<PluginRuntimeMediaMock["saveMediaBuffer"]>>;

export function createPluginRuntimeMediaMock(
  overrides: Partial<PluginRuntimeMediaMock> = {},
): PluginRuntimeMediaMock {
  const readRemoteMediaBuffer = vi.fn<PluginRuntimeMediaMock["readRemoteMediaBuffer"]>();
  return {
    readRemoteMediaBuffer,
    fetchRemoteMedia: readRemoteMediaBuffer,
    saveRemoteMedia: vi
      .fn<PluginRuntimeMediaMock["saveRemoteMedia"]>()
      .mockResolvedValue(TEST_SAVED_MEDIA),
    saveResponseMedia: vi
      .fn<PluginRuntimeMediaMock["saveResponseMedia"]>()
      .mockResolvedValue(TEST_SAVED_MEDIA),
    saveMediaBuffer: vi
      .fn<PluginRuntimeMediaMock["saveMediaBuffer"]>()
      .mockResolvedValue(TEST_SAVED_MEDIA),
    ...overrides,
  };
}

export function createPluginRuntimeMock(overrides: PluginRuntimeMockOverrides = {}): PluginRuntime {
  const runtimeContexts = createChannelRuntimeContextRegistry();
  const runEmbeddedAgentMock = vi
    .fn<PluginRuntime["agent"]["runEmbeddedAgent"]>()
    .mockResolvedValue({
      payloads: [],
      meta: { durationMs: 0 },
    });
  const sessionRuntime = createPluginSessionRuntimeMock();
  const inboundRuntime = createPluginInboundRuntimeMock(() => mergedRuntime);
  const base: PluginRuntime = {
    version: "1.0.0-test",
    ...createPluginModelRuntimeMock({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }),
    gateway: createPluginGatewayRuntimeMock(),
    config: {
      current: vi.fn<PluginRuntime["config"]["current"]>(() => ({})),
      mutateConfigFile: createGenericMock<PluginRuntime["config"]["mutateConfigFile"]>(
        async () => ({
          path: "/tmp/openclaw.json",
          previousHash: null,
          persistedHash: null,
          snapshot: TEST_CONFIG_SNAPSHOT,
          nextConfig: {},
          afterWrite: { mode: "auto" },
          followUp: { mode: "auto", requiresRestart: false },
          result: undefined,
        }),
      ),
      replaceConfigFile: vi.fn<PluginRuntime["config"]["replaceConfigFile"]>(
        async ({ nextConfig }) => ({
          path: "/tmp/openclaw.json",
          previousHash: null,
          persistedHash: null,
          snapshot: TEST_CONFIG_SNAPSHOT,
          nextConfig,
          afterWrite: { mode: "auto" },
          followUp: { mode: "auto", requiresRestart: false },
        }),
      ),
    },
    agent: {
      defaults: {
        model: DEFAULT_MODEL,
        provider: DEFAULT_PROVIDER,
      },
      resolveAgentDir: vi.fn<PluginRuntime["agent"]["resolveAgentDir"]>(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn<PluginRuntime["agent"]["resolveAgentWorkspaceDir"]>(
        () => "/tmp/workspace",
      ),
      resolveAgentIdentity: vi.fn<PluginRuntime["agent"]["resolveAgentIdentity"]>(() => ({
        name: "test-agent",
      })),
      resolveSessionCatalogCreateTarget: vi.fn<
        PluginRuntime["agent"]["resolveSessionCatalogCreateTarget"]
      >(resolveAgentCatalogCreateTarget),
      resolveThinkingDefault: vi.fn<PluginRuntime["agent"]["resolveThinkingDefault"]>(() => "off"),
      resolveCliBackendDispatchEligibility: vi.fn<
        PluginRuntime["agent"]["resolveCliBackendDispatchEligibility"]
      >(() => undefined),
      resolveCliBackendDispatchEligibilityAsync: vi.fn<
        PluginRuntime["agent"]["resolveCliBackendDispatchEligibilityAsync"]
      >(async () => undefined),
      normalizeThinkingLevel:
        vi.fn<PluginRuntime["agent"]["normalizeThinkingLevel"]>(normalizeThinkLevel),
      resolveThinkingPolicy: vi.fn<PluginRuntime["agent"]["resolveThinkingPolicy"]>(() => ({
        levels: [
          { id: "off", label: "off" },
          { id: "minimal", label: "minimal" },
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
        ],
      })),
      runCommandFromIngress: vi.fn<PluginRuntime["agent"]["runCommandFromIngress"]>(),
      runEmbeddedAgent: runEmbeddedAgentMock,
      resolveAgentTimeoutMs: vi.fn<PluginRuntime["agent"]["resolveAgentTimeoutMs"]>(() => 30_000),
      ensureAgentWorkspace: vi
        .fn<PluginRuntime["agent"]["ensureAgentWorkspace"]>()
        .mockResolvedValue({ dir: "/tmp/workspace" }),
      session: {
        resolveStorePath: vi.fn<PluginRuntime["agent"]["session"]["resolveStorePath"]>(
          () => "/tmp/agent-sessions.json",
        ),
        createSessionEntry: vi.fn(
          async (
            params: Parameters<PluginRuntime["agent"]["session"]["createSessionEntry"]>[0],
          ) => {
            const sessionId = "plugin-runtime-mock-session";
            const key = params.key;
            const sessionInitialEntry =
              "acpSessionBinding" in params.initialEntry
                ? {
                    acpSessionBinding: {
                      acpBackendId: params.initialEntry.acpBackendId,
                      ...params.initialEntry.acpSessionBinding,
                    },
                    ...(params.initialEntry.modelSelectionLocked
                      ? { modelSelectionLocked: true as const }
                      : {}),
                    ...(params.initialEntry.pluginExtensions
                      ? { pluginExtensions: structuredClone(params.initialEntry.pluginExtensions) }
                      : {}),
                    ...(params.initialEntry.pluginOwnerId
                      ? { pluginOwnerId: params.initialEntry.pluginOwnerId }
                      : {}),
                  }
                : structuredClone(params.initialEntry);
            const initialEntry = {
              sessionId,
              updatedAt: Date.now(),
              ...(params.label !== undefined ? { label: params.label } : {}),
              ...(params.spawnedCwd !== undefined ? { spawnedCwd: params.spawnedCwd } : {}),
              ...sessionInitialEntry,
              ...(params.afterCreate ? { initializationPending: true as const } : {}),
            };
            const initialized = {
              key,
              agentId: params.agentId ?? "main",
              sessionId,
              entry: initialEntry,
            };
            const finalPatch = await params.afterCreate?.(structuredClone(initialized));
            if (finalPatch !== undefined) {
              const patchKeys = Object.keys(finalPatch);
              if (patchKeys.length !== 1 || patchKeys[0] !== "pluginExtensions") {
                throw new Error("session creation final patch may only contain pluginExtensions");
              }
            }
            return {
              ...initialized,
              entry:
                params.afterCreate === undefined
                  ? initialEntry
                  : {
                      ...initialEntry,
                      ...(finalPatch === undefined
                        ? {}
                        : {
                            pluginExtensions: structuredClone(finalPatch.pluginExtensions),
                          }),
                      initializationPending: undefined,
                    },
            };
          },
        ) as PluginRuntime["agent"]["session"]["createSessionEntry"],
        getSessionEntry: vi.fn<PluginRuntime["agent"]["session"]["getSessionEntry"]>(
          () => undefined,
        ),
        getSessionEntryAsync: vi
          .fn<PluginRuntime["agent"]["session"]["getSessionEntryAsync"]>()
          .mockResolvedValue(undefined),
        getSessionEntryByIdAsync: vi
          .fn<PluginRuntime["agent"]["session"]["getSessionEntryByIdAsync"]>()
          .mockResolvedValue(undefined),
        listSessionEntries: vi.fn<PluginRuntime["agent"]["session"]["listSessionEntries"]>(
          () => [],
        ),
        listSessionEntriesAsync: vi
          .fn<PluginRuntime["agent"]["session"]["listSessionEntriesAsync"]>()
          .mockResolvedValue([]),
        createSessionEntryListReader: vi
          .fn<PluginRuntime["agent"]["session"]["createSessionEntryListReader"]>()
          .mockResolvedValue(async () => ({ entries: [], assertCurrent: () => {} })),
        prepareSessionEntryPatch: vi
          .fn<PluginRuntime["agent"]["session"]["prepareSessionEntryPatch"]>()
          .mockResolvedValue(null),
        patchSessionEntry: vi
          .fn<PluginRuntime["agent"]["session"]["patchSessionEntry"]>()
          .mockResolvedValue(null),
        upsertSessionEntry: vi
          .fn<PluginRuntime["agent"]["session"]["upsertSessionEntry"]>()
          .mockResolvedValue(undefined),
        runWithWorkAdmission: vi.fn(
          async (_params, run) => await run(new AbortController().signal),
        ) as PluginRuntime["agent"]["session"]["runWithWorkAdmission"],
        updateSessionStoreEntry: vi
          .fn<PluginRuntime["agent"]["session"]["updateSessionStoreEntry"]>()
          .mockResolvedValue(null),
      },
    },
    system: createPluginSystemRuntimeMock(),
    media: {
      loadWebMedia: vi.fn<PluginRuntime["media"]["loadWebMedia"]>(),
      detectMime: vi.fn<PluginRuntime["media"]["detectMime"]>(),
      mediaKindFromMime: vi.fn<PluginRuntime["media"]["mediaKindFromMime"]>(),
      isVoiceCompatibleAudio: vi.fn<PluginRuntime["media"]["isVoiceCompatibleAudio"]>(),
      getImageMetadata: vi.fn<PluginRuntime["media"]["getImageMetadata"]>(),
      resizeToJpeg: vi.fn<PluginRuntime["media"]["resizeToJpeg"]>(),
    },
    tts: {
      prepareTtsRequest: vi.fn<PluginRuntime["tts"]["prepareTtsRequest"]>(),
      textToSpeech: vi.fn<PluginRuntime["tts"]["textToSpeech"]>(),
      textToSpeechStream: vi.fn<PluginRuntime["tts"]["textToSpeechStream"]>(),
      textToSpeechTelephony: vi.fn<PluginRuntime["tts"]["textToSpeechTelephony"]>(),
      listVoices: vi.fn<PluginRuntime["tts"]["listVoices"]>(),
    },
    mediaUnderstanding: {
      resolveAudioInputBudget: vi
        .fn<PluginRuntime["mediaUnderstanding"]["resolveAudioInputBudget"]>()
        .mockResolvedValue({ enabled: true, maxBytes: 20 * 1024 * 1024 }),
      runFile: vi.fn<PluginRuntime["mediaUnderstanding"]["runFile"]>(),
      describeImageFile: vi.fn<PluginRuntime["mediaUnderstanding"]["describeImageFile"]>(),
      describeImageFileWithModel:
        vi.fn<PluginRuntime["mediaUnderstanding"]["describeImageFileWithModel"]>(),
      extractStructuredWithModel:
        vi.fn<PluginRuntime["mediaUnderstanding"]["extractStructuredWithModel"]>(),
      describeVideoFile: vi.fn<PluginRuntime["mediaUnderstanding"]["describeVideoFile"]>(),
      transcribeAudioFile: vi.fn<PluginRuntime["mediaUnderstanding"]["transcribeAudioFile"]>(),
    },
    imageGeneration: {
      generate: vi.fn<PluginRuntime["imageGeneration"]["generate"]>(),
      listProviders: vi.fn<PluginRuntime["imageGeneration"]["listProviders"]>(),
    },
    musicGeneration: {
      generate: vi.fn<PluginRuntime["musicGeneration"]["generate"]>(),
      listProviders: vi.fn<PluginRuntime["musicGeneration"]["listProviders"]>(),
    },
    videoGeneration: {
      generate: vi.fn<PluginRuntime["videoGeneration"]["generate"]>(),
      listProviders: vi.fn<PluginRuntime["videoGeneration"]["listProviders"]>(),
    },
    webSearch: {
      listProviders: vi.fn<PluginRuntime["webSearch"]["listProviders"]>(),
      search: vi.fn<PluginRuntime["webSearch"]["search"]>(),
    },
    channel: {
      text: {
        chunkByNewline: vi.fn((text: string) => (text ? [text] : [])),
        chunkMarkdownText: vi.fn((text: string) => [text]),
        chunkMarkdownTextWithMode: vi.fn((text: string) => (text ? [text] : [])),
        chunkText: vi.fn((text: string) => (text ? [text] : [])),
        chunkTextWithMode: vi.fn((text: string) => (text ? [text] : [])),
        resolveChunkMode: vi.fn<PluginRuntime["channel"]["text"]["resolveChunkMode"]>(
          () => "length",
        ),
        resolveTextChunkLimit: vi.fn(() => 4000),
        hasControlCommand: vi.fn(() => false),
        resolveMarkdownTableMode: vi.fn<
          PluginRuntime["channel"]["text"]["resolveMarkdownTableMode"]
        >(() => "code"),
        convertMarkdownTables: vi.fn((text: string) => text),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn<
          PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
        >(async () => ({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        })),
        createReplyDispatcherWithTyping:
          vi.fn<PluginRuntime["channel"]["reply"]["createReplyDispatcherWithTyping"]>(),
        resolveEffectiveMessagesConfig:
          vi.fn<PluginRuntime["channel"]["reply"]["resolveEffectiveMessagesConfig"]>(),
        resolveHumanDelayConfig:
          vi.fn<PluginRuntime["channel"]["reply"]["resolveHumanDelayConfig"]>(),
        dispatchReplyFromConfig:
          vi.fn<PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"]>(),
        settleReplyDispatcher: vi.fn<PluginRuntime["channel"]["reply"]["settleReplyDispatcher"]>(
          async ({ dispatcher, onSettled }) => {
            dispatcher.markComplete();
            try {
              await dispatcher.waitForIdle();
            } finally {
              await onSettled?.();
            }
          },
        ),
        withReplyDispatcher: createGenericMock<
          PluginRuntime["channel"]["reply"]["withReplyDispatcher"]
        >(
          async ({
            dispatcher,
            run,
            onSettled,
          }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
            try {
              return await run();
            } finally {
              dispatcher.markComplete();
              try {
                await dispatcher.waitForIdle();
              } finally {
                await onSettled?.();
              }
            }
          },
        ),
        finalizeInboundContext: createGenericMock<
          PluginRuntime["channel"]["reply"]["finalizeInboundContext"]
        >((ctx: Record<string, unknown>) => ctx),
        formatAgentEnvelope: vi.fn<PluginRuntime["channel"]["reply"]["formatAgentEnvelope"]>(
          (opts: { body: string }) => opts.body,
        ),
        resolveEnvelopeFormatOptions: vi.fn<
          PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"]
        >(() => ({})),
      },
      routing: {
        buildAgentSessionKey: vi.fn<PluginRuntime["channel"]["routing"]["buildAgentSessionKey"]>(
          ({ agentId, channel, peer }) =>
            `agent:${agentId}:${channel}:${peer?.kind ?? "direct"}:${peer?.id ?? "peer"}`,
        ),
        resolveAgentRoute: vi.fn<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>(() => ({
          agentId: "main",
          channel: "test",
          accountId: "default",
          sessionKey: "agent:main:test:dm:peer",
          mainSessionKey: "agent:main:main",
          lastRoutePolicy: "session",
          matchedBy: "default",
        })),
      },
      pairing: {
        buildPairingReply: vi.fn<PluginRuntime["channel"]["pairing"]["buildPairingReply"]>(
          () => "Pairing code: TESTCODE",
        ),
        readAllowFromStore: vi
          .fn<PluginRuntime["channel"]["pairing"]["readAllowFromStore"]>()
          .mockResolvedValue([]),
        removeAllowFromStoreEntry: vi
          .fn<PluginRuntime["channel"]["pairing"]["removeAllowFromStoreEntry"]>()
          .mockResolvedValue({
            changed: false,
            allowFrom: [],
          }),
        upsertPairingRequest: vi
          .fn<PluginRuntime["channel"]["pairing"]["upsertPairingRequest"]>()
          .mockResolvedValue({
            code: "TESTCODE",
            created: true,
          }),
      },
      media: createPluginRuntimeMediaMock(),
      session: sessionRuntime,
      mentions: {
        buildMentionRegexes: vi.fn<PluginRuntime["channel"]["mentions"]["buildMentionRegexes"]>(
          () => [/\bbert\b/i],
        ),
        matchesMentionPatterns: vi.fn<
          PluginRuntime["channel"]["mentions"]["matchesMentionPatterns"]
        >((text: string, regexes: RegExp[]) => regexes.some((regex) => regex.test(text))),
        matchesMentionWithExplicit: vi.fn<
          PluginRuntime["channel"]["mentions"]["matchesMentionWithExplicit"]
        >((params: { text: string; mentionRegexes: RegExp[]; explicitWasMentioned?: boolean }) =>
          params.explicitWasMentioned === true
            ? true
            : params.mentionRegexes.some((regex) => regex.test(params.text)),
        ),
        implicitMentionKindWhen,
        resolveInboundMentionDecision,
      },
      reactions: {
        createAckReactionHandle,
        shouldAckReaction,
        removeAckReactionAfterReply,
        removeAckReactionHandleAfterReply,
      },
      groups: {
        resolveGroupPolicy: vi.fn<PluginRuntime["channel"]["groups"]["resolveGroupPolicy"]>(() => ({
          allowlistEnabled: false,
          allowed: true,
        })),
        resolveRequireMention: vi.fn<PluginRuntime["channel"]["groups"]["resolveRequireMention"]>(
          () => false,
        ),
      },
      debounce: {
        createInboundDebouncer: createGenericMock<
          PluginRuntime["channel"]["debounce"]["createInboundDebouncer"]
        >((params: Pick<InboundDebounceCreateParams<unknown>, "onFlush">) => {
          const activeCompletions = new Set<Promise<void>>();
          const runFlush = async (flush: InboundDebounceFlush) => {
            const completion = flush.completion.catch(() => undefined);
            activeCompletions.add(completion);
            void completion.finally(() => activeCompletions.delete(completion));
            await Promise.race([flush.admission, completion]);
          };
          return {
            shouldBuffer: vi.fn(() => false),
            enqueue: async (item: unknown) => {
              await runFlush(params.onFlush([item], createTestInboundDebounceFlush));
            },
            flushKey: vi.fn(),
            cancelKey: vi.fn(() => false),
            drain: async () => {
              await Promise.all(activeCompletions);
            },
          };
        }),
        resolveInboundDebounceMs:
          vi.fn<PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"]>(
            resolveInboundDebounceMs,
          ),
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn<
          PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"]
        >(() => false),
        isControlCommandMessage:
          vi.fn<PluginRuntime["channel"]["commands"]["isControlCommandMessage"]>(),
        shouldComputeCommandAuthorized:
          vi.fn<PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"]>(),
        shouldHandleTextCommands:
          vi.fn<PluginRuntime["channel"]["commands"]["shouldHandleTextCommands"]>(),
      },
      outbound: {
        loadAdapter: vi.fn<PluginRuntime["channel"]["outbound"]["loadAdapter"]>(),
      },
      inbound: inboundRuntime,
      turn: inboundRuntime,
      threadBindings: createPluginThreadBindingsRuntimeMock(),
      runtimeContexts: {
        register: vi.fn<PluginRuntime["channel"]["runtimeContexts"]["register"]>(
          runtimeContexts.register,
        ),
        get: createGenericMock<PluginRuntime["channel"]["runtimeContexts"]["get"]>(
          runtimeContexts.get,
        ),
        watch: vi.fn<PluginRuntime["channel"]["runtimeContexts"]["watch"]>(runtimeContexts.watch),
      },
      activity: {
        record: vi.fn(),
        get: vi.fn(() => ({ inboundAt: null, outboundAt: null })),
      },
    },
    events: {
      onAgentEvent: vi.fn<PluginRuntime["events"]["onAgentEvent"]>(() => () => {}),
      onSessionTranscriptUpdate: vi.fn<PluginRuntime["events"]["onSessionTranscriptUpdate"]>(
        () => () => {},
      ),
    },
    logging: {
      shouldLogVerbose: vi.fn(() => false),
      getChildLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
    state: createPluginStateRuntimeMock(),
    subagent: {
      complete: vi.fn(),
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      deleteSession: vi.fn(),
    },
    hooks: {
      dispatchHookAgentTurn: vi.fn(),
    },
    sandbox: {
      resolveWorkspaceAuthority: vi.fn(),
      prepareWorkspaceAuthority: vi.fn(),
    },
    worktrees: {
      resolveCheckoutRoot: vi.fn(),
      hasSelfContainedCheckoutMetadata: vi.fn(),
      create: vi.fn(),
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    },
    nodes: {
      list: vi.fn(async () => ({ nodes: [] })),
      invoke: vi.fn(),
      openDuplex: vi.fn(),
    },
  };

  const mergedRuntime = mergePluginRuntimeMockOverrides(base, overrides);
  return mergedRuntime;
}
