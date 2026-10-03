// Shared provider boundaries and setup for ACP dispatch and source-lifecycle tests.
import { detectMime } from "@openclaw/media-core/mime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, vi } from "vitest";
import type { MediaUnderstandingSkipError } from "../../../packages/media-understanding-common/src/errors.js";
import type { AcpSessionResolution } from "../../acp/control-plane/manager.types.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import type { HistoryEntry } from "./history.types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { createAcpSessionMeta, createAcpTestConfig } from "./test-fixtures/acp-runtime.js";
const managerMocks = vi.hoisted(() => ({
  resolveSessionAsync: vi.fn<() => Promise<AcpSessionResolution>>(),
  runTurn: vi.fn(),
  getObservabilitySnapshot: vi.fn(() => ({
    turns: { queueDepth: 0 },
    runtimeCache: { activeSessions: 0 },
  })),
}));

const auditMocks = vi.hoisted(() => ({
  emitAcpLifecycleStart: vi.fn(),
  emitAcpRuntimeEvent: vi.fn(),
  emitAcpLifecycleEnd: vi.fn(),
  emitAcpLifecycleError: vi.fn(),
}));

const policyMocks = vi.hoisted(() => ({
  resolveAcpDispatchPolicyError: vi.fn<(cfg: OpenClawConfig) => AcpRuntimeError | null>(() => null),
  resolveAcpAgentPolicyError: vi.fn<(cfg: OpenClawConfig, agent: string) => AcpRuntimeError | null>(
    () => null,
  ),
}));

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn<(_params: unknown) => ReturnType<typeof import("./route-reply.js").routeReply>>(
    async () => ({ ok: true, delivered: true, messageId: "mock" }),
  ),
}));

const channelPluginMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn((channelId: string) => {
    if (channelId !== "discord" && channelId !== "slack" && channelId !== "telegram") {
      return undefined;
    }
    return {
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      outbound: {
        shouldTreatDeliveredTextAsVisible: ({
          kind,
          text,
        }: {
          kind: "tool" | "block" | "final";
          text?: string;
        }) => kind === "block" && typeof text === "string" && text.trim().length > 0,
      },
    };
  }),
}));

const messageActionMocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(async (_params: unknown) => ({ ok: true as const })),
}));

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
}));

const ttsCapabilityMocks = vi.hoisted(() => ({ captionedFinalText: false }));

const mediaUnderstandingMocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn<
    (_params: unknown) => Promise<ApplyMediaUnderstandingResult | undefined>
  >(async () => undefined),
}));

const acpAttachmentBuffers = vi.hoisted(() => new Map<string, Buffer>());
export const ACP_PNG_IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);
export const ACP_JPEG_IMAGE_BYTES = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffd9",
  "hex",
);
export const ACP_PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");

const diagnosticMocks = vi.hoisted(() => ({
  markDiagnosticSessionProgress: vi.fn(),
}));

const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn<
    (params: { sessionKey: string; cfg?: OpenClawConfig }) => AcpSessionStoreEntry | null
  >(() => null),
}));

const transcriptMocks = vi.hoisted(() => ({
  persistAcpDispatchTranscript: vi.fn(async (_params: unknown) => undefined),
}));

const { mocks: bindingServiceMocks, module: bindingServiceModule } = await vi.hoisted(async () => {
  const { createAcpBindingMocks } = await import("./session-binding.test-mocks.js");
  const binding = createAcpBindingMocks(vi);
  const resolveByConversation = vi.fn<() => SessionBindingRecord | null>(() => null);
  return {
    mocks: { ...binding.mocks, resolveByConversation },
    module: {
      ...binding.module,
      getSessionBindingService: () => ({
        ...binding.mocks,
        resolveByConversationAsync: async () => resolveByConversation(),
        touchAsync: async () => {},
      }),
    },
  };
});

export {
  managerMocks,
  auditMocks,
  policyMocks,
  routeMocks,
  messageActionMocks,
  ttsMocks,
  ttsCapabilityMocks,
  mediaUnderstandingMocks,
  acpAttachmentBuffers,
  diagnosticMocks,
  sessionMetaMocks,
  transcriptMocks,
  bindingServiceMocks,
};

vi.mock("../../infra/outbound/session-binding-service.js", () => bindingServiceModule);
vi.mock("./dispatch-acp-manager.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dispatch-acp-manager.runtime.js")>()),
  getAcpSessionManager: () => managerMocks,
  readAcpSessionEntryAsync: async (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    sessionMetaMocks.readAcpSessionEntry(params),
}));

vi.mock("../../agents/command/acp-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/command/acp-lifecycle.js")>();
  return {
    createAcpToolLifecycleTracker: actual.createAcpToolLifecycleTracker,
    emitAcpLifecycleStart: auditMocks.emitAcpLifecycleStart,
    emitAcpRuntimeEvent: auditMocks.emitAcpRuntimeEvent,
    emitAcpLifecycleEnd: auditMocks.emitAcpLifecycleEnd,
    emitAcpLifecycleError: auditMocks.emitAcpLifecycleError,
    resolveAcpLifecycleEndFields: actual.resolveAcpLifecycleEndFields,
  };
});

vi.mock("../../acp/policy.js", () => ({
  resolveAcpDispatchPolicyError: (cfg: OpenClawConfig) =>
    policyMocks.resolveAcpDispatchPolicyError(cfg),
  resolveAcpAgentPolicyError: (cfg: OpenClawConfig, agent: string) =>
    policyMocks.resolveAcpAgentPolicyError(cfg, agent),
}));

vi.mock("./route-reply.runtime.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) => channelPluginMocks.getChannelPlugin(channelId),
  getLoadedChannelPlugin: (channelId: string) => channelPluginMocks.getChannelPlugin(channelId),
  normalizeChannelId: (channelId?: string | null) => channelId?.trim().toLowerCase() || null,
}));

vi.mock("../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: (params: unknown) => messageActionMocks.runMessageAction(params),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

vi.mock("../../tts/captioned-final.js", async () => {
  const actual = await vi.importActual<typeof import("../../tts/captioned-final.js")>(
    "../../tts/captioned-final.js",
  );
  return {
    ...actual,
    shouldDeferFinalTtsText: () => ttsCapabilityMocks.captionedFinalText,
  };
});

vi.mock("../../tts/status-config.js", () => ({
  resolveStatusTtsSnapshot: () => ({
    autoMode: "always",
    provider: "auto",
    maxLength: 1500,
    summarize: true,
  }),
}));

vi.mock("./dispatch-acp-media.runtime.js", async () => {
  const attachmentNormalization = await vi.importActual<
    typeof import("../../media-understanding/attachments.normalize.js")
  >("../../media-understanding/attachments.normalize.js");
  return {
    applyMediaUnderstanding: (params: unknown) =>
      mediaUnderstandingMocks.applyMediaUnderstanding(params),
    isImageAttachment: attachmentNormalization.isImageAttachment,
    isMediaUnderstandingSkipError: (error: unknown): error is MediaUnderstandingSkipError =>
      error instanceof Error && error.name === "MediaUnderstandingSkipError",
    normalizeAttachments: attachmentNormalization.normalizeAttachments,
    resolveMediaAttachmentLocalRoots: (params: {
      cfg: { channels?: Record<string, { attachmentRoots?: string[] } | undefined> };
      ctx: { Provider?: string; Surface?: string };
    }) => {
      const channel = params.ctx.Provider ?? params.ctx.Surface ?? "";
      return params.cfg.channels?.[channel]?.attachmentRoots ?? [];
    },
    MediaAttachmentCache: class {
      constructor(
        private readonly attachments: Array<{ path?: string; mime?: string; index: number }>,
      ) {}
      async getBuffer({ attachmentIndex }: { attachmentIndex: number }) {
        const attachment = this.attachments.find((item) => item.index === attachmentIndex);
        const pathLocal = attachment?.path;
        const buffer = pathLocal ? acpAttachmentBuffers.get(pathLocal) : undefined;
        if (buffer) {
          return {
            buffer,
            mime: await detectMime({
              buffer,
              filePath: pathLocal,
              headerMime: attachment?.mime,
            }),
            fileName: pathLocal,
            size: buffer.length,
          };
        }
        const error = new Error("outside allowed roots");
        error.name = "MediaUnderstandingSkipError";
        throw error;
      }
    },
  };
});

vi.mock("../../logging/diagnostic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/diagnostic.js")>()),
  markDiagnosticSessionProgress: diagnosticMocks.markDiagnosticSessionProgress,
}));

vi.mock("./dispatch-acp-transcript.runtime.js", () => ({
  persistAcpDispatchTranscript: (params: unknown) =>
    transcriptMocks.persistAcpDispatchTranscript(params),
}));

export const sessionKey = "agent:codex-acp:session-1";
const originalFetch = globalThis.fetch;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

export const requireRecord = createRequireRecord("object", "expected-label");

export function routeCall(index = 0) {
  return requireRecord(routeMocks.routeReply.mock.calls[index]?.[0], "route call");
}

export function routePayload(index = 0) {
  return requireRecord(routeCall(index).payload, `route payload ${index}`);
}

export function expectTranscript(fields: Record<string, unknown>) {
  expect(transcriptMocks.persistAcpDispatchTranscript).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining(fields),
  );
}

export function transcriptCall() {
  return requireRecord(
    transcriptMocks.persistAcpDispatchTranscript.mock.calls[0]?.[0],
    "transcript",
  );
}

export function runTurnCall(index = 0) {
  return requireRecord(managerMocks.runTurn.mock.calls[index]?.[0], "run turn");
}

export function dispatcherCall(
  fn:
    | ReplyDispatcher["sendToolResult"]
    | ReplyDispatcher["sendBlockReply"]
    | ReplyDispatcher["sendFinalReply"],
  index = 0,
) {
  return requireRecord((fn as unknown as MockCallSource).mock.calls[index]?.[0], "dispatcher call");
}

export function sessionBinding(
  targetSessionKey: string,
  accountId = "default",
): SessionBindingRecord {
  return {
    bindingId: `discord:${accountId}:thread-1`,
    targetSessionKey,
    targetKind: "session",
    status: "active",
    boundAt: 0,
    conversation: { channel: "discord", accountId, conversationId: "thread-1" },
  };
}

export function imageHistory(
  media: HistoryEntry["media"],
  overrides: Partial<HistoryEntry> = {},
): HistoryEntry {
  return {
    sender: "@alice",
    body: "<media:image>",
    timestamp: 1_700_000_000_000,
    media,
    ...overrides,
  };
}

export function liveConfig(tts: OpenClawConfig["tts"]) {
  return createAcpTestConfig({
    acp: { enabled: true, stream: { deliveryMode: "live" } },
    tts,
  });
}

export function mockToolLifecycleTurn(toolCallId: string) {
  managerMocks.runTurn.mockImplementation(
    async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
      await onEvent({
        type: "tool_call",
        tag: "tool_call",
        toolCallId,
        status: "in_progress",
        title: "Run command",
        text: "Run command (in_progress)",
      });
      await onEvent({
        type: "tool_call",
        tag: "tool_call_update",
        toolCallId,
        status: "completed",
        title: "Run command",
        text: "Run command (completed)",
      });
      await onEvent({ type: "done" });
    },
  );
}

export function mockVisibleTextTurn(text = "visible") {
  managerMocks.runTurn.mockImplementationOnce(
    async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
      await onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
      await onEvent({ type: "done" });
    },
  );
}

beforeEach(() => {
  auditMocks.emitAcpLifecycleStart.mockReset();
  auditMocks.emitAcpRuntimeEvent.mockReset();
  auditMocks.emitAcpLifecycleEnd.mockReset();
  auditMocks.emitAcpLifecycleError.mockReset();
  auditMocks.emitAcpLifecycleError.mockReturnValue({ reason: "failed", status: "error" });
  managerMocks.resolveSessionAsync.mockReset();
  managerMocks.resolveSessionAsync.mockResolvedValue({
    kind: "ready",
    sessionKey,
    agentId: "codex-acp",
    meta: createAcpSessionMeta(),
  });
  managerMocks.runTurn.mockReset();
  managerMocks.runTurn.mockImplementation(
    async ({ onEvent }: { onEvent?: (event: unknown) => Promise<void> }) => {
      await onEvent?.({ type: "done" });
    },
  );
  managerMocks.getObservabilitySnapshot.mockReset();
  managerMocks.getObservabilitySnapshot.mockReturnValue({
    turns: { queueDepth: 0 },
    runtimeCache: { activeSessions: 0 },
  });
  policyMocks.resolveAcpDispatchPolicyError.mockReset();
  policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(null);
  policyMocks.resolveAcpAgentPolicyError.mockReset();
  policyMocks.resolveAcpAgentPolicyError.mockReturnValue(null);
  routeMocks.routeReply.mockReset();
  routeMocks.routeReply.mockResolvedValue({
    ok: true,
    delivered: true,
    messageId: "mock",
  });
  channelPluginMocks.getChannelPlugin.mockClear();
  messageActionMocks.runMessageAction.mockReset();
  messageActionMocks.runMessageAction.mockResolvedValue({ ok: true as const });
  ttsMocks.maybeApplyTtsToPayload.mockReset();
  ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  });
  ttsCapabilityMocks.captionedFinalText = false;
  mediaUnderstandingMocks.applyMediaUnderstanding.mockReset();
  mediaUnderstandingMocks.applyMediaUnderstanding.mockResolvedValue(undefined);
  acpAttachmentBuffers.clear();
  diagnosticMocks.markDiagnosticSessionProgress.mockReset();
  sessionMetaMocks.readAcpSessionEntry.mockReset();
  sessionMetaMocks.readAcpSessionEntry.mockReturnValue(null);
  transcriptMocks.persistAcpDispatchTranscript.mockReset();
  transcriptMocks.persistAcpDispatchTranscript.mockResolvedValue(undefined);
  bindingServiceMocks.listBySession.mockReset();
  bindingServiceMocks.listBySession.mockReturnValue([]);
  bindingServiceMocks.resolveByConversation.mockReset();
  bindingServiceMocks.resolveByConversation.mockReturnValue(null);
  bindingServiceMocks.unbind.mockReset();
  bindingServiceMocks.unbind.mockResolvedValue([]);
  globalThis.fetch = originalFetch;
});
