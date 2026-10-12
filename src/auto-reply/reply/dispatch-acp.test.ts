import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type { AcpElicitationHandler } from "@openclaw/acp-core/runtime/types";
import { detectMime } from "@openclaw/media-core/mime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import type { MediaUnderstandingSkipError } from "../../../packages/media-understanding-common/src/errors.js";
import { createTestChannelIngressOwner } from "../../../test/helpers/channel-admission-evidence.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AcpSessionResolution } from "../../acp/control-plane/manager.types.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../channels/inbound-event/host-context-builder.js";
import { createChannelAdmissionAudit } from "../../channels/message-access/admission-evidence.js";
import { createHostChannelIngressRuntime } from "../../channels/message-access/runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ReplyDispatchRun } from "../get-reply-options.types.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { expectAcpSessionParticipantInput } from "./dispatch-acp.participant.test-support.js";
import { runDispatch } from "./dispatch-acp.test-support.js";
import { createAbortAwareDispatcher } from "./dispatch-from-config.abort.js";
import type { HistoryEntry } from "./history.types.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { buildTestCtx } from "./test-ctx.js";
import {
  createAcpSessionMeta,
  createAcpTestConfig,
  createAcpTestReplyDispatcherFixture as createDispatcher,
} from "./test-fixtures/acp-runtime.js";

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
const ACP_PNG_IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);
const ACP_JPEG_IMAGE_BYTES = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const ACP_PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");

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
  return createAcpBindingMocks(vi);
});

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

vi.mock("./route-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./route-reply.js")>()),
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

vi.mock("../../logging/diagnostic.js", () => ({
  markDiagnosticSessionProgress: diagnosticMocks.markDiagnosticSessionProgress,
}));

vi.mock("./dispatch-acp-transcript.runtime.js", () => ({
  persistAcpDispatchTranscript: (params: unknown) =>
    transcriptMocks.persistAcpDispatchTranscript(params),
}));

const sessionKey = "agent:codex-acp:session-1";
const originalFetch = globalThis.fetch;
type MockTtsReply = Awaited<ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>>;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

const requireRecord = createRequireRecord("object", "expected-label");

function routeCall(index = 0) {
  return requireRecord(routeMocks.routeReply.mock.calls[index]?.[0], "route call");
}

function routePayload(index = 0) {
  return requireRecord(routeCall(index).payload, `route payload ${index}`);
}

function expectTranscript(fields: Record<string, unknown>) {
  expect(transcriptMocks.persistAcpDispatchTranscript).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining(fields),
  );
}

function runTurnCall(index = 0) {
  return requireRecord(managerMocks.runTurn.mock.calls[index]?.[0], "run turn");
}

function dispatcherCall(
  fn:
    | ReplyDispatcher["sendToolResult"]
    | ReplyDispatcher["sendBlockReply"]
    | ReplyDispatcher["sendFinalReply"],
  index = 0,
) {
  return requireRecord((fn as unknown as MockCallSource).mock.calls[index]?.[0], "dispatcher call");
}

function sessionBinding(targetSessionKey: string, accountId = "default"): SessionBindingRecord {
  return {
    bindingId: `discord:${accountId}:thread-1`,
    targetSessionKey,
    targetKind: "session",
    status: "active",
    boundAt: 0,
    conversation: { channel: "discord", accountId, conversationId: "thread-1" },
  };
}

function imageHistory(
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

function liveConfig(tts: OpenClawConfig["tts"]) {
  return createAcpTestConfig({
    acp: { enabled: true, stream: { deliveryMode: "live" } },
    tts,
  });
}

function mockToolLifecycleTurn(toolCallId: string) {
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

function mockVisibleTextTurn(text = "visible") {
  managerMocks.runTurn.mockImplementationOnce(
    async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
      await onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
      await onEvent({ type: "done" });
    },
  );
}

describe("tryDispatchAcpReplyCore", () => {
  it("records an accepted channel input in the canonical participant store", async () => {
    await expectAcpSessionParticipantInput(sessionKey, async () => {
      await runDispatch({ bodyForAgent: "hello", ctxOverrides: { SenderId: "participant" } });
    });
  });
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
    routeMocks.routeReply.mockReset().mockResolvedValue({
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
    transcriptMocks.persistAcpDispatchTranscript.mockClear();
    bindingServiceMocks.listBySession.mockReset();
    bindingServiceMocks.listBySession.mockReturnValue([]);
    bindingServiceMocks.unbind.mockReset();
    bindingServiceMocks.unbind.mockResolvedValue([]);
    globalThis.fetch = originalFetch;
  });

  it("admits ACP message turns with the original channel participant", async () => {
    const captured: unknown[] = [];
    const audit = createChannelAdmissionAudit({ enabled: true });
    const clearSink = configureExecutionIdentityAdmissionSink((work) => {
      captured.push(work);
      return true;
    });
    const owner = createTestChannelIngressOwner({ audit, channelId: "discord" });
    try {
      const channelIngress = await createHostChannelIngressRuntime(owner).resolveStable({
        channelId: "discord",
        accountId: "default",
        subject: { stableId: "person-42" },
        conversation: { kind: "group", id: "room-1" },
        contextBinding: {
          agentId: "main",
          sessionKey,
          messageId: "msg-acp",
          inboundEventKind: "user_request",
        },
        dmPolicy: "open",
        groupPolicy: "open",
      });
      const buildContext = createHostChannelInboundEventContextBuilder(
        buildChannelInboundEventContext,
        owner,
      );
      const ctx = finalizeInboundContext(
        await buildContext({
          channel: "discord",
          accountId: "default",
          messageId: "msg-acp",
          from: "discord:channel:room-1",
          sender: { id: "person-42" },
          conversation: { kind: "group", id: "room-1" },
          route: { agentId: "main", routeSessionKey: sessionKey },
          reply: { to: "discord:channel:room-1" },
          message: { rawBody: "run acp", bodyForAgent: "run acp" },
          channelIngress,
        }),
      );

      await runDispatch({
        bodyForAgent: "run acp",
        cfg: createAcpTestConfig({ logging: { audit: { executionIdentity: true } } }),
        ctx,
      });

      expect(captured).toMatchObject([
        {
          kind: "capture",
          envelope: {
            ingress: { kind: "acp", state: "present" },
            invoker: { state: "present", kind: "person" },
          },
        },
      ]);
    } finally {
      clearSink();
      audit.close();
    }
  });

  it("passes one turn-scoped elicitation handler and fences it after admission closes", async () => {
    let onElicitation: AcpElicitationHandler | undefined;
    managerMocks.runTurn.mockImplementationOnce(async (input: unknown) => {
      const turn = input as {
        onElicitation?: typeof onElicitation;
        onEvent?: (event: unknown) => Promise<void>;
      };
      onElicitation = turn.onElicitation;
      await turn.onEvent?.({ type: "done" });
    });

    await runDispatch({ bodyForAgent: "ask me" });

    expect(onElicitation).toBeTypeOf("function");
    const response = await onElicitation!(
      {
        mode: "url",
        sessionId: "acp-session",
        message: "Continue",
        elicitationId: "url-1",
        url: "https://example.com",
      },
      { requestId: "rpc-1", signal: new AbortController().signal },
    );
    expect(response.action).toBe("cancel");
  });

  it("records one owner-bound unsupported native-action receipt after alias admission", async () => {
    const requestedSessionKey = "agent:legacy-acp:private-session";
    const ordering: string[] = [];
    const receipts: DecisionReceiptV1[] = [];
    const clearAdmission = configureExecutionIdentityAdmissionSink(() => {
      ordering.push("admission");
      return true;
    });
    const clearDecision = configureRuntimeActionDecisionSink((receipt) => {
      ordering.push("decision");
      receipts.push(receipt);
      return true;
    });
    managerMocks.resolveSessionAsync.mockResolvedValue({
      kind: "ready",
      sessionKey,
      agentId: "codex-acp",
      meta: createAcpSessionMeta({ agent: "private-agent-must-not-leak" }),
    });
    managerMocks.runTurn.mockImplementationOnce(
      async ({
        onLifecycle,
        onEvent,
      }: {
        onLifecycle?: (event: { type: "prompt_submitted"; at: number }) => void;
        onEvent?: (event: unknown) => Promise<void>;
      }) => {
        onLifecycle?.({ type: "prompt_submitted", at: 101 });
        onLifecycle?.({ type: "prompt_submitted", at: 102 });
        await onEvent?.({
          type: "tool_call",
          toolCallId: "private-tool-call",
          title: "adapter-private-marker",
        });
        await onEvent?.({ type: "done" });
      },
    );

    try {
      await runDispatch({
        bodyForAgent: "private prompt must not leak",
        cfg: createAcpTestConfig({ logging: { audit: { executionIdentity: true } } }),
        sessionKeyOverride: requestedSessionKey,
      });
    } finally {
      clearDecision();
      clearAdmission();
    }

    const admittedToken = requireRecord(
      requireRecord(runTurnCall().admittedRunContext, "admitted run context")
        .executionIdentityToken,
      "execution identity token",
    );
    expect(ordering).toEqual(["admission", "decision"]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      contextId: admittedToken.contextId,
      executionId: admittedToken.executionId,
      runId: admittedToken.runId,
      action: { family: "native-runtime", operation: "action-evidence" },
      decision: {
        outcome: "not-applicable",
        reasonCode: "native_action_callback_unsupported",
      },
      enforcement: { coverageState: "unsupported" },
      source: { owner: "acp-runtime" },
    });
    const serialized = JSON.stringify(receipts);
    expect(serialized.length).toBeLessThan(2_048);
    expect(serialized).not.toContain(requestedSessionKey);
    expect(serialized).not.toContain("private-session");
    expect(serialized).not.toContain("private-agent-must-not-leak");
    expect(serialized).not.toContain("private prompt must not leak");
    expect(serialized).not.toContain("private-tool-call");
    expect(serialized).not.toContain("adapter-private-marker");
  });

  it("does not transfer completion ownership to an asynchronous acknowledgement", async () => {
    await runDispatch({
      bodyForAgent: "audit this turn",
      runId: "caller-run",
      onAgentRunStart: () => Promise.resolve("reply-dispatch"),
    });

    const expected = expect.objectContaining({
      runId: "caller-run",
      auditOnly: false,
      completionSource: undefined,
    });
    expect(auditMocks.emitAcpLifecycleStart).toHaveBeenCalledWith(expected);
    expect(auditMocks.emitAcpLifecycleEnd).toHaveBeenCalledWith(expected);
  });

  it("reports uncertain question input when ACP notice delivery fails", async () => {
    routeMocks.routeReply.mockRejectedValueOnce(new Error("synthetic notice delivery failure"));
    const registration = registerPendingAgentQuestion({
      questionId: "synthetic-acp-question",
      sessionKey,
      questions: [
        { id: "answer", header: "Answer", question: "Continue?", options: [], isOther: true },
      ],
      gatewayCall: async () => {
        throw new Error("custom response lost");
      },
    });
    registration.attachRegistration(Promise.resolve());
    const { dispatcher } = createDispatcher();
    const recordProcessed = vi.fn();
    try {
      const result = await runDispatch({
        bodyForAgent: "candidate answer",
        dispatcher,
        shouldRouteToOriginating: true,
        suppressUserDelivery: false,
        recordProcessed,
      });
      expect(result).toMatchObject({ queuedFinal: false });
      expect(recordProcessed).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({ reason: "acp_question_answer_unconfirmed" }),
      );
      expect(managerMocks.runTurn).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(routePayload()).toMatchObject({
        isError: true,
        text: expect.stringContaining("confirmation was lost"),
      });
    } finally {
      registration.dispose();
    }
  });

  it("keeps same-provider tool-only ACP final replies private when an origin route exists", async () => {
    mockVisibleTextTurn("hidden final");
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    const result = await runDispatch({
      bodyForAgent: "reply via message tool if needed",
      dispatcher,
      onReplyStart,
      suppressUserDelivery: true,
      sourceReplyDeliveryMode: "message_tool_only",
      shouldRouteToOriginating: true,
      originatingChannel: "discord",
      originatingTo: "channel:C1",
    });

    expect(result?.queuedFinal).toBe(false);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
    expect(routeMocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "edits ACP tool updates with a new-message fallback on failure=%s",
    async (fails) => {
      mockToolLifecycleTurn("call-1");
      routeMocks.routeReply.mockResolvedValueOnce({
        ok: true,
        delivered: true,
        messageId: "tool-msg-1",
      });
      if (fails) {
        messageActionMocks.runMessageAction.mockRejectedValueOnce(new Error("edit unsupported"));
      }
      await runDispatch({
        bodyForAgent: "run tool",
        cfg: createAcpTestConfig({
          acp: {
            enabled: true,
            stream: { tagVisibility: { tool_call: true, tool_call_update: true } },
          },
        }),
        shouldRouteToOriginating: true,
      });
      expect(messageActionMocks.runMessageAction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          action: "edit",
          params: expect.objectContaining({ messageId: "tool-msg-1" }),
        }),
      );
      expect(routeMocks.routeReply).toHaveBeenCalledTimes(fails ? 2 : 1);
    },
  );

  it("starts the reply lifecycle for a hidden-only ACP turn", async () => {
    const onReplyStart = vi.fn();
    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "status",
          tag: "usage_update",
          text: "usage updated: 1/100",
          used: 1,
          size: 100,
        });
        await onEvent({ type: "done" });
      },
    );
    await runDispatch({ bodyForAgent: "hidden", onReplyStart });
    expect(onReplyStart).toHaveBeenCalledOnce();
  });

  it("does not mark ACP progress when diagnostics are disabled", async () => {
    mockVisibleTextTurn();
    await runDispatch({
      bodyForAgent: "visible",
      cfg: createAcpTestConfig({ diagnostics: { enabled: false } }),
    });
    expect(diagnosticMocks.markDiagnosticSessionProgress).not.toHaveBeenCalled();
  });

  it("preserves an intentionally empty canonical agent prompt", async () => {
    await runDispatch({
      bodyForAgent: "",
      ctxOverrides: { BodyForCommands: "/status", CommandBody: "/status" },
    });
    expect(managerMocks.runTurn).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "admits live ACP events before speech-cleaned block settlement, no-send=%s",
    async (noSend) => {
      const deliveryStarted = createDeferred();
      const deliveryGate = createDeferred();
      const fallbackStarted = createDeferred();
      const fallbackGate = createDeferred();
      const eventsAccepted = createDeferred();
      const attempts: Array<{ kind: string; text?: string }> = [];
      const confirmed: Array<{ kind: string; text?: string }> = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload, { kind }) => {
          const message = { kind, text: payload.text };
          attempts.push(message);
          if (kind === "block") {
            deliveryStarted.resolve();
            await deliveryGate.promise;
            if (noSend) {
              throw new PlatformMessageNotDispatchedError("offline", {
                cause: new Error("offline"),
              });
            }
          } else if (kind === "final") {
            fallbackStarted.resolve();
            await fallbackGate.promise;
          }
          confirmed.push(message);
        },
      });
      managerMocks.runTurn.mockImplementationOnce(
        async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
          await onEvent({ type: "text_delta", text: "hello. ", tag: "agent_message_chunk" });
          await onEvent({ type: "done", status: "completed" });
          eventsAccepted.resolve();
        },
      );
      let dispatchSettled = false;
      const dispatchPromise = runDispatch({
        bodyForAgent: "reply while delivery is pending",
        cfg: liveConfig({ enabled: true, mode: "final" }),
        dispatcher,
      }).then((result) => {
        dispatchSettled = true;
        return result;
      });

      try {
        await eventsAccepted.promise;
        await deliveryStarted.promise;
        await nextEventLoopTurn();

        expect(attempts).toEqual([{ kind: "block", text: "hello." }]);
        expect(confirmed).toEqual([]);
        expect(dispatchSettled).toBe(false);
        expect(transcriptMocks.persistAcpDispatchTranscript).not.toHaveBeenCalled();

        deliveryGate.resolve();
        if (noSend) {
          await fallbackStarted.promise;
          expect(attempts).toEqual([
            { kind: "block", text: "hello." },
            { kind: "final", text: "hello." },
          ]);
          expect(confirmed).toEqual([]);
          expect(dispatchSettled).toBe(false);
          expect(transcriptMocks.persistAcpDispatchTranscript).not.toHaveBeenCalled();
          fallbackGate.resolve();
        }

        await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: true });
        expect(attempts).toEqual([
          { kind: "block", text: "hello." },
          ...(noSend ? [{ kind: "final", text: "hello." }] : []),
        ]);
        expect(confirmed).toEqual([{ kind: noSend ? "final" : "block", text: "hello." }]);
        expectTranscript({ finalText: "hello." });
      } finally {
        deliveryGate.resolve();
        fallbackGate.resolve();
        await dispatchPromise;
        await dispatcher.waitForIdle();
      }
    },
  );

  it("persists the confirmed ACP prefix when cancellation leaves a TTS directive buffered", async () => {
    const controller = new AbortController();
    const deliveryStarted = createDeferred();
    const deliveryGate = createDeferred();
    const turnReady = createDeferred();
    const finishTurn = createDeferred();
    const turnDone = createDeferred();
    const prefix = "Visible before cancellation. ".repeat(18);
    const delivered: ReplyPayload[] = [];
    const core = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        deliveryStarted.resolve();
        await deliveryGate.promise;
      },
    });
    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "text_delta",
          text: prefix + "[[tts:text]]Private speech.",
          tag: "agent_message_chunk",
        });
        turnReady.resolve();
        await finishTurn.promise;
        await onEvent({ type: "done", status: "cancelled" });
        turnDone.resolve();
      },
    );
    let settled = false;
    const dispatch = runDispatch({
      bodyForAgent: "cancel after delivery",
      abortSignal: controller.signal,
      cfg: liveConfig({ enabled: true }),
      dispatcher: createAbortAwareDispatcher({
        dispatcher: core,
        isAborted: () => controller.signal.aborted,
      }),
    }).then(() => {
      settled = true;
    });
    try {
      await turnReady.promise;
      await deliveryStarted.promise;
      controller.abort();
      finishTurn.resolve();
      await turnDone.promise;
      await nextEventLoopTurn();
      expect(settled).toBe(false);
      expect(transcriptMocks.persistAcpDispatchTranscript).not.toHaveBeenCalled();
      expect(delivered).toEqual([{ text: prefix, textMode: "delta" }]);
      deliveryGate.resolve();
      await dispatch;
      expect(delivered).toEqual([{ text: prefix, textMode: "delta" }]);
      expectTranscript({ finalText: prefix });
    } finally {
      finishTurn.resolve();
      deliveryGate.resolve();
      await dispatch;
      core.markComplete();
      await core.waitForIdle();
    }
  });

  it("keeps settled ACP completion aligned with transcript persistence during caller cancellation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "codex-acp",
        sessionId: "acp-cancel-during-transcript",
        sessionKey,
        storePath: path.join(state.sessionsDir("codex-acp"), "sessions.json"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const text = "Completed output awaiting transcript persistence.";
      mockVisibleTextTurn(text);
      const controller = new AbortController();
      const recorder = createUserTurnTranscriptRecorder({
        target: { ...target, sessionEntry: undefined },
        resolveInput: async () => ({ text: "Cancel while saving this turn." }),
      });
      const actualTranscript = await vi.importActual<
        typeof import("./dispatch-acp-transcript.runtime.js")
      >("./dispatch-acp-transcript.runtime.js");
      transcriptMocks.persistAcpDispatchTranscript.mockImplementationOnce(async (input) => {
        expect(managerMocks.runTurn).toHaveBeenCalledOnce();
        controller.abort();
        await actualTranscript.persistAcpDispatchTranscript(
          input as Parameters<typeof actualTranscript.persistAcpDispatchTranscript>[0],
        );
      });
      const { emitAcpLifecycleEnd } = await vi.importActual<
        typeof import("../../agents/command/acp-lifecycle.js")
      >("../../agents/command/acp-lifecycle.js");
      auditMocks.emitAcpLifecycleEnd.mockImplementationOnce(emitAcpLifecycleEnd);
      const preparedMessages: unknown[] = [];
      let dispatchedRun: ReplyDispatchRun | undefined;
      await runDispatch({
        bodyForAgent: "Cancel while saving this turn.",
        runId: "acp-cancel-during-transcript",
        cfg: createAcpTestConfig({ session: { store: target.storePath } }),
        abortSignal: controller.signal,
        userTurnTranscriptRecorder: recorder,
        prepareAssistantTranscriptMessage: (message) => {
          preparedMessages.push(structuredClone(message));
          return message;
        },
        onAgentRunStart: (_runId, _meta, run) => {
          dispatchedRun = run;
          return "reply-dispatch";
        },
      });
      const persistedMessages = (await loadTranscriptEvents(target)).flatMap((event) => {
        const entry = requireRecord(event, "transcript event");
        return entry.type === "message" ? [entry.message] : [];
      });
      const expectedAssistant = {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
      };
      expect({
        preparedMessages,
        persistedMessages,
        terminalOutcome: dispatchedRun?.getResult().terminalOutcome,
      }).toMatchObject({
        preparedMessages: [expectedAssistant],
        persistedMessages: [{ role: "user" }, expectedAssistant],
        terminalOutcome: { reason: "completed", status: "ok" },
      });
    });
  });

  it("records an ACP error when output finalization fails", async () => {
    mockVisibleTextTurn("visible output");
    const { dispatcher } = createDispatcher();
    vi.mocked(dispatcher.waitForIdle)
      .mockRejectedValueOnce(new Error("output settlement failed"))
      .mockResolvedValue(undefined);

    await runDispatch({
      bodyForAgent: "finalize this turn",
      dispatcher,
    });

    expect(auditMocks.emitAcpLifecycleEnd).not.toHaveBeenCalled();
    expect(auditMocks.emitAcpLifecycleError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: "output settlement failed" }),
      }),
    );
    expectTranscript({
      terminalOutcome: expect.objectContaining({ reason: "failed", status: "error" }),
    });
  });

  it("passes the ACP agent directory without declaring host-path access", async () => {
    const agentDir = "/tmp/acp-agent";
    await runDispatch({
      bodyForAgent: "describe image",
      cfg: createAcpTestConfig({
        agents: { entries: { "codex-acp": { agentDir } } },
        channels: { imessage: { attachmentRoots: ["/tmp/acp-inbound"] } },
      }),
      ctxOverrides: {
        Provider: "imessage",
        Surface: "imessage",
        MediaPath: "/tmp/acp-inbound/image.png",
        MediaType: "image/png",
      },
    });
    const input = requireRecord(
      mediaUnderstandingMocks.applyMediaUnderstanding.mock.calls[0]?.[0],
      "media understanding",
    );
    expect(input.agentDir).toBe(agentDir);
    expect(input.selfServeLocalPaths).toBeUndefined();
  });

  it.each([["unknown", "application/pdf"]] as const)(
    "never forwards PNG bytes or substitutes history for %s media with %s MIME",
    async (kind, contentType) => {
      const documentPath = "/tmp/openclaw-acp-document.png";
      const historyPath = "/tmp/openclaw-acp-unrelated-history.png";
      acpAttachmentBuffers.set(documentPath, ACP_PNG_IMAGE_BYTES);
      acpAttachmentBuffers.set(historyPath, ACP_PNG_IMAGE_BYTES);
      await runDispatch({
        bodyForAgent: "summarize this document",
        ctxOverrides: {
          Timestamp: 1_700_000_000_000,
          media: [{ path: documentPath, contentType, kind }],
          InboundHistory: [
            imageHistory([{ path: historyPath, contentType: "image/png", kind: "image" }]),
          ],
        },
      });
      expect(runTurnCall().attachments).toBeUndefined();
      expect(runTurnCall().text).not.toContain("Recent image");
    },
  );

  it("falls back to bounded, ordered, deduplicated history images when current image bytes are unusable", async () => {
    const currentPath = "/tmp/openclaw-acp-current-spoofed.bin";
    const historyPath = "/tmp/openclaw-acp-history-valid.bin";
    const stickerPath = "C:\\Users\\Alice\\Pictures\\sticker";
    const earlierPaths = Array.from({ length: 3 }, (_, index) => `/tmp/earlier-image-${index}.png`);
    for (const earlierPath of earlierPaths) {
      acpAttachmentBuffers.set(earlierPath, ACP_PNG_IMAGE_BYTES);
    }
    acpAttachmentBuffers.set(currentPath, ACP_PDF_BYTES);
    acpAttachmentBuffers.set(historyPath, ACP_PNG_IMAGE_BYTES);
    acpAttachmentBuffers.set(stickerPath, ACP_JPEG_IMAGE_BYTES);
    await runDispatch({
      bodyForAgent: "describe the recent images",
      ctxOverrides: {
        Timestamp: 1_700_000_000_000,
        media: [{ path: currentPath, contentType: "image/png", kind: "image" }],
        InboundHistory: [
          ...earlierPaths.map((imagePath, index) =>
            imageHistory([{ path: imagePath, kind: "image" }], { messageId: `earlier-${index}` }),
          ),
          imageHistory(
            [
              { path: historyPath, contentType: "application/octet-stream", kind: "image" },
              { path: historyPath, contentType: "application/octet-stream", kind: "image" },
            ],
            { messageId: "image-message" },
          ),
          imageHistory([{ path: stickerPath, kind: "sticker" }], { messageId: "sticker-message" }),
          imageHistory([{ path: currentPath, kind: "document" }]),
        ],
      },
    });
    expect(runTurnCall().attachments).toEqual([
      { mediaType: "image/png", data: ACP_PNG_IMAGE_BYTES.toString("base64") },
      { mediaType: "image/png", data: ACP_PNG_IMAGE_BYTES.toString("base64") },
      { mediaType: "image/png", data: ACP_PNG_IMAGE_BYTES.toString("base64") },
      { mediaType: "image/jpeg", data: ACP_JPEG_IMAGE_BYTES.toString("base64") },
    ]);
    expect(runTurnCall().text).not.toContain("message earlier-0");
  });

  it("annotates recent history images with sent time and available history position", async () => {
    const historyPath = "/tmp/openclaw-history-metadata.png";
    const historyImage = Buffer.from("history-image");
    acpAttachmentBuffers.set(historyPath, historyImage);

    await runDispatch({
      bodyForAgent: "describe current state",
      ctxOverrides: {
        Timestamp: 1_700_000_060_000,
        InboundHistory: [
          {
            sender: "@alice",
            body: "bug report",
            timestamp: 1_699_999_980_000,
            messageId: "msg-before",
          },
          {
            sender: "@bob",
            body: "<media:image>",
            timestamp: 1_700_000_000_000,
            messageId: "msg-history",
            media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
          },
          {
            sender: "@alice",
            body: "fixed after refresh",
            timestamp: 1_700_000_060_000,
            messageId: "msg-after",
          },
        ],
      },
    });

    const text = String(runTurnCall().text);
    expect(text).toContain("describe current state");
    expect(text).toContain("Recent image 1 from @bob, message msg-history");
    expect(text).toContain("sent at 2023-11-14T22:13:20.000Z");
    expect(text).toContain("message 2 of 3 in available history");
    expect(text).not.toContain(historyPath);
    expect(runTurnCall().attachments).toEqual([
      {
        mediaType: "image/png",
        data: historyImage.toString("base64"),
      },
    ]);
  });

  it("omits described images while retaining first-read undescribed attachment bytes", async () => {
    const describedPath = "/tmp/openclaw-described-current.png";
    const undescribedPath = "/tmp/openclaw-undescribed-current.jpg";
    const pdfPage = {
      type: "image" as const,
      mimeType: "image/png",
      data: Buffer.from("pdf-page").toString("base64"),
      attachmentIndex: 2,
    };
    acpAttachmentBuffers.set(describedPath, ACP_PNG_IMAGE_BYTES);
    acpAttachmentBuffers.set(undescribedPath, ACP_JPEG_IMAGE_BYTES);
    mediaUnderstandingMocks.applyMediaUnderstanding.mockImplementationOnce(async (params) => {
      const ctx = (params as { ctx: { MediaUnderstanding?: unknown[] } }).ctx;
      const description = {
        kind: "image.description" as const,
        attachmentIndex: 0,
        text: "A described image.",
        provider: "imageModel",
      };
      ctx.MediaUnderstanding = [description];
      acpAttachmentBuffers.delete(undescribedPath);
      return {
        extractedFileImages: [pdfPage],
      };
    });

    await runDispatch({
      bodyForAgent: "compare described, undescribed, and extracted images",
      ctxOverrides: {
        media: [
          { path: describedPath, contentType: "image/png", kind: "image" },
          { path: undescribedPath, contentType: "image/jpeg", kind: "image" },
        ],
      },
    });

    expect(runTurnCall().attachments).toEqual([
      { mediaType: "image/jpeg", data: ACP_JPEG_IMAGE_BYTES.toString("base64") },
      { mediaType: "image/png", data: pdfPage.data },
    ]);
  });

  it.each([true])(
    "drops history when an unreadable current image is described (preprocessed=%s)",
    async (preprocessed) => {
      const currentPath = "/tmp/openclaw-described-history-current.png";
      const historyPath = "/tmp/openclaw-described-history-previous.jpg";
      acpAttachmentBuffers.set(historyPath, ACP_JPEG_IMAGE_BYTES);
      const description = {
        kind: "image.description" as const,
        attachmentIndex: 0,
        text: "The current image was already described.",
        provider: "imageModel",
      };
      mediaUnderstandingMocks.applyMediaUnderstanding.mockImplementationOnce(async (params) => {
        const ctx = (params as { ctx: { MediaUnderstanding?: unknown[]; agentText: string } }).ctx;
        ctx.MediaUnderstanding = [description];
        ctx.agentText = `${ctx.agentText}\n\n[Image 1]\n${description.text}`;
        return {
          extractedFileImages: [],
        };
      });

      await runDispatch({
        bodyForAgent: preprocessed
          ? "The current image was already described."
          : "describe the current image",
        ctxOverrides: {
          Timestamp: 1_700_000_060_000,
          MediaUnderstanding: preprocessed ? [description] : undefined,
          media: [{ path: currentPath, contentType: "image/png", kind: "image" }],
          InboundHistory: [
            imageHistory([{ path: historyPath, contentType: "image/jpeg", kind: "image" }]),
          ],
        },
      });

      if (preprocessed) {
        expect(mediaUnderstandingMocks.applyMediaUnderstanding).not.toHaveBeenCalled();
      } else {
        expect(mediaUnderstandingMocks.applyMediaUnderstanding).toHaveBeenCalledWith(
          expect.objectContaining({ deliveredImageIndexes: new Set([1]) }),
        );
      }
      expect(runTurnCall().text).toContain("The current image was already described.");
      expect(runTurnCall().text).not.toContain("Recent image 1");
      expect(runTurnCall().attachments).toBeUndefined();
    },
  );

  it("preserves chat.send inline image attachments over recent history images", async () => {
    const image = {
      mimeType: "image/png",
      data: Buffer.from("inline-image").toString("base64"),
    };
    const historyPath = "/tmp/openclaw-history-inline.png";
    acpAttachmentBuffers.set(historyPath, Buffer.from("history-image"));

    await runDispatch({
      bodyForAgent: "describe image",
      images: [image],
      ctxOverrides: {
        Timestamp: 1_700_000_000_000,
        InboundHistory: [
          imageHistory([{ path: historyPath, contentType: "image/png", kind: "image" }], {
            messageId: "msg-history",
          }),
        ],
      },
    });

    expect(runTurnCall().text).toBe("describe image");
    expect(runTurnCall().attachments).toEqual([
      {
        mediaType: "image/png",
        data: image.data,
      },
    ]);
  });

  it("does not fall back to remote URLs when ACP local attachment paths are blocked", async () => {
    const fetchSpy = vi.fn(async () => new Response(ACP_PNG_IMAGE_BYTES));
    globalThis.fetch = withFetchPreconnect(fetchSpy as typeof fetch);
    await runDispatch({
      bodyForAgent: "   ",
      ctxOverrides: {
        MediaPath: "/tmp/blocked-image.png",
        MediaUrl: "https://example.com/image.png",
        MediaType: "image/png",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(managerMocks.runTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["dispatch", "ACP dispatch is disabled by policy."],
    ["tools", "cannot enforce its permission or tool policy"],
    ["conversation", "use an embedded runtime"],
    ["agent", "ACP agent is not allowed by policy."],
  ] as const)("blocks ACP %s policy violations with a visible error", async (policy, message) => {
    if (policy === "dispatch") {
      policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(
        new AcpRuntimeError("ACP_DISPATCH_DISABLED", message),
      );
    }
    if (policy === "agent") {
      policyMocks.resolveAcpAgentPolicyError.mockReturnValue(
        new AcpRuntimeError("ACP_SESSION_INIT_FAILED", message),
      );
    }
    const { dispatcher } = createDispatcher();
    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
      toolsAllow: policy === "tools" ? ["message"] : undefined,
      ctxOverrides:
        policy === "conversation" ? { ConversationToolPolicy: { deny: ["exec"] } } : undefined,
    });
    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply)).toMatchObject({
      isError: true,
      text: expect.stringContaining(message),
    });
    expect(bindingServiceMocks.unbind).not.toHaveBeenCalled();
    expect(auditMocks.emitAcpLifecycleStart).toHaveBeenCalledOnce();
    expect(auditMocks.emitAcpLifecycleError).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: "blocked" }),
    );
    expect(auditMocks.emitAcpLifecycleEnd).not.toHaveBeenCalled();
  });

  it.each(["resolution", "runtime"] as const)(
    "only unbinds stale ACP conversations after a %s failure",
    async (failure) => {
      const aliasSessionKey = "main";
      const canonicalSessionKey = "agent:main:main";
      const error = new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP metadata is missing.");
      if (failure === "resolution") {
        managerMocks.resolveSessionAsync.mockResolvedValue({
          kind: "stale",
          sessionKey: canonicalSessionKey,
          agentId: "main",
          error,
        });
      } else {
        managerMocks.resolveSessionAsync.mockResolvedValue({
          kind: "ready",
          sessionKey: canonicalSessionKey,
          agentId: "main",
          meta: createAcpSessionMeta(),
        });
        managerMocks.runTurn.mockRejectedValueOnce(error);
      }
      bindingServiceMocks.unbind.mockResolvedValueOnce([sessionBinding(canonicalSessionKey)]);
      const { dispatcher } = createDispatcher();

      await runDispatch({
        bodyForAgent: "test",
        dispatcher,
        sessionKeyOverride: aliasSessionKey,
      });

      expect(managerMocks.runTurn).toHaveBeenCalledTimes(failure === "resolution" ? 0 : 1);
      expect(bindingServiceMocks.unbind).toHaveBeenCalledExactlyOnceWith({
        targetSessionKey: canonicalSessionKey,
        reason: "acp-session-init-failed",
      });
      expect(dispatcherCall(dispatcher.sendFinalReply).isError).toBe(true);
      expect(dispatcherCall(dispatcher.sendFinalReply).text).toContain(error.message);
    },
  );

  it("honors the configured default account when checking bound-session identity notices", async () => {
    const canonicalSessionKey = "agent:main:main";
    managerMocks.resolveSessionAsync.mockResolvedValue({
      kind: "ready",
      sessionKey: canonicalSessionKey,
      agentId: "main",
      meta: createAcpSessionMeta({
        identity: {
          state: "pending",
          source: "ensure",
          lastUpdatedAt: Date.now(),
          acpxRecordId: "rec-work",
        },
      }),
    });
    bindingServiceMocks.listBySession.mockImplementation((targetSessionKey: string) =>
      targetSessionKey === canonicalSessionKey ? [sessionBinding(canonicalSessionKey, "work")] : [],
    );
    sessionMetaMocks.readAcpSessionEntry.mockImplementation(
      (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
        params.sessionKey === canonicalSessionKey
          ? {
              cfg: params.cfg ?? createAcpTestConfig(),
              storePath: "/tmp/openclaw-session-store.json",
              sessionKey: canonicalSessionKey,
              storeSessionKey: canonicalSessionKey,
              acp: createAcpSessionMeta({
                identity: {
                  state: "resolved",
                  source: "status",
                  lastUpdatedAt: Date.now(),
                  acpxSessionId: "acpx-work",
                },
              }),
            }
          : null,
    );
    managerMocks.runTurn.mockResolvedValue(undefined);
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
      cfg: createAcpTestConfig({
        channels: {
          discord: {
            defaultAccount: "work",
          },
        },
      }),
      ctxOverrides: {
        Provider: "discord",
        Surface: "discord",
      },
      sessionKeyOverride: canonicalSessionKey,
    });

    expect(bindingServiceMocks.listBySession).toHaveBeenCalledWith(canonicalSessionKey);
    expect(dispatcherCall(dispatcher.sendFinalReply, 0).text).toContain("Session ids resolved.");
    expect(dispatcherCall(dispatcher.sendFinalReply, 0).text).toContain(
      "acpx session id: acpx-work",
    );
  });

  it.each([
    { deliveryPath: "direct", outcome: "channel_transform" },
    { deliveryPath: "direct", outcome: "cancelled" },
    { deliveryPath: "routed", outcome: "channel_transform" },
    { deliveryPath: "routed", outcome: "no_visible_result" },
    { deliveryPath: "routed", outcome: "ambiguous" },
  ] as const)(
    "preserves $deliveryPath ACP block settlement policy ($outcome)",
    async ({ deliveryPath, outcome }) => {
      managerMocks.runTurn.mockImplementation(
        async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
          await onEvent({ type: "text_delta", text: "First chunk. ", tag: "agent_message_chunk" });
          await onEvent({ type: "text_delta", text: "Second chunk. ", tag: "agent_message_chunk" });
          await onEvent({ type: "done" });
        },
      );
      const visible: Array<{ kind: string; text: string | undefined }> = [];
      routeMocks.routeReply.mockImplementation(async (params) => {
        const { replyKind, payload } = requireRecord(params, "route request");
        const text = String(requireRecord(payload, "route payload").text);
        if (replyKind === "block" && text.trim() === "Second chunk.") {
          if (outcome === "ambiguous") {
            return { ok: true, delivered: true, ambiguous: true };
          }
          if (outcome === "no_visible_result") {
            return { ok: true, delivered: false };
          }
          return { ok: true, delivered: false, suppressed: true, reason: "channel_transform" };
        }
        visible.push({ kind: String(replyKind), text: text.trim() });
        return { ok: true, delivered: true };
      });
      const dispatcher = createReplyDispatcher({
        beforeDeliver: (payload, info) =>
          outcome === "cancelled" &&
          info.kind === "block" &&
          payload.text?.trim() === "Second chunk."
            ? null
            : payload,
        deliver: async (payload, info) => {
          if (info.kind === "block" && payload.text?.trim() === "Second chunk.") {
            return { visibleReplySent: false, suppression: { reason: outcome } };
          }
          visible.push({ kind: info.kind, text: payload.text?.trim() });
          return { visibleReplySent: true };
        },
      });

      await runDispatch({
        bodyForAgent: "reply",
        dispatcher,
        cfg: createAcpTestConfig({ acp: { enabled: true, stream: { deliveryMode: "live" } } }),
        ctxOverrides: { Provider: "discord", Surface: "discord" },
        shouldRouteToOriginating: deliveryPath === "routed",
        originatingChannel: "discord",
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(visible).toEqual([
        { kind: "block", text: "First chunk." },
        ...(outcome === "channel_transform" || outcome === "ambiguous"
          ? []
          : [{ kind: "final", text: "Second chunk." }]),
      ]);
      if (deliveryPath === "routed") {
        expect(
          routeMocks.routeReply.mock.calls.map((_, index) => ({
            kind: routeCall(index).replyKind,
            text: String(routePayload(index).text).trim(),
          })),
        ).toEqual([
          { kind: "block", text: "First chunk." },
          { kind: "block", text: "Second chunk." },
          ...(outcome === "channel_transform" || outcome === "ambiguous"
            ? []
            : [{ kind: "final", text: "Second chunk." }]),
        ]);
      }
      expectTranscript({ finalText: "First chunk.\nSecond chunk." });
    },
  );

  it.each([
    { captioned: false, stage: "text" },
    { captioned: false, stage: "permanent" },
    { captioned: true, stage: "retryable" },
  ] as const)(
    "honors direct TTS suppression without losing independent text (captioned=$captioned, stage=$stage)",
    async ({ captioned, stage }) => {
      ttsCapabilityMocks.captionedFinalText = captioned;
      mockVisibleTextTurn("Spoken answer.");
      const mediaUrl = "/tmp/openclaw-media/acp-tts.ogg";
      ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
        mediaUrl,
        audioAsVoice: true,
      } as MockTtsReply);
      const attempted: Array<{ kind: string; text?: string; mediaUrl?: string }> = [];
      const dispatcher = createReplyDispatcher({
        transformReplyPayload: stage === "text" ? () => null : undefined,
        deliver: async (payload, info) => {
          attempted.push({ kind: info.kind, text: payload.text, mediaUrl: payload.mediaUrl });
          if (payload.mediaUrl && (stage === "permanent" || stage === "retryable")) {
            throw new PlatformMessageNotDispatchedError("media rejected", {
              cause: undefined,
              retryable: stage === "retryable",
            });
          }
          return payload.mediaUrl
            ? { visibleReplySent: false, suppression: { reason: "channel_transform" } }
            : { visibleReplySent: info.kind === "final" };
        },
      });

      await runDispatch({
        bodyForAgent: "reply",
        dispatcher,
        cfg: liveConfig({ auto: "always", mode: "final" }),
        ctxOverrides: { Provider: "telegram", Surface: "telegram" },
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(attempted).toEqual(
        stage === "text"
          ? []
          : [
              ...(captioned
                ? []
                : [{ kind: "block", text: "Spoken answer.", mediaUrl: undefined }]),
              { kind: "final", text: captioned ? "Spoken answer." : undefined, mediaUrl },
              ...(!captioned || stage === "retryable"
                ? [{ kind: "final", text: "Spoken answer.", mediaUrl: undefined }]
                : []),
            ],
      );
      expectTranscript({ finalText: stage === "text" ? "" : "Spoken answer." });
      if (stage === "text") {
        expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
      }
    },
  );

  it("retains deferred text after media-only block suppression and TTS failure", async () => {
    ttsCapabilityMocks.captionedFinalText = true;
    const text = "Deferred answer.";
    const mediaUrl = "https://example.test/block.png";
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
        await onEvent({
          type: "done",
          status: "completed",
        });
      },
    );
    ttsMocks.maybeApplyTtsToPayload.mockRejectedValueOnce(new Error("TTS unavailable"));
    let attachBlockMedia = true;
    const attempted: Array<{ kind: string; text?: string; mediaUrl?: string }> = [];
    const dispatcher = createReplyDispatcher({
      transformReplyPayload: (payload) => {
        if (!attachBlockMedia) {
          return payload;
        }
        attachBlockMedia = false;
        return { ...payload, mediaUrl };
      },
      deliver: async (payload, info) => {
        attempted.push({ kind: info.kind, text: payload.text, mediaUrl: payload.mediaUrl });
        return payload.mediaUrl
          ? { visibleReplySent: false, suppression: { reason: "channel_transform" } }
          : { visibleReplySent: true };
      },
    });

    await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      cfg: liveConfig({ auto: "always", mode: "final" }),
      ctxOverrides: { Provider: "telegram", Surface: "telegram" },
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(attempted).toEqual([
      { kind: "block", text: undefined, mediaUrl },
      { kind: "final", text, mediaUrl: undefined },
    ]);
    expectTranscript({ finalText: text });
  });

  it.each(["confirmed", "held"] as const)(
    "records only confirmed text when cancellation interrupts a %s caption receipt",
    async (outcome) => {
      ttsCapabilityMocks.captionedFinalText = true;
      const text = "Caption awaiting delivery.";
      ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
        text,
        mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
        audioAsVoice: true,
        spokenText: text,
        ttsSupplement: { spokenText: text },
      } as MockTtsReply);
      mockVisibleTextTurn(text);
      const controller = new AbortController();
      const started = createDeferred();
      const receipt = createDeferred<{ visibleReplySent: true }>();
      const attempted: ReplyPayload[] = [];
      const coreDispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          attempted.push(payload);
          started.resolve();
          return { visibleReplySent: false, finalization: receipt.promise };
        },
      });
      const dispatcher = createAbortAwareDispatcher({
        dispatcher: coreDispatcher,
        isAborted: () => controller.signal.aborted,
      });
      const dispatch = runDispatch({
        bodyForAgent: "reply",
        dispatcher,
        abortSignal: controller.signal,
        cfg: liveConfig({ auto: "always", mode: "final" }),
        ctxOverrides: { Provider: "telegram", Surface: "telegram" },
      });
      await started.promise;
      controller.abort();
      await nextEventLoopTurn();
      if (outcome === "confirmed") {
        receipt.resolve({ visibleReplySent: true });
      } else {
        receipt.reject(
          Object.assign(
            new OutboundDeliveryError("receipt pending", {
              cause: new PlatformMessageNotDispatchedError("offline", { cause: undefined }),
            }),
            { queueCustody: "held" as const },
          ),
        );
      }
      await dispatch;
      coreDispatcher.markComplete();
      await coreDispatcher.waitForIdle();
      expect(attempted).toHaveLength(1);
      expect(coreDispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
      expectTranscript({
        finalText: outcome === "confirmed" ? text : "",
        terminalOutcome: expect.objectContaining({ reason: "aborted" }),
      });
    },
  );

  it("settles tail-only ACP text before error transcript completion", async () => {
    ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (paramsUnknown) => {
      const payload = requireRecord(
        requireRecord(paramsUnknown, "TTS request").payload,
        "TTS payload",
      );
      return payload.isError ? payload : {};
    });
    const controller = new AbortController();
    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "[", tag: "agent_message_chunk" });
        throw new Error("Runtime stopped");
      },
    );
    const delivered: ReplyPayload[] = [];
    const coreDispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        return { visibleReplySent: true };
      },
    });
    const dispatcher = createAbortAwareDispatcher({
      dispatcher: coreDispatcher,
      isAborted: () => controller.signal.aborted,
    });

    await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      abortSignal: controller.signal,
      cfg: liveConfig({ auto: "always", mode: "final" }),
    });
    coreDispatcher.markComplete();
    await coreDispatcher.waitForIdle();

    expect(delivered.filter((payload) => !payload.isError).map((payload) => payload.text)).toEqual([
      "[",
    ]);
    expectTranscript({
      finalText: `[\n\n${delivered.find((payload) => payload.isError)?.text}`,
    });
  });

  it("does not synthesize ACP speech after cancellation while the tail receipt is pending", async () => {
    mockVisibleTextTurn("[");
    const controller = new AbortController();
    const tailStarted = createDeferred();
    const tailGate = createDeferred();
    const attempted: ReplyPayload[] = [];
    const coreDispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        attempted.push(payload);
        tailStarted.resolve();
        await tailGate.promise;
        throw new PlatformMessageNotDispatchedError("cancelled", { cause: undefined });
      },
    });
    const dispatch = runDispatch({
      bodyForAgent: "reply",
      dispatcher: createAbortAwareDispatcher({
        dispatcher: coreDispatcher,
        isAborted: () => controller.signal.aborted,
      }),
      abortSignal: controller.signal,
      cfg: liveConfig({ auto: "always", mode: "final" }),
    });
    try {
      await tailStarted.promise;
      controller.abort();
      tailGate.resolve();
      await dispatch;
      expect(attempted.map((payload) => payload.text)).toEqual(["["]);
      expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
      expectTranscript({ finalText: "" });
    } finally {
      controller.abort();
      tailGate.resolve();
      await dispatch;
      await coreDispatcher.waitForIdle();
    }
  });

  it.each([
    { mode: "all", outcome: "tail-failed" },
    { mode: "final", outcome: "custody" },
    { mode: "final", outcome: "caller-abort" },
  ] as const)(
    "settles prepared ACP text and media once ($mode, $outcome)",
    async ({ mode, outcome }) => {
      ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (input) => {
        const request = requireRecord(input, "TTS request");
        return request.kind === "block" ? request.payload : {};
      });
      const text = "a".repeat(479) + "[";
      const prefixDelivered = createDeferred();
      const delivered: ReplyPayload[] = [];
      const attempts: ReplyPayload[] = [];
      const controller = new AbortController();
      const mediaUrl = "https://example.test/source.png";
      const transformReplyPayload = vi.fn((payload: ReplyPayload) =>
        setReplyPayloadMetadata(
          { ...payload, text: `[channel] ${payload.text}`, replyToId: "source-message", mediaUrl },
          { assistantMessageIndex: 7 },
        ),
      );
      const dispatcher = createReplyDispatcher({
        responsePrefix: "[bot]",
        transformReplyPayload,
        deliver: async (payload, { kind }) => {
          attempts.push(payload);
          if (kind === "block" && payload.text === "[") {
            if (outcome === "caller-abort") {
              controller.abort();
            }
            const cause = new PlatformMessageNotDispatchedError("terminal send failed", {
              cause: undefined,
            });
            if (outcome === "custody") {
              const failure = new OutboundDeliveryError("queue retained tail", { cause });
              failure.queueCustody = "held";
              throw failure;
            }
            throw cause;
          }
          delivered.push(payload);
          prefixDelivered.resolve();
          return { visibleReplySent: true };
        },
      });
      managerMocks.runTurn.mockImplementationOnce(
        async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
          await onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
          await prefixDelivered.promise;
          expect(delivered).toHaveLength(1);
          expect(delivered[0]).toMatchObject({
            text: `[bot] [channel] ${"a".repeat(479)}`,
            mediaUrl,
          });
          await onEvent({ type: "done", status: "completed" });
        },
      );

      await runDispatch({
        bodyForAgent: "reply",
        dispatcher: createAbortAwareDispatcher({
          dispatcher,
          isAborted: () => controller.signal.aborted,
        }),
        abortSignal: controller.signal,
        cfg: liveConfig({ auto: "always", mode }),
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      const recovered = outcome === "tail-failed";
      expect(delivered.map((payload) => payload.text).join("")).toBe(
        `[bot] [channel] ${recovered ? text : text.slice(0, -1)}`,
      );
      expect(attempts.map((payload) => payload.text)).toEqual([
        `[bot] [channel] ${text.slice(0, -1)}`,
        "[",
        ...(outcome === "tail-failed" ? ["["] : []),
      ]);
      expect(delivered.map((payload) => payload.mediaUrl)).toEqual(
        recovered ? [mediaUrl, undefined] : [mediaUrl],
      );
      expect(delivered.map((payload) => payload.replyToId)).toEqual(
        recovered ? ["source-message", "source-message"] : ["source-message"],
      );
      expect(
        delivered.map((payload) => getReplyPayloadMetadata(payload)?.assistantMessageIndex),
      ).toEqual(recovered ? [7, 7] : [7]);
      expect(transformReplyPayload).toHaveBeenCalledOnce();
    },
  );

  it.each([{ audio: false, visible: false, expectedText: "Private ACP speech." }])(
    "delivers tagged ACP text once (audio=$audio, visible=$visible)",
    async ({ audio, visible, expectedText }) => {
      const mediaUrl = "/tmp/openclaw-media/acp-tts.ogg";
      ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
        text: visible ? "Visible ACP answer." : "Private ACP speech.",
        ...(audio ? { mediaUrl, audioAsVoice: true } : {}),
      });
      mockVisibleTextTurn(
        `${visible ? "Visible ACP answer. " : ""}[[tts:text]]Private ACP speech.[[/tts:text]]`,
      );
      const { dispatcher } = createDispatcher();
      await runDispatch({
        bodyForAgent: "reply",
        cfg: liveConfig({ auto: "tagged" }),
        dispatcher,
        ctxOverrides: { Provider: "telegram", Surface: "telegram" },
      });
      const payload = dispatcherCall(
        visible ? dispatcher.sendBlockReply : dispatcher.sendFinalReply,
      );
      expect(payload.text).toBe(expectedText);
      if (visible) {
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      } else {
        expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
        if (audio) {
          expect(payload).toMatchObject({ mediaUrl, audioAsVoice: true });
        }
      }
    },
  );

  const notSent = new PlatformMessageNotDispatchedError("offline", { cause: undefined });
  it.each([
    ["sent", { ok: true, delivered: true, messageId: "sent" }, 1],
    ["vetoed", { ok: true, delivered: false, suppressed: true, reason: "channel_transform" }, 1],
    ["not-sent", { ok: false, delivered: false, cause: notSent }, 2],
    ["partial", { ok: false, delivered: true }, 1],
    ["held", { ok: false, delivered: false, queueCustody: "held" }, 1],
  ] as const)(
    "retries a routed ACP voice caption only after %s permits it",
    async (outcome, result, calls) => {
      ttsCapabilityMocks.captionedFinalText = true;
      const text = "Visible ACP fallback.";
      const mediaUrl = "/tmp/openclaw-media/acp-tts.ogg";
      ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
        text,
        mediaUrl,
        audioAsVoice: true,
        spokenText: text,
        ttsSupplement: { spokenText: text },
      });
      mockVisibleTextTurn(text);
      routeMocks.routeReply.mockResolvedValueOnce(result);
      await runDispatch({
        bodyForAgent: "reply",
        cfg: createAcpTestConfig({
          acp: {
            enabled: true,
            stream: { deliveryMode: outcome === "sent" ? "final_only" : "live" },
          },
          tts: { auto: "always" },
        }),
        shouldRouteToOriginating: true,
      });
      expectTranscript({
        sessionKey,
        promptText: "reply",
        finalText: text,
        terminalOutcome: expect.objectContaining({ reason: "completed", status: "ok" }),
      });
      expect(routeCall().mirror).toBe(false);
      expect(routeMocks.routeReply).toHaveBeenCalledTimes(calls);
      expect(routePayload()).toMatchObject({ text, mediaUrl });
      if (calls === 2) {
        expect(routePayload(1)).toEqual({ text });
      }
    },
  );

  it.each(["direct", "routed"] as const)(
    "never leaks a marked private inbound prompt across ACP live text deltas via %s delivery",
    async (deliveryPath) => {
      const marker = "[Current message - respond to this]";
      const conversationContext = `${marker}\nPrivate secret. Keep hidden.`;
      const directTexts: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          if (deliveryPath === "routed") {
            throw new Error("ACP output must use the origin route");
          }
          if (payload.text) {
            directTexts.push(payload.text);
          }
        },
      });
      const ctx = buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: sessionKey,
        Body: conversationContext,
        BodyForAgent: conversationContext,
      });
      managerMocks.runTurn.mockImplementationOnce(
        async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
          await onEvent({
            type: "text_delta",
            text: "Visible answer before. ",
            tag: "agent_message_chunk",
          });
          await onEvent({
            type: "text_delta",
            text: `${marker}\nPrivate secret. `,
            tag: "agent_message_chunk",
          });
          await onEvent({
            type: "text_delta",
            text: "Keep hidden. Visible answer after.",
            tag: "agent_message_chunk",
          });
          await onEvent({ type: "done", status: "completed" });
        },
      );

      await runDispatch({
        bodyForAgent: conversationContext,
        cfg: createAcpTestConfig({
          acp: { enabled: true, stream: { deliveryMode: "live" } },
        }),
        ctx,
        dispatcher,
        shouldRouteToOriginating: deliveryPath === "routed",
        originatingChannel: "discord",
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      const deliveredTexts =
        deliveryPath === "direct"
          ? directTexts
          : routeMocks.routeReply.mock.calls.map((_, index) => String(routePayload(index).text));
      expect(deliveredTexts.join("")).toContain("Visible answer before.");
      expect(deliveredTexts.join("")).toContain("Visible answer after.");
      for (const text of deliveredTexts) {
        expect(text).not.toContain(marker);
        expect(text).not.toContain("Private secret.");
        expect(text).not.toContain("Keep hidden.");
      }
    },
  );

  it("honors the configured default account for ACP projector chunking when AccountId is omitted", async () => {
    const cfg = createAcpTestConfig({
      acp: {
        enabled: true,
        stream: {
          deliveryMode: "live",
        },
      },
      channels: {
        discord: {
          defaultAccount: "work",
          accounts: {
            work: {
              textChunkLimit: 5,
            },
          },
        },
      },
    });
    mockVisibleTextTurn("abcdef");

    const { dispatcher } = createDispatcher();
    await runDispatch({
      bodyForAgent: "reply",
      cfg,
      dispatcher,
      ctxOverrides: {
        Provider: "discord",
        Surface: "discord",
      },
    });

    expect(dispatcherCall(dispatcher.sendBlockReply, 0).text).toBe("abcde");
    expect(dispatcherCall(dispatcher.sendBlockReply, 1).text).toBe("f");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
