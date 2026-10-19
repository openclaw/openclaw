import { vi, type Mock } from "vitest";
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
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
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
import { createPluginThreadBindingsRuntimeMock } from "./plugin-runtime-thread-bindings-mock.js";

function resolved<T extends (...args: never[]) => unknown>(
  value: Parameters<Mock<T>["mockResolvedValue"]>[0],
) {
  return vi.fn<T>().mockResolvedValue(value);
}

function configWriteResult(
  nextConfig: OpenClawConfig,
): Awaited<ReturnType<PluginRuntime["config"]["replaceConfigFile"]>> {
  return {
    path: "/tmp/openclaw.json",
    previousHash: null,
    persistedHash: null,
    snapshot: TEST_CONFIG_SNAPSHOT,
    nextConfig,
    afterWrite: { mode: "auto" as const },
    followUp: { mode: "auto" as const, requiresRestart: false },
  };
}

async function settleReply({
  dispatcher,
  onSettled,
}: Parameters<Reply["settleReplyDispatcher"]>[0]): Promise<undefined> {
  dispatcher.markComplete();
  try {
    await dispatcher.waitForIdle();
  } finally {
    await onSettled?.();
  }
}

type AgentSession = PluginRuntime["agent"]["session"];
type Agent = PluginRuntime["agent"];
type Reply = PluginRuntime["channel"]["reply"];
type Pairing = PluginRuntime["channel"]["pairing"];
type Mentions = PluginRuntime["channel"]["mentions"];
type Commands = PluginRuntime["channel"]["commands"];
type Debounce = PluginRuntime["channel"]["debounce"];
type RuntimeContexts = PluginRuntime["channel"]["runtimeContexts"];
type Text = PluginRuntime["channel"]["text"];
type Groups = PluginRuntime["channel"]["groups"];
type Routing = PluginRuntime["channel"]["routing"];
type MediaUnderstanding = PluginRuntime["mediaUnderstanding"];

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
    saveRemoteMedia: resolved<PluginRuntimeMediaMock["saveRemoteMedia"]>(TEST_SAVED_MEDIA),
    saveResponseMedia: resolved<PluginRuntimeMediaMock["saveResponseMedia"]>(TEST_SAVED_MEDIA),
    saveMediaBuffer: resolved<PluginRuntimeMediaMock["saveMediaBuffer"]>(TEST_SAVED_MEDIA),
    deleteMediaBuffer: resolved<PluginRuntimeMediaMock["deleteMediaBuffer"]>(undefined),
    ...overrides,
  };
}

export function createPluginRuntimeMock(overrides: PluginRuntimeMockOverrides = {}): PluginRuntime {
  const runtimeContexts = createChannelRuntimeContextRegistry();
  const runEmbeddedAgentMock = resolved<Agent["runEmbeddedAgent"]>({
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
      current: vi.fn((): OpenClawConfig => ({})),
      mutateConfigFile: createGenericMock<PluginRuntime["config"]["mutateConfigFile"]>(
        async () => ({ ...configWriteResult({}), result: undefined }),
      ),
      replaceConfigFile: vi.fn<PluginRuntime["config"]["replaceConfigFile"]>(
        async ({ nextConfig }) => configWriteResult(nextConfig),
      ),
    },
    agent: {
      defaults: {
        model: DEFAULT_MODEL,
        provider: DEFAULT_PROVIDER,
      },
      resolveAgentDir: vi.fn<Agent["resolveAgentDir"]>(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn<Agent["resolveAgentWorkspaceDir"]>(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn<Agent["resolveAgentIdentity"]>(() => ({
        name: "test-agent",
      })),
      resolveSessionCatalogCreateTarget: vi.fn<Agent["resolveSessionCatalogCreateTarget"]>(
        resolveAgentCatalogCreateTarget,
      ),
      resolveThinkingDefault: vi.fn<Agent["resolveThinkingDefault"]>(() => "off"),
      resolveCliBackendDispatchEligibility: vi.fn<Agent["resolveCliBackendDispatchEligibility"]>(
        () => undefined,
      ),
      resolveCliBackendDispatchEligibilityAsync: vi.fn<
        Agent["resolveCliBackendDispatchEligibilityAsync"]
      >(async () => undefined),
      normalizeThinkingLevel: vi.fn<Agent["normalizeThinkingLevel"]>(normalizeThinkLevel),
      resolveThinkingPolicy: vi.fn<Agent["resolveThinkingPolicy"]>(() => ({
        levels: (["off", "minimal", "low", "medium", "high"] as const).map((id) => ({
          id,
          label: id,
        })),
      })),
      runCommandFromIngress: vi.fn<Agent["runCommandFromIngress"]>(),
      runEmbeddedAgent: runEmbeddedAgentMock,
      resolveAgentTimeoutMs: vi.fn<Agent["resolveAgentTimeoutMs"]>(() => 30_000),
      ensureAgentWorkspace: resolved<Agent["ensureAgentWorkspace"]>({ dir: "/tmp/workspace" }),
      session: {
        resolveStorePath: vi.fn<AgentSession["resolveStorePath"]>(() => "/tmp/agent-sessions.json"),
        createSessionEntry: vi.fn(
          async (params: Parameters<AgentSession["createSessionEntry"]>[0]) => {
            const sessionId = "plugin-runtime-mock-session";
            const { key, initialEntry: input } = params;
            const sessionInitialEntry =
              "acpSessionBinding" in input
                ? {
                    acpSessionBinding: {
                      acpBackendId: input.acpBackendId,
                      ...input.acpSessionBinding,
                    },
                    ...(input.modelSelectionLocked ? { modelSelectionLocked: true as const } : {}),
                    ...(input.pluginExtensions
                      ? { pluginExtensions: structuredClone(input.pluginExtensions) }
                      : {}),
                    ...(input.pluginOwnerId ? { pluginOwnerId: input.pluginOwnerId } : {}),
                  }
                : structuredClone(input);
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
        ) as AgentSession["createSessionEntry"],
        getSessionEntry: vi.fn<AgentSession["getSessionEntry"]>(() => undefined),
        getSessionEntryAsync: resolved<AgentSession["getSessionEntryAsync"]>(undefined),
        getSessionEntryByIdAsync: resolved<AgentSession["getSessionEntryByIdAsync"]>(undefined),
        listSessionEntries: vi.fn<AgentSession["listSessionEntries"]>(() => []),
        listSessionEntriesAsync: resolved<AgentSession["listSessionEntriesAsync"]>([]),
        createSessionEntryListReader: resolved<AgentSession["createSessionEntryListReader"]>(
          async () => ({ entries: [], assertCurrent: () => {} }),
        ),
        prepareSessionEntryPatch: resolved<AgentSession["prepareSessionEntryPatch"]>(null),
        patchSessionEntry: resolved<AgentSession["patchSessionEntry"]>(null),
        upsertSessionEntry: resolved<AgentSession["upsertSessionEntry"]>(undefined),
        runWithWorkAdmission: vi.fn(
          async (_params, run) => await run(new AbortController().signal),
        ) as AgentSession["runWithWorkAdmission"],
        updateSessionStoreEntry: resolved<AgentSession["updateSessionStoreEntry"]>(null),
      },
    },
    system: {
      enqueueSystemEvent: vi.fn<PluginRuntime["system"]["enqueueSystemEvent"]>(),
      requestHeartbeat: vi.fn<PluginRuntime["system"]["requestHeartbeat"]>(),
      requestHeartbeatNow: vi.fn<PluginRuntime["system"]["requestHeartbeatNow"]>(),
      runHeartbeatOnce: vi.fn<PluginRuntime["system"]["runHeartbeatOnce"]>(async () => ({
        status: "ran" as const,
        durationMs: 0,
      })),
      runCommandWithTimeout: vi.fn<PluginRuntime["system"]["runCommandWithTimeout"]>(),
      formatNativeDependencyHint: vi.fn<PluginRuntime["system"]["formatNativeDependencyHint"]>(
        () => "",
      ),
    },
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
      resolveAudioInputBudget: resolved<MediaUnderstanding["resolveAudioInputBudget"]>({
        enabled: true,
        maxBytes: 20 * 1024 * 1024,
      }),
      runFile: vi.fn<MediaUnderstanding["runFile"]>(),
      describeImageFile: vi.fn<MediaUnderstanding["describeImageFile"]>(),
      describeImageFileWithModel: vi.fn<MediaUnderstanding["describeImageFileWithModel"]>(),
      extractStructuredWithModel: vi.fn<MediaUnderstanding["extractStructuredWithModel"]>(),
      describeVideoFile: vi.fn<MediaUnderstanding["describeVideoFile"]>(),
      transcribeAudioFile: vi.fn<MediaUnderstanding["transcribeAudioFile"]>(),
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
      listProvidersAsync: vi.fn<PluginRuntime["webSearch"]["listProvidersAsync"]>(),
      search: vi.fn<PluginRuntime["webSearch"]["search"]>(),
    },
    channel: {
      text: {
        chunkByNewline: vi.fn((text: string) => (text ? [text] : [])),
        chunkMarkdownText: vi.fn((text: string) => [text]),
        chunkMarkdownTextWithMode: vi.fn((text: string) => (text ? [text] : [])),
        chunkText: vi.fn((text: string) => (text ? [text] : [])),
        chunkTextWithMode: vi.fn((text: string) => (text ? [text] : [])),
        resolveChunkMode: vi.fn<Text["resolveChunkMode"]>(() => "length"),
        resolveTextChunkLimit: vi.fn(() => 4000),
        hasControlCommand: vi.fn(() => false),
        resolveMarkdownTableMode: vi.fn<Text["resolveMarkdownTableMode"]>(() => "code"),
        convertMarkdownTables: vi.fn((text: string) => text),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn<
          Reply["dispatchReplyWithBufferedBlockDispatcher"]
        >(async () => ({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        })),
        createReplyDispatcherWithTyping: vi.fn<Reply["createReplyDispatcherWithTyping"]>(),
        resolveEffectiveMessagesConfig: vi.fn<Reply["resolveEffectiveMessagesConfig"]>(),
        resolveHumanDelayConfig: vi.fn<Reply["resolveHumanDelayConfig"]>(),
        dispatchReplyFromConfig: vi.fn<Reply["dispatchReplyFromConfig"]>(),
        settleReplyDispatcher: vi.fn<Reply["settleReplyDispatcher"]>(settleReply),
        withReplyDispatcher: createGenericMock<Reply["withReplyDispatcher"]>(
          async ({ dispatcher, run, onSettled }: Parameters<Reply["withReplyDispatcher"]>[0]) => {
            try {
              return await run();
            } finally {
              await settleReply({ dispatcher, onSettled });
            }
          },
        ),
        finalizeInboundContext: createGenericMock<Reply["finalizeInboundContext"]>(
          (ctx: Record<string, unknown>) => ctx,
        ),
        formatAgentEnvelope: vi.fn<Reply["formatAgentEnvelope"]>(
          (opts: { body: string }) => opts.body,
        ),
        resolveEnvelopeFormatOptions: vi.fn<Reply["resolveEnvelopeFormatOptions"]>(() => ({})),
      },
      routing: {
        buildAgentSessionKey: vi.fn<Routing["buildAgentSessionKey"]>(
          ({ agentId, channel, peer }) =>
            `agent:${agentId}:${channel}:${peer?.kind ?? "direct"}:${peer?.id ?? "peer"}`,
        ),
        resolveAgentRoute: vi.fn<Routing["resolveAgentRoute"]>(() => ({
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
        buildPairingReply: vi.fn<Pairing["buildPairingReply"]>(() => "Pairing code: TESTCODE"),
        readAllowFromStore: resolved<Pairing["readAllowFromStore"]>([]),
        removeAllowFromStoreEntry: resolved<Pairing["removeAllowFromStoreEntry"]>({
          changed: false,
          allowFrom: [],
        }),
        upsertPairingRequest: resolved<Pairing["upsertPairingRequest"]>({
          code: "TESTCODE",
          created: true,
        }),
      },
      media: createPluginRuntimeMediaMock(),
      session: sessionRuntime,
      mentions: {
        buildMentionRegexes: vi.fn<Mentions["buildMentionRegexes"]>(() => [/\bbert\b/i]),
        matchesMentionPatterns: vi.fn<Mentions["matchesMentionPatterns"]>(
          (text: string, regexes: RegExp[]) => regexes.some((regex) => regex.test(text)),
        ),
        matchesMentionWithExplicit: vi.fn<Mentions["matchesMentionWithExplicit"]>(
          (params: { text: string; mentionRegexes: RegExp[]; explicitWasMentioned?: boolean }) =>
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
        resolveGroupPolicy: vi.fn<Groups["resolveGroupPolicy"]>(() => ({
          allowlistEnabled: false,
          allowed: true,
        })),
        resolveRequireMention: vi.fn<Groups["resolveRequireMention"]>(() => false),
      },
      debounce: {
        createInboundDebouncer: createGenericMock<Debounce["createInboundDebouncer"]>(
          (params: Pick<InboundDebounceCreateParams<unknown>, "onFlush">) => {
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
          },
        ),
        resolveInboundDebounceMs:
          vi.fn<Debounce["resolveInboundDebounceMs"]>(resolveInboundDebounceMs),
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn<
          Commands["resolveCommandAuthorizedFromAuthorizers"]
        >(() => false),
        isControlCommandMessage: vi.fn<Commands["isControlCommandMessage"]>(),
        shouldComputeCommandAuthorized: vi.fn<Commands["shouldComputeCommandAuthorized"]>(),
        shouldHandleTextCommands: vi.fn<Commands["shouldHandleTextCommands"]>(),
      },
      outbound: {
        loadAdapter: vi.fn<PluginRuntime["channel"]["outbound"]["loadAdapter"]>(),
      },
      inbound: inboundRuntime,
      turn: inboundRuntime,
      threadBindings: createPluginThreadBindingsRuntimeMock(),
      runtimeContexts: {
        register: vi.fn<RuntimeContexts["register"]>(runtimeContexts.register),
        get: createGenericMock<RuntimeContexts["get"]>(runtimeContexts.get),
        watch: vi.fn<RuntimeContexts["watch"]>(runtimeContexts.watch),
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
      forkSession: vi.fn(),
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
