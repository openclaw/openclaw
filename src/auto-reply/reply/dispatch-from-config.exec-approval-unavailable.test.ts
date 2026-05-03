import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type {
  PluginHookBeforeDispatchResult,
  PluginTargetedInboundClaimOutcome,
} from "../../plugins/hooks.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortResult = { handled: boolean; aborted: boolean; stoppedSubagents?: number };

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
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
    plugins: [] as Array<{
      id: string;
      status: "loaded" | "disabled" | "error";
    }>,
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
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));
const acpMocks = vi.hoisted(() => ({
  listAcpSessionEntries: vi.fn(async () => []),
  readAcpSessionEntry: vi.fn<() => unknown>(() => null),
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
const sessionStoreMocks = vi.hoisted(() => ({
  currentEntry: undefined as Record<string, unknown> | undefined,
  loadSessionStore: vi.fn(() => ({})),
  resolveStorePath: vi.fn(() => "/tmp/mock-sessions.json"),
  resolveSessionStoreEntry: vi.fn(() => ({ existing: sessionStoreMocks.currentEntry })),
}));
const agentEventMocks = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
}));
const ttsMocks = vi.hoisted(() => {
  const state = {
    synthesizeFinalAudio: false,
  };
  return {
    state,
    maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        payload: ReplyPayload;
        kind: "tool" | "block" | "final";
      };
      if (
        state.synthesizeFinalAudio &&
        params.kind === "final" &&
        typeof params.payload?.text === "string" &&
        params.payload.text.trim()
      ) {
        return {
          ...params.payload,
          mediaUrl: "https://example.com/tts-synth.opus",
          audioAsVoice: true,
        };
      }
      return params.payload;
    }),
    normalizeTtsAutoMode: vi.fn((value: unknown) =>
      typeof value === "string" ? value : undefined,
    ),
    resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
  };
});

vi.mock("./route-reply.runtime.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      [
        "telegram",
        "slack",
        "discord",
        "signal",
        "imessage",
        "whatsapp",
        "feishu",
        "mattermost",
      ].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./route-reply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./route-reply.js")>();
  return {
    ...actual,
    routeReply: mocks.routeReply,
  };
});

vi.mock("./abort.runtime.js", () => ({
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
  formatAbortReplyText: (stoppedSubagents?: number) => {
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return "⚙️ Agent was aborted.";
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.`;
  },
}));

vi.mock("../../logging/diagnostic.js", () => ({
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));
vi.mock("../../config/sessions/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/store.js")>();
  return {
    ...actual,
    loadSessionStore: sessionStoreMocks.loadSessionStore,
    resolveSessionStoreEntry: sessionStoreMocks.resolveSessionStoreEntry,
  };
});
vi.mock("../../config/sessions/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/paths.js")>();
  return {
    ...actual,
    resolveStorePath: sessionStoreMocks.resolveStorePath,
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
  getGlobalPluginRegistry: () => hookMocks.registry,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: acpMocks.listAcpSessionEntries,
  readAcpSessionEntry: acpMocks.readAcpSessionEntry,
  upsertAcpSessionMeta: acpMocks.upsertAcpSessionMeta,
}));
vi.mock("../../acp/runtime/registry.js", () => ({
  requireAcpRuntimeBackend: acpMocks.requireAcpRuntimeBackend,
}));
vi.mock("../../infra/outbound/session-binding-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/session-binding-service.js")>();
  return {
    ...actual,
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
  };
});
vi.mock("../../infra/agent-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/agent-events.js")>();
  return {
    ...actual,
    emitAgentEvent: (params: unknown) => agentEventMocks.emitAgentEvent(params),
  };
});
vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
  normalizeTtsAutoMode: (value: unknown) => ttsMocks.normalizeTtsAutoMode(value),
  resolveTtsConfig: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg),
}));
vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));
vi.mock("../../tts/tts-config.js", () => ({
  normalizeTtsAutoMode: (value: unknown) => ttsMocks.normalizeTtsAutoMode(value),
  resolveConfiguredTtsMode: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg).mode,
}));

const noAbortResult = { handled: false, aborted: false } as const;
const emptyConfig = {} as OpenClawConfig;
let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let acpManagerTesting: typeof import("../../acp/control-plane/manager.js").__testing;
let pluginBindingTesting: typeof import("../../plugins/conversation-binding.js").__testing;

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

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

describe("dispatchReplyFromConfig — resolveToolDeliveryPayload exec-approval-unavailable in group context", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    ({ __testing: acpManagerTesting } = await import("../../acp/control-plane/manager.js"));
    ({ __testing: pluginBindingTesting } = await import("../../plugins/conversation-binding.js"));
  });

  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    acpManagerTesting.resetAcpSessionManagerForTests();
    resetInboundDedupe();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    diagnosticMocks.logMessageQueued.mockClear();
    diagnosticMocks.logMessageProcessed.mockClear();
    diagnosticMocks.logSessionStateChange.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runInboundClaim.mockClear();
    hookMocks.runner.runInboundClaim.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockClear();
    hookMocks.runner.runInboundClaimForPlugin.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockClear();
    hookMocks.runner.runBeforeDispatch.mockClear();
    hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
    hookMocks.registry.plugins = [];
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
    acpMocks.readAcpSessionEntry.mockReset();
    acpMocks.readAcpSessionEntry.mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset();
    acpMocks.upsertAcpSessionMeta.mockResolvedValue(null);
    acpMocks.requireAcpRuntimeBackend.mockReset();
    agentEventMocks.emitAgentEvent.mockReset();
    sessionBindingMocks.listBySession.mockReset();
    sessionBindingMocks.listBySession.mockReturnValue([]);
    pluginBindingTesting.reset();
    sessionBindingMocks.resolveByConversation.mockReset();
    sessionBindingMocks.resolveByConversation.mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStore.mockClear();
    sessionStoreMocks.resolveStorePath.mockClear();
    sessionStoreMocks.resolveSessionStoreEntry.mockClear();
    ttsMocks.state.synthesizeFinalAudio = false;
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    ttsMocks.normalizeTtsAutoMode.mockClear();
    ttsMocks.resolveTtsConfig.mockClear();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    setNoAbort();
  });

  it("delivers exec-approval-unavailable tool result with channelData marker in group context", async () => {
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram", ChatType: "group" });

    const unavailablePayload: ReplyPayload = {
      text: "Exec approval is required, but no interactive approval client is currently available.",
      channelData: {
        execApprovalUnavailable: { reason: "no-approval-route" },
      },
    };

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ) => {
      if (opts?.onToolResult) {
        await opts.onToolResult(unavailablePayload);
      }
      return { text: "" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const delivered = (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReplyPayload;
    expect(delivered.channelData?.execApprovalUnavailable).toEqual({ reason: "no-approval-route" });
  });

  it("delivers exec-approval-pending tool result in group context (existing behavior preserved)", async () => {
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram", ChatType: "group" });

    const approvalPayload: ReplyPayload = {
      text: "Approval required.\nRun: /approve abc123 allow-once",
      channelData: {
        execApproval: {
          approvalId: "abc123",
          approvalSlug: "abc1",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
      },
    };

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ) => {
      if (opts?.onToolResult) {
        await opts.onToolResult(approvalPayload);
      }
      return { text: "" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const delivered = (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReplyPayload;
    expect(delivered.channelData?.execApproval).toBeDefined();
  });

  it("delivers exec-approval-unavailable with initiating-platform-disabled reason in group context", async () => {
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram", ChatType: "group" });

    const unavailablePayload: ReplyPayload = {
      text: "Exec approval is required, but chat exec approvals are not enabled on this platform.",
      channelData: {
        execApprovalUnavailable: { reason: "initiating-platform-disabled" },
      },
    };

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ) => {
      if (opts?.onToolResult) {
        await opts.onToolResult(unavailablePayload);
      }
      return { text: "" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const delivered = (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReplyPayload;
    expect(delivered.channelData?.execApprovalUnavailable).toEqual({
      reason: "initiating-platform-disabled",
    });
  });

  it("delivers exec-approval-unavailable with initiating-platform-unsupported reason in group context", async () => {
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram", ChatType: "group" });

    const unavailablePayload: ReplyPayload = {
      text: "Exec approval is required, but this platform does not support chat exec approvals.",
      channelData: {
        execApprovalUnavailable: { reason: "initiating-platform-unsupported" },
      },
    };

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ) => {
      if (opts?.onToolResult) {
        await opts.onToolResult(unavailablePayload);
      }
      return { text: "" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const delivered = (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReplyPayload;
    expect(delivered.channelData?.execApprovalUnavailable).toEqual({
      reason: "initiating-platform-unsupported",
    });
  });
});
