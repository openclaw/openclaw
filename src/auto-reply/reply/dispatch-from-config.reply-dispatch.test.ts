import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type {
  PluginHookBeforeDispatchResult,
  PluginHookReplyDispatchResult,
  PluginTargetedInboundClaimOutcome,
} from "../../plugins/hooks.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortResult = { handled: boolean; aborted: boolean; stoppedSubagents?: number };

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async () => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn<() => Promise<AbortResult>>(async () => ({
    handled: false,
    aborted: false,
  })),
}));
const diagnosticMocks = vi.hoisted(() => ({
  logMessageQueued: vi.fn(),
  logMessageProcessed: vi.fn(),
  logSessionStateChange: vi.fn(),
}));
const hookMocks = vi.hoisted(() => ({
  registry: {
    plugins: [] as Array<{ id: string; status: "loaded" | "disabled" | "error" }>,
  },
  runner: {
    hasHooks: vi.fn<(hookName?: string) => boolean>(() => false),
    runInboundClaim: vi.fn(async () => undefined),
    runInboundClaimForPlugin: vi.fn(async () => undefined),
    runInboundClaimForPluginOutcome: vi.fn<() => Promise<PluginTargetedInboundClaimOutcome>>(
      async () => ({ status: "no_handler" as const }),
    ),
    runMessageReceived: vi.fn(async () => {}),
    runBeforeDispatch: vi.fn<
      (_event: unknown, _ctx: unknown) => Promise<PluginHookBeforeDispatchResult | undefined>
    >(async () => undefined),
    runReplyDispatch: vi.fn<
      (_event: unknown, _ctx: unknown) => Promise<PluginHookReplyDispatchResult | undefined>
    >(async () => undefined),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));
const acpMocks = vi.hoisted(() => ({
  listAcpSessionEntries: vi.fn(async () => []),
  readAcpSessionEntry: vi.fn<(params: { sessionKey: string; cfg?: OpenClawConfig }) => unknown>(
    () => null,
  ),
  upsertAcpSessionMeta: vi.fn(async () => null),
  requireAcpRuntimeBackend: vi.fn<() => unknown>(),
}));
const sessionBindingMocks = vi.hoisted(() => ({
  listBySession: vi.fn<(targetSessionKey: string) => SessionBindingRecord[]>(() => []),
  resolveByConversation: vi.fn<
    (ref: {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    }) => SessionBindingRecord | null
  >(() => null),
  touch: vi.fn(),
}));
const pluginConversationBindingMocks = vi.hoisted(() => ({
  shownFallbackNoticeBindingIds: new Set<string>(),
}));
const sessionStoreMocks = vi.hoisted(() => ({
  currentEntry: undefined as Record<string, unknown> | undefined,
  loadSessionStore: vi.fn(() => ({})),
  resolveStorePath: vi.fn(() => "/tmp/mock-sessions.json"),
  resolveSessionStoreEntry: vi.fn(() => ({ existing: sessionStoreMocks.currentEntry })),
}));
const acpManagerRuntimeMocks = vi.hoisted(() => ({
  getAcpSessionManager: vi.fn(() => ({
    resolveSession: () => ({ kind: "none" as const }),
    getObservabilitySnapshot: () => ({
      runtimeCache: { activeSessions: 0, idleTtlMs: 0, evictedTotal: 0 },
      turns: {
        active: 0,
        queueDepth: 0,
        completed: 0,
        failed: 0,
        averageLatencyMs: 0,
        maxLatencyMs: 0,
      },
      errorsByCode: {},
    }),
    runTurn: vi.fn(),
  })),
}));
const agentEventMocks = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
  onAgentEvent: vi.fn<(listener: unknown) => () => void>(() => () => {}),
}));
const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: ReplyPayload };
    return params.payload;
  }),
  normalizeTtsAutoMode: vi.fn((value: unknown) => (typeof value === "string" ? value : undefined)),
  resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
}));
const threadInfoMocks = vi.hoisted(() => ({
  parseSessionThreadInfo: vi.fn<
    (sessionKey: string | undefined) => {
      baseSessionKey: string | undefined;
      threadId: string | undefined;
    }
  >(),
}));

function parseGenericThreadSessionInfo(sessionKey: string | undefined) {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return { baseSessionKey: undefined, threadId: undefined };
  }
  const threadMarker = ":thread:";
  const topicMarker = ":topic:";
  const marker = trimmed.includes(threadMarker)
    ? threadMarker
    : trimmed.includes(topicMarker)
      ? topicMarker
      : undefined;
  if (!marker) {
    return { baseSessionKey: trimmed, threadId: undefined };
  }
  const index = trimmed.lastIndexOf(marker);
  if (index < 0) {
    return { baseSessionKey: trimmed, threadId: undefined };
  }
  const baseSessionKey = trimmed.slice(0, index).trim() || undefined;
  const threadId = trimmed.slice(index + marker.length).trim() || undefined;
  return { baseSessionKey, threadId };
}

vi.mock("./route-reply.runtime.js", () => ({
  isRoutableChannel: () => true,
  routeReply: mocks.routeReply,
}));
vi.mock("./route-reply.js", () => ({
  isRoutableChannel: () => true,
  routeReply: mocks.routeReply,
}));
vi.mock("./abort.runtime.js", () => ({
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
  formatAbortReplyText: () => "⚙️ Agent was aborted.",
}));
vi.mock("../../logging/diagnostic.js", () => ({
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));
vi.mock("../../config/sessions/thread-info.js", () => ({
  parseSessionThreadInfo: (sessionKey: string | undefined) =>
    threadInfoMocks.parseSessionThreadInfo(sessionKey),
}));
vi.mock("./dispatch-from-config.runtime.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  loadSessionStore: sessionStoreMocks.loadSessionStore,
  resolveSessionStoreEntry: sessionStoreMocks.resolveSessionStoreEntry,
  resolveStorePath: sessionStoreMocks.resolveStorePath,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
  getGlobalPluginRegistry: () => hookMocks.registry,
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: acpMocks.listAcpSessionEntries,
  readAcpSessionEntry: acpMocks.readAcpSessionEntry,
  upsertAcpSessionMeta: acpMocks.upsertAcpSessionMeta,
}));
vi.mock("../../acp/runtime/registry.js", () => ({
  requireAcpRuntimeBackend: acpMocks.requireAcpRuntimeBackend,
}));
vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    bind: vi.fn(async () => {
      throw new Error("bind not mocked");
    }),
    getCapabilities: vi.fn(() => ({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"] as const,
    })),
    listBySession: (targetSessionKey: string) =>
      sessionBindingMocks.listBySession(targetSessionKey),
    resolveByConversation: sessionBindingMocks.resolveByConversation,
    touch: sessionBindingMocks.touch,
    unbind: vi.fn(async () => []),
  }),
}));
vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: (params: unknown) => agentEventMocks.emitAgentEvent(params),
  onAgentEvent: (listener: unknown) => agentEventMocks.onAgentEvent(listener),
}));
vi.mock("../../plugins/conversation-binding.js", () => ({
  buildPluginBindingDeclinedText: () => "Plugin binding request was declined.",
  buildPluginBindingErrorText: () => "Plugin binding request failed.",
  buildPluginBindingUnavailableText: (binding: { pluginName?: string; pluginId: string }) =>
    `${binding.pluginName ?? binding.pluginId} is not currently loaded.`,
  hasShownPluginBindingFallbackNotice: (bindingId: string) =>
    pluginConversationBindingMocks.shownFallbackNoticeBindingIds.has(bindingId),
  isPluginOwnedSessionBindingRecord: (
    record: SessionBindingRecord | null | undefined,
  ): record is SessionBindingRecord =>
    record?.metadata != null &&
    typeof record.metadata === "object" &&
    (record.metadata as { pluginBindingOwner?: string }).pluginBindingOwner === "plugin",
  markPluginBindingFallbackNoticeShown: (bindingId: string) => {
    pluginConversationBindingMocks.shownFallbackNoticeBindingIds.add(bindingId);
  },
  toPluginConversationBinding: (record: SessionBindingRecord) => ({
    bindingId: record.bindingId,
    pluginId: "unknown-plugin",
    pluginName: undefined,
    pluginRoot: "",
    channel: record.conversation.channel,
    accountId: record.conversation.accountId,
    conversationId: record.conversation.conversationId,
    parentConversationId: record.conversation.parentConversationId,
  }),
}));
vi.mock("./dispatch-acp-manager.runtime.js", () => ({
  getAcpSessionManager: () => acpManagerRuntimeMocks.getAcpSessionManager(),
  getSessionBindingService: () => ({
    listBySession: (targetSessionKey: string) =>
      sessionBindingMocks.listBySession(targetSessionKey),
    unbind: vi.fn(async () => []),
  }),
}));
vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
  normalizeTtsAutoMode: (value: unknown) => ttsMocks.normalizeTtsAutoMode(value),
  resolveTtsConfig: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg),
}));
vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));
vi.mock("../../tts/status-config.js", () => ({
  resolveStatusTtsSnapshot: () => ({
    autoMode: "always",
    provider: "auto",
    maxLength: 1500,
    summarize: true,
  }),
}));
vi.mock("./dispatch-acp-tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));
vi.mock("./dispatch-acp-session.runtime.js", () => ({
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    acpMocks.readAcpSessionEntry(params),
}));
vi.mock("../../tts/tts-config.js", () => ({
  normalizeTtsAutoMode: (value: unknown) => ttsMocks.normalizeTtsAutoMode(value),
  resolveConfiguredTtsMode: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg).mode,
}));

const emptyConfig = {} as OpenClawConfig;
let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function createHookCtx() {
  return buildTestCtx({
    Body: "hello",
    BodyForAgent: "hello",
    BodyForCommands: "hello",
    From: "user1",
    Surface: "telegram",
    ChatType: "private",
    SessionKey: "agent:test:session",
  });
}

describe("dispatchReplyFromConfig reply_dispatch hook", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  });

  beforeEach(() => {
    const discordTestPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        capabilities: { chatTypes: ["direct"], nativeCommands: true },
      }),
      outbound: {
        deliveryMode: "direct",
        shouldSuppressLocalPayloadPrompt: () => false,
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordTestPlugin }]),
    );
    resetInboundDedupe();
    mocks.routeReply.mockReset().mockResolvedValue({ ok: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset().mockResolvedValue({
      handled: false,
      aborted: false,
    });
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runInboundClaim.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome.mockReset().mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runBeforeDispatch.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockReset().mockResolvedValue(undefined);
    internalHookMocks.createInternalHookEvent.mockReset();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset().mockResolvedValue(undefined);
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    pluginConversationBindingMocks.shownFallbackNoticeBindingIds.clear();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStore.mockReset().mockReturnValue({});
    sessionStoreMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/mock-sessions.json");
    sessionStoreMocks.resolveSessionStoreEntry.mockReset().mockReturnValue({ existing: undefined });
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockImplementation(() => ({
      resolveSession: () => ({ kind: "none" as const }),
      getObservabilitySnapshot: () => ({
        runtimeCache: { activeSessions: 0, idleTtlMs: 0, evictedTotal: 0 },
        turns: {
          active: 0,
          queueDepth: 0,
          completed: 0,
          failed: 0,
          averageLatencyMs: 0,
          maxLatencyMs: 0,
        },
        errorsByCode: {},
      }),
      runTurn: vi.fn(),
    }));
    agentEventMocks.emitAgentEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReset().mockImplementation(() => () => {});
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    ttsMocks.maybeApplyTtsToPayload
      .mockReset()
      .mockImplementation(async (paramsUnknown: unknown) => {
        const params = paramsUnknown as { payload: ReplyPayload };
        return params.payload;
      });
    ttsMocks.normalizeTtsAutoMode
      .mockReset()
      .mockImplementation((value: unknown) => (typeof value === "string" ? value : undefined));
    ttsMocks.resolveTtsConfig.mockReset().mockReturnValue({ mode: "final" });
    threadInfoMocks.parseSessionThreadInfo
      .mockReset()
      .mockImplementation(parseGenericThreadSessionInfo);
  });

  it("returns handled dispatch results from plugins", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "model reply" }),
    });

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:test:session",
        sendPolicy: "allow",
        inboundAudio: false,
      }),
      expect.objectContaining({
        cfg: emptyConfig,
      }),
    );
    expect(result).toEqual({
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });
  });

  it("still applies send-policy deny after an unhandled plugin dispatch", async () => {
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: false,
    });

    const result = await dispatchReplyFromConfig({
      ctx: createHookCtx(),
      cfg: {
        ...emptyConfig,
        session: {
          sendPolicy: { default: "deny" },
        },
      },
      dispatcher: createDispatcher(),
      replyResolver: async () => ({ text: "model reply" }),
    });

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalled();
    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
  });
});
