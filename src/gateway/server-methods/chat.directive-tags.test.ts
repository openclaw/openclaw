import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord, expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../../packages/gateway-protocol/src/schema.js";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  bindActiveCronCreatorAuthorityResolver,
  runWithCronCreatorAuthorityCapabilityResolver,
  type CronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import type { ReplyDispatchRun } from "../../auto-reply/get-reply-options.types.js";
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { getTotalPendingReplies } from "../../auto-reply/reply/dispatcher-registry.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  replyRunRegistry,
  type ReplyBackendQueueMessageOptions,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunRegistryTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { recordAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry as loadSqliteSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  switchSessionBranch,
  type SessionAccessScope,
  type SessionTranscriptReadScope,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { resolveSessionTranscriptActiveLeafEntryId } from "../../config/sessions/transcript-tree.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import {
  getActiveSessionWorkAdmissionCount,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { projectAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { extractFirstTextBlock } from "../../shared/chat-message-content.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { consumeCronCreatorAuthorityGrant } from "../cron-creator-authority-grant.js";
import { createChatRunState } from "../server-chat-state.js";
import { STALE_WORKER_BUILD_REASON } from "../worker-environments/admission.js";
import { agentHandlers } from "./agent.js";
import { createScopedCliClient } from "./chat-client.test-support.js";
import {
  createFileAttachment,
  createImageAttachment,
  createPngBuffer,
  getMessage,
  getMessageContent,
  mockCallAt,
  responseErrorMessage,
  INLINE_PNG_BASE64,
  OFFLOAD_PNG_BASE64,
  TINY_JPEG_BASE64,
  TINY_PNG_BASE64,
} from "./chat-message.test-fixtures.js";
import { handleChatSend } from "./chat-send-handler.js";
import { readChatSendDedupeResponse } from "./chat-send-reservation.js";
import { createChatSendLateReplyFinalizer } from "./chat-send-source-finalization.js";
import { registerChatSourceMediaTests } from "./chat.directive-tags.source-media.suite.js";
import {
  ChatDirectiveDedupe,
  createChatDirectiveReplyBackend,
  createGlobalChatDirectiveConfig,
  createChatDirectiveSender,
  createChatDirectiveSuiteResources,
  createChatDirectiveUserMessageReader,
  expectManagedAudioBlock,
  createUnconfirmedTranscriptDelivery,
  expectClaimOnlyTranscriptMedia,
  readChatDirectiveConfig,
  seedChatDirectiveFileTranscript,
} from "./chat.directive-tags.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type ProjectedDispatchParams = Parameters<
  typeof import("../../auto-reply/dispatch.js").dispatchInboundMessageWithProjectedDispatcher
>[0];
type TestReplyDispatcher = ReturnType<
  typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcher
>;
type TestDispatchParams = Omit<ProjectedDispatchParams, "dispatcherOptions"> & {
  dispatcher: TestReplyDispatcher;
};
type RespondMock = ReturnType<typeof vi.fn<RespondFn>>;
type TranscriptUpdate = Parameters<
  typeof import("../../sessions/transcript-events.js").emitSessionTranscriptUpdate
>[0];

const TEST_TOOL_AUTHORITY_FINGERPRINT = "test-tool-authority";
const TEST_TOOL_AUTHORITY_ROUTE = { provider: "openai", model: "gpt-6-astra" } as const;

const mockState = vi.hoisted(() => {
  const createTestState = () => ({
    config: {} as Record<string, unknown>,
    mainSessionKey: "main",
    finalText: "[[reply_to_current]]",
    finalPayload: null as ReplyPayload | null,
    dispatchedReplies: [] as Array<{
      kind: "tool" | "block" | "final";
      payload: ReplyPayload;
    }>,
    dispatchError: null as Error | null,
    dispatchWait: null as Promise<void> | null,
    dispatchErrorAfterAgentRunStart: null as Error | null,
    dispatchErrorAfterDelivery: null as Error | null,
    sessionMetadataChanges: [] as Array<{
      sessionKey: string;
      agentId?: string;
      reason: "command-metadata";
    }>,
    triggerAgentRunStart: false,
    replyDispatchRun: undefined as ReplyDispatchRun | undefined,
    triggerUserMessagePersisted: false,
    runtimeUserMessagePersistenceError: null as Error | null,
    onAfterAgentRunStart: null as (() => void) | null,
    agentRunId: "run-agent-1",
    sessionEntry: {} as Record<string, unknown>,
    sessionIdsByKey: new Map<string, string>(),
    sessionMissing: false,
    loadSessionEntryCalls: [] as Array<{ rawKey: string; opts?: { agentId?: string } }>,
    lastDispatchCtx: undefined as MsgContext | undefined,
    lastDispatchImages: undefined as Array<{ mimeType: string; data: string }> | undefined,
    lastDispatchImageOrder: undefined as string[] | undefined,
    lastDispatchThinkingLevelOverride: undefined as string | undefined,
    lastDispatchOriginatingLeafEntryId: undefined as string | null | undefined,
    lastTaskSuggestionDeliveryMode: undefined as "gateway" | undefined,
    lastMessageInjectionDisposition: undefined as "none" | "accepted" | "rejected" | undefined,
    lastDispatchUserTurnInput: undefined as unknown,
    modelCatalog: null as ModelCatalogEntry[] | null,
    emittedTranscriptUpdates: [] as TranscriptUpdate[],
    savedMediaResults: [] as Array<{ id?: string; path: string; contentType?: string }>,
    saveMediaError: null as Error | null,
    steerDocumentRenderError: null as Error | null,
    savedMediaCalls: [] as Array<{ contentType?: string; subdir?: string; size: number }>,
    saveMediaWait: null as Promise<void> | null,
    activeSaveMediaCalls: 0,
    maxActiveSaveMediaCalls: 0,
    replyContextCalls: 0,
    replyContextResult: null as {
      ReplyToId?: string;
      ReplyToBody?: string;
      ReplyToSender?: string;
    } | null,
    replyContextWait: null as Promise<void> | null,
    sandboxWorkspace: null as { workspaceDir: string; containerWorkdir?: string } | null,
    stageSandboxMediaError: null as Error | null,
    stagedRelativePaths: null as string[] | null,
    hasBeforeAgentRunHooks: false,
    hasMessageReceivedHooks: false,
    messageReceivedCalls: [] as Array<{ event: unknown; context: unknown }>,
    beforeMessageWriteBlock: false,
    beforeMessageWriteContent: null as string | null,
    beforeMessageWriteCalls: [] as Array<{ message: unknown; ctx: unknown }>,
    dispatchBlockedByBeforeAgentRun: false,
    disposedTranscriptWriteContext: false,
    disposedTranscriptWriteAttempts: 0,
    runtimeAssistantContentBeforeDelivery: null as Array<Record<string, unknown>> | null,
    runtimeAssistantTextsBeforeDelivery: [] as string[],
    cronAuthorityProbe: undefined as
      | ((
          runId: string | undefined,
          capability: CronCreatorAuthorityCapability | undefined,
        ) => Promise<void> | void)
      | undefined,
    // `unstagedSources` lets tests simulate partial staging failure: absolute
    // source paths listed here are excluded from the returned `staged` map even
    // though ctx still carries their rewritten paths. This mirrors how the real
    // stageSandboxMedia silently skips over-cap files.
    unstagedSources: null as string[] | null,
    deleteMediaBufferCalls: [] as Array<{ id: string; subdir?: string }>,
  });
  const state = {
    storePath: "",
    transcriptPath: "",
    sessionId: "sess-1",
    ...createTestState(),
  };
  return Object.assign(state, {
    reset: () => Object.assign(state, createTestState()),
  });
});

type TestReply = (typeof mockState.dispatchedReplies)[number];
type TestReplyPayload = TestReply["payload"];
type SourceReplyTranscriptMirror = NonNullable<
  Parameters<typeof setReplyPayloadMetadata>[1]["sourceReplyTranscriptMirror"]
>;

let suiteResources: ReturnType<typeof createChatDirectiveSuiteResources>;
let suiteFixtureRoot = "";
let suiteDatabasePath = "";
let suiteFixtureEnv: NodeJS.ProcessEnv = {};
let suiteFixtureSeq = 0;
let testSignal: AbortSignal;

function readTranscriptJsonLines(transcriptPath: string): Array<Record<string, unknown>> {
  const sqliteEvents = loadTranscriptEventsSync(transcriptScope()).filter(
    (event): event is Record<string, unknown> =>
      Boolean(event) && typeof event === "object" && !Array.isArray(event),
  );
  if (sqliteEvents.length > 0) {
    return sqliteEvents;
  }
  const entries: Array<Record<string, unknown>> = [];
  if (!fs.existsSync(transcriptPath)) {
    return entries;
  }
  for (const line of fs.readFileSync(transcriptPath, "utf-8").split("\n")) {
    if (line.length > 0) {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return entries;
}

const bindingMocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn(
    (_ref: unknown) =>
      null as { metadata?: Record<string, unknown>; targetSessionKey?: string } | null,
  ),
}));

vi.mock("../../media-understanding/file-context.js", async () => {
  const actual = await vi.importActual<typeof import("../../media-understanding/file-context.js")>(
    "../../media-understanding/file-context.js",
  );
  return {
    ...actual,
    renderInboundDocumentContext: (
      params: Parameters<typeof actual.renderInboundDocumentContext>[0],
    ) => {
      if (mockState.steerDocumentRenderError) {
        return Promise.reject(mockState.steerDocumentRenderError);
      }
      return actual.renderInboundDocumentContext(params);
    },
  };
});

function loadFixtureSessionEntry(rawKey: string, opts?: { agentId?: string }) {
  mockState.loadSessionEntryCalls.push({ rawKey, opts });
  return suiteResources.loadSessionEntry(mockState, rawKey, opts);
}

vi.mock("../session-utils.js", async () => {
  const original =
    await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...original,
    loadSessionEntry: loadFixtureSessionEntry,
    loadGatewaySessionEntryReadOnly: loadFixtureSessionEntry,
  };
});

vi.mock("../session-utils-store-worker.js", async () => {
  const original = await vi.importActual<typeof import("../session-utils-store-worker.js")>(
    "../session-utils-store-worker.js",
  );
  return {
    ...original,
    loadGatewaySessionEntryReadOnlyInWorker: async (
      params: Parameters<typeof original.loadGatewaySessionEntryReadOnlyInWorker>[0],
    ) => {
      params.assertActive?.();
      const loaded = loadFixtureSessionEntry(params.key, { agentId: params.agentId });
      params.assertActive?.();
      return loaded;
    },
  };
});

const dispatchInboundMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../auto-reply/dispatch.js", async () => {
  const { createReplyDispatcher } = await vi.importActual<
    typeof import("../../auto-reply/reply/reply-dispatcher.js")
  >("../../auto-reply/reply/reply-dispatcher.js");
  const { withReplyDispatcher } = await vi.importActual<
    typeof import("../../auto-reply/dispatch-dispatcher.js")
  >("../../auto-reply/dispatch-dispatcher.js");
  return {
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithProjectedDispatcher: vi.fn(
      async (params: ProjectedDispatchParams) => {
        const { dispatcherOptions, ...dispatchParams } = params;
        const dispatcher = createReplyDispatcher(dispatcherOptions);
        return await withReplyDispatcher({
          dispatcher,
          run: () => dispatchInboundMessageMock({ ...dispatchParams, dispatcher }),
        });
      },
    ),
  };
});

dispatchInboundMessageMock.mockImplementation(
  vi.fn(async (params: TestDispatchParams) => {
    mockState.lastDispatchCtx = params.ctx;
    mockState.lastDispatchImages = params.replyOptions?.images;
    mockState.lastDispatchImageOrder = params.replyOptions?.imageOrder;
    mockState.lastDispatchThinkingLevelOverride = params.replyOptions?.thinkingLevelOverride;
    mockState.lastDispatchOriginatingLeafEntryId =
      params.replyOptions?.turnAdoptionLifecycle?.originatingLeafEntryId;
    mockState.lastTaskSuggestionDeliveryMode = params.replyOptions?.taskSuggestionDeliveryMode;
    mockState.lastMessageInjectionDisposition = params.replyOptions?.messageInjectionDisposition;
    await mockState.cronAuthorityProbe?.(
      params.replyOptions?.runId,
      params.replyOptions?.cronCreatorAuthorityCapability,
    );
    const recorder = params.replyOptions?.userTurnTranscriptRecorder;
    mockState.lastDispatchUserTurnInput = recorder?.resolveMessage
      ? await recorder.resolveMessage()
      : recorder?.message;
    if (mockState.dispatchError) {
      throw mockState.dispatchError;
    }
    if (mockState.dispatchWait) {
      await mockState.dispatchWait;
    }
    if (mockState.triggerAgentRunStart) {
      params.replyOptions?.onAgentRunStart?.(
        mockState.agentRunId,
        undefined,
        mockState.replyDispatchRun,
      );
      mockState.onAfterAgentRunStart?.();
    }
    if (mockState.triggerUserMessagePersisted) {
      params.replyOptions?.userTurnTranscriptRecorder?.markRuntimePersisted({
        role: "user",
        content: "persisted by runtime",
        timestamp: Date.now(),
      });
    }
    if (mockState.runtimeUserMessagePersistenceError) {
      const runtimeRecorder = expectDefined(recorder, "runtime persistence fixture");
      runtimeRecorder.markRuntimePersistencePending(
        Promise.reject(mockState.runtimeUserMessagePersistenceError),
      );
      await runtimeRecorder.waitForRuntimePersistence();
    }
    if (mockState.dispatchErrorAfterAgentRunStart) {
      throw mockState.dispatchErrorAfterAgentRunStart;
    }
    if (mockState.runtimeAssistantContentBeforeDelivery) {
      await appendSourceReplyMirrorEntry({
        content: mockState.runtimeAssistantContentBeforeDelivery,
        text: "",
        provider: "openai",
        model: "gpt-5.6-luna",
        now: Date.now(),
      });
    }
    for (const text of mockState.runtimeAssistantTextsBeforeDelivery) {
      await appendSourceReplyMirrorEntry({
        text,
        provider: "openai",
        model: "gpt-5.6-luna",
        now: Date.now(),
      });
    }
    if (mockState.sessionMetadataChanges.length > 0) {
      params.onSessionMetadataChanges?.(mockState.sessionMetadataChanges);
    }
    const deliverReplies = async () => {
      if (mockState.dispatchedReplies.length > 0) {
        for (const reply of mockState.dispatchedReplies) {
          if (reply.kind === "tool") {
            params.dispatcher.sendToolResult(reply.payload);
            continue;
          }
          if (reply.kind === "block") {
            params.dispatcher.sendBlockReply(reply.payload);
            continue;
          }
          params.dispatcher.sendFinalReply(reply.payload);
        }
      } else {
        params.dispatcher.sendFinalReply(mockState.finalPayload ?? { text: mockState.finalText });
      }
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
    };
    if (mockState.disposedTranscriptWriteContext) {
      const sessionKey = mockState.mainSessionKey;
      const storePath = mockState.storePath;
      await withOwnedSessionTranscriptWrites(
        {
          sessionKey,
          sessionTarget: {
            agentId: "main",
            sessionId: mockState.sessionId,
            sessionKey,
            storePath,
          },
          withTranscriptWrite: async () => {
            mockState.disposedTranscriptWriteAttempts += 1;
            throw new Error("attempt disposed before transcript write");
          },
        },
        deliverReplies,
      );
    } else {
      await deliverReplies();
    }
    if (mockState.dispatchErrorAfterDelivery) {
      throw mockState.dispatchErrorAfterDelivery;
    }
    return {
      ok: true,
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      ...(mockState.dispatchBlockedByBeforeAgentRun ? { beforeAgentRunBlocked: true } : {}),
    };
  }),
);

vi.mock("../../infra/outbound/session-binding-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/session-binding-service.js")
  >("../../infra/outbound/session-binding-service.js");
  return {
    ...actual,
    getSessionBindingService: () => ({
      ...actual.getSessionBindingService(),
      resolveByConversationAsync: async (ref: unknown) => bindingMocks.resolveByConversation(ref),
    }),
  };
});

vi.mock("./chat-send-reply-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-send-reply-context.js")>();
  return {
    ...actual,
    resolveChatSendReplyContext: async (
      ...args: Parameters<typeof actual.resolveChatSendReplyContext>
    ) => {
      mockState.replyContextCalls += 1;
      if (mockState.replyContextWait) {
        await mockState.replyContextWait;
      }
      return mockState.replyContextResult ?? actual.resolveChatSendReplyContext(...args);
    },
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => {
  const hasHooks = (hookName: string) =>
    (hookName === "before_agent_run" && mockState.hasBeforeAgentRunHooks) ||
    (hookName === "message_received" && mockState.hasMessageReceivedHooks) ||
    (hookName === "before_message_write" &&
      (mockState.beforeMessageWriteBlock || mockState.beforeMessageWriteContent !== null));
  return {
    getGlobalHookRunner: () => ({
      hasHooks,
      runBeforeMessageWrite: (event: { message: unknown }, ctx: unknown) => {
        mockState.beforeMessageWriteCalls.push({ message: event.message, ctx });
        if (mockState.beforeMessageWriteBlock) {
          return { block: true };
        }
        if (mockState.beforeMessageWriteContent !== null) {
          return {
            message: {
              ...(typeof event.message === "object" && event.message !== null ? event.message : {}),
              role: "user",
              content: mockState.beforeMessageWriteContent,
            },
          };
        }
        return undefined;
      },
      runMessageReceived: async (event: unknown, context: unknown) => {
        mockState.messageReceivedCalls.push({ event, context });
      },
    }),
    hasGlobalHooks: hasHooks,
  };
});

vi.mock("../../sessions/transcript-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/transcript-events.js")>();
  return {
    ...actual,
    emitSessionTranscriptUpdate: vi.fn((update: TranscriptUpdate) => {
      mockState.emittedTranscriptUpdates.push(update);
    }),
  };
});

vi.mock("../../agents/sandbox/context.js", async () => {
  const original = await vi.importActual<typeof import("../../agents/sandbox/context.js")>(
    "../../agents/sandbox/context.js",
  );
  return {
    ...original,
    ensureSandboxWorkspaceForSession: vi.fn(async () => mockState.sandboxWorkspace),
  };
});

vi.mock("../../auto-reply/reply/stage-sandbox-media.js", () => ({
  SANDBOX_MEDIA_MAX_BYTES: 50 * 1024 * 1024,
  stageSandboxMedia: vi.fn(
    async (params: {
      ctx: { media?: Array<{ path?: string; contentType?: string; workspaceDir?: string }> };
    }) => {
      if (mockState.stageSandboxMediaError) {
        throw mockState.stageSandboxMediaError;
      }
      const staged = new Map<number, string>();
      const originalPaths = params.ctx.media?.map((fact) => fact.path) ?? [];
      if (mockState.stagedRelativePaths) {
        const mapping = mockState.stagedRelativePaths;
        params.ctx.media = (params.ctx.media ?? []).map((fact, index) => ({
          path: mapping[index] ?? fact.path,
          contentType: fact.contentType,
          workspaceDir: mockState.sandboxWorkspace?.workspaceDir,
        }));
        for (let i = 0; i < mapping.length; i += 1) {
          const source = originalPaths[i];
          const dest = mapping[i];
          if (source && dest) {
            staged.set(i, dest);
          }
        }
      }
      if (mockState.unstagedSources) {
        for (const source of mockState.unstagedSources) {
          const index = originalPaths.indexOf(source);
          if (index >= 0) {
            staged.delete(index);
          }
        }
      }
      return { staged };
    },
  ),
}));

vi.mock("../../media/store.js", async () => {
  const original =
    await vi.importActual<typeof import("../../media/store.js")>("../../media/store.js");
  return {
    ...original,
    deleteMediaBuffer: vi.fn(async (id: string, subdir?: string) => {
      mockState.deleteMediaBufferCalls.push({ id, subdir });
    }),
    saveMediaBuffer: vi.fn(async (...args: Parameters<typeof original.saveMediaBuffer>) => {
      const [buffer, contentType, subdir] = args;
      mockState.activeSaveMediaCalls += 1;
      mockState.maxActiveSaveMediaCalls = Math.max(
        mockState.maxActiveSaveMediaCalls,
        mockState.activeSaveMediaCalls,
      );
      if (mockState.saveMediaWait) {
        await mockState.saveMediaWait;
      }
      if (mockState.saveMediaError) {
        mockState.activeSaveMediaCalls -= 1;
        throw mockState.saveMediaError;
      }
      mockState.savedMediaCalls.push({ contentType, subdir, size: buffer.byteLength });
      const next = mockState.savedMediaResults.shift();
      try {
        if (subdir === "outgoing/originals") {
          return await original.saveMediaBuffer(...args);
        }
        return {
          id: next?.id ?? "saved-media",
          path: next?.path ?? `/tmp/${mockState.savedMediaCalls.length}.png`,
          size: buffer.byteLength,
          contentType: next?.contentType ?? contentType,
        };
      } finally {
        mockState.activeSaveMediaCalls -= 1;
      }
    }),
  };
});

const { chatHandlers } = await import("./chat.js");
const { handleDirectExternalChatSend } = await import("./chat-send-external-entry.js");
const runNonStreamingChatSend = createChatDirectiveSender({
  internal: handleChatSend,
  external: handleDirectExternalChatSend,
});

// Multi-media transcript mirroring can exceed 1s on loaded CI before the async broadcast lands.
async function waitForAssertion(assertion: () => void, timeoutMs = 5_000, stepMs = 2) {
  await vi.waitFor(assertion, { interval: stepMs, timeout: timeoutMs });
}

function createFixturePaths(prefix: string): { dir: string; transcriptPath: string } {
  const dir = fs.mkdtempSync(path.join(suiteFixtureRoot, `${suiteFixtureSeq++}-${prefix}`));
  const transcriptPath = path.join(dir, "sess.jsonl");
  mockState.sessionId = `chat-directive-${suiteFixtureSeq}`;
  mockState.transcriptPath = transcriptPath;
  return { dir, transcriptPath };
}

async function createTranscriptFixture(
  prefix: string,
  owner: Pick<SessionAccessScope, "agentId" | "sessionKey"> = {
    agentId: "main",
    sessionKey: "main",
  },
  fixtureStore?: "fixed" | "per-agent",
) {
  const { dir, transcriptPath } = createFixturePaths(prefix);
  if (fixtureStore) {
    const store = path.join(
      dir,
      fixtureStore === "per-agent" ? "{agentId}.sqlite" : "session.sqlite",
    );
    mockState.config = {
      ...mockState.config,
      session: { ...(mockState.config.session as OpenClawConfig["session"]), store },
    };
    mockState.storePath = store.replace("{agentId}", owner.agentId ?? "main");
    suiteResources.openDatabase(owner.agentId ?? "main", mockState.storePath);
  }
  await seedChatDirectiveFileTranscript(
    { ...owner, storePath: mockState.storePath },
    mockState.sessionId,
    transcriptPath,
  );
  return dir;
}

async function createSqliteTranscriptFixture(prefix: string) {
  const { dir } = createFixturePaths(prefix);
  await replaceSessionEntry(sessionEntryScope(), {
    sessionId: mockState.sessionId,
    updatedAt: 1,
  });
  return dir;
}

async function withTranscriptFixtureState(
  prefix: string,
  run: (fixtureDir: string) => Promise<void>,
): Promise<void> {
  const fixtureDir = await createTranscriptFixture(prefix);
  await withEnvAsync({ OPENCLAW_STATE_DIR: suiteFixtureRoot }, async () => await run(fixtureDir));
}

function transcriptScope(): SessionTranscriptReadScope {
  return {
    agentId: "main",
    sessionId: mockState.sessionId,
    sessionKey: "main",
    storePath: mockState.storePath,
  };
}

function sessionEntryScope(): SessionAccessScope {
  return {
    agentId: "main",
    sessionKey: "main",
    storePath: mockState.storePath,
  };
}

async function seedSqliteSessionEntry(entry: Record<string, unknown> = {}): Promise<void> {
  await upsertSessionEntryCore(sessionEntryScope(), {
    sessionId: mockState.sessionId,
    ...entry,
  });
}

function readSqliteMainSessionEntry(): Record<string, any> | undefined {
  return loadSqliteSessionEntry(sessionEntryScope()) as Record<string, any> | undefined;
}

async function appendSourceReplyMirrorEntry(params: {
  content?: Array<Record<string, unknown>>;
  idempotencyKey?: string;
  openclawDelivery?: Record<string, unknown>;
  text: string;
  provider?: string;
  model?: string;
  now?: number;
}) {
  const now = params.now ?? 0;
  await appendTranscriptMessage(transcriptScope(), {
    idempotencyLookup: "scan",
    now,
    message: {
      role: "assistant",
      content: params.content ?? [{ type: "text", text: params.text }],
      api: "openai-responses",
      provider: params.provider ?? "openclaw",
      model: params.model ?? "delivery-mirror",
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(params.openclawDelivery ? { openclawDelivery: params.openclawDelivery } : {}),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: now,
    },
  });
}

async function readRawActiveAssistantTranscriptMessages(): Promise<Array<Record<string, unknown>>> {
  return readTranscriptJsonLines(mockState.transcriptPath)
    .map((entry) => entry.message)
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        (message as { role?: unknown }).role === "assistant",
    );
}

async function readActiveAssistantTranscriptMessages(): Promise<Array<Record<string, unknown>>> {
  return (await readRawActiveAssistantTranscriptMessages()).map(projectAssistantDisplayContent);
}

function lastRespondCall(respond: RespondMock) {
  return mockCallAt(respond, -1) as
    | [boolean, Record<string, any> | undefined, Record<string, any> | undefined]
    | undefined;
}

function lastBroadcastPayload(context: ChatContext): Record<string, any> | undefined {
  const chatCall = mockCallAt(context.broadcast, -1);
  expect(chatCall?.[0]).toBe("chat");
  return chatCall?.[1] as Record<string, any> | undefined;
}

function lastNodeSendCall(context: ChatContext) {
  return mockCallAt(context.nodeSendToSession, -1) as
    | [string, string, Record<string, any>]
    | undefined;
}

function findAssistantTranscriptUpdates() {
  return mockState.emittedTranscriptUpdates
    .filter(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant",
    )
    .map((update) => {
      const message = update.message as Record<string, unknown>;
      const projected = projectAssistantDisplayContent(message);
      return projected === message ? update : Object.assign({}, update, { message: projected });
    });
}

function findUserUpdate() {
  return mockState.emittedTranscriptUpdates.find((update) => {
    const message = update.message as { role?: unknown } | undefined;
    return message?.role === "user";
  });
}

function expectUserUpdateIdentity(update: ReturnType<typeof findUserUpdate>) {
  expect(update?.target).toEqual({
    agentId: "main",
    sessionId: mockState.sessionId,
    sessionKey: "agent:main:main",
    storePath: mockState.storePath,
  });
  expect(update?.sessionKey).toBe("agent:main:main");
  expect(update?.agentId).toBe("main");
}

const readPersistedUserMessages = createChatDirectiveUserMessageReader(() =>
  readTranscriptJsonLines(mockState.transcriptPath),
);

function expectDispatchContextFields(expected: {
  OriginatingChannel?: unknown;
  OriginatingTo?: unknown;
  ExplicitDeliverRoute?: unknown;
  AccountId?: unknown;
  MessageThreadId?: unknown;
  BodyForCommands?: unknown;
  CommandSource?: unknown;
}) {
  for (const [key, value] of Object.entries(expected)) {
    expect((mockState.lastDispatchCtx as Record<string, unknown> | undefined)?.[key]).toBe(value);
  }
}

function createChatContext() {
  const context = {
    broadcast: vi.fn<GatewayRequestContext["broadcast"]>(),
    nodeSendToSession: vi.fn<GatewayRequestContext["nodeSendToSession"]>(),
    agentRunSeq: new Map<string, number>(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: createChatRunState(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    dedupe: new ChatDirectiveDedupe(testSignal),
    loadGatewayModelCatalog: async () =>
      mockState.modelCatalog ?? [
        // Keep the default model image-capable here; otherwise attachment tests
        // exercise the unsupported-model fallback instead of Pi persistence.
        {
          provider: "openai",
          id: "gpt-6-astra",
          name: "GPT-6 Astra",
          input: ["text", "image"],
        },
        {
          provider: "anthropic",
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          input: ["text", "image"],
        },
      ],
    getRuntimeConfig: () => readChatDirectiveConfig(mockState),
    registerToolEventRecipient: vi.fn<GatewayRequestContext["registerToolEventRecipient"]>(),
    broadcastToConnIds: vi.fn<GatewayRequestContext["broadcastToConnIds"]>(),
    getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
    logGateway: {
      warn: vi.fn<GatewayRequestContext["logGateway"]["warn"]>(),
      debug: vi.fn<GatewayRequestContext["logGateway"]["debug"]>(),
      error: vi.fn<GatewayRequestContext["logGateway"]["error"]>(),
    },
  };
  return context as typeof context & GatewayRequestContext;
}

type ChatContext = ReturnType<typeof createChatContext>;

function useChatTestModel(model: "vision-model" | "text-only", configured = false) {
  mockState.sessionEntry = {
    modelProvider: "test-provider",
    model,
    ...(configured ? { providerOverride: "test-provider", modelOverride: model } : {}),
  };
  mockState.modelCatalog = [
    {
      provider: "test-provider",
      id: model,
      name: model === "vision-model" ? "Vision model" : "Text only",
      input: model === "vision-model" ? ["text", "image"] : ["text"],
    },
  ];
}

async function createGlobalTranscriptFixture(prefix: string, agentId = "main") {
  mockState.config = createGlobalChatDirectiveConfig();
  return await createTranscriptFixture(
    prefix,
    { agentId, sessionKey: "global" },
    agentId === "main" ? undefined : "per-agent",
  );
}

async function createReadyChatTranscript(prefix: string) {
  await createTranscriptFixture(prefix);
  mockState.finalText = "ok";
}

function createChatRequestFixture() {
  const context = createChatContext();
  const respond = vi.fn<RespondFn>();
  return {
    context,
    respond,
    send: (params: Omit<Parameters<typeof runNonStreamingChatSend>[0], "context" | "respond">) =>
      runNonStreamingChatSend({ context, respond, ...params }),
    inject: (params: Parameters<NonNullable<(typeof chatHandlers)["chat.inject"]>>[0]["params"]) =>
      expectDefined(
        chatHandlers["chat.inject"],
        'chatHandlers["chat.inject"] test invariant',
      )({
        params,
        respond,
        req: {} as never,
        client: null as never,
        isWebchatConnect: () => false,
        context,
      }),
  };
}

async function sendNewChatRequest(
  params: Omit<Parameters<typeof runNonStreamingChatSend>[0], "context" | "respond">,
) {
  const fixture = createChatRequestFixture();
  const payload = await fixture.send(params);
  return { ...fixture, payload };
}

async function createSqliteChatRequest(prefix: string) {
  await createSqliteTranscriptFixture(prefix);
  return createChatRequestFixture();
}

type ChatDeliveryRoutingCase = readonly [
  name: string,
  id: string,
  delivery: { channel: string; to: string; accountId: string; threadId?: string | number },
  sessionKey: string,
  options?: {
    deliver?: boolean;
    clientMode?: string;
    mainSessionKey?: string;
    origin?: { provider: string; accountId: string; threadId?: string };
    omitClientDetails?: boolean;
    external?: boolean;
  },
];
type SlashCommandMediaCase = {
  name: string;
  id: string;
  files: string[];
  replies: (paths: [string, string]) => typeof mockState.dispatchedReplies;
  verify: (content: Array<Record<string, any>>, paths: [string, string]) => void;
};

function createSlashCommandMediaReply(
  kind: "block" | "final",
  mediaUrls: string[],
  payload: (typeof mockState.dispatchedReplies)[number]["payload"] = {},
): (typeof mockState.dispatchedReplies)[number] {
  return { kind, payload: { mediaUrls, trustedLocalMedia: true, ...payload } };
}

function managedAudioBlocks(content: Array<Record<string, unknown>>) {
  return content.filter((block) => block.type === "audio");
}

function bindTestToolAuthority(operation: ReplyOperation) {
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => TEST_TOOL_AUTHORITY_FINGERPRINT,
    project: () => TEST_TOOL_AUTHORITY_FINGERPRINT,
  });
  operation.bindToolAuthorityRoute(TEST_TOOL_AUTHORITY_ROUTE);
}

function beginActiveReplyOperation(params: {
  backend?: Parameters<ReplyOperation["attachBackend"]>[0];
  bindToolAuthority?: boolean;
  originatingLeafEntryId?: string | null;
  sessionId?: string;
  sessionKey?: string;
}) {
  const operation = replyRunRegistry.begin({
    sessionKey: params.sessionKey ?? "agent:main:main",
    sessionId: params.sessionId ?? mockState.sessionId,
    resetTriggered: false,
    ...(params.originatingLeafEntryId !== undefined
      ? { originatingLeafEntryId: params.originatingLeafEntryId }
      : {}),
  });
  if (params.bindToolAuthority) {
    bindTestToolAuthority(operation);
  }
  operation.setPhase("running");
  if (params.backend) {
    operation.attachBackend(params.backend);
  }
  return operation;
}

function beginMessageInjectionOperation(
  params: Parameters<typeof createChatDirectiveReplyBackend>[0] & {
    bindToolAuthority?: boolean;
    originatingLeafEntryId?: string | null;
  },
) {
  return beginActiveReplyOperation({
    bindToolAuthority: params.bindToolAuthority ?? true,
    originatingLeafEntryId: params.originatingLeafEntryId,
    backend: createChatDirectiveReplyBackend(params),
  });
}

async function appendTestTranscriptMessage(params: {
  content: string;
  display?: boolean;
  eventId: string;
  now: number;
  parentId: string | null;
  role: "assistant" | "user";
}) {
  await appendTranscriptMessage(transcriptScope(), {
    eventId: params.eventId,
    message: {
      role: params.role,
      content: params.content,
      ...(params.display === undefined ? {} : { display: params.display }),
    },
    now: params.now,
    parentId: params.parentId,
  });
}

function writeSavedPng(fixtureDir: string, fileName: string): string {
  const savedImagePath = path.join(fixtureDir, fileName);
  fs.writeFileSync(savedImagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
  mockState.savedMediaResults.push({ path: savedImagePath, contentType: "image/png" });
  return savedImagePath;
}

function setSavedMediaResults(...results: Array<[path: string, contentType: string, id?: string]>) {
  mockState.savedMediaResults = results.map(([pathValue, contentType, id]) => {
    const result = { path: pathValue, contentType, id: undefined as string | undefined };
    if (id) {
      result.id = id;
    }
    return result;
  });
}

async function createAudioTranscriptFixture(prefix: string, fileName = "tts.mp3") {
  const transcriptDir = await createTranscriptFixture(prefix);
  const audioPath = path.join(transcriptDir, fileName);
  fs.writeFileSync(audioPath, createPlaybackMediaFixture("mp3"));
  mockState.config = { agents: { defaults: { workspace: transcriptDir } } };
  return { audioPath, transcriptDir };
}

function createSourceReply(
  payload: TestReplyPayload,
  sourceReplyTranscriptMirror: SourceReplyTranscriptMirror,
): TestReply {
  return {
    kind: "final",
    payload: setReplyPayloadMetadata(payload, { sourceReplyTranscriptMirror }),
  };
}

function createMainSourceReply(params: {
  idempotencyKey: string;
  mediaUrls?: string[];
  replyToCurrent?: boolean;
  replyToId?: string;
  text?: string;
  transcriptOwner?: true;
}): TestReply {
  const { idempotencyKey, mediaUrls, replyToCurrent, replyToId, text, transcriptOwner } = params;
  return createSourceReply(
    {
      ...(text ? { text } : {}),
      ...(mediaUrls ? { mediaUrls } : {}),
      ...(replyToCurrent ? { replyToCurrent } : {}),
      ...(replyToId ? { replyToId } : {}),
    },
    {
      sessionKey: "main",
      ...(text ? { text } : {}),
      ...(mediaUrls ? { mediaUrls } : {}),
      idempotencyKey,
      ...(transcriptOwner ? { transcriptOwner } : {}),
    },
  );
}

function setAgentRunReplies(replies: TestReply[]) {
  mockState.triggerAgentRunStart = true;
  mockState.dispatchedReplies = replies;
}

async function expectImageOnlyFinal(params: {
  transcriptPrefix: string;
  idempotencyKey: string;
  finalPayload: NonNullable<typeof mockState.finalPayload>;
}) {
  await createTranscriptFixture(params.transcriptPrefix);
  mockState.finalPayload = params.finalPayload;
  const { send } = createChatRequestFixture();
  const payload = await send({ idempotencyKey: params.idempotencyKey });
  const content = getMessageContent(payload);
  const mediaUrl = params.finalPayload.mediaUrl;
  if (typeof mediaUrl !== "string") {
    throw new Error("Expected an image-only final media URL");
  }
  const image = content.find((block) => block.type === "image");
  expect(getMessage(payload)?.role).toBe("assistant");
  expect(content).toHaveLength(1);
  expect(image).toMatchObject({
    type: "image",
    artifactId: expect.stringMatching(/^artifact_managed_image_/u),
    mimeType: "image/png",
    url: expect.stringMatching(/\/api\/chat\/media\/outgoing\//u),
    openUrl: expect.stringMatching(/\/api\/chat\/media\/outgoing\//u),
  });
  expect(content.some((block) => block.type === "attachment_error")).toBe(false);
  expect(JSON.stringify(content)).not.toContain(mediaUrl);
}

beforeEach(({ signal }) => {
  testSignal = signal;
});

beforeAll(() => {
  suiteResources = createChatDirectiveSuiteResources();
  suiteFixtureRoot = suiteResources.root;
  suiteDatabasePath = suiteResources.databasePath;
  suiteFixtureEnv = suiteResources.env;
  mockState.storePath = suiteDatabasePath;
  suiteResources.open();
});

afterEach(async () => {
  await suiteResources.settleFixtures();
  // ACKs and terminal errors can precede detached transcript cleanup.
  await waitForAssertion(() => expect(getActiveSessionWorkAdmissionCount()).toBe(0));
  await suiteResources.closeCaseDatabases();
  replyRunRegistryTesting.resetReplyRunRegistry();
  mockState.reset();
  mockState.storePath = suiteDatabasePath;
  bindingMocks.resolveByConversation.mockReset();
  bindingMocks.resolveByConversation.mockReturnValue(null);
});

afterAll(async () => {
  try {
    expect(getTotalPendingReplies()).toBe(0);
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      env: suiteFixtureEnv,
      path: suiteDatabasePath,
    });
  } finally {
    await suiteResources.close();
  }
});

describe("chat directive tag stripping for non-streaming final payloads", () => {
  it.each([
    ["rejects an off-path leaf without a session id", "previous-leaf", undefined, false],
    ["rejects a stale empty leaf without a session id", null, undefined, false],
    ["accepts an empty starting leaf after a same-session append", null, "current", true],
    ["accepts a same-session active ancestor", "rendered-leaf", "current", true],
    ["rejects an ancestor from a replaced session", "rendered-leaf", "replaced", false],
  ] as const)("%s", async (_name, expectedLeafEntryId, sessionId, accepted) => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-active-ancestor-",
    );
    // Capture the physical session before another participant appends the first turn.
    const requestedSessionId = sessionId === "current" ? mockState.sessionId : sessionId;
    await appendTestTranscriptMessage({
      eventId: "rendered-leaf",
      role: "assistant",
      content: "rendered",
      now: 1,
      parentId: null,
    });
    await appendTestTranscriptMessage({
      eventId: "memory-flush-user",
      role: "user",
      content: "maintenance prompt",
      display: false,
      now: 2,
      parentId: "rendered-leaf",
    });
    await appendTranscriptEvent(transcriptScope(), {
      type: "compaction",
      id: "background-compaction",
      parentId: "memory-flush-user",
      timestamp: "2026-08-10T00:00:00.000Z",
      summary: "background maintenance",
      firstKeptEntryId: "rendered-leaf",
      tokensBefore: 10,
    });
    await appendTestTranscriptMessage({
      eventId: "background-leaf",
      role: "assistant",
      content: "background append",
      display: false,
      now: 3,
      parentId: "background-compaction",
    });
    const before = loadTranscriptEventsSync(transcriptScope());

    await send({
      idempotencyKey: `idem-active-ancestor-${sessionId}`,
      requestParams: {
        expectedLeafEntryId,
        sessionId: requestedSessionId,
      },
      waitFor: "none",
    });

    const response = expectDefined(
      lastRespondCall(respond),
      "active ancestor response test invariant",
    );
    expect(response[0]).toBe(accepted);
    expect(context.addChatRun).toHaveBeenCalledTimes(accepted ? 1 : 0);
    if (accepted) {
      expect(response[1]).toEqual(expect.objectContaining({ status: "started" }));
    } else {
      expect(response).toEqual([
        false,
        undefined,
        expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
      ]);
      expect(mockState.lastDispatchCtx).toBeUndefined();
      expect(loadTranscriptEventsSync(transcriptScope())).toEqual(before);
    }
  });

  it.each(["copied-leaf", null])(
    "rejects leaf %s from before a branch switch",
    async (expectedLeafEntryId) => {
      const { context, respond, send } = await createSqliteChatRequest(
        "openclaw-chat-send-rotated-exact-leaf-",
      );
      await appendTestTranscriptMessage({
        eventId: "branch-root",
        role: "user",
        content: "root",
        now: 1,
        parentId: null,
      });
      await appendTestTranscriptMessage({
        eventId: "copied-leaf",
        role: "assistant",
        content: "selected branch",
        now: 2,
        parentId: "branch-root",
      });
      await appendTestTranscriptMessage({
        eventId: "active-sibling",
        role: "assistant",
        content: "active branch",
        now: 3,
        parentId: "branch-root",
      });
      await waitForSessionTranscriptIndexReconcile({
        agentId: "main",
        env: suiteFixtureEnv,
        path: suiteDatabasePath,
      });
      const staleSessionId = mockState.sessionId;
      const switched = await switchSessionBranch({
        agentId: "main",
        env: suiteFixtureEnv,
        leafEntryId: "copied-leaf",
        sessionKey: "agent:main:main",
        storePath: suiteDatabasePath,
      });
      expect(switched.status).toBe("created");
      if (switched.status !== "created") {
        throw new Error("expected branch switch test invariant");
      }
      expect(switched.entry.sessionId).not.toBe(staleSessionId);
      mockState.sessionId = switched.entry.sessionId;
      const before = loadTranscriptEventsSync(transcriptScope());
      expect(resolveSessionTranscriptActiveLeafEntryId(before)).toBe("copied-leaf");

      await send({
        idempotencyKey: "idem-rotated-exact-leaf",
        requestParams: {
          expectedLeafEntryId,
          sessionId: staleSessionId,
        },
        waitFor: "none",
      });

      expect(lastRespondCall(respond)).toEqual([
        false,
        undefined,
        expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
      ]);
      expect(context.addChatRun).not.toHaveBeenCalled();
      expect(mockState.lastDispatchCtx).toBeUndefined();
      expect(loadTranscriptEventsSync(transcriptScope())).toEqual(before);
    },
  );

  it("rejects an expected sibling that is off the active path", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-off-path-sibling-",
    );
    await appendTestTranscriptMessage({
      eventId: "branch-root",
      role: "user",
      content: "root",
      now: 1,
      parentId: null,
    });
    await appendTestTranscriptMessage({
      eventId: "off-path-sibling",
      role: "assistant",
      content: "abandoned",
      now: 2,
      parentId: "branch-root",
    });
    await appendTestTranscriptMessage({
      eventId: "active-sibling",
      role: "assistant",
      content: "active",
      now: 3,
      parentId: "branch-root",
    });
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      env: suiteFixtureEnv,
      path: suiteDatabasePath,
    });
    const before = loadTranscriptEventsSync(transcriptScope());

    await send({
      idempotencyKey: "idem-off-path-sibling",
      requestParams: {
        expectedLeafEntryId: "off-path-sibling",
        sessionId: mockState.sessionId,
      },
      waitFor: "none",
    });

    expect(lastRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
    ]);
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(loadTranscriptEventsSync(transcriptScope())).toEqual(before);
  });

  it("allows an expected empty leaf when the transcript is still empty", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-matching-empty-leaf-",
    );

    await send({
      idempotencyKey: "idem-matching-empty-leaf",
      requestParams: { expectedLeafEntryId: null },
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    expect(context.addChatRun).toHaveBeenCalledTimes(1);
    expect(mockState.lastDispatchOriginatingLeafEntryId).toBeNull();
  });

  it.each(["active descendant", "non-injectable CLI owner"] as const)(
    "dispatches a new turn despite %s activity",
    async (owner) => {
      const { context, respond, send } = await createSqliteChatRequest(
        "openclaw-chat-send-steer-fallback-",
      );
      const descendant = owner === "active descendant";
      const operation = beginActiveReplyOperation(
        descendant
          ? {
              sessionKey: "agent:main:main:subagent:child",
              sessionId: `${mockState.sessionId}-descendant`,
            }
          : {
              backend: { kind: "cli", runId: "cli-run", cancel: vi.fn() },
            },
      );
      try {
        await send({
          idempotencyKey: "idem-steer-fallback",
          requestParams: { queueMode: "steer" },
        });
      } finally {
        operation.complete();
      }
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      expect(context.addChatRun).toHaveBeenCalledOnce();
      expect(operation.result).toEqual({ kind: "completed" });
      expect(mockState.lastDispatchCtx?.BodyForAgent).toBe("hello");
      expect(mockState.lastMessageInjectionDisposition).toBeUndefined();
    },
  );

  it("injects a matching leaf-bound steer once through the legacy backend on retry", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-targetless-steer-",
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "assistant",
      content: "working",
      now: 1,
      parentId: null,
    });
    const queueMessage = vi.fn(async () => {});
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: "current-leaf",
      legacy: true,
      isStopped: () => false,
      queueMessage,
    });

    try {
      await send({
        idempotencyKey: "idem-targetless-steer",
        requestParams: { expectedLeafEntryId: "current-leaf", queueMode: "steer" },
      });
      await send({
        idempotencyKey: "idem-targetless-steer",
        requestParams: { expectedLeafEntryId: "current-leaf", queueMode: "steer" },
      });
    } finally {
      operation.complete();
    }

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(context.addChatRun).toHaveBeenCalledOnce();
  });

  it("dispatches tool-bound input instead of injecting it into the active run", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-tool-bound-dispatch-",
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "assistant",
      content: "working",
      now: 1,
      parentId: null,
    });
    const queueMessage = vi.fn(async () => {});
    const operation = beginMessageInjectionOperation({
      bindToolAuthority: false,
      originatingLeafEntryId: "current-leaf",
      queueMessage,
    });
    const toolBindings = { browser: { kind: "tab", tabId: 1, targetId: "target-1" } };

    try {
      await send({
        idempotencyKey: "idem-tool-bound-dispatch",
        requestParams: {
          expectedLeafEntryId: "current-leaf",
          queueMode: "steer",
          toolBindings,
        },
        client: {
          connId: "copilot",
          pairedClientId: "openclaw-browser-copilot",
          connect: {
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            caps: ["run-tool-bindings"],
            client: {
              id: "openclaw-browser-copilot",
              version: "test",
              platform: "chrome",
              mode: "ui",
            },
          },
        },
        waitFor: "none",
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      expect(queueMessage).not.toHaveBeenCalled();
      expect(context.addChatRun).toHaveBeenCalledOnce();
      operation.complete();
      await waitForAssertion(() =>
        expect(mockState.lastDispatchCtx?.GatewayRunToolBindings).toEqual(toolBindings),
      );
    } finally {
      operation.complete();
    }
  });

  it("falls back once without touching a successor when the captured owner ends", async () => {
    const { context, respond } = await createSqliteChatRequest(
      "openclaw-chat-send-targetless-operation-aba-",
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "assistant",
      content: "working",
      now: 1,
      parentId: null,
    });
    const originalQueue = vi.fn(async () => {});
    const successorQueue = vi.fn(async () => {});
    const successorCancel = vi.fn();
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    const original = beginMessageInjectionOperation({
      originatingLeafEntryId: "current-leaf",
      queueMessage: originalQueue,
    });
    let successor: ReturnType<typeof replyRunRegistry.begin> | undefined;

    try {
      await handleChatSend(
        {
          params: {
            sessionKey: "main",
            message: "hello",
            idempotencyKey: "idem-targetless-operation-aba",
            expectedLeafEntryId: "current-leaf",
            queueMode: "steer",
          },
          respond: respond as never,
          req: {} as never,
          client: {
            connect: {
              client: {
                id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
                mode: GATEWAY_CLIENT_MODES.WEBCHAT,
                version: "dev",
                platform: "web",
              },
              scopes: ["operator.admin"],
            },
          } as never,
          isWebchatConnect: () => false,
          context,
        },
        async () => {
          original.complete();
          successor = beginMessageInjectionOperation({
            originatingLeafEntryId: "current-leaf",
            cancel: successorCancel,
            queueMessage: successorQueue,
          });
          return true;
        },
      );
    } finally {
      original.complete();
      successor?.complete();
    }

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    await waitForAssertion(() =>
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore + 1),
    );
    expect(originalQueue).not.toHaveBeenCalled();
    expect(successorQueue).not.toHaveBeenCalled();
    expect(successorCancel).not.toHaveBeenCalled();
    expect(context.addChatRun).toHaveBeenCalledOnce();
    expect(mockState.lastMessageInjectionDisposition).toBe("rejected");
  });

  it("starts captured-operation injection before ACK and does not dispatch after owner clear", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-steer-before-ack-",
    );
    const delivery = createDeferred();
    let reportAcceptance: ((accepted: boolean) => void) | undefined;
    const queueMessage = vi.fn((_text: string, options?: ReplyBackendQueueMessageOptions) => {
      expect(respond).not.toHaveBeenCalled();
      reportAcceptance = options?.onQueueAccepted;
      return delivery.promise;
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "active-run",
      queueMessage,
    });

    const pendingSend = send({
      idempotencyKey: "idem-steer-before-ack",
      requestParams: { queueMode: "steer" },
      waitFor: "none",
    });

    await waitForAssertion(() => expect(queueMessage).toHaveBeenCalledOnce());
    expect(respond).not.toHaveBeenCalled();
    reportAcceptance?.(true);
    await pendingSend;
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    expect(mockState.lastDispatchCtx).toBeUndefined();
    operation.complete();
    delivery.resolve();
    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-steer-before-ack")?.payload).toEqual({
        runId: "idem-steer-before-ack",
        status: "ok",
      });
    });
    expect(context.broadcast).toHaveBeenCalledOnce();
  });

  it("records accepted steering once across transcript, hooks, audit, and finalization", async () => {
    const { context, send } = await createSqliteChatRequest("openclaw-chat-send-steer-accounting-");
    mockState.hasMessageReceivedHooks = true;
    setSavedMediaResults(["/tmp/steer.png", "image/png"]);
    const auditEvents: Array<{ reasonCode?: unknown; runId?: unknown }> = [];
    const disposeAudit = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    const queueMessage = vi.fn(async (_text: string, options?: ReplyBackendQueueMessageOptions) => {
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore);
      await options?.userTurnTranscriptRecorder?.persistApproved();
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "active-run",
      supportsQueueMessageImages: true,
      taskSuggestionDeliveryMode: "gateway",
      queueMessage,
    });

    try {
      await send({
        idempotencyKey: "idem-steer-accounting",
        requestParams: {
          queueMode: "steer",
          attachments: [createImageAttachment()],
        },
        client: {
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              version: "dev",
              platform: "web",
            },
            caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
            scopes: ["operator.admin"],
          },
        },
      });
    } finally {
      operation.complete();
      disposeAudit();
    }

    await waitForAssertion(() => expect(mockState.messageReceivedCalls).toHaveLength(1));
    expect(readPersistedUserMessages()).toHaveLength(1);
    expect(readPersistedUserMessages()[0]?.content).toBe("hello");
    expect(readPersistedUserMessages()[0]?.["__openclaw"]).toMatchObject({
      steerTargetRunId: "active-run",
    });
    const userUpdates = mockState.emittedTranscriptUpdates.filter(
      (update) => getMessage(update)?.role === "user",
    );
    expect(userUpdates).toHaveLength(2);
    expect(getMessage(userUpdates[0])).not.toHaveProperty("__openclaw.steerTargetRunId");
    expect(getMessage(userUpdates[1])).toHaveProperty("__openclaw.steerTargetRunId", "active-run");
    expect(queueMessage).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        images: [expect.objectContaining({ mimeType: "image/png" })],
        imageOrder: ["inline"],
        taskSuggestionDeliveryMode: "gateway",
        userTurnTranscriptRecorder: expect.any(Object),
      }),
    );
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        reasonCode: "active_run_injected",
        runId: "idem-steer-accounting",
      }),
    );
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore);
    expect(context.broadcast).toHaveBeenCalledOnce();
  });

  it.each([false, true])("steers document context with render failure=%s", async (renderFails) => {
    const { respond, send } = await createSqliteChatRequest("openclaw-chat-send-steer-document-");
    mockState.hasMessageReceivedHooks = true;
    const documentPath = path.join(suiteFixtureRoot, "notes.txt");
    fs.writeFileSync(documentPath, "steered document body");
    setSavedMediaResults([documentPath, "text/plain"]);
    if (renderFails) {
      mockState.steerDocumentRenderError = new Error("lazy media runtime unavailable");
    }
    const queueMessage = vi.fn(async (_text: string, options?: ReplyBackendQueueMessageOptions) => {
      await options?.userTurnTranscriptRecorder?.persistApproved();
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "active-run",
      supportsQueueMessageImages: true,
      taskSuggestionDeliveryMode: "gateway",
      queueMessage,
    });
    try {
      await send({
        idempotencyKey: "idem-steer-document",
        requestParams: {
          queueMode: "steer",
          attachments: [
            createFileAttachment(
              "notes.txt",
              "text/plain",
              Buffer.from("steered document body").toString("base64"),
            ),
          ],
        },
        client: {
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              version: "dev",
              platform: "web",
            },
            caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
            scopes: ["operator.admin"],
          },
        },
      });
    } finally {
      operation.complete();
      mockState.steerDocumentRenderError = null;
    }
    expect(queueMessage).toHaveBeenCalledOnce();
    const [injectedText] = expectDefined(queueMessage.mock.calls[0], "injected document text");
    if (renderFails) {
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      expect(injectedText).toBeDefined();
      expect(injectedText).not.toContain('<file name="notes.txt"');
      expect(injectedText).toContain("hello");
    } else {
      expect(injectedText).toContain('<file name="notes.txt" mime="text/plain">');
      expect(injectedText).toContain("steered document body");
    }
  });

  it("hydrates and accepts reply injection before ACK without waiting for delivery", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-reply-steer-",
    );
    mockState.hasMessageReceivedHooks = true;
    const hydration = createDeferred();
    mockState.replyContextWait = hydration.promise;
    mockState.replyContextResult = {
      ReplyToId: "prior-message",
      ReplyToBody: "quoted deployment status",
      ReplyToSender: "Alice",
    };
    const auditEvents: Array<{ reasonCode?: unknown }> = [];
    const disposeAudit = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const delivery = createDeferred();
    let reportAcceptance: ((accepted: boolean) => void) | undefined;
    const queueMessage = vi.fn((_text: string, options?: ReplyBackendQueueMessageOptions) => {
      reportAcceptance = options?.onQueueAccepted;
      return delivery.promise;
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: "current-leaf",
      runId: "run-a",
      queueMessage,
    });

    try {
      const pendingSend = send({
        idempotencyKey: "idem-reply-steer",
        requestParams: {
          queueMode: "steer",
          replyToId: "prior-message",
        },
        waitFor: "none",
      });

      await waitForAssertion(() => expect(mockState.replyContextCalls).toBe(1));
      expect(queueMessage).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();

      hydration.resolve();
      await waitForAssertion(() => expect(queueMessage).toHaveBeenCalledOnce());
      expect(queueMessage.mock.calls[0]?.[0]).toContain("Reply target of current user message:");
      expect(queueMessage.mock.calls[0]?.[0]).toContain("quoted deployment status");
      expect(queueMessage.mock.calls[0]?.[0]).toContain("hello");
      expect(respond).not.toHaveBeenCalled();

      reportAcceptance?.(true);
      await pendingSend;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(mockState.lastDispatchCtx).toBeUndefined();

      delivery.resolve();
      await waitForAssertion(() => expect(context.broadcast).toHaveBeenCalledOnce());
    } finally {
      hydration.resolve();
      delivery.resolve();
      operation.complete();
      disposeAudit();
    }

    expect(mockState.messageReceivedCalls).toHaveLength(1);
    expect(readPersistedUserMessages()).toHaveLength(1);
    expect(readPersistedUserMessages()[0]?.["__openclaw"]).toMatchObject({
      replyToId: "prior-message",
      replyToPreview: {
        text: "quoted deployment status",
        senderLabel: "Alice",
      },
    });
    expect(auditEvents.filter((event) => event.reasonCode === "active_run_injected")).toHaveLength(
      1,
    );
    expect(mockState.replyContextCalls).toBe(1);
    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(context.broadcast).toHaveBeenCalledOnce();
  });

  it("falls back once when reply hydration outlives its captured run", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-reply-steer-race-",
    );
    const hydration = createDeferred();
    mockState.replyContextWait = hydration.promise;
    mockState.replyContextResult = {
      ReplyToId: "prior-message",
      ReplyToBody: "quoted deployment status",
      ReplyToSender: "Alice",
    };
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    const originalQueue = vi.fn(async () => {});
    const successorQueue = vi.fn(async () => {});
    const successorCancel = vi.fn();
    const original = beginMessageInjectionOperation({
      originatingLeafEntryId: "current-leaf",
      runId: "run-a",
      queueMessage: originalQueue,
    });
    let successor: ReturnType<typeof replyRunRegistry.begin> | undefined;

    try {
      const pendingSend = send({
        idempotencyKey: "idem-reply-steer-race",
        requestParams: {
          queueMode: "steer",
          replyToId: "prior-message",
        },
        waitFor: "none",
      });
      await waitForAssertion(() => expect(mockState.replyContextCalls).toBe(1));
      expect(respond).not.toHaveBeenCalled();
      expect(originalQueue).not.toHaveBeenCalled();
      original.complete();
      successor = beginMessageInjectionOperation({
        originatingLeafEntryId: "current-leaf",
        runId: "run-b",
        cancel: successorCancel,
        queueMessage: successorQueue,
      });
      hydration.resolve();
      await pendingSend;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      await waitForAssertion(() => {
        expect(context.dedupe.get("chat:idem-reply-steer-race")?.payload).toMatchObject({
          status: "ok",
        });
      });
    } finally {
      hydration.resolve();
      original.complete();
      successor?.complete();
    }

    expect(originalQueue).not.toHaveBeenCalled();
    expect(successorQueue).not.toHaveBeenCalled();
    expect(successorCancel).not.toHaveBeenCalled();
    expect(mockState.replyContextCalls).toBe(1);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore + 1);
    expect(mockState.lastMessageInjectionDisposition).toBe("rejected");
    expect(readPersistedUserMessages()).toHaveLength(1);
    expect(
      (readPersistedUserMessages()[0]?.["__openclaw"] as Record<string, unknown> | undefined)
        ?.steerTargetRunId,
    ).toBeUndefined();
    const broadcasts = context.broadcast.mock.calls.map(
      ([, payload]) => payload as Record<string, unknown>,
    );
    expect(broadcasts.filter((payload) => payload.state === "error")).toEqual([]);
  });

  it("hydrates an ordinary reply before acknowledging its durable input", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-reply-no-steer-",
    );
    const hydration = createDeferred();
    mockState.replyContextWait = hydration.promise;
    mockState.replyContextResult = {
      ReplyToId: "prior-message",
      ReplyToBody: "quoted deployment status",
      ReplyToSender: "Alice",
    };

    const pendingSend = send({
      idempotencyKey: "idem-reply-no-steer",
      requestParams: { replyToId: "prior-message" },
      waitFor: "none",
    });
    try {
      await waitForAssertion(() => expect(mockState.replyContextCalls).toBe(1));
      expect(respond).not.toHaveBeenCalled();
      expect(mockState.lastDispatchCtx).toBeUndefined();
      hydration.resolve();
      await pendingSend;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      await waitForAssertion(() => {
        expect(context.dedupe.get("chat:idem-reply-no-steer")?.payload).toMatchObject({
          status: "ok",
        });
      });
    } finally {
      hydration.resolve();
    }

    expect(mockState.replyContextCalls).toBe(1);
    expect(mockState.lastDispatchCtx).toMatchObject({
      ReplyToId: "prior-message",
      ReplyToBody: "quoted deployment status",
      ReplyToSender: "Alice",
    });
  });

  it("falls back once when captured injection rejects acceptance", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-steer-reject-",
    );
    mockState.finalText = "fallback reply";
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    const delivery = createDeferred();
    const queueMessage = vi.fn((_text: string, options?: ReplyBackendQueueMessageOptions) => {
      options?.onQueueAccepted?.(false);
      return delivery.promise;
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "active-run",
      queueMessage,
    });

    const pendingSend = send({
      idempotencyKey: "idem-steer-reject",
      requestParams: { queueMode: "steer" },
      waitFor: "none",
    });
    const rejection = new Error("native turn ended");
    try {
      await waitForAssertion(() => expect(queueMessage).toHaveBeenCalledOnce());
      // A negative callback is provisional; only the terminal rejection permits fallback.
      expect(respond).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore);
      delivery.reject(rejection);
      await pendingSend;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      operation.complete();

      await waitForAssertion(() => {
        expect(context.dedupe.get("chat:idem-steer-reject")?.payload).toEqual({
          runId: "idem-steer-reject",
          status: "ok",
        });
      });
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore + 1);
      expect(mockState.lastDispatchCtx?.BodyForAgent).toBe("hello");
    } finally {
      delivery.reject(rejection);
      operation.complete();
      await Promise.allSettled([pendingSend, delivery.promise]);
    }
  });

  it("never aborts or replays onto a successor after unconfirmed acceptance", async ({ signal }) =>
    suiteResources.runFixture(async () => {
      const { context, send } = await createSqliteChatRequest(
        "openclaw-chat-send-steer-unconfirmed-",
      );
      const delivery = createUnconfirmedTranscriptDelivery();
      const first = beginMessageInjectionOperation({
        originatingLeafEntryId: null,
        runId: "active-run",
        cancel: vi.fn(),
        queueMessage: delivery.queueMessage,
      });

      let successor: ReturnType<typeof beginMessageInjectionOperation> | undefined;
      try {
        await send({
          idempotencyKey: "idem-steer-unconfirmed",
          requestParams: { queueMode: "steer" },
          waitFor: "none",
        });
        await withinTest(delivery.persisted, signal);
        expect(readPersistedUserMessages()).toHaveLength(1);
        expect(readPersistedUserMessages()[0]).not.toHaveProperty("__openclaw.steerTargetRunId");
        first.complete();
        const successorCancel = vi.fn();
        successor = beginMessageInjectionOperation({
          originatingLeafEntryId: null,
          runId: "successor-run",
          cancel: successorCancel,
          queueMessage: vi.fn(async () => {}),
        });
        const errorMessage = "receipt timed out";
        delivery.resolve({ transcriptCommit: "unconfirmed", errorMessage });

        await waitForAssertion(() => {
          expect(context.dedupe.get("chat:idem-steer-unconfirmed")?.payload).toEqual({
            runId: "idem-steer-unconfirmed",
            status: "error",
            summary: errorMessage,
          });
        });
        expect(successor.result).toBeNull();
        expect(successorCancel).not.toHaveBeenCalled();
        expect(mockState.lastDispatchCtx).toBeUndefined();
        const persistedUsers = readPersistedUserMessages();
        expect(persistedUsers).toHaveLength(1);
        expect(
          (persistedUsers[0]?.["__openclaw"] as Record<string, unknown> | undefined)
            ?.steerTargetRunId,
        ).toBeUndefined();
      } finally {
        await suiteResources.verifyFixtureCleanup(async () => {
          delivery.resolve({ transcriptCommit: "unconfirmed", errorMessage: "test finished" });
          first.complete();
          successor?.complete();
          await delivery.settle();
        });
      }
    }));

  it("falls back once when captured owner evidence is stale", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-steer-stale-owner-",
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "assistant",
      content: "stale tool work",
      now: 1,
      parentId: null,
    });
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    const staleQueue = vi.fn(async () => {});
    const staleCancel = vi.fn();
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: "leaf-before-stale-run-output",
      runId: "active-run",
      cancel: staleCancel,
      isStreaming: () => false,
      isStopped: () => false,
      legacy: true,
      queueMessage: staleQueue,
    });

    try {
      vi.advanceTimersByTime(RUN_STALE_TAKEOVER_MS + 1);
      await send({
        idempotencyKey: "idem-steer-stale-owner",
        requestParams: {
          expectedLeafEntryId: "current-leaf",
          queueMode: "steer",
        },
        waitFor: "none",
      });
    } finally {
      operation.complete();
      vi.useRealTimers();
    }

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    await waitForAssertion(() =>
      expect(context.dedupe.get("chat:idem-steer-stale-owner")?.payload).toMatchObject({
        status: "ok",
      }),
    );
    expect(context.addChatRun).toHaveBeenCalledOnce();
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore + 1);
    expect(mockState.lastMessageInjectionDisposition).toBeUndefined();
    expect(staleQueue).not.toHaveBeenCalled();
    expect(staleCancel).not.toHaveBeenCalled();
    expect(readPersistedUserMessages()).toHaveLength(1);
    expect(
      context.broadcast.mock.calls.filter(
        ([, payload]) => (payload as { state?: unknown }).state === "error",
      ),
    ).toEqual([]);
  });

  it("broadcasts session metadata changes before later command dispatch failure", async () => {
    await createTranscriptFixture("openclaw-chat-send-session-metadata-error-");
    mockState.sessionMetadataChanges = [
      {
        sessionKey: "agent:main:main",
        reason: "command-metadata",
      },
    ];
    mockState.dispatchErrorAfterDelivery = new Error("delivery failed after metadata");
    const { context } = await sendNewChatRequest({
      idempotencyKey: "idem-command-session-metadata-error",
      message: "/goal pause waiting",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-command-session-metadata-error")?.ok).toBe(false);
    });
    const call = mockCallAt(context.broadcastToConnIds, 0);
    expect(call?.[0]).toBe("sessions.changed");
    expect(call?.[1]).toMatchObject({
      sessionKey: "agent:main:main",
      reason: "command-metadata",
    });
  });

  it("persists non-agent plugin-bound replies in the binding-owned session", async () => {
    await createTranscriptFixture("openclaw-chat-send-plugin-binding-history-");
    const targetSessionKey = "plugin-binding:codex:history123";
    const targetSessionId = "plugin-binding-history-session";
    mockState.sessionIdsByKey.set(targetSessionKey, targetSessionId);
    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: `agent:main:${targetSessionKey}`,
        storePath: mockState.storePath,
      },
      { sessionId: targetSessionId, updatedAt: Date.now() },
    );
    mockState.finalPayload = setReplyPayloadMetadata(
      {
        text: "bound history reply",
        mediaUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
      },
      {
        sourceReplyTranscriptMirror: {
          sessionKey: targetSessionKey,
          agentId: "main",
          expectedSessionId: targetSessionId,
        },
      },
    );
    await sendNewChatRequest({
      idempotencyKey: "idem-plugin-binding-history",
      expectBroadcast: false,
    });

    const targetMessages = loadTranscriptEventsSync({
      agentId: "main",
      sessionKey: `agent:main:${targetSessionKey}`,
      sessionId: targetSessionId,
      storePath: mockState.storePath,
    })
      .map((event) => asOptionalRecord(asOptionalRecord(event)?.message))
      .filter((message) => message?.role === "assistant");
    expect(targetMessages).toHaveLength(1);
    const targetMessage = expectDefined(targetMessages[0], "binding-owned assistant reply");
    expect(targetMessage.idempotencyKey).toBe("idem-plugin-binding-history");
    expect(extractFirstTextBlock(projectAssistantDisplayContent(targetMessage))).toBe(
      "bound history reply",
    );
    expect(loadTranscriptEventsSync(transcriptScope())).not.toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          idempotencyKey: "idem-plugin-binding-history",
        }),
      }),
    );
    const assistantUpdate = mockState.emittedTranscriptUpdates.find(
      (update) => (update.message as { role?: unknown } | undefined)?.role === "assistant",
    );
    expect(assistantUpdate?.target).toMatchObject({
      agentId: "main",
      sessionKey: `agent:main:${targetSessionKey}`,
    });
    expect(JSON.stringify(assistantUpdate?.message)).toContain(
      `/api/chat/media/outgoing/${encodeURIComponent(targetSessionKey)}/`,
    );
    expect(JSON.stringify(assistantUpdate?.message)).not.toContain(
      "/api/chat/media/outgoing/agent%3Amain%3Amain/",
    );
  });

  it("replaces failed managed media with bounded visible guidance", async () => {
    await createTranscriptFixture("openclaw-chat-send-managed-media-failure-");
    const source = "data:audio/mpeg;base64,not-valid!";
    mockState.finalPayload = { mediaUrl: source };
    const { payload } = await sendNewChatRequest({
      idempotencyKey: "idem-managed-media-failure",
    });

    const serialized = JSON.stringify(payload?.message);
    expect(serialized).toContain('"type":"attachment_error"');
    expect(serialized).toContain('"code":"delivery-failed"');
    expect(serialized).toContain('"label":"Generated audio 1"');
    expect(serialized).not.toContain(source);
    expect(Buffer.byteLength(serialized)).toBeLessThan(1_024);
    const assistantEntries = await readActiveAssistantTranscriptMessages();
    expect(JSON.stringify(assistantEntries)).not.toContain(source);
  });

  it("keeps managed media failures visible when rewriting an existing assistant row", async () => {
    await createTranscriptFixture("openclaw-chat-send-managed-media-partial-failure-");
    const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
    const mirrorKey = "idem-managed-media-partial-failure:internal-source-reply:0";
    await appendSourceReplyMirrorEntry({
      idempotencyKey: mirrorKey,
      text: `Artifacts ready\nMEDIA:${mediaUrl}`,
    });
    const sourceReply = createMainSourceReply({
      idempotencyKey: mirrorKey,
      text: "Artifacts ready\n⚠️ report.7z: Delivery failed. Try sending this file again.",
      mediaUrls: [mediaUrl],
    });
    setReplyPayloadMetadata(sourceReply.payload, {
      assistantMediaFailures: [
        {
          code: "delivery-failed",
          kind: "document",
          label: "report.7z",
          mimeType: "application/x-7z-compressed",
        },
      ],
    });
    setAgentRunReplies([sourceReply]);
    await createChatRequestFixture().send({
      idempotencyKey: "idem-managed-media-partial-failure",
      message: "hello from codex",
    });

    const rawAssistantEntries = await readRawActiveAssistantTranscriptMessages();
    const assistantEntries = rawAssistantEntries.map(projectAssistantDisplayContent);
    expect(JSON.stringify(rawAssistantEntries[0]?.content)).not.toContain("attachment_error");
    expect(JSON.stringify(assistantEntries[0])).toContain('"type":"attachment_error"');
    expect(JSON.stringify(assistantEntries[0])).toContain('"label":"report.7z"');
    expect(JSON.stringify(assistantEntries[0])).not.toContain("Media failed");
    expect(JSON.stringify(assistantEntries[0])).not.toContain("MEDIA:");
  });

  it.each([
    ["rotated", "binding-owned session changed before finalization"],
    ["blocked", "binding-owned user turn was not persisted"],
    ["partial", "inconsistent binding-owned transcript metadata"],
  ] as const)("keeps %s plugin-bound replies out of source history", async (kind, warning) => {
    await createTranscriptFixture(`openclaw-chat-send-plugin-binding-${kind}-`);
    const sourceReply = createSourceReply(
      { text: "bound reply" },
      {
        sessionKey: `plugin-binding:codex:${kind}`,
        agentId: "main",
        ...(kind === "blocked"
          ? { transcriptWriteBlocked: true }
          : {
              expectedSessionId:
                kind === "rotated" ? "previous-bound-session" : mockState.sessionId,
            }),
      },
    );
    mockState.dispatchedReplies = [sourceReply];
    if (kind === "partial") {
      mockState.dispatchedReplies.push({
        kind: "final",
        payload: { text: "derived reply without owner" },
      });
    }
    const { context } = await sendNewChatRequest({
      idempotencyKey: `idem-plugin-binding-${kind}`,
      expectBroadcast: false,
    });
    if (kind === "blocked") {
      expect(mockState.emittedTranscriptUpdates).toHaveLength(0);
    } else {
      expect(
        mockState.emittedTranscriptUpdates.some(
          (update) => getMessage(update)?.role === "assistant",
        ),
      ).toBe(false);
    }
    expect(context.logGateway.warn).toHaveBeenCalledWith(
      `webchat transcript append skipped: ${warning}`,
    );
  });

  it.each([
    {
      agentId: "main",
      sessionKey: "global",
      connId: "conn-global",
      currentRun: "run-current-global",
      allowed: "run-default-global",
      denied: "run-work-global",
    },
    {
      agentId: "work",
      sessionKey: "agent:work:main",
      connId: "conn-work",
      currentRun: "run-current-work-global",
      allowed: "run-work-global",
      denied: "run-default-global",
    },
  ])(
    "registers tool-event recipients for $agentId global sessions",
    async ({ agentId, sessionKey, connId, currentRun, allowed, denied }) => {
      await createGlobalTranscriptFixture("openclaw-chat-send-global-tool-events-", agentId);
      if (agentId === "work") {
        mockState.sessionEntry = { canonicalKey: "global" };
      }
      mockState.finalText = "ok";
      mockState.triggerAgentRunStart = true;
      mockState.agentRunId = currentRun;
      const { context, send } = createChatRequestFixture();
      for (const [runId, owner] of [
        ["run-default-global", undefined],
        ["run-work-global", "work"],
      ] as const) {
        context.chatAbortControllers.set(runId, {
          controller: new AbortController(),
          sessionId: `sess-${runId}`,
          sessionKey: "global",
          ...(owner ? { agentId: owner } : {}),
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 10_000,
        });
      }
      await send({
        sessionKey,
        idempotencyKey: "idem-global-tool-events",
        client: {
          ...createScopedCliClient(undefined, {}, [GATEWAY_CLIENT_CAPS.TOOL_EVENTS]),
          connId,
        },
        expectBroadcast: false,
      });
      expect(context.registerToolEventRecipient).toHaveBeenCalledWith(currentRun, connId);
      expect(context.registerToolEventRecipient).toHaveBeenCalledWith(allowed, connId);
      expect(context.registerToolEventRecipient).not.toHaveBeenCalledWith(denied, connId);
    },
  );

  it("does not register tool-event recipients without tool-events capability", async () => {
    await createReadyChatTranscript("openclaw-chat-send-tool-events-off-");
    mockState.triggerAgentRunStart = true;
    mockState.agentRunId = "run-no-cap";
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-tool-events-off",
      client: {
        ...createScopedCliClient(undefined, {}, []),
        connId: "conn-2",
      },
      expectBroadcast: false,
    });

    const register = context.registerToolEventRecipient;
    expect(register).not.toHaveBeenCalled();
    expect(mockState.lastDispatchCtx).toBeDefined();
  });

  it.each([false, true])(
    "persists a reply beside the WebChat user turn (runtime owns source=%s)",
    async (ownsSource) => {
      await createReadyChatTranscript("openclaw-chat-acp-transcript-owner-");
      const idempotencyKey = "acp-source-reply";
      if (ownsSource) {
        await appendSourceReplyMirrorEntry({ text: "ok", idempotencyKey });
      }
      mockState.triggerAgentRunStart = true;
      mockState.replyDispatchRun = {
        completionSource: "reply-dispatch",
        getResult: () => ({
          assistantTranscript: {
            agentId: ownsSource ? "main" : "claude",
            sessionKey: ownsSource ? "main" : "agent:claude:acp:bound",
            sessionId: ownsSource ? mockState.sessionId : "bound-session",
            storePath: mockState.storePath,
            messageId: "runtime-message",
            idempotencyKey,
          },
        }),
      };
      await createChatRequestFixture().send({
        idempotencyKey,
        expectBroadcast: false,
        waitFor: "dedupe",
      });
      const messages = await readActiveAssistantTranscriptMessages();
      expect(messages.map((message) => message.idempotencyKey)).toEqual([idempotencyKey]);
    },
  );

  it("replaces reply-to-current on a signed runtime-owned media rewrite", async () => {
    await withTranscriptFixtureState("openclaw-chat-send-owned-media-", async (fixtureDir) => {
      const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
      writeSavedPng(fixtureDir, "reply.png");
      await appendSourceReplyMirrorEntry({
        idempotencyKey: "older-distinct-assistant",
        text: "A distinct earlier reply.",
        provider: "openai",
        model: "codex",
      });
      await appendSourceReplyMirrorEntry({
        idempotencyKey: "runtime-owned-assistant",
        openclawDelivery: { audioAsVoice: true, replyToCurrent: true },
        text: `Dinner options\nMEDIA:${mediaUrl}`,
        content: [
          { type: "text", text: "Dinner options", textSignature: "msg_final" },
          { type: "text", text: `MEDIA:${mediaUrl}` },
        ],
        provider: "openai",
        model: "codex",
      });
      setAgentRunReplies([
        {
          kind: "final",
          payload: setReplyPayloadMetadata(
            {
              text: "Dinner options",
              mediaUrl,
              mediaUrls: [mediaUrl],
              replyToId: "3114cf3c-e628-4c33-9214-894a1d8b6c60",
            },
            {
              assistantTranscriptOwned: true,
              assistantTranscriptIdempotencyKey: "runtime-owned-assistant",
            },
          ),
        },
      ]);
      await createChatRequestFixture().send({
        idempotencyKey: "idem-owned-media",
        expectBroadcast: false,
        waitFor: "dedupe",
      });

      const messages = await readActiveAssistantTranscriptMessages();
      expect(messages.map((message) => message.idempotencyKey)).toEqual([
        "older-distinct-assistant",
        "runtime-owned-assistant",
      ]);
      const rewritten = messages[1];
      const content = Array.isArray(rewritten?.content)
        ? (rewritten.content as Array<Record<string, unknown>>)
        : [];
      expect(content[0]).toEqual({ type: "text", text: "Dinner options" });
      expect(content.filter((block) => block.type === "image")).toHaveLength(1);
      expect((await readRawActiveAssistantTranscriptMessages())[1]?.content).toEqual([
        { type: "text", text: "Dinner options", textSignature: "msg_final" },
      ]);
      expect(rewritten?.openclawDelivery).toEqual({
        audioAsVoice: true,
        mediaUrls: [mediaUrl],
        replyToId: "3114cf3c-e628-4c33-9214-894a1d8b6c60",
      });
      expect(JSON.stringify(rewritten)).not.toContain("[[reply_to:");
      expect(JSON.stringify(messages)).not.toContain(":assistant-media");
    });
  });

  it("persists agent media only after a disposed attempt transcript owner has unwound", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-disposed-media-owner-",
      async (fixtureDir) => {
        const mediaUrl = writeSavedPng(fixtureDir, "reply.png");
        await appendSourceReplyMirrorEntry({
          text: `Stale reply\nMEDIA:${mediaUrl}`,
          provider: "openai",
          model: "gpt-5.6-luna",
          now: Date.now(),
        });
        mockState.triggerAgentRunStart = true;
        mockState.disposedTranscriptWriteContext = true;
        mockState.dispatchErrorAfterDelivery = new Error("after media delivery");
        mockState.runtimeAssistantContentBeforeDelivery = [
          { type: "thinking", thinking: "preserve runtime reasoning" },
          { type: "text", text: "Earlier chunk" },
          { type: "text", text: "[[reply_to_current]] Image reply" },
          { type: "text", text: `MEDIA:${mediaUrl}` },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ];
        mockState.runtimeAssistantTextsBeforeDelivery = [`Later reply\nMEDIA:${mediaUrl}`];
        mockState.dispatchedReplies = [
          {
            kind: "final",
            payload: setReplyPayloadMetadata(
              {
                text: "Image reply",
                mediaUrl,
                mediaUrls: [mediaUrl],
              },
              { assistantMessageIndex: 1, assistantTranscriptMediaUrls: [mediaUrl] },
            ),
          },
        ];
        await createChatRequestFixture().send({
          idempotencyKey: "idem-disposed-media-owner",
          expectBroadcast: false,
          waitFor: "dedupe",
        });

        const messages = await readActiveAssistantTranscriptMessages();
        const rawMessages = await readRawActiveAssistantTranscriptMessages();
        expect(messages).toHaveLength(3);
        expect(messages[0]?.content).toEqual([
          { type: "text", text: `Stale reply\nMEDIA:${mediaUrl}` },
        ]);
        expect(messages[1]?.idempotencyKey).toBeUndefined();
        const content = Array.isArray(messages[1]?.content)
          ? (messages[1].content as Array<Record<string, unknown>>)
          : [];
        expect(content.filter((block) => block.type === "text")).toEqual([
          { type: "text", text: "Earlier chunk" },
          { type: "text", text: "Image reply" },
        ]);
        expect(content.filter((block) => block.type === "image")).toHaveLength(1);
        expect(content.map((block) => block.type)).toEqual([
          "thinking",
          "text",
          "text",
          "image",
          "toolCall",
        ]);
        expect(rawMessages[1]?.content).toEqual([
          { type: "thinking", thinking: "preserve runtime reasoning" },
          { type: "text", text: "Earlier chunk" },
          { type: "text", text: "Image reply" },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ]);
        expect(JSON.stringify(content)).toContain("artifact_managed_image_");
        expect(JSON.stringify(content)).not.toContain("MEDIA:");
        expect(messages[1]?.openclawDelivery).toEqual({ mediaUrls: [mediaUrl] });
        expect(JSON.stringify(messages)).not.toContain(":assistant-media");
        expect(messages[2]?.content).toEqual([
          { type: "text", text: `Later reply\nMEDIA:${mediaUrl}` },
        ]);
        expect(mockState.disposedTranscriptWriteAttempts).toBe(0);
      },
    );
  });

  it("rewrites a reply whose only MEDIA directive was rejected instead of appending a copy", async () => {
    await withTranscriptFixtureState("openclaw-chat-send-rejected-media-", async () => {
      const text =
        "Here is the movie.\nMEDIA:http://192.168.1.138:64384/movie.mp4?openclaw_portal=synthetic";
      const parsed = parseReplyDirectives(text);
      mockState.triggerAgentRunStart = true;
      mockState.runtimeAssistantTextsBeforeDelivery = [text];
      mockState.dispatchedReplies = [
        {
          kind: "final",
          payload: setReplyPayloadMetadata(
            { text: parsed.text },
            { assistantMessageIndex: 1, assistantMediaFailures: parsed.mediaFailures },
          ),
        },
      ];
      await createChatRequestFixture().send({
        idempotencyKey: "idem-rejected-media",
        expectBroadcast: false,
        waitFor: "dedupe",
      });

      const messages = await readActiveAssistantTranscriptMessages();
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages)).not.toContain(":assistant-media");
      const content = Array.isArray(messages[0]?.content)
        ? (messages[0].content as Array<Record<string, unknown>>)
        : [];
      expect(content.filter((block) => block.type === "attachment_error")).toEqual([
        {
          type: "attachment_error",
          attachment: { code: "invalid-reference", kind: "document", label: "Media not attached" },
        },
      ]);
    });
  });

  it("materializes latest media payloads once in first-seen order", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-multiple-assistant-media-",
      async (fixtureDir) => {
        const firstMediaUrl = writeSavedPng(fixtureDir, "first.png");
        const secondMediaUrl = writeSavedPng(fixtureDir, "second.png");
        await appendSourceReplyMirrorEntry({
          text: "Older assistant reply",
          provider: "openai",
          model: "gpt-5.6-luna",
          now: Date.now(),
        });
        mockState.triggerAgentRunStart = true;
        mockState.runtimeAssistantTextsBeforeDelivery = [
          `First image\nMEDIA:${firstMediaUrl}`,
          `Second image\nMEDIA:${secondMediaUrl}`,
        ];
        mockState.dispatchedReplies = [
          {
            kind: "block",
            payload: setReplyPayloadMetadata(
              { text: "Draft first image", mediaUrl: firstMediaUrl, mediaUrls: [firstMediaUrl] },
              {
                assistantMessageIndex: 1,
                assistantTranscriptMediaUrls: [firstMediaUrl],
              },
            ),
          },
          {
            kind: "final",
            payload: setReplyPayloadMetadata(
              { text: "Second image", mediaUrl: secondMediaUrl, mediaUrls: [secondMediaUrl] },
              {
                assistantMessageIndex: 2,
                assistantTranscriptMediaUrls: [secondMediaUrl],
              },
            ),
          },
          {
            kind: "final",
            payload: setReplyPayloadMetadata(
              { text: "First image", mediaUrl: firstMediaUrl, mediaUrls: [firstMediaUrl] },
              {
                assistantMessageIndex: 1,
                assistantTranscriptMediaUrls: [firstMediaUrl],
              },
            ),
          },
        ];
        await createChatRequestFixture().send({
          idempotencyKey: "idem-multiple-assistant-media",
          expectBroadcast: false,
          waitFor: "dedupe",
        });

        const messages = await readActiveAssistantTranscriptMessages();
        expect(messages).toHaveLength(3);
        expect(messages[0]?.content).toEqual([{ type: "text", text: "Older assistant reply" }]);
        for (const [index, expectedText] of ["First image", "Second image"].entries()) {
          const message = messages[index + 1];
          const content = Array.isArray(message?.content)
            ? (message.content as Array<Record<string, unknown>>)
            : [];
          expect(content.filter((block) => block.type === "text")).toEqual([
            { type: "text", text: expectedText },
          ]);
          expect(content.filter((block) => block.type === "image")).toHaveLength(1);
          expect(JSON.stringify(content)).not.toContain("MEDIA:");
        }
        expect(JSON.stringify(messages)).not.toContain(":assistant-media");
        const mediaMessageIds = readTranscriptJsonLines(mockState.transcriptPath)
          .filter((entry) => asOptionalRecord(entry.message)?.role === "assistant")
          .slice(1)
          .map((entry) => entry.id);
        expect(
          mockState.emittedTranscriptUpdates
            .filter((update) => mediaMessageIds.includes(update.messageId))
            .map((update) => update.messageId),
        ).toEqual(mediaMessageIds);
      },
    );
  });

  it("supplements queued tool media without recreating saved runtime text", async () => {
    await withTranscriptFixtureState("openclaw-chat-send-queued-media-", async (fixtureDir) => {
      const mediaUrl = writeSavedPng(fixtureDir, "fetched.png");
      const text = "The directory fetch is complete.";
      mockState.triggerAgentRunStart = true;
      mockState.runtimeAssistantTextsBeforeDelivery = [text];
      mockState.dispatchedReplies = [
        {
          kind: "final",
          payload: setReplyPayloadMetadata(
            { text, mediaUrl, mediaUrls: [mediaUrl], trustedLocalMedia: true },
            { assistantMessageIndex: 1 },
          ),
        },
      ];
      await createChatRequestFixture().send({
        idempotencyKey: "idem-queued-tool-media",
        expectBroadcast: false,
        waitFor: "dedupe",
      });

      const messages = await readActiveAssistantTranscriptMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]?.content).toEqual([{ type: "text", text }]);
      const supplement = messages.at(-1);
      expect(supplement?.content).toEqual([expect.objectContaining({ type: "image" })]);
      expect(JSON.stringify(supplement)).not.toContain(text);
    });
  });

  it("persists auto-TTS final media as audio-only so webchat does not duplicate assistant text", async () => {
    const { audioPath } = await createAudioTranscriptFixture("openclaw-chat-send-agent-tts-final-");
    setAgentRunReplies([
      {
        kind: "final",
        payload: {
          text: "This text is already in the model transcript.",
          spokenText: "This text is already in the model transcript.",
          mediaUrl: audioPath,
          mediaUrls: [audioPath],
          trustedLocalMedia: true,
          audioAsVoice: true,
          ttsSupplement: { spokenText: "This text is already in the model transcript." },
        },
      },
    ]);
    await createChatRequestFixture().send({
      idempotencyKey: "idem-agent-tts",
      expectBroadcast: false,
      waitFor: "dedupe",
    });

    const assistantUpdates = findAssistantTranscriptUpdates();
    expect(assistantUpdates).toHaveLength(1);
    const message = assistantUpdates[0]?.message as Record<string, any> | undefined;
    const content = Array.isArray(message?.content)
      ? (message.content as Array<Record<string, any>>)
      : [];
    expect(message?.role).toBe("assistant");
    expect(message?.idempotencyKey).toBe("idem-agent-tts:assistant-media");
    expect(content[0]).toEqual({ type: "text", text: "Audio reply" });
    expect(content[1]).toEqual(
      expect.objectContaining({
        type: "audio",
        artifactId: expect.stringMatching(/^artifact_managed_media_/u),
        fileName: "tts.mp3",
        mimeType: "audio/mpeg",
      }),
    );
    expect(JSON.stringify(content[1])).not.toContain(fs.realpathSync(audioPath));
    expect(JSON.stringify(assistantUpdates[0]?.message)).not.toContain(
      "This text is already in the model transcript.",
    );
  });

  it("keeps text while excluding the failure card from durable history for agent-run media", async () => {
    const transcriptDir = await createTranscriptFixture("openclaw-chat-send-agent-stale-tts-");
    const staleAudioPath = path.join(transcriptDir, "stale.mp3");
    mockState.config = { agents: { defaults: { workspace: transcriptDir } } };
    setAgentRunReplies([
      {
        kind: "final",
        payload: {
          text: "Text-only test: one clean reply, no TTS, no media, no tool narration.",
          mediaUrl: staleAudioPath,
          mediaUrls: [staleAudioPath],
          trustedLocalMedia: true,
        },
      },
    ]);
    const { send } = createChatRequestFixture();
    await send({
      idempotencyKey: "idem-stale-agent-media",
      expectBroadcast: false,
      waitFor: "dedupe",
    });

    const assistantUpdates = findAssistantTranscriptUpdates();
    const assistantEntries = readTranscriptJsonLines(mockState.transcriptPath).filter(
      (entry) =>
        (entry as { message?: { role?: string } }).message?.role === "assistant" ||
        (entry as { role?: string }).role === "assistant",
    );
    expect(assistantEntries).toHaveLength(1);
    const message = (assistantEntries[0] as { message?: Record<string, unknown> }).message;
    const modelContent = Array.isArray(message?.content) ? message.content : [];
    expect(JSON.stringify(assistantUpdates)).toContain('"type":"attachment_error"');
    expect(JSON.stringify(assistantUpdates)).toContain("stale.mp3");
    expect(JSON.stringify(assistantUpdates)).not.toContain(staleAudioPath);
    expect(JSON.stringify(modelContent)).not.toContain("attachment_error");
    expect(JSON.stringify(message?.openclawDisplayContent)).toContain("attachment_error");
  });

  it.each([false, true])(
    "delivers a settled fallback only while its writer remains current (replaced=%s)",
    async (replaced) => {
      await createTranscriptFixture("openclaw-chat-send-settled-fallback-");
      const idempotencyKey = "run-settled:settled-finalization-fallback";
      const text =
        "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";
      await appendSourceReplyMirrorEntry({ idempotencyKey, text });
      mockState.sessionEntry = {
        lifecycleRevision: "revision-a",
        activeWriterRunId: "run-settled",
      };
      if (replaced) {
        mockState.onAfterAgentRunStart = () => {
          mockState.sessionEntry = {
            lifecycleRevision: "revision-a",
            activeWriterRunId: "replacement-run",
          };
        };
      }
      const reply: TestReply = replaced
        ? createMainSourceReply({ idempotencyKey, text })
        : { kind: "final", payload: { text } };
      setReplyPayloadMetadata(reply.payload, {
        assistantTranscriptOwned: true,
        assistantTranscriptIdempotencyKey: idempotencyKey,
        ...(!replaced ? { deliverDespiteSourceReplySuppression: true } : {}),
        sessionWriterDeliveryAuthority: {
          agentId: "main",
          expectedLifecycleRevision: "revision-a",
          expectedSessionId: mockState.sessionId,
          expectedWriterRunId: "run-settled",
          sessionKey: "main",
          storePath: mockState.storePath,
        },
      });
      setAgentRunReplies([reply]);
      const { context, send } = createChatRequestFixture();
      await send({ idempotencyKey: "idem-settled-fallback", waitFor: "dedupe" });
      if (replaced) {
        expect(context.broadcast).not.toHaveBeenCalled();
        expect(context.nodeSendToSession).not.toHaveBeenCalled();
      } else {
        expect(extractFirstTextBlock(getMessage(lastBroadcastPayload(context)))).toBe(text);
      }
      expect(await readActiveAssistantTranscriptMessages()).toHaveLength(1);
    },
  );

  it("broadcasts a block status once while ignoring an ordinary agent final", async () => {
    await createTranscriptFixture("openclaw-chat-send-agent-block-status-notice-");
    setAgentRunReplies([
      {
        kind: "block",
        payload: {
          text: "Model set to openai/gpt-5.5 for this session.",
          isStatusNotice: true,
        },
      },
      {
        kind: "final",
        payload: {
          text: "ordinary provider final",
        },
      },
    ]);
    const { context, payload: broadcast } = await sendNewChatRequest({
      idempotencyKey: "idem-agent-block-status-notice",
      message: "/model openai/gpt-5.5 keep going",
    });

    expect(broadcast).toMatchObject({
      runId: "idem-agent-block-status-notice",
      sessionKey: "agent:main:main",
      state: "final",
    });
    expect(extractFirstTextBlock(getMessage(broadcast))).toBe(
      "Model set to openai/gpt-5.5 for this session.",
    );
    expect(context.broadcast.mock.calls).toHaveLength(1);
    expect(findAssistantTranscriptUpdates()).toStrictEqual([]);
    expect(await readActiveAssistantTranscriptMessages()).toStrictEqual([]);
  });

  it("replaces an explicit reply id with reply-to-current on a source reply rewrite", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-media-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply.png");
        const mirrorIdempotencyKey = "idem-agent-source-reply-media:internal-source-reply:0";
        const updatedAt = Date.parse("2026-05-18T11:00:00.000Z");
        const rewrittenAt = Date.parse("2026-05-18T11:05:00.000Z");
        await seedSqliteSessionEntry({
          sessionFile: mockState.transcriptPath,
          updatedAt,
          status: "done",
        });
        await appendSourceReplyMirrorEntry({
          idempotencyKey: mirrorIdempotencyKey,
          openclawDelivery: { audioAsVoice: true, replyToId: "stale-reply-id" },
          text: "Codex source reply with media",
        });
        const sourceReply = createMainSourceReply({
          idempotencyKey: mirrorIdempotencyKey,
          text: "Codex source reply with media",
          mediaUrls: [mediaUrl],
          replyToCurrent: true,
        });
        setAgentRunReplies([sourceReply]);
        const { send } = createChatRequestFixture();

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(rewrittenAt);
        try {
          const broadcast = await send({
            idempotencyKey: "idem-agent-source-reply-media",
            message: "hello from codex",
          });

          expect(broadcast).toMatchObject({
            runId: "idem-agent-source-reply-media",
            sessionKey: "agent:main:main",
            state: "final",
          });
          expect(extractFirstTextBlock(getMessage(broadcast))).toBe(
            "Codex source reply with media",
          );
          const broadcastContent = getMessageContent(broadcast);
          expect(String(broadcastContent[1]?.url)).toContain("/api/chat/media/outgoing/");
          expect(String(broadcastContent[1]?.openUrl)).toContain("/api/chat/media/outgoing/");
          const assistantUpdates = findAssistantTranscriptUpdates();
          expect(assistantUpdates).toStrictEqual([]);
          const assistantEntries = await readActiveAssistantTranscriptMessages();
          expect(assistantEntries).toHaveLength(1);
          expect(assistantEntries[0]?.idempotencyKey).toBe(mirrorIdempotencyKey);
          expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
          expect(JSON.stringify(assistantEntries[0]?.content)).not.toContain(mediaUrl);
          expect(assistantEntries[0]?.openclawDelivery).toEqual({
            audioAsVoice: true,
            mediaUrls: [mediaUrl],
            replyToCurrent: true,
          });
          expect(JSON.stringify(assistantEntries[0])).not.toContain("[[reply_to:");
          const entry = readSqliteMainSessionEntry();
          expect(entry?.updatedAt).toBeGreaterThanOrEqual(rewrittenAt);
          expect(entry?.updatedAt).toBeGreaterThan(updatedAt);
          expect(entry?.status).toBe("done");
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });

  registerChatSourceMediaTests({
    session: () => ({
      cfg: readChatDirectiveConfig(mockState),
      scope: { ...transcriptScope(), sessionId: mockState.sessionId },
      stateDir: suiteFixtureRoot,
    }),
    stageMediaPath: (mediaPath, contentType) => {
      mockState.savedMediaResults.push({ path: mediaPath, contentType });
    },
    publishedUpdates: () => mockState.emittedTranscriptUpdates,
    withTranscriptFixtureState,
    readActiveAssistantTranscriptMessages,
    readRawActiveAssistantTranscriptMessages,
    appendSourceReplyMirrorEntry,
    createMainSourceReply,
    setAgentRunReplies,
    send: (params) => createChatRequestFixture().send(params),
    sendLate: async ({ runId, payloads, canvas, bufferCurrent }) => {
      const context = createChatContext();
      const run = context.chatRunState.getOrCreate(runId);
      run.canvasBlocks = [{ type: "canvas", ...canvas }];
      run.bufferIsCurrent = () => bufferCurrent;
      const finalize = createChatSendLateReplyFinalizer({
        context,
        accountId: undefined,
        terminalEntry: undefined,
        session: {
          cfg: readChatDirectiveConfig(mockState),
          agentId: "main",
          sessionKey: "agent:main:main",
          backingSessionId: mockState.sessionId,
          clientRunId: runId,
          sessionLoadOptions: { agentId: "main" },
        },
      });
      await expect(
        finalize({
          runId,
          clientRunId: runId,
          payloads,
          completion: { kind: "completed" },
          isCurrent: () => true,
        }),
      ).resolves.toMatchObject({ kind: "delivered" });
      expect(context.removeChatRun).toHaveBeenCalledWith(runId, runId, "agent:main:main");
      expect(context.chatRunState.runs.has(runId)).toBe(false);
      return lastBroadcastPayload(context);
    },
    writeSavedPng,
  });

  it("does not broadcast an error terminal after an internal-ui source reply final", async () => {
    await createTranscriptFixture("openclaw-chat-send-agent-source-reply-error-");
    const sourceReply = createMainSourceReply({
      idempotencyKey: "idem-agent-source-reply-error:internal-source-reply:0",
      text: "Codex source reply",
    });
    setAgentRunReplies([
      sourceReply,
      {
        kind: "final",
        payload: {
          text: "tool warning",
          isError: true,
        },
      },
    ]);
    const { context, send } = createChatRequestFixture();

    const broadcast = await send({
      idempotencyKey: "idem-agent-source-reply-error",
      message: "hello from codex",
    });

    expect(broadcast).toMatchObject({
      runId: "idem-agent-source-reply-error",
      sessionKey: "agent:main:main",
      state: "final",
    });
    expect(extractFirstTextBlock(getMessage(broadcast))).toBe("Codex source reply");
    const errorBroadcasts = context.broadcast.mock.calls.filter(
      ([, payload]) => (payload as { state?: unknown })?.state === "error",
    );
    expect(errorBroadcasts).toStrictEqual([]);
    const dedupe = context.dedupe.get("chat:idem-agent-source-reply-error");
    expect(dedupe?.ok).toBe(true);
    expect(dedupe?.payload).toMatchObject({
      runId: "idem-agent-source-reply-error",
      status: "ok",
    });
  });

  it.each([
    ["source reply", "Model login expired. Re-authenticate, then try again."],
    ["status notice", "LLM idle timeout (120s): no response from model"],
    ["multiple errors", "Primary execution failed\n\nAdditional error: Workspace recovery failed"],
  ] as const)("broadcasts returned agent errors after %s", async (kind, errorMessage) => {
    await createTranscriptFixture("openclaw-chat-send-agent-errors-");
    const mirrorKey = "idem-agent-errors:internal-source-reply:0";
    if (kind === "source reply") {
      await appendSourceReplyMirrorEntry({
        idempotencyKey: mirrorKey,
        text: "Original source reply",
      });
      const source = createMainSourceReply({ idempotencyKey: mirrorKey, text: errorMessage });
      source.payload.isError = true;
      setAgentRunReplies([source]);
    } else if (kind === "status notice") {
      setAgentRunReplies([
        {
          kind: "block",
          payload: { text: "⚙️ Codex compaction started • Context 2k/200k", isStatusNotice: true },
        },
        { kind: "final", payload: { text: errorMessage, isError: true } },
      ]);
    } else {
      setAgentRunReplies([
        { kind: "final", payload: { text: "Primary execution failed", isError: true } },
        { kind: "final", payload: { text: "Workspace recovery failed", isError: true } },
        { kind: "final", payload: { text: "Workspace recovery failed", isError: true } },
      ]);
    }
    const { context, send } = createChatRequestFixture();
    await send({
      idempotencyKey: "idem-agent-errors",
      message: kind === "status notice" ? "/compact" : "run on the worker",
      waitFor: "dedupe",
    });
    const broadcasts = context.broadcast.mock.calls.map(([, payload]) => payload);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      runId: "idem-agent-errors",
      sessionKey: "agent:main:main",
      state: "error",
      errorMessage,
    });
    expect(broadcasts[0]).not.toHaveProperty("message");
    expect(
      broadcasts.filter((payload) => asOptionalRecord(payload)?.state === "final"),
    ).toStrictEqual([]);
    if (kind === "source reply") {
      const entries = await readActiveAssistantTranscriptMessages();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.content).toStrictEqual([{ type: "text", text: "Original source reply" }]);
    }
  });

  it.each([
    ["error payload before launch", false, "error", undefined],
    ["recorded failure with source reply", true, "source", "failed"],
    ["recorded success with a recoverable warning", true, "warning", "completed"],
    ["recorded success with only a tool warning", true, "warning-only", "completed"],
    ["recorded success with source reply plus warning", true, "source-warning", "completed"],
  ] as const)(
    "projects agent-run terminal: $0",
    async (name, agentStarted, presentation, outcome) => {
      const fixtureDir = await createSqliteTranscriptFixture("openclaw-chat-send-agent-terminal-");
      const runId = `idem-agent-terminal-${name.replaceAll(" ", "-")}`;
      const failed = outcome === "failed" || presentation === "error";
      const sourceReply = presentation === "source" || presentation === "source-warning";
      const replyText = presentation === "warning-only" ? "⚠️ Exec failed" : "Partial agent reply";
      const errorMessage =
        presentation === "error"
          ? agentStarted
            ? "LLM idle timeout (120s): no response from model"
            : STALE_WORKER_BUILD_REASON
          : "agent run failed";
      const mirrorIdempotencyKey = `${runId}:internal-source-reply:0`;
      const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
      mockState.triggerAgentRunStart = agentStarted;
      if (outcome) {
        await appendTestTranscriptMessage({
          eventId: `${runId}:user`,
          role: "user",
          content: "please keep working",
          now: 0,
          parentId: null,
        });
        mockState.triggerUserMessagePersisted = true;
      }
      if (sourceReply) {
        writeSavedPng(fixtureDir, "source-terminal.png");
        await appendSourceReplyMirrorEntry({
          idempotencyKey: mirrorIdempotencyKey,
          text: replyText,
        });
        mockState.dispatchedReplies = [
          createMainSourceReply({
            idempotencyKey: mirrorIdempotencyKey,
            text: replyText,
            mediaUrls: [mediaUrl],
          }),
        ];
      } else if (presentation === "warning-only") {
        mockState.finalText = "";
      } else if (presentation === "error") {
        mockState.dispatchedReplies = [
          {
            kind: "final",
            payload: { text: errorMessage, isError: true },
          },
        ];
      } else {
        mockState.runtimeAssistantTextsBeforeDelivery = [replyText];
        mockState.dispatchedReplies = [{ kind: "final", payload: { text: replyText } }];
      }
      if (
        presentation === "warning" ||
        presentation === "warning-only" ||
        presentation === "source-warning"
      ) {
        mockState.dispatchedReplies.push({
          kind: "final",
          payload: { text: "⚠️ Exec failed", isError: true },
        });
      }
      if (outcome) {
        const dispatch = expectDefined(
          dispatchInboundMessageMock.getMockImplementation(),
          "default chat dispatch fixture",
        );
        dispatchInboundMessageMock.mockImplementationOnce(async (params: TestDispatchParams) =>
          recordAgentRunTerminalOutcome(await dispatch(params), outcome),
        );
      }
      const { context, send } = createChatRequestFixture();

      await send({
        idempotencyKey: runId,
        message: "please keep working",
        waitFor: "none",
      });
      // Admission already owns a dedupe entry; observe the first terminal write, not key presence.
      await waitForAssertion(() => {
        expect(["ok", "error"]).toContain(
          asOptionalRecord(context.dedupe.get(`chat:${runId}`)?.payload)?.status,
        );
      });
      const dedupe = context.dedupe.get(`chat:${runId}`);
      expect(dedupe?.ok).toBe(!failed);
      expect(dedupe?.payload).toMatchObject({
        runId,
        status: failed ? "error" : "ok",
        ...(failed ? { summary: errorMessage } : {}),
      });
      const waitRespond = vi.fn<RespondFn>();
      await agentHandlers["agent.wait"]!({
        params: { runId, timeoutMs: 0 },
        respond: waitRespond,
        context,
        req: {} as never,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(waitRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId, status: failed ? "error" : "ok" }),
      );
      const broadcasts = context.broadcast.mock.calls
        .filter(([event]) => event === "chat")
        .map(([, payload]) => payload);
      if (failed) {
        expect(broadcasts).toEqual([
          expect.objectContaining({
            runId,
            sessionKey: "agent:main:main",
            state: "error",
            errorMessage,
          }),
        ]);
        expect(broadcasts[0]).not.toHaveProperty("message");
      } else if (sourceReply || presentation === "warning-only") {
        expect(broadcasts).toEqual([expect.objectContaining({ runId, state: "final" })]);
        expect(extractFirstTextBlock(getMessage(broadcasts[0]))).toBe(replyText);
      } else {
        expect(broadcasts).toEqual([]);
      }
      const assistantEntries = await readActiveAssistantTranscriptMessages();
      if (presentation === "error") {
        expect(assistantEntries).toEqual([]);
        expect(findAssistantTranscriptUpdates()).toEqual([]);
      } else {
        expect(assistantEntries).toHaveLength(1);
        expect(JSON.stringify(assistantEntries[0]?.content)).toContain(replyText);
      }
      if (sourceReply) {
        expect(assistantEntries[0]?.idempotencyKey).toBe(mirrorIdempotencyKey);
        expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
        expect(JSON.stringify(assistantEntries[0]?.content)).not.toContain(mediaUrl);
        expect(fs.existsSync(mockState.transcriptPath)).toBe(false);
      }
      if (presentation === "error") {
        expectUserUpdateIdentity(findUserUpdate());
      } else {
        expect(readPersistedUserMessages()).toHaveLength(1);
      }
    },
  );

  it.each([false, true])(
    "keeps trusted worktree TTS media under sender policy (denied=%s)",
    async (denied) => {
      await withTempDir("openclaw-command-tts-worktree-", async (worktree) => {
        const transcriptDir = await createTranscriptFixture(
          "openclaw-chat-send-command-tts-final-",
        );
        const audioPath = path.join(worktree, "tts.mp3");
        const audio = Buffer.alloc(6 * 1024 * 1024);
        createPlaybackMediaFixture("mp3").copy(audio);
        fs.writeFileSync(audioPath, audio);
        mockState.config = {
          agents: { defaults: { workspace: transcriptDir } },
          tools: {
            fs: { workspaceOnly: true },
            toolsBySender: { "id:cli": { deny: denied ? ["read"] : [] } },
          },
        };
        mockState.sessionEntry = { sessionRoot: worktree, spawnedCwd: worktree };
        mockState.finalPayload = createSlashCommandMediaReply("final", [audioPath], {
          text: "Command result with TTS.",
          spokenText: "Command result with TTS.",
          mediaUrl: audioPath,
          audioAsVoice: true,
        }).payload;
        const payload = await createChatRequestFixture().send({
          idempotencyKey: "idem-command-tts",
          client: createScopedCliClient(["operator.admin"], { id: "cli" }),
        });

        const content = getMessageContent(payload);
        expect(getMessage(payload)?.role).toBe("assistant");
        expect(content[0]).toEqual({ type: "text", text: "Command result with TTS." });
        if (denied) {
          expect(managedAudioBlocks(content)).toEqual([]);
          expect(JSON.stringify(content)).not.toContain("/api/chat/media/outgoing/");
        } else {
          expectManagedAudioBlock(content[1], "tts.mp3", true);
          expect(JSON.stringify(content[1])).not.toContain(fs.realpathSync(audioPath));
        }
        const assistantUpdates = findAssistantTranscriptUpdates();
        expect(assistantUpdates).toHaveLength(1);
        expect(JSON.stringify(assistantUpdates[0]?.message)).toContain("Command result with TTS.");
      });
    },
  );

  it("persists admitted prepared literal NO_REPLY through chat.send", async () => {
    await createTranscriptFixture("openclaw-chat-prepared-control-");
    const literal = "NO_REPLY\n";
    const fragments = ["Here is the example:\n\n```text\n", "literal-slot", "```\n\nDone"];
    const deliveredTexts: Array<string | undefined> = [];
    dispatchInboundMessageMock.mockImplementationOnce(
      async ({ dispatcher }: TestDispatchParams) => {
        expectDefined(
          dispatcher.appendBeforeDeliver,
          "before-delivery modifier",
        )((payload) => {
          const prepared =
            payload.text === "literal-slot" ? { ...payload, text: literal } : payload;
          deliveredTexts.push(prepared.text);
          return prepared;
        });
        const plans = createStructuredOutboundPayloadPlan(fragments.map((text) => ({ text })));
        for (const plan of plans) {
          expect(dispatcher.sendPreparedReply("final", plan)).toBe(true);
        }
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: plans.length } };
      },
    );
    const { context, payload } = await sendNewChatRequest({
      idempotencyKey: "idem-prepared-control",
    });
    const content = [
      { type: "text", text: `Here is the example:\n\n\`\`\`text\n${literal}\`\`\`\n\nDone` },
    ];
    const assistantMessages = await readRawActiveAssistantTranscriptMessages();
    expect(deliveredTexts).toEqual([fragments[0], literal, fragments[2]]);
    expect.soft(getMessageContent(payload)).toEqual(content);
    expect.soft(getMessageContent(lastNodeSendCall(context)?.[2])).toEqual(content);
    expect.soft(assistantMessages.map((message) => message.content)).toEqual([content]);
  });

  it.each([
    {
      name: "directive before indented code",
      text: "    const value = 1;\n    use(value);",
      directive: "[[reply_to_current]]\n\n",
      finalDirective: false,
    },
    {
      name: "directive-only final",
      text: "Trajectory exports can include prompts.",
      directive: "",
      finalDirective: true,
    },
  ])(
    "folds block-only non-agent command replies into the final WebChat message ($name)",
    async ({ text, directive, finalDirective }) => {
      await createTranscriptFixture("openclaw-chat-send-command-block-final-");
      mockState.dispatchedReplies = [
        {
          kind: "block",
          payload: { text: `${directive}${text}` },
        },
        ...(finalDirective
          ? [{ kind: "final" as const, payload: { text: "[[reply_to_current]]" } }]
          : []),
      ];
      const { context, send } = createChatRequestFixture();
      const runId = finalDirective ? "idem-command-block-reply-directive" : "idem-command-block";
      const payload = await send({
        idempotencyKey: runId,
        message: "/export-trajectory bundle",
      });
      expect(extractFirstTextBlock(getMessage(payload))).toBe(text);
      if (finalDirective) {
        const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
          (update) =>
            typeof update.message === "object" &&
            update.message !== null &&
            (update.message as { role?: unknown }).role === "assistant",
        );
        expect(transcriptUpdate?.message).toMatchObject({
          openclawDelivery: { replyToCurrent: true },
        });
        expect(JSON.stringify(transcriptUpdate?.message)).not.toContain("[[reply_to_current]]");
        expect(JSON.stringify(transcriptUpdate?.message)).toContain(text);
        return;
      }
      const broadcast = lastBroadcastPayload(context);
      expect(broadcast?.runId).toBe("idem-command-block");
      expect(broadcast?.state).toBe("final");
      expect.soft(extractFirstTextBlock(getMessage(broadcast))).toBe(text);
      const delta = context.broadcast.mock.calls
        .map(([event, value]) => (event === "chat" ? asOptionalRecord(value) : undefined))
        .findLast((value) => value?.state === "delta");
      expect.soft(delta?.deltaText).toBe(text);
      const assistantMessages = await readRawActiveAssistantTranscriptMessages();
      expect(assistantMessages).toHaveLength(1);
      expect.soft(assistantMessages[0]?.content).toEqual([{ type: "text", text }]);
      expect.soft(assistantMessages[0]?.openclawDelivery).toEqual({ replyToCurrent: true });
      await waitForAssertion(() =>
        expect(context.chatRunState.runs.has("idem-command-block")).toBe(false),
      );
    },
  );

  it("broadcasts sensitive pairing QR display without persisting QR content", async () => {
    await createTranscriptFixture("openclaw-chat-send-command-pair-qr-");
    const setupCode = "openclaw-test-pairing-setup-code";
    mockState.dispatchedReplies = [
      {
        kind: "final",
        payload: {
          text: "Scan this QR code with the OpenClaw iOS app:",
          channelData: {
            openclawPairingQr: {
              setupCode,
              expiresAtMs: Date.now() + 10 * 60_000,
            },
          },
          sensitiveMedia: true,
        },
      },
    ];
    const payload = await createChatRequestFixture().send({
      idempotencyKey: "idem-command-pair-qr",
      message: "/pair qr",
    });

    const content = getMessageContent(payload);
    expect(content[0]).toEqual({
      type: "text",
      text: "Scan this QR code with the OpenClaw iOS app:",
    });
    expect(content[1]).toEqual(
      expect.objectContaining({
        type: "openclaw_pairing_qr",
        image_url: expect.stringMatching(/^data:image\/png;base64,/u),
        terminalText: expect.stringContaining("█"),
        sensitive: true,
      }),
    );
    const transcriptMessages = await readActiveAssistantTranscriptMessages();
    const serializedTranscript = JSON.stringify(transcriptMessages);
    expect(serializedTranscript).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(serializedTranscript).not.toContain("openclaw_pairing_qr");
    expect(serializedTranscript).not.toContain("data:image/png");
    expect(serializedTranscript).not.toContain("terminalText");
    expect(serializedTranscript).not.toContain(setupCode);
  });

  it.each([
    {
      name: "keeps slash-command block text when the final payload only adds media",
      id: "media-final",
      files: ["tts.mp3"],
      replies: ([audio]) => [
        { kind: "block", payload: { text: "Trajectory exports can include prompts." } },
        createSlashCommandMediaReply("final", [audio], {
          mediaUrl: audio,
          audioAsVoice: true,
          replyToCurrent: true,
        }),
      ],
      verify: (content) => {
        expect(content[0]).toEqual({
          type: "text",
          text: "Trajectory exports can include prompts.",
        });
        expectManagedAudioBlock(content[1], "tts.mp3", true);
        const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
          (update) =>
            typeof update.message === "object" &&
            update.message !== null &&
            (update.message as { role?: unknown }).role === "assistant" &&
            (update.message as { openclawDelivery?: { replyToCurrent?: boolean } }).openclawDelivery
              ?.replyToCurrent === true,
        );
        expect(transcriptUpdate).toBeTruthy();
        expect(JSON.stringify(transcriptUpdate)).not.toContain("[[reply_to_current]]");
      },
    },
    {
      name: "keeps media from duplicate slash-command finals without duplicating block text",
      id: "media-dupe",
      files: ["tts.mp3"],
      replies: ([audio]) => [
        createSlashCommandMediaReply("block", [audio], {
          text: "Trajectory exports can include prompts.",
          mediaUrl: audio,
        }),
        createSlashCommandMediaReply("final", [audio], {
          text: "[[audio_as_voice]]",
          mediaUrl: audio,
        }),
      ],
      verify: (content) => {
        const text = content
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .filter(Boolean)
          .join("\n");
        expect(text.match(/Trajectory exports/gu)).toHaveLength(1);
        expectManagedAudioBlock(content[1], "tts.mp3", true);
      },
    },
    {
      name: "keeps final text when only the slash-command media is duplicated",
      id: "media-different-final-text",
      files: ["voice.mp3"],
      replies: ([audio]) => [
        createSlashCommandMediaReply("block", [audio], { text: "preview" }),
        createSlashCommandMediaReply("final", [audio], {
          text: "done",
          replyToCurrent: true,
        }),
      ],
      verify: (content) => {
        const text = content
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .filter(Boolean)
          .join("\n");
        expect(text).toContain("preview");
        expect(text).toContain("done");
        expect(managedAudioBlocks(content)).toHaveLength(1);
        const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
          (update) =>
            typeof update.message === "object" &&
            update.message !== null &&
            (update.message as { role?: unknown }).role === "assistant",
        );
        expect(transcriptUpdate?.message).toMatchObject({
          openclawDelivery: { replyToCurrent: true },
        });
        expect(JSON.stringify(transcriptUpdate?.message)).not.toContain("[[reply_to_current]]");
        expect(JSON.stringify(transcriptUpdate?.message)).toContain("done");
      },
    },
    {
      name: "deduplicates slash-command final echoes against the same text and media block",
      id: "same-caption-same-media",
      files: ["first.mp3", "second.mp3"],
      replies: ([first, second]) => [
        createSlashCommandMediaReply("block", [first], { text: "shared caption" }),
        createSlashCommandMediaReply("block", [second], { text: "shared caption" }),
        createSlashCommandMediaReply("final", [second], {
          text: "shared caption",
          audioAsVoice: true,
        }),
      ],
      verify: (content) => {
        const text = content
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .filter(Boolean)
          .join("\n");
        expect(text.match(/shared caption/gu)).toHaveLength(2);
        const attachments = managedAudioBlocks(content);
        expect(attachments).toHaveLength(2);
        expectManagedAudioBlock(attachments[0], "first.mp3");
        expectManagedAudioBlock(attachments[1], "second.mp3", true);
      },
    },
    {
      name: "keeps sensitive overlapping slash-command media out of transcripts",
      id: "media-sensitive-overlap",
      files: ["secret.mp3", "public.mp3"],
      replies: ([secret, publicAudio]) => [
        createSlashCommandMediaReply("block", [secret, publicAudio], { text: "preview" }),
        createSlashCommandMediaReply("final", [secret], { sensitiveMedia: true }),
      ],
      verify: (_content, [secret]) => {
        const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
          (update) =>
            typeof update.message === "object" &&
            update.message !== null &&
            (update.message as { role?: unknown }).role === "assistant",
        );
        expect(JSON.stringify(transcriptUpdate?.message)).not.toContain(secret);
      },
    },
    {
      name: "keeps reordered slash-command final media instead of treating it as duplicate",
      id: "media-reordered",
      files: ["first.mp3", "second.mp3"],
      replies: ([first, second]) => [
        createSlashCommandMediaReply("block", [first, second], {
          text: "Trajectory exports can include prompts.",
        }),
        createSlashCommandMediaReply("final", [second, first], { audioAsVoice: true }),
      ],
      verify: (content) => {
        const attachments = managedAudioBlocks(content);
        expect(attachments.map((block) => block.fileName)).toEqual([
          "first.mp3",
          "second.mp3",
          "second.mp3",
          "first.mp3",
        ]);
        expect(attachments.slice(0, 2).every((block) => block.isVoiceNote !== true)).toBe(true);
        expect(attachments.slice(2).every((block) => block.isVoiceNote === true)).toBe(true);
      },
    },
  ] satisfies SlashCommandMediaCase[])("$name", async ({ id, files, replies, verify }) => {
    const transcriptDir = await createTranscriptFixture(`openclaw-chat-send-command-block-${id}-`);
    const audioPaths = files.map((file, index) => {
      const audioPath = path.join(transcriptDir, file);
      fs.writeFileSync(
        audioPath,
        id === "media-final"
          ? createPlaybackMediaFixture("mp3")
          : Buffer.from([0xff, 0xfb, 0x90, index]),
      );
      return audioPath;
    });
    const firstAudioPath = expectDefined(audioPaths[0], "slash-command media fixture");
    const fixturePaths: [string, string] = [firstAudioPath, audioPaths[1] ?? firstAudioPath];
    mockState.config = { agents: { defaults: { workspace: transcriptDir } } };
    mockState.dispatchedReplies = replies(fixturePaths);

    const payload = await runNonStreamingChatSend({
      context: createChatContext(),
      respond: vi.fn(),
      idempotencyKey: `idem-command-block-${id}`,
      message: "/export-trajectory bundle",
    });

    verify(getMessageContent(payload), fixturePaths);
  });

  it("renders mixed image reply payloads as assistant image content instead of MEDIA text", async () => {
    const transcriptDir = await createTranscriptFixture("openclaw-chat-send-agent-image-");
    const localPath = path.join(transcriptDir, "local.png");
    fs.writeFileSync(localPath, Buffer.from(TINY_PNG_BASE64, "base64"));
    writeSavedPng(transcriptDir, "staged.png");
    mockState.config = { agents: { defaults: { workspace: transcriptDir } } };
    const inlineUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
    mockState.finalPayload = {
      text: "Scan this QR code with the OpenClaw iOS app:",
      mediaUrls: [inlineUrl, localPath],
      attachments: [{ path: localPath, name: "Board chart.png", mimeType: "image/png" }],
    };
    const payload = await createChatRequestFixture().send({
      idempotencyKey: "idem-agent-image",
    });

    const content = getMessageContent(payload);
    expect(getMessage(payload)?.role).toBe("assistant");
    expect(content[0]).toEqual({
      type: "text",
      text: "Scan this QR code with the OpenClaw iOS app:",
    });
    const expectedImages = [
      expect.objectContaining({
        type: "image",
        alt: "Generated image 1",
        artifactId: expect.stringMatching(/^artifact_managed_image_/u),
        mimeType: "image/png",
        url: expect.stringMatching(/\/api\/chat\/media\/outgoing\//u),
        openUrl: expect.stringMatching(/\/api\/chat\/media\/outgoing\//u),
      }),
      expect.objectContaining({
        type: "image",
        alt: "Board chart.png",
        mimeType: "image/png",
      }),
    ];
    expect.soft(content.filter((block) => block.type === "image")).toEqual(expectedImages);
    const transcriptMessages = await readActiveAssistantTranscriptMessages();
    expect(transcriptMessages).toHaveLength(1);
    const persistedContent = getMessageContent({ message: transcriptMessages[0] });
    expect.soft(persistedContent.filter((block) => block.type === "image")).toEqual(expectedImages);
    expect(JSON.stringify(payload?.message)).not.toContain(`MEDIA:${inlineUrl}`);
  });

  it("chat.inject rechecks archive state after lifecycle admission waits", async () => {
    await createTranscriptFixture("openclaw-chat-inject-archive-race-");
    const storePath = mockState.storePath;
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation("patch", {
      scope: storePath,
      identities: ["main", mockState.sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
    });
    await mutationStarted.promise;
    const { context, respond } = createChatRequestFixture();

    try {
      const inject = expectDefined(
        chatHandlers["chat.inject"],
        'chatHandlers["chat.inject"] test invariant',
      )({
        params: { sessionKey: "main", message: "must lose the archive race" },
        respond,
        req: {} as never,
        client: null as never,
        isWebchatConnect: () => false,
        context,
      });
      await waitForAssertion(() => expect(mockState.loadSessionEntryCalls).toHaveLength(1));
      mockState.sessionEntry = { archivedAt: Date.now() };
      releaseMutation.resolve();
      await mutation;
      await inject;

      const response = lastRespondCall(respond);
      expect(response?.[0]).toBe(false);
      expect(response?.[2]?.message).toMatch(/archived/i);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(readTranscriptJsonLines(mockState.transcriptPath)).toHaveLength(1);
    } finally {
      releaseMutation.resolve();
      await mutation;
    }
  });

  it("chat.send non-streaming final keeps message defined for directive-only assistant text", async () => {
    await createTranscriptFixture("openclaw-chat-send-directive-only-");
    mockState.finalText = "[[reply_to_current]]";
    const payload = await createChatRequestFixture().send({
      idempotencyKey: "idem-directive-only",
    });

    expect(payload?.runId).toBe("idem-directive-only");
    expect(payload?.state).toBe("final");
    expect(extractFirstTextBlock(getMessage(payload))).toBe("");
  });

  it("rejects oversized chat.send session keys before dispatch", async () => {
    await createTranscriptFixture("openclaw-chat-send-session-key-too-long-");
    const { context, respond } = createChatRequestFixture();

    await handleDirectExternalChatSend({
      params: {
        sessionKey: `agent:main:${"x".repeat(CHAT_SEND_SESSION_KEY_MAX_LENGTH)}`,
        message: "hello",
        idempotencyKey: "idem-session-key-too-long",
      },
      respond,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context,
    });

    const response = lastRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[1]).toBeUndefined();
    expect(response?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(context.broadcast).not.toHaveBeenCalled();
  });

  it("rejects chat.send creation in an agent harness-owned namespace", async () => {
    await createTranscriptFixture("openclaw-chat-send-harness-reserved-");
    mockState.sessionMissing = true;
    const { context, respond } = createChatRequestFixture();

    await handleDirectExternalChatSend({
      params: {
        sessionKey: "agent:main:harness:codex:supervision:native-thread",
        message: "claim reserved session",
        idempotencyKey: "idem-harness-reserved",
      },
      respond,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context,
    });

    const response = lastRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: "Session key namespace is reserved for agent harness-owned sessions.",
    });
    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(context.broadcast).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "canonical key",
      sessionKey: "legacy-key",
      canonicalKey: "agent:main:canon",
      agentId: undefined,
      message: "hello",
    },
    {
      name: "selected-agent global",
      sessionKey: "main",
      canonicalKey: "global",
      agentId: "work",
      message: "hello selected global",
    },
  ])(
    "chat.inject broadcasts and routes on the $name",
    async ({ sessionKey, canonicalKey, agentId, message }) => {
      if (agentId) {
        await createGlobalTranscriptFixture("openclaw-chat-inject-selected-global-", agentId);
      } else {
        await createTranscriptFixture("openclaw-chat-inject-canonical-key-");
        mockState.config = { agents: { ownership: "explicit", entries: { main: {} } } };
      }
      mockState.sessionEntry = { canonicalKey };
      const { context, respond, inject } = createChatRequestFixture();
      await inject({
        sessionKey,
        ...(agentId ? { agentId } : {}),
        message,
      });
      const response = lastRespondCall(respond);
      expect(response?.[0]).toBe(true);
      const nodeSend = lastNodeSendCall(context);
      if (agentId) {
        expect(mockState.loadSessionEntryCalls[0]).toEqual({
          rawKey: sessionKey,
          opts: { agentId },
        });
        expect(lastBroadcastPayload(context)).toMatchObject({
          sessionKey: canonicalKey,
          agentId,
          state: "final",
        });
        expect(nodeSend?.[0]).toBe(`agent:${agentId}:global`);
        expect(nodeSend?.[2]).toMatchObject({ sessionKey: canonicalKey, agentId });
      } else {
        expect(response?.[1]?.ok).toBe(true);
        expect(lastBroadcastPayload(context)?.sessionKey).toBe(canonicalKey);
        expect(nodeSend?.[0]).toBe(canonicalKey);
        expect(nodeSend?.[1]).toBe("chat");
        expect(nodeSend?.[2].sessionKey).toBe(canonicalKey);
      }
    },
  );

  it("chat.send keeps thinking metadata out of command text for normal messages", async () => {
    await createReadyChatTranscript("openclaw-chat-send-thinking-normal-message-");
    await createChatRequestFixture().send({
      idempotencyKey: "idem-thinking-normal-message",
      message: "hello from phone",
      requestParams: {
        thinking: "low",
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.BodyForCommands).toBe("hello from phone");
    expect(mockState.lastDispatchCtx?.CommandBody).toBe("hello from phone");
    expect(mockState.lastDispatchCtx?.CommandTurn).toEqual({
      kind: "normal",
      source: "message",
      authorized: false,
      body: "hello from phone",
    });
    const userTurnInput = mockState.lastDispatchUserTurnInput as
      | {
          content?: unknown;
        }
      | undefined;
    expect(userTurnInput?.content).toBe("hello from phone");
    expect(mockState.lastDispatchThinkingLevelOverride).toBe("low");
  });

  it.each([
    [
      "keeps explicit delivery routes for channel-scoped sessions",
      "origin-routing",
      { channel: "telegram", to: "telegram:6812765697", accountId: "default", threadId: 42 },
      "agent:main:telegram:direct:6812765697",
      { deliver: true, external: true },
    ],
    [
      "keeps explicit delivery routes for legacy thread sessions",
      "legacy-thread-channel-peer-routing",
      { channel: "telegram", to: "telegram:6812765697", accountId: "default", threadId: "42" },
      "agent:main:telegram:6812765697:thread:42",
      { deliver: true, external: true },
    ],
    [
      "does not inherit external delivery context for UI clients on main sessions when deliver is enabled",
      "main-ui-deliver-no-route",
      { channel: "telegram", to: "telegram:200482621", accountId: "default" },
      "agent:main:main",
      { clientMode: GATEWAY_CLIENT_MODES.UI, deliver: true },
    ],
    [
      "inherits canonical origin-backed thread routing for configured main CLI sessions",
      "config-main-origin-thread-routes",
      { channel: "telegram", to: "telegram:6812765697", accountId: "default", threadId: "42" },
      "agent:main:work",
      {
        clientMode: GATEWAY_CLIENT_MODES.CLI,
        mainSessionKey: "work",
        origin: { provider: "telegram", accountId: "default", threadId: "42" },
        deliver: true,
        external: true,
      },
    ],
    [
      "keeps configured main delivery inheritance when connect metadata omits client details",
      "config-main-connect-no-client",
      { channel: "whatsapp", to: "whatsapp:+8613800138000", accountId: "default" },
      "agent:main:work",
      { mainSessionKey: "work", omitClientDetails: true, deliver: true, external: true },
    ],
    [
      "does not inherit external routes for webchat clients on channel-scoped sessions",
      "webchat-channel-scoped-no-inherit",
      { channel: "imessage", to: "+8619800001234", accountId: "default" },
      "agent:main:imessage:direct:+8619800001234",
      { clientMode: GATEWAY_CLIENT_MODES.WEBCHAT, deliver: true },
    ],
  ] satisfies ChatDeliveryRoutingCase[])(
    "chat.send %s",
    async (...[_name, id, delivery, sessionKey, options = {}]: ChatDeliveryRoutingCase) => {
      mockState.mainSessionKey = options.mainSessionKey ?? "main";
      await createTranscriptFixture(
        `openclaw-chat-send-${id}-`,
        { agentId: "main", sessionKey },
        options.mainSessionKey ? "fixed" : undefined,
      );
      mockState.finalText = "ok";
      mockState.sessionEntry = {
        delivery: normalizeSessionDeliveryState({
          context: delivery,
          ...(options.origin ? { origin: options.origin } : {}),
        }),
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath: mockState.storePath },
        { sessionId: mockState.sessionId, ...mockState.sessionEntry },
      );
      const client = options.clientMode
        ? {
            connect: {
              client: {
                mode: options.clientMode,
                id:
                  options.clientMode === GATEWAY_CLIENT_MODES.CLI
                    ? "cli"
                    : options.clientMode === GATEWAY_CLIENT_MODES.WEBCHAT
                      ? "openclaw-webchat"
                      : "openclaw-tui",
              },
            },
          }
        : options.omitClientDetails
          ? { connect: {} }
          : undefined;

      await runNonStreamingChatSend({
        context: createChatContext(),
        respond: vi.fn(),
        idempotencyKey: `idem-${id}`,
        sessionKey,
        ...(client ? { client } : {}),
        ...(typeof options.deliver === "boolean" ? { deliver: options.deliver } : {}),
        expectBroadcast: false,
      });

      const internalSessionKey = sessionKey === "main" ? "agent:main:main" : sessionKey;
      expectDispatchContextFields({
        OriginatingChannel: options.external ? delivery.channel : "webchat",
        OriginatingTo: options.external ? delivery.to : internalSessionKey,
        ExplicitDeliverRoute: Boolean(options.external && options.deliver),
        AccountId: options.external ? delivery.accountId : undefined,
        ...(options.external && delivery.threadId !== undefined
          ? { MessageThreadId: delivery.threadId }
          : {}),
      });
    },
  );

  it("chat.send accepts admin-scoped synthetic originating routes without external delivery", async () => {
    await createReadyChatTranscript("openclaw-chat-send-synthetic-origin-admin-");
    await createChatRequestFixture().send({
      idempotencyKey: "idem-synthetic-origin-admin",
      client: createScopedCliClient(["operator.admin"]),
      requestParams: {
        originatingChannel: "slack",
        originatingTo: "D123",
        originatingAccountId: "default",
        originatingThreadId: "thread-42",
      },
      deliver: false,
      expectBroadcast: false,
    });

    expectDispatchContextFields({
      OriginatingChannel: "slack",
      OriginatingTo: "D123",
      ExplicitDeliverRoute: false,
      AccountId: "default",
      MessageThreadId: "thread-42",
    });
  });

  it.each([
    {
      name: "synthetic originating routes",
      id: "synthetic-origin-reject",
      client: createScopedCliClient(["operator.write"]),
      requestParams: { originatingChannel: "slack", originatingTo: "D123" },
      errorMessage: "originating route fields require admin scope",
    },
    {
      name: "forged ACP metadata",
      id: "system-provenance-spoof-reject",
      client: createScopedCliClient(["operator.write"], {
        id: "cli",
        displayName: "ACP",
        version: "acp",
      }),
      requestParams: {
        systemInputProvenance: {
          kind: "external_user",
          originSessionId: "acp-session-spoof",
          sourceChannel: "acp",
          sourceTool: "openclaw_acp",
        },
        systemProvenanceReceipt:
          "[Source Receipt]\nbridge=openclaw-acp\noriginSessionId=acp-session-spoof\n[/Source Receipt]",
      },
      errorMessage: "system provenance fields require admin scope",
    },
  ])(
    "rejects $name when the caller lacks admin scope",
    async ({ id, client, requestParams, errorMessage }) => {
      await createReadyChatTranscript(`openclaw-chat-send-${id}-`);
      const { respond, send } = createChatRequestFixture();
      await send({
        idempotencyKey: `idem-${id}`,
        client,
        requestParams,
        expectBroadcast: false,
        waitForCompletion: false,
      });
      const [ok, _payload, error] = lastRespondCall(respond) ?? [];
      expect(ok).toBe(false);
      expect(error?.message).toBe(errorMessage);
      expect(mockState.lastDispatchCtx).toBeUndefined();
    },
  );

  it("injects ACP system provenance into the agent-visible body", async () => {
    await createReadyChatTranscript("openclaw-chat-send-system-provenance-acp-");
    const { send } = createChatRequestFixture();
    const provenance = {
      kind: "external_user" as const,
      originSessionId: "acp-session-1",
      sourceChannel: "acp",
      sourceTool: "openclaw_acp",
    };

    await send({
      idempotencyKey: "idem-system-provenance-acp",
      message: "bench update",
      client: createScopedCliClient(["operator.admin"], {
        id: "cli",
        displayName: "ACP",
        version: "acp",
      }),
      requestParams: {
        systemInputProvenance: provenance,
        systemProvenanceReceipt:
          "[Source Receipt]\nbridge=openclaw-acp\noriginSessionId=acp-session-1\n[/Source Receipt]",
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.InputProvenance).toEqual(provenance);
    expect(mockState.lastDispatchCtx?.Body).toBe(
      "[Source Receipt]\nbridge=openclaw-acp\noriginSessionId=acp-session-1\n[/Source Receipt]\n\nbench update",
    );
    expect(mockState.lastDispatchCtx?.RawBody).toBe("bench update");
    expect(mockState.lastDispatchCtx?.CommandBody).toBe("bench update");
    expect(mockState.lastDispatchUserTurnInput).toEqual({
      role: "user",
      content: "bench update",
      timestamp: expect.any(Number),
      idempotencyKey: "idem-system-provenance-acp:user",
      __openclaw: {
        senderIsOwner: true,
        transport: { clients: [{ id: "cli", mode: "cli", displayName: "ACP" }] },
      },
      provenance,
    });
  });

  it("does not emit pre-gate user transcript content when before_agent_run hooks are registered", async () => {
    await createReadyChatTranscript("openclaw-chat-send-user-transcript-before-run-gate-");
    mockState.triggerAgentRunStart = true;
    mockState.hasBeforeAgentRunHooks = true;
    let userUpdateCountAtAgentStart = 0;
    mockState.onAfterAgentRunStart = () => {
      userUpdateCountAtAgentStart = mockState.emittedTranscriptUpdates.filter(
        (update) =>
          typeof update.message === "object" &&
          update.message !== null &&
          (update.message as { role?: unknown }).role === "user",
      ).length;
    };
    await createChatRequestFixture().send({
      idempotencyKey: "idem-user-transcript-before-run-gate",
      message: "secret prompt that may be blocked",
      expectBroadcast: false,
    });

    expect(userUpdateCountAtAgentStart).toBe(0);
    const userUpdates = mockState.emittedTranscriptUpdates.filter(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "user",
    );
    expect(userUpdates).toHaveLength(0);
  });

  it("does not persist raw user transcript content when a delivered before_agent_run block is followed by a dispatch error", async () => {
    await createTranscriptFixture("openclaw-chat-send-user-transcript-blocked-delivery-error-");
    mockState.triggerAgentRunStart = true;
    mockState.hasBeforeAgentRunHooks = true;
    mockState.dispatchBlockedByBeforeAgentRun = true;
    mockState.dispatchErrorAfterDelivery = new Error("delivery failed after block");
    mockState.dispatchedReplies = [
      {
        kind: "block",
        payload: setReplyPayloadMetadata(
          { text: "The agent cannot read this message." },
          { beforeAgentRunBlocked: true },
        ),
      },
    ];
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-blocked-delivery-error",
      message: "secret prompt blocked before persistence then delivery failed",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-user-transcript-blocked-delivery-error")?.ok).toBe(
        false,
      );
    });
    expect(findUserUpdate()).toBeUndefined();
    expect(readPersistedUserMessages()).toHaveLength(0);
  });

  it("preserves managed attachment claims in transcript order", async () => {
    await createReadyChatTranscript("openclaw-chat-send-user-transcript-offloaded-");
    mockState.triggerAgentRunStart = true;
    useChatTestModel("vision-model", true);
    await seedSqliteSessionEntry(mockState.sessionEntry);
    setSavedMediaResults(
      ["/tmp/offloaded-big.png", "image/png", "offloaded-big.png"],
      ["/tmp/chat-send-inline.png", "image/png", "chat-send-inline.png"],
    );
    const { send } = createChatRequestFixture();
    const bigPng = createPngBuffer(2_100_000);

    await send({
      idempotencyKey: "idem-user-transcript-offloaded",
      message: "edit both",
      requestParams: {
        attachments: [
          createImageAttachment({ content: INLINE_PNG_BASE64 }),
          createImageAttachment({ content: bigPng.toString("base64") }),
        ],
      },
      expectBroadcast: false,
      waitForCompletion: false,
    });

    await waitForAssertion(() => {
      const userTurnInput = mockState.lastDispatchUserTurnInput as
        | { content?: unknown }
        | undefined;
      expect(findUserUpdate()).toBeUndefined();
      expect(userTurnInput?.content).toBe("edit both");
      expectClaimOnlyTranscriptMedia(
        userTurnInput,
        [
          expect.objectContaining({
            url: "media://inbound/chat-send-inline.png",
            contentType: "image/png",
            kind: "image",
          }),
          expect.objectContaining({
            url: "media://inbound/offloaded-big.png",
            contentType: "image/png",
            kind: "image",
          }),
        ],
        ["/tmp/chat-send-inline.png", "/tmp/offloaded-big.png"],
      );
      expect(userTurnInput?.content).not.toContain("media://");
    });
  });

  it("leaves ACP bridge user persistence to the agent runtime", async () => {
    await createReadyChatTranscript("openclaw-chat-send-user-transcript-acp-images-");
    mockState.triggerAgentRunStart = true;
    setSavedMediaResults(["/tmp/should-not-be-used.png", "image/png"]);
    await createChatRequestFixture().send({
      idempotencyKey: "idem-user-transcript-acp-images",
      message: "bridge image",
      client: {
        connect: {
          client: {
            id: GATEWAY_CLIENT_NAMES.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
            displayName: "ACP",
            version: "acp",
          },
        },
      },
      requestParams: {
        attachments: [createImageAttachment({ content: INLINE_PNG_BASE64 })],
      },
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(mockState.savedMediaCalls).toStrictEqual([]);
      expect(findUserUpdate()).toBeUndefined();
      expect(mockState.lastDispatchUserTurnInput).toEqual({
        role: "user",
        content: "bridge image",
        timestamp: expect.any(Number),
        idempotencyKey: "idem-user-transcript-acp-images:user",
        __openclaw: {
          transport: { clients: [{ id: "cli", mode: "cli", displayName: "ACP" }] },
        },
      });
    });
  });

  it("persists attachments serially before ACK and the user transcript before final broadcast", async () => {
    await createSqliteTranscriptFixture("openclaw-chat-send-no-agent-images-order-");
    mockState.finalText = "ok";
    setSavedMediaResults(
      ["/tmp/chat-send-image-a.png", "image/png"],
      ["/tmp/chat-send-image-b.jpg", "image/jpeg"],
    );
    let releaseSave = () => {};
    mockState.saveMediaWait = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const { context, respond, send } = createChatRequestFixture();

    const pendingSend = send({
      idempotencyKey: "idem-no-agent-images-order",
      message: "quick command",
      requestParams: {
        attachments: [
          createImageAttachment({ content: INLINE_PNG_BASE64 }),
          createImageAttachment({ content: TINY_JPEG_BASE64, mimeType: "image/jpeg" }),
        ],
      },
      expectBroadcast: false,
      waitForCompletion: false,
    });

    try {
      await waitForAssertion(() => expect(mockState.activeSaveMediaCalls).toBe(1));
      expect(mockState.maxActiveSaveMediaCalls).toBe(1);
      expect(mockState.savedMediaCalls).toHaveLength(0);
      expect(respond).not.toHaveBeenCalled();
      expect(context.broadcast.mock.calls.length).toBe(0);
    } finally {
      releaseSave();
      await pendingSend;
    }

    await waitForAssertion(() => {
      expect(mockState.maxActiveSaveMediaCalls).toBe(1);
      expect(mockState.savedMediaCalls).toHaveLength(2);
      expect(
        readChatSendDedupeResponse(context.dedupe, "idem-no-agent-images-order"),
      ).toBeDefined();
      expect(context.broadcast.mock.calls.length).toBe(1);
      const userUpdate = findUserUpdate();
      if (userUpdate?.message === undefined) {
        throw new Error("Expected streamed user transcript update message");
      }
      expectUserUpdateIdentity(userUpdate);
    });
  });

  it.each([
    { id: "media-only-silent-final", finalPayload: { text: "NO_REPLY" } },
    { id: "media-reply-tags", finalPayload: { replyToCurrent: true } },
  ])(
    "keeps image-only final content without leaking $id controls",
    async ({ id, finalPayload }) => {
      await expectImageOnlyFinal({
        transcriptPrefix: `openclaw-chat-send-${id}-`,
        idempotencyKey: `idem-${id}`,
        finalPayload: {
          ...finalPayload,
          mediaUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
        },
      });
      if (!finalPayload.replyToCurrent) {
        return;
      }
      const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
        (update) =>
          typeof update.message === "object" &&
          update.message !== null &&
          (update.message as { role?: unknown }).role === "assistant" &&
          Array.isArray((update.message as { content?: unknown }).content) &&
          (update.message as { openclawDelivery?: { replyToCurrent?: boolean } }).openclawDelivery
            ?.replyToCurrent === true,
      );
      const transcriptMessage = transcriptUpdate?.message as Record<string, any> | undefined;
      const displayContent = Array.isArray(transcriptMessage?.openclawDisplayContent)
        ? transcriptMessage.openclawDisplayContent
        : transcriptMessage?.content;
      expect(transcriptMessage?.role).toBe("assistant");
      expect(displayContent?.[0]).toEqual({
        type: "text",
        text: "Image reply",
      });
      expect(displayContent?.[1]).toMatchObject({
        type: "image",
        artifactId: expect.stringMatching(/^artifact_managed_image_/u),
        mimeType: "image/png",
      });
      expect(JSON.stringify(transcriptUpdate)).not.toContain("[[reply_to_current]]");
      expect(JSON.stringify(transcriptUpdate)).not.toContain(TINY_PNG_BASE64);
    },
  );

  it("does not persist sensitive image media into transcript updates", async () => {
    await createTranscriptFixture("openclaw-chat-send-sensitive-media-final-");
    mockState.finalPayload = {
      text: "Scan this QR code with the OpenClaw iOS app:",
      mediaUrl: "data:image/png;base64,cG5n",
      sensitiveMedia: true,
    };
    const payload = await createChatRequestFixture().send({
      idempotencyKey: "idem-sensitive-media-final",
    });

    const content = getMessageContent(payload);
    expect(getMessage(payload)?.role).toBe("assistant");
    expect(content[0]).toEqual({
      type: "text",
      text: "Scan this QR code with the OpenClaw iOS app:",
    });
    expect(content[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,cG5n" });
    const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant",
    );
    const transcriptMessage = transcriptUpdate?.message as Record<string, any> | undefined;
    expect(transcriptMessage?.role).toBe("assistant");
    expect(transcriptMessage?.content?.[0]).toEqual({
      type: "text",
      text: "Scan this QR code with the OpenClaw iOS app:",
    });
    expect(JSON.stringify(transcriptUpdate)).not.toContain("input_image");
    expect(JSON.stringify(transcriptUpdate)).not.toContain("data:image/png;base64,cG5n");
    expect(JSON.stringify(payload?.message)).not.toContain("/api/chat/media/outgoing/");
  });

  it("keeps image attachments for text-only sessions bound to ACP", async () => {
    await createReadyChatTranscript("openclaw-chat-send-text-only-acp-bound-attachments-");
    useChatTestModel("text-only");
    bindingMocks.resolveByConversation.mockReturnValue({
      targetSessionKey: "agent:claude:acp:spawned",
    });
    await createChatRequestFixture().send({
      idempotencyKey: "idem-text-only-acp-bound-attachments",
      message: "describe image",
      client: createScopedCliClient(["operator.admin"]),
      requestParams: {
        originatingChannel: "slack",
        originatingTo: "user:U123",
        originatingAccountId: "default",
        attachments: [createImageAttachment({ content: OFFLOAD_PNG_BASE64 })],
      },
      expectBroadcast: false,
    });

    expect(bindingMocks.resolveByConversation).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "default",
      conversationId: "user:U123",
    });
    expect(mockState.lastDispatchImages).toHaveLength(1);
    expect(mockState.lastDispatchImageOrder).toEqual(["inline"]);
  });

  it("resolves attachment image support from the session agent model", async () => {
    await createTranscriptFixture("openclaw-chat-send-agent-scoped-text-only-attachments-", {
      agentId: "writer",
      sessionKey: "agent:writer:main",
    });
    mockState.finalText = "ok";
    mockState.config = {
      agents: {
        entries: {
          vision: {
            model: "test-provider/vision-model",
          },
          writer: {
            model: "test-provider/text-only",
          },
        },
      },
    };
    mockState.modelCatalog = [
      {
        provider: "test-provider",
        id: "vision-model",
        name: "Vision model",
        input: ["text", "image"],
      },
      {
        provider: "test-provider",
        id: "text-only",
        name: "Text only",
        input: ["text"],
      },
    ];
    await createChatRequestFixture().send({
      sessionKey: "agent:writer:main",
      idempotencyKey: "idem-agent-scoped-text-only-attachments",
      message: "describe image",
      requestParams: {
        attachments: [createImageAttachment({ content: OFFLOAD_PNG_BASE64 })],
      },
      expectBroadcast: false,
      waitFor: "none",
    });

    await waitForAssertion(() => {
      expect(mockState.lastDispatchCtx?.Body).toBe("describe image");
    });
    expect(mockState.lastDispatchImages).toBeUndefined();
    expect(mockState.lastDispatchImageOrder).toEqual(["offloaded"]);
    expect(mockState.lastDispatchCtx?.Body).toBe("describe image");
    expect(mockState.lastDispatchCtx?.Body).not.toContain("media://");
    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        fileName: "attachment-1",
        path: "/tmp/1.png",
        contentType: "image/png",
        workspaceDir: "/tmp",
      },
    ]);
    expect(mockState.savedMediaCalls).toEqual([
      {
        contentType: "image/png",
        subdir: "inbound",
        size: mockState.savedMediaCalls[0]?.size ?? 0,
      },
    ]);
  });

  it("preserves staged non-image paths when plugin-bound sessions also carry inline images", async () => {
    await createReadyChatTranscript("openclaw-chat-send-plugin-bound-mixed-media-staging-");
    useChatTestModel("vision-model");
    bindingMocks.resolveByConversation.mockReturnValue({
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "demo-plugin",
        pluginRoot: "/plugins/demo-plugin",
      },
    });
    setSavedMediaResults(
      ["/home/user/.openclaw/media/inbound/report.pdf", "application/pdf"],
      ["/home/user/.openclaw/media/inbound/screenshot.png", "image/png"],
    );
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    mockState.stagedRelativePaths = ["media/inbound/report.pdf"];
    const { send } = createChatRequestFixture();
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");

    await send({
      idempotencyKey: "idem-plugin-bound-mixed-media-staging",
      message: "inspect these",
      client: createScopedCliClient(["operator.admin"]),
      requestParams: {
        originatingChannel: "slack",
        originatingTo: "user:U123",
        originatingAccountId: "default",
        attachments: [
          createFileAttachment("screenshot.png", "image/png", TINY_PNG_BASE64, "image"),
          createFileAttachment("report.pdf", "application/pdf", pdf),
        ],
      },
      expectBroadcast: false,
    });

    expect(bindingMocks.resolveByConversation).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "default",
      conversationId: "user:U123",
    });
    expect(mockState.lastDispatchImages).toHaveLength(1);
    expect(mockState.lastDispatchImageOrder).toEqual(["inline"]);
    expect(mockState.lastDispatchCtx?.media?.map((fact) => fact.path)).toEqual([
      "media/inbound/report.pdf",
    ]);
  });

  it.each(["throw", "incomplete"] as const)(
    "returns UNAVAILABLE and cleans up media after non-PDF staging %s",
    async (mode) => {
      const id = mode === "throw" ? "stage-unavailable" : "mixed-stage-skip";
      await createReadyChatTranscript(`openclaw-chat-send-${id}-`);
      useChatTestModel("vision-model");
      mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
      if (mode === "throw") {
        setSavedMediaResults([
          "/home/user/.openclaw/media/inbound/report.bin",
          "application/octet-stream",
        ]);
        const stageError = Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
        stageError.stack =
          "Error: ENOSPC: no space left on device\n    at stageSandboxMedia (stage-sandbox-media.ts:1:1)";
        mockState.stageSandboxMediaError = stageError;
      } else {
        setSavedMediaResults(
          ["/home/user/.openclaw/media/inbound/report.pdf", "application/pdf"],
          ["/home/user/.openclaw/media/inbound/data.bin", "application/octet-stream"],
        );
        mockState.stagedRelativePaths = ["media/inbound/report.pdf", "media/inbound/data.bin"];
        mockState.unstagedSources = ["/home/user/.openclaw/media/inbound/data.bin"];
      }
      const { context, respond, send } = createChatRequestFixture();
      const binPayload = Buffer.from("OPENCLAW-BINARY\n").toString("base64");
      await send({
        idempotencyKey: `idem-${id}`,
        message: mode === "throw" ? "read this" : "read these",
        requestParams: {
          attachments:
            mode === "throw"
              ? [createFileAttachment("report.bin", "application/octet-stream", binPayload)]
              : [
                  createFileAttachment(
                    "report.pdf",
                    "application/pdf",
                    Buffer.from("%PDF-1.4\n").toString("base64"),
                  ),
                  createFileAttachment("data.bin", "application/octet-stream", binPayload),
                ],
        },
        expectBroadcast: false,
        waitFor: "none",
      });

      expect(mockState.lastDispatchCtx).toBeUndefined();
      expect(respond).toHaveBeenCalledTimes(1);
      const [ok, payload, error] = lastRespondCall(respond) ?? [];
      expect(ok).toBe(false);
      expect(payload).toBeUndefined();
      expect(error?.code).toBe(ErrorCodes.UNAVAILABLE);
      if (mode === "throw") {
        expect(responseErrorMessage(error)).toMatch(/ENOSPC|non-image attachments/i);
        const unavailableLogCall = mockCallAt(context.logGateway.error, 0) as
          | [string, Record<string, string>]
          | undefined;
        expect(unavailableLogCall?.[0]).toBe("chat.send attachment parse/stage failed");
        expect(unavailableLogCall?.[1].consoleMessage).toContain(
          "chat.send attachment parse/stage failed: MediaOffloadError",
        );
        expect(unavailableLogCall?.[1].error).toContain(
          "Caused by: Error: ENOSPC: no space left on device\n    at stageSandboxMedia",
        );
        expect(mockState.deleteMediaBufferCalls).toEqual([
          { id: "saved-media", subdir: "inbound" },
        ]);
      } else {
        expect(responseErrorMessage(error)).toMatch(/staging incomplete/i);
        expect(mockState.deleteMediaBufferCalls.map((c) => c.id).toSorted()).toEqual([
          "saved-media",
          "saved-media",
        ]);
      }
    },
  );

  it.each(["throw", "skip"] as const)(
    "falls back to the managed PDF path when sandbox staging %s occurs",
    async (mode) => {
      await createReadyChatTranscript(`openclaw-chat-send-managed-pdf-stage-${mode}-`);
      useChatTestModel("vision-model");
      setSavedMediaResults(["/home/user/.openclaw/media/inbound/report.pdf", "application/pdf"]);
      mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
      if (mode === "throw") {
        mockState.stageSandboxMediaError = Object.assign(
          new Error("ENOSPC: no space left on device"),
          {
            code: "ENOSPC",
          },
        );
      }
      const { send } = createChatRequestFixture();
      // Below the staging cap; an empty staged map models a silently skipped PDF.
      const pdf = Buffer.from("%PDF-1.4\n%µ¶\nendobj\n").toString("base64");
      await send({
        idempotencyKey: `idem-managed-pdf-stage-${mode}`,
        message: "read this",
        requestParams: {
          attachments: [createFileAttachment("report.pdf", "application/pdf", pdf)],
        },
        expectBroadcast: false,
      });
      if (mode === "throw") {
        expect(mockState.lastDispatchCtx?.media).toEqual([
          {
            fileName: "report.pdf",
            path: "/home/user/.openclaw/media/inbound/report.pdf",
            contentType: "application/pdf",
            workspaceDir: "/home/user/.openclaw/media/inbound",
          },
        ]);
      } else {
        expect(mockState.lastDispatchCtx?.media?.map((fact) => fact.path)).toEqual([
          "/home/user/.openclaw/media/inbound/report.pdf",
        ]);
      }
      expect(mockState.deleteMediaBufferCalls).toEqual([]);
    },
  );

  it("stages non-image attachments above the generic media-store limit", async () => {
    // Regression: Gateway used MEDIA_MAX_BYTES (5 MiB) as a pre-staging cap
    // even though stageSandboxMedia accepts files up to 50 MiB.
    await createReadyChatTranscript("openclaw-chat-send-sandbox-oversize-");
    useChatTestModel("vision-model");
    setSavedMediaResults([
      "/home/user/.openclaw/media/inbound/huge.bin",
      "application/octet-stream",
    ]);
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    mockState.stagedRelativePaths = ["media/inbound/huge.bin"];
    const { send } = createChatRequestFixture();
    // 6 MiB buffer — above MEDIA_MAX_BYTES but below the default 20 MiB parser
    // cap and the canonical 50 MiB sandbox staging cap.
    const oversized = Buffer.alloc(6 * 1024 * 1024);
    oversized.set(Buffer.from("OPENCLAW-BINARY\n"), 0);
    const oversizedPayload = oversized.toString("base64");

    await send({
      idempotencyKey: "idem-sandbox-oversize",
      message: "read this",
      requestParams: {
        attachments: [
          createFileAttachment("huge.bin", "application/octet-stream", oversizedPayload),
        ],
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.media?.map((fact) => fact.path)).toEqual([
      "media/inbound/huge.bin",
    ]);
    expect(mockState.deleteMediaBufferCalls).toEqual([]);
  });

  it("persists a Gateway user turn under the canonical owner of a requested alias", async () => {
    createFixturePaths("openclaw-chat-send-aliased-transcript-owner-");
    const canonicalSessionKey = "agent:main:main";
    const requestedSessionKey = "main";
    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: canonicalSessionKey,
        storePath: mockState.storePath,
      },
      { sessionId: mockState.sessionId, updatedAt: 1 },
    );
    mockState.finalText = "ok";
    await createChatRequestFixture().send({
      idempotencyKey: "idem-aliased-transcript-owner",
      message: "keep this Gateway turn",
      sessionKey: requestedSessionKey,
      requestParams: { sessionId: mockState.sessionId },
      expectBroadcast: false,
    });

    const persistedEvents = loadTranscriptEventsSync({
      agentId: "main",
      sessionId: mockState.sessionId,
      sessionKey: canonicalSessionKey,
      storePath: mockState.storePath,
    });
    expect(persistedEvents).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "user",
          content: "keep this Gateway turn",
        }),
      }),
    );
    expect(mockState.loadSessionEntryCalls).toContainEqual({
      rawKey: canonicalSessionKey,
      opts: { agentId: "main" },
    });
    expect(findUserUpdate()?.target).toEqual({
      agentId: "main",
      sessionId: mockState.sessionId,
      sessionKey: canonicalSessionKey,
      storePath: mockState.storePath,
    });
  });

  it("does not duplicate fallback user transcript rows when chat.send is replayed", async () => {
    await createSqliteTranscriptFixture("openclaw-chat-send-user-transcript-error-replay-");
    mockState.dispatchError = new Error("upstream unavailable");

    await runNonStreamingChatSend({
      context: createChatContext(),
      respond: vi.fn(),
      idempotencyKey: "idem-user-transcript-error-replay",
      message: "hello from replayed failed dispatch",
      expectBroadcast: false,
    });
    await runNonStreamingChatSend({
      context: createChatContext(),
      respond: vi.fn(),
      idempotencyKey: "idem-user-transcript-error-replay",
      message: "hello from replayed failed dispatch",
      expectBroadcast: false,
    });

    expect(readPersistedUserMessages()).toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello from replayed failed dispatch",
        idempotencyKey: "idem-user-transcript-error-replay:user",
      }),
    ]);
    const userUpdates = mockState.emittedTranscriptUpdates.filter(
      (update) => getMessage(update)?.role === "user",
    );
    expect(userUpdates).toHaveLength(1);
  });

  it.each(["redact", "block"] as const)(
    "honors before_message_write %s in gateway fallback user persistence",
    async (mode) => {
      const idempotencyKey = `idem-user-transcript-error-before-write-${mode}`;
      await createSqliteTranscriptFixture(
        `openclaw-chat-send-user-transcript-error-before-write-${mode}-`,
      );
      mockState.triggerAgentRunStart = true;
      mockState.dispatchErrorAfterAgentRunStart = new Error("cli backend unavailable");
      if (mode === "block") {
        mockState.beforeMessageWriteBlock = true;
      } else {
        mockState.beforeMessageWriteContent = "[redacted by hook]";
      }
      const { context, send, respond } = createChatRequestFixture();
      await send({
        idempotencyKey,
        message: mode === "block" ? "blocked sensitive prompt" : "raw sensitive prompt",
        expectBroadcast: false,
        ...(mode === "block" ? { waitFor: "none" as const } : {}),
      });
      if (mode === "block") {
        await waitForAssertion(() => {
          expect(respond).toHaveBeenCalledWith(
            false,
            expect.objectContaining({ status: "error" }),
            expect.objectContaining({ message: expect.stringContaining("not durably admitted") }),
            expect.anything(),
          );
          expect(mockState.beforeMessageWriteCalls).toHaveLength(1);
        });
        expect(readChatSendDedupeResponse(context.dedupe, idempotencyKey)).toBeUndefined();
        expect(mockState.lastDispatchCtx).toBeUndefined();
        expect(findUserUpdate()).toBeUndefined();
        expect(readPersistedUserMessages()).toHaveLength(0);
      } else {
        const userUpdate = findUserUpdate();
        expectUserUpdateIdentity(userUpdate);
        expect(getMessage(userUpdate)?.content).toBe("[redacted by hook]");
        expect(mockState.beforeMessageWriteCalls).toHaveLength(1);
        const persistedUser = readPersistedUserMessages()[0];
        expect(persistedUser?.content).toBe("[redacted by hook]");
        expect(JSON.stringify(persistedUser)).not.toContain("raw sensitive prompt");
      }
    },
  );

  it("falls back to gateway user persistence when successful runtime persistence fails", async () => {
    await createSqliteTranscriptFixture(
      "openclaw-chat-send-user-transcript-success-runtime-persist-failed-",
    );
    mockState.triggerAgentRunStart = true;
    mockState.runtimeUserMessagePersistenceError = new Error("runtime prompt mirror failed");
    mockState.finalPayload = { text: "agent still answered" };
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-success-runtime-persist-failed",
      message: "hello before successful fallback",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(
        context.dedupe.get("chat:idem-user-transcript-success-runtime-persist-failed")?.ok,
      ).toBe(true);
      const userUpdate = findUserUpdate();
      expectUserUpdateIdentity(userUpdate);
      const message = getMessage(userUpdate);
      expect(message?.role).toBe("user");
      expect(message?.content).toBe("hello before successful fallback");
      expect(message?.idempotencyKey).toBe(
        "idem-user-transcript-success-runtime-persist-failed:user",
      );
    });
  });
});

describe("chat.send local operator client sender context", () => {
  it.each([
    [GATEWAY_CLIENT_NAMES.CONTROL_UI, GATEWAY_CLIENT_MODES.WEBCHAT, "web"],
    [GATEWAY_CLIENT_NAMES.CLI, GATEWAY_CLIENT_MODES.CLI, "darwin"],
  ] as const)(
    "binds lazy configured-MCP cron authority to an admitted local %s turn",
    async (clientId, mode, platform) => {
      await createSqliteTranscriptFixture(`openclaw-chat-send-cron-authority-${clientId}-`);
      const { send } = createChatRequestFixture();
      let retainedResolver: ReturnType<typeof bindActiveCronCreatorAuthorityResolver>;
      let resolvedGrant: { runId: string; token: string } | undefined;
      mockState.cronAuthorityProbe = async (runId, capability) => {
        await new Promise<void>((resolveTick) => {
          setTimeout(resolveTick, 0);
        });
        const resolve = async () =>
          ({
            tools: ["read", { name: "configured__lookup", pluginId: "bundle-mcp" }],
            provenance: { version: 1, source: "final-executable-surface" },
          }) as const;
        runWithCronCreatorAuthorityCapabilityResolver({
          capability,
          runId: "other-run",
          resolve,
          run: () => {
            expect(bindActiveCronCreatorAuthorityResolver(runId)).toBeUndefined();
          },
        });
        await runWithCronCreatorAuthorityCapabilityResolver({
          capability,
          runId,
          resolve,
          run: async () => {
            retainedResolver = bindActiveCronCreatorAuthorityResolver(runId);
            const snapshot = await retainedResolver!();
            resolvedGrant = snapshot.grant;
            expect(snapshot.tools).toEqual([
              "read",
              { name: "configured__lookup", pluginId: "bundle-mcp" },
            ]);
          },
        });
      };

      await send({
        idempotencyKey: `idem-cron-authority-${clientId}`,
        client: {
          connect: {
            client: { id: clientId, mode, version: "dev", platform },
            scopes: ["operator.admin"],
          },
          internal: { isLocalClient: true },
        },
        expectBroadcast: false,
      });

      expect(resolvedGrant).toMatchObject({ runId: `idem-cron-authority-${clientId}` });
      await expect(retainedResolver!()).rejects.toThrow(
        "Configured MCP cron authority is no longer active",
      );
      expect(() => consumeCronCreatorAuthorityGrant(resolvedGrant!)).toThrow(
        "Configured MCP cron authority is no longer active",
      );
    },
  );

  it.each([
    {
      name: "internal re-entry, including Talk consults",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      directExternal: false,
      message: "Talk realtime agent consult prompt",
    },
    {
      name: "remote client",
      client: { internal: {}, scopes: ["operator.admin"] },
    },
    {
      name: "non-admin client",
      client: { internal: { isLocalClient: true }, scopes: ["operator.write"] },
    },
    {
      name: "incognito session",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      sessionEntry: { incognito: true },
    },
    {
      name: "synthetic client",
      client: {
        internal: { isLocalClient: true, syntheticClient: true },
        scopes: ["operator.admin"],
      },
    },
    {
      name: "input provenance",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      requestParams: { systemInputProvenance: { kind: "external_user" } },
    },
    {
      name: "explicit origin",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      requestParams: { originatingChannel: "slack", originatingTo: "D123" },
    },
    {
      name: "delegated handoff",
      client: {
        internal: { isLocalClient: true, delegatedToolPolicyHandoffId: "handoff-1" },
        scopes: ["operator.admin"],
      },
    },
    {
      name: "spawned lineage",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      sessionEntry: { spawnedBy: "agent:main:parent" },
    },
    {
      name: "synthetic cron continuation",
      client: {
        internal: { isLocalClient: true, cronRunContinuation: true },
        scopes: ["operator.admin"],
      },
    },
    {
      name: "persisted cron continuation",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      sessionEntry: {
        cronRunContinuation: { lifecycleRevision: "revision-1", phase: "running" },
      },
    },
  ])("does not mint configured-MCP cron authority for $name", async (testCase) => {
    await createSqliteTranscriptFixture("openclaw-chat-send-cron-authority-negative-");
    mockState.sessionEntry = testCase.sessionEntry ?? {};
    await seedSqliteSessionEntry(mockState.sessionEntry);
    let boundResolver: ReturnType<typeof bindActiveCronCreatorAuthorityResolver>;
    mockState.cronAuthorityProbe = async (runId, capability) => {
      runWithCronCreatorAuthorityCapabilityResolver({
        capability,
        runId,
        resolve: async () => ({
          tools: testCase.directExternal === false ? ["read", "configured__lookup"] : ["read"],
          provenance: { version: 1, source: "final-executable-surface" },
        }),
        run: () => {
          boundResolver = bindActiveCronCreatorAuthorityResolver(runId);
        },
      });
    };
    await createChatRequestFixture().send({
      idempotencyKey: `idem-cron-authority-negative-${testCase.name.replaceAll(" ", "-")}`,
      ...(testCase.directExternal === false
        ? { directExternal: false, message: testCase.message }
        : {}),
      client: {
        connect: {
          client: {
            id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            version: "dev",
            platform: "web",
          },
          scopes: testCase.client.scopes,
        },
        internal: testCase.client.internal,
      },
      requestParams: testCase.requestParams,
      expectBroadcast: false,
    });

    expect(boundResolver!).toBeUndefined();
  });

  it.each([
    {
      name: "withholds task suggestions from operator UI clients that cannot accept them",
      id: "write-only-tui",
      message: "hello from a write-only tui",
      clientId: GATEWAY_CLIENT_NAMES.TUI,
      mode: GATEWAY_CLIENT_MODES.UI,
      platform: "terminal",
      scopes: ["operator.write"],
      caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
      expected: undefined,
    },
    {
      name: "withholds task suggestions from non-operator gateway clients",
      id: "channel",
      message: "hello from a channel bridge",
      clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      platform: "server",
      scopes: ["operator.write"],
      caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
      expected: undefined,
    },
  ])("$name", async ({ id, message, clientId, mode, platform, scopes, caps, expected }) => {
    await createChatRequestFixture().send({
      idempotencyKey: `idem-${id}-task-suggestions`,
      message,
      client: {
        connect: {
          client: { id: clientId, mode, version: "dev", platform },
          caps,
          scopes,
        },
      },
      expectBroadcast: false,
    });
    expect(mockState.lastTaskSuggestionDeliveryMode).toBe(expected);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
