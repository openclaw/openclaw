import { reduceSessionProjection } from "@openclaw/gateway-client/browser";
/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { peekChatMetadata } from "../../lib/chat/chat-metadata-store.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  replaceSlashCommands,
} from "../../lib/chat/commands.ts";
import * as outboxPayloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store-scope.ts";
import {
  captureChatOutboxAdmission,
  storageTargetForComposer,
} from "../../lib/chat/outbox-store.ts";
import "../../lib/toast-host.tsx";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult as sessionListFixture,
} from "../../lib/sessions/session-capability.test-support.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { sessionListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient as clientWithRequest } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload as registerStoredChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import * as chatCommandExecutor from "./chat-command-executor.ts";
import type { executeSlashCommand } from "./chat-command-executor.ts";
import {
  createDeliveryAttachmentBatch,
  reloadChatDocumentStorage,
} from "./chat-delivery-attachments.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  expectNoRpc,
  expectRpc,
  findRequestPayload,
  makeChatHost,
  makeRequestMock,
  requestCalls,
  requireRecord,
} from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  admitHostQueueItems,
  createQueuedLocalCommand,
  idleChatHistory,
  row,
} from "./chat-outbox-recovery.test-support.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import {
  keepVolatileQueuedMessage,
  readChatQueueForScope,
  removeQueuedMessage,
  updateQueuedMessage,
} from "./chat-queue.ts";
import {
  flushChatQueueForEvent,
  moveQueuedChatMessage,
  resumeStoredChatOutboxes,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
} from "./chat-send-actions.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { registerChatSendPayloadLimitTests } from "./chat-send-payload-limits.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { switchChatSetting } from "./chat-session.ts";
import { getPendingChatPickerPatch, patchChatSessionSettings } from "./chat-settings-patches.ts";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  refreshChatMetadata,
  refreshChatModelCatalogOnDemand,
  refreshPageChat,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { loadChatComposerState } from "./composer-draft-storage.ts";
import { getChatSessionProjection, publishChatSessionProjection } from "./history-merge.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";
import {
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  updateQueuedMessageEdit,
} from "./queued-message-edit.ts";
import { handleChatScrollTakeover } from "./scroll.ts";
import {
  cacheChatSessionSnapshot,
  readChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-key.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";
import { handleAgentEvent } from "./tool-stream.ts";

type ExecuteSlashCommand = typeof executeSlashCommand;
type TestChatHost = ReturnType<typeof makeChatHost>;

const startupOptions = { startup: true, awaitHistory: true, deferBranches: true };
const historyBudget = { limit: 80, maxBytes: 256 * 1024, toolResultMaxChars: 2_000 };
const storageError =
  "Could not store this message for reconnect. Free browser storage or reconnect before sending.";

function admitItem(
  host: TestChatHost,
  item: ChatQueueItem,
  sessionKey = host.sessionKey,
  agentId?: string,
) {
  const admission = captureChatOutboxAdmission(host, sessionKey, agentId);
  expect(admitQueuedMessageForSession(host, admission, item)).toBe(true);
}

function wireAttachments(
  attachments: ReturnType<typeof createDeliveryAttachmentBatch>["attachments"],
  dataUrls: string[],
) {
  return attachments.map((attachment, index) => ({
    type: attachment.mimeType.startsWith("image/") ? "image" : "file",
    mimeType: attachment.mimeType,
    fileName: attachment.fileName,
    content: dataUrls[index]!.split(",")[1],
  }));
}

function nextMacrotask() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function sendAck(params: unknown, label: string, status: string, messageSeq?: number) {
  return {
    runId: requireRecord(params, label).idempotencyKey,
    status,
    ...(messageSeq === undefined ? {} : { messageSeq }),
  };
}

function queuedMessage<T extends Partial<ChatQueueItem>>(id: string, text: string, details: T) {
  return { id, text, createdAt: 1, ...details };
}

function expectItems(actual: unknown, ...items: unknown[]): void {
  expect(actual).toEqual(items.map((item) => expect.objectContaining(item)));
}

function asChatPageHost(host: TestChatHost): ChatPageHost {
  return host as ChatPageHost;
}

function requireChatMessageCache(host: ChatHost): ChatMessageCache {
  if (!host.chatMessagesBySession) {
    throw new Error("Expected chat message cache");
  }
  return host.chatMessagesBySession;
}

function cacheChatMessages(
  cache: ChatMessageCache,
  host: Parameters<typeof cacheChatSessionSnapshot>[1],
  target: Parameters<typeof cacheChatSessionSnapshot>[2],
  messages: unknown[],
): void {
  cacheChatSessionSnapshot(cache, host, target, {
    messages,
    pagination: { hasMore: false },
    sessionId: null,
  });
}

function cacheEmptyChatSnapshot(host: ChatHost, sessionKey: string): void {
  cacheChatSessionSnapshot(
    requireChatMessageCache(host),
    host,
    { sessionKey },
    {
      messages: [],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "cached-session",
    },
  );
}

const executeSlashCommandMock = vi.fn();
const executeSlashCommandActual = chatCommandExecutor.executeSlashCommand;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function registerChatAttachmentPayload(
  params: Parameters<typeof registerStoredChatAttachmentPayload>[0],
) {
  const attachment = registerStoredChatAttachmentPayload(params);
  onTestFinished(() => releaseChatAttachmentPayloads([attachment]));
  return attachment;
}

function registerFileAttachment(id: string, text: string, fileName: string, mimeType: string) {
  const file = new File([text], fileName, { type: mimeType });
  return registerChatAttachmentPayload({
    attachment: { id, mimeType, fileName, sizeBytes: file.size },
    dataUrl: `data:${mimeType};base64,${btoa(text)}`,
    file,
  });
}

function registerTextAttachment(id: string, text: string, fileName?: string) {
  return registerChatAttachmentPayload({
    attachment: { id, mimeType: "text/plain", ...(fileName ? { fileName } : {}) },
    dataUrl: `data:text/plain;base64,${btoa(text)}`,
    file: new File([text], fileName ?? `${text}.txt`, { type: "text/plain" }),
  });
}

function installQuotaExceededStorage(): void {
  rejectStorageWritesWhen(() => true);
}

function rejectStorageWritesWhen(
  shouldReject: (key: string, value: string) => boolean,
  storage = createStorageMock(),
) {
  const write = storage.setItem.bind(storage);
  vi.stubGlobal("sessionStorage", storage);
  return vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
    if (shouldReject(key, value)) {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    }
    write(key, value);
  });
}

function holdNextPayloadRead(readStarted = createDeferred(), releaseRead = createDeferred()) {
  const readPayload = outboxPayloadStore.readOutboxPayload;
  const read = vi
    .spyOn(outboxPayloadStore, "readOutboxPayload")
    .mockImplementationOnce(async (...args) => {
      const result = await readPayload(...args);
      readStarted.resolve();
      await releaseRead.promise;
      return result;
    });
  return { readStarted, releaseRead, read };
}

beforeEach(() => {
  installOutboxBrowserStorage();
  executeSlashCommandMock.mockReset();
  vi.spyOn(chatCommandExecutor, "executeSlashCommand").mockImplementation((...args) => {
    const implementation = executeSlashCommandMock.getMockImplementation() as
      | ExecuteSlashCommand
      | undefined;
    return implementation ? executeSlashCommandMock(...args) : executeSlashCommandActual(...args);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createSessionsResult(sessions: GatewaySessionRow[]): SessionsListResult {
  return { ...sessionListFixture(sessions, 0), path: "" };
}

function deviceSessionRow(
  key: string,
  status: "available" | "offline",
  overrides: Pick<GatewaySessionRow, "sessionId" | "archived"> = {},
) {
  return row(key, {
    ...overrides,
    updatedAt: 10,
    placement: createActiveSessionPlacement({
      generation: 4,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
      environmentId: "environment-device",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-device",
      runner: { kind: "device", status },
    }),
  });
}

async function raceWithMacrotask(promise: Promise<unknown>): Promise<"resolved" | "pending"> {
  return await Promise.race([
    promise.then(() => "resolved" as const),
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

describe("refreshChat", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("requestIdleCallback", vi.fn());
  });

  it("commits startup history before immediately hydrating missing metadata (metadata settles first)", async () => {
    const startup = createDeferred<unknown>();
    const metadata = createDeferred<unknown>();
    const catalog = createDeferred<unknown>();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Transcript paints before metadata" }],
    };
    const host = makeChatHost({
      hello: gatewayHelloForMethods(["chat.metadata", "chat.startup"], []),
      requestHandlers: {
        "chat.startup": () => startup.promise,
        "chat.metadata": () => metadata.promise,
        "models.list": () => catalog.promise,
      },
    });

    const refresh = refreshPageChat(asChatPageHost(host), startupOptions);
    const reobserved = refreshChatMetadata(asChatPageHost(host));
    startup.resolve({ messages: [message] });
    await expect(refresh).resolves.toBeUndefined();
    const joined = refreshChatMetadata(asChatPageHost(host));
    const scope = { agentId: "main", sessionKey: host.sessionKey };
    const metadataParams = { agentId: scope.agentId, includeModels: false };

    expect(host.chatMessages).toEqual([message]);
    expect(host.request).toHaveBeenCalledWith("chat.metadata", metadataParams);
    expect(asChatPageHost(host).chatModelsLoading).toBe(true);

    const model = {
      available: true,
      id: "hydrated-model",
      name: "Hydrated Model",
      provider: "openai",
    };
    metadata.resolve({ commands: [] });
    await waitForFast(() =>
      expect(peekChatMetadata(expectDefined(host.client, "chat client"), scope)).toEqual({
        commands: [],
      }),
    );
    expect(asChatPageHost(host).chatModelsLoading).toBe(true);
    expect(host.chatModelCatalog).toEqual([]);
    catalog.resolve({ models: [model] });
    await waitForFast(() => {
      expect(host.chatModelCatalog).toEqual([model]);
      expect(asChatPageHost(host).chatModelsLoading).toBe(false);
    });
    await Promise.all([reobserved, joined]);
    expect(requestCalls(host.request, "chat.metadata")).toHaveLength(1);
    expect(requestCalls(host.request, "models.list")).toHaveLength(1);
  });

  it("does not let late startup metadata replace a repaired retained session", async () => {
    const startup = createDeferred<unknown>();
    const ready = { id: "model", name: "Model", provider: "test", available: true };
    const host = makeChatHost({
      requestHandlers: {
        "chat.startup": () => startup.promise,
        "chat.metadata": async () => ({ commands: [] }),
        "models.list": async () => ({ models: [ready] }),
      },
    });
    const refresh = refreshPageChat(asChatPageHost(host), startupOptions);
    invalidateChatMetadataStore(expectDefined(host.client, "chat host client"));
    await waitForFast(() => expect(host.chatModelCatalog).toEqual([ready]));
    startup.resolve({
      messages: [],
      metadata: {
        commands: [],
        models: [{ ...ready, available: false, unavailableReason: "missing-auth" }],
      },
    });
    await refresh;
    expect(host.chatModelCatalog).toEqual([ready]);
  });

  it("keeps direct catalog reads alive after another pane disconnects", async () => {
    const startup = createDeferred<unknown>();
    const metadata = createDeferred<unknown>();
    const ready = { id: "model", name: "Model", provider: "test", available: true };
    const retained = makeChatHost({
      requestHandlers: {
        "models.list": () => metadata.promise,
        "chat.startup": () => startup.promise,
      },
    });
    const opening = makeChatHost({ client: retained.client });
    const kept = asChatPageHost(retained);
    const closed = asChatPageHost(opening);
    kept.chatModelCatalog = [{ ...ready, available: false, unavailableReason: "missing-auth" }];
    const restoring = refreshChatModelCatalogOnDemand(kept);
    const loading = refreshPageChat(closed, startupOptions);
    retireChatMetadataRequests(closed);
    closed.connected = false;
    metadata.resolve({ commands: [], models: [ready] });
    await restoring;
    startup.resolve({ messages: [], metadata: { commands: [], models: [ready] } });
    await loading;
    try {
      await waitForFast(() => expect(kept.chatModelCatalog).toEqual([ready]));
      expect(closed.chatModelCatalog).toEqual([]);
    } finally {
      retireChatMetadataRequests(kept);
    }
  });

  it("keeps an active run adopted from history over newer stale catalog metadata", async () => {
    const runId = "run-restored";
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          inFlightRun: { runId, text: "Still working after navigation." },
          sessionInfo: row("main", {
            activeRunIds: [runId],
            hasActiveRun: true,
            status: "running",
            updatedAt: 1,
          }),
        },
      },
      sessionKey: "main",
      sessionsResult: createSessionsResult([
        row("main", { hasActiveRun: false, status: "done", updatedAt: 10 }),
      ]),
    });

    await refreshPageChat(asChatPageHost(host), {
      awaitHistory: true,
      scheduleScroll: false,
    });
    await nextMacrotask();

    expect(host.chatRunId).toBe(runId);
    expect(host.chatStream).toBe("Still working after navigation.");
    expect(host.sessionsResult?.sessions[0]).toMatchObject({
      hasActiveRun: false,
      status: "done",
      updatedAt: 10,
    });
  });

  it("still lets late startup hydration add a routed row absent from a newer canonical list", async () => {
    const key = "agent:main:archived-device-session";
    const routed = deviceSessionRow(key, "available", { archived: true });
    const startup = createDeferred<unknown>();
    const host = makeChatHost({
      hello: gatewayHelloForMethods(["chat.startup"], []),
      requestHandlers: {
        "chat.startup": () => startup.promise,
        "sessions.list": createSessionsResult([]),
      },
      sessionKey: key,
    });
    const refresh = refreshPageChat(asChatPageHost(host), {
      awaitHistory: true,
      deferBranches: true,
      scheduleScroll: false,
      startup: true,
    });
    await vi.waitFor(() => expect(requestCalls(host.request, "chat.startup")).toHaveLength(1));
    await host.sessions.refresh({ force: true });
    expect(host.sessions.canonicalListRevision).toBe(1);
    expect(host.sessions.state.result?.sessions).toEqual([]);

    startup.resolve({ messages: [], sessionInfo: routed });
    await refresh;
    await nextMacrotask();

    expectItems(host.sessions.state.result?.sessions, { key, archived: true });
  });

  it("rejects a deleted global history generation without publishing it into another agent's pane", async () => {
    const current = row("global", {
      kind: "global",
      sessionId: "work-current",
      hasActiveRun: true,
      status: "running",
    });
    const client = clientWithRequest(
      makeRequestMock({
        "sessions.list": createSessionsResult([current]),
        "chat.history": {
          messages: [],
          sessionInfo: {
            ...current,
            sessionId: current.sessionId,
            hasActiveRun: false,
            status: "done",
            modelProvider: "openai",
            totalTokens: 90_000,
          },
        },
      }),
    );
    const { gateway, emitEvent } = createGatewayHarness(client);
    const host = makeChatHost({
      client,
      sessions: createTestSessionCapability(gateway),
      sessionKey: "agent:work:main",
      agentsList: { defaultId: "main", mainKey: "main", scope: "global" },
      sessionsResult: createSessionsResult([row("agent:main:main")]),
      sessionsResultAgentId: "main",
    });
    host.sessions.reconcile(row("agent:main:main"), undefined, { resultAgentId: "main" });
    await host.sessions.list({ agentId: "work" });
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "global",
        agentId: "work",
        sessionId: current.sessionId,
        reason: "delete",
      },
    });
    const primary = host.sessions.state.result;
    const pane = host.sessionsResult;
    await refreshPageChat(asChatPageHost(host), { awaitHistory: true, scheduleScroll: false });
    expect(host.sessions.state.result).toBe(primary);
    expect(host.sessionsResult).toBe(pane);
    expect(host.sessionsResultAgentId).toBe("main");
    expect(selectedChatSessionRow(asChatPageHost(host))).toBeUndefined();
    host.sessions.dispose();
  });

  it.each(["selected session", "other-agent rows", "global alias"] as const)(
    "drains a restored queue from history for %s",
    async (scenario) => {
      const scoped = scenario !== "selected session";
      const global = scenario === "global alias";
      const sessionKey = global
        ? "agent:work:main"
        : scoped
          ? "agent:work:dashboard"
          : "agent:main:dashboard";
      const message = "after reload";
      const primarySessions = createSessionsResult([
        row("agent:main:main", { hasActiveRun: false, status: "done" }),
      ]);
      const expectedSend = {
        sessionKey: global ? "global" : sessionKey,
        message,
        ...(global ? { agentId: "work" } : {}),
      };
      const sendRequested = createDeferred();
      const host = makeChatHost({
        sessionKey,
        ...(scoped ? { sessionsResult: primarySessions, sessionsResultAgentId: "main" } : {}),
        ...(global
          ? { agentsList: { defaultId: "main", mainKey: "main", scope: "global" as const } }
          : {}),
        requestHandlers: {
          "chat.history": global
            ? {
                messages: [],
                sessionInfo: row("global", {
                  kind: "global",
                  sessionId: "work-current",
                  hasActiveRun: false,
                  status: "done",
                  modelProvider: "openai",
                  totalTokens: 90_000,
                  contextTokens: 300_000,
                }),
              }
            : () => idleChatHistory(sessionKey),
          "chat.send": (params: unknown) => {
            const payload = requireRecord(params, "restored send payload");
            sendRequested.resolve();
            return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
          },
        },
        chatQueue: [queuedMessage("queued-1", message, {})],
      });
      if (scoped) {
        for (const session of primarySessions.sessions) {
          host.sessions.reconcile(session, primarySessions.defaults, { resultAgentId: "main" });
        }
      }
      const primaryResult = host.sessions.state.result;
      admitHostQueueItems(host);

      await refreshPageChat(asChatPageHost(host), { scheduleScroll: false });
      await sendRequested.promise;
      await resumeStoredChatOutboxes(host);
      expectRpc(host.request, "chat.send", expect.objectContaining(expectedSend));
      expect(host.chatQueue).toEqual([]);

      if (expectedSend.sessionKey === "global") {
        expect(host.sessions.state.result).toBe(primaryResult);
        expect(host.sessions.state.agentId).toBe("main");
        expect(host.sessionsResultAgentId).toBe("work");
        expect(selectedChatSessionRow(asChatPageHost(host))).toMatchObject({
          key: "global",
          modelProvider: "openai",
          totalTokens: 90_000,
          contextTokens: 300_000,
          hasActiveRun: false,
          status: "done",
        });
      } else {
        expect(host.sessionsResult).toBe(host.sessions.state.result);
      }
    },
  );

  it("keeps a timed-out startup settled through an outbox wake until explicit history retry", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:dashboard";
    const startup = createDeferred<ChatHistoryResult>();
    const recovered = {
      messages: [],
      sessionInfo: row(sessionKey, {
        sessionId: "dashboard-session",
        hasActiveRun: false,
        status: "done",
      }),
    };
    const host = makeChatHost({
      sessionKey,
      chatMessage: "Send after recovery",
      requestHandlers: {
        "chat.startup": () => startup.promise,
        "chat.history": recovered,
        "chat.send": (params: unknown) => sendAck(params, "recovered send", "started", 1),
      },
    });
    try {
      const initialLoad = loadChatHistory(host, { startup: true, deferBranches: true });
      const send = handleSendChat(host);
      await vi.advanceTimersByTimeAsync(0);
      expectItems(host.chatQueue, { text: "Send after recovery", sendState: "waiting-idle" });
      host.chatMessage = "Keep my next draft";
      await vi.advanceTimersByTimeAsync(60_001);
      await initialLoad;
      await send;
      expect(getChatHistoryLoadState(host)).toMatchObject({ phase: "failed" });
      const wake = flushChatQueueForEvent(host);
      await vi.advanceTimersByTimeAsync(0);
      expect(requestCalls(host.request, "chat.startup")).toHaveLength(1);
      expect(getChatHistoryLoadState(host)).toMatchObject({ phase: "failed" });
      await wake;
      expect(host).toMatchObject({ chatLoading: false, chatMessage: "Keep my next draft" });
      expect(requestCalls(host.request, "chat.send")).toHaveLength(0);

      startup.resolve(recovered);
      await loadChatHistory(host, { startup: true, deferBranches: true });
      await flushChatQueueForEvent(host);
      expect(requestCalls(host.request, "chat.startup")).toHaveLength(2);
      expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
      expect(host.chatMessage).toBe("Keep my next draft");
    } finally {
      startup.resolve(recovered);
      await vi.advanceTimersByTimeAsync(0);
      host.sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("drains a message submitted during startup after stale active history becomes idle", async () => {
    const sessionKey = "agent:main:dashboard";
    const message = "Continue after history loads";
    const startup = createDeferred<ChatHistoryResult>();
    const idleHistory: ChatHistoryResult = {
      messages: [],
      sessionInfo: row(sessionKey, {
        sessionId: "dashboard-session",
        hasActiveRun: false,
        status: "done",
        updatedAt: 11,
      }),
    };
    const host = makeChatHost({
      sessionKey,
      chatMessage: message,
      chatFollowUpMode: "queue",
      sessionsResult: createSessionsResult([
        row(sessionKey, {
          sessionId: "dashboard-session",
          hasActiveRun: true,
          status: "running",
          updatedAt: 10,
        }),
      ]),
      requestHandlers: {
        "chat.startup": () => startup.promise,
        "chat.history": idleHistory,
        "chat.send": (params: unknown) => sendAck(params, "startup send payload", "started", 1),
      },
    });
    const refresh = refreshPageChat(asChatPageHost(host), {
      startup: true,
      awaitHistory: true,
      deferBranches: true,
      scheduleScroll: false,
    });
    onTestFinished(async () => {
      startup.resolve(idleHistory);
      await refresh;
      retireChatMetadataRequests(asChatPageHost(host));
      host.sessions.dispose();
    });

    expect(host.chatQueue).toEqual([]);
    await handleSendChat(host);
    expect(host.chatMessage).toBe("");
    expectItems(host.chatQueue, { text: message, sendState: "waiting-idle" });
    expectNoRpc(host.request, "chat.send");

    startup.resolve(idleHistory);
    await refresh;
    await waitForFast(() => {
      expectRpc(
        host.request,
        "chat.send",
        expect.objectContaining({ sessionKey, sessionId: "dashboard-session", message }),
      );
      expect(host.chatQueue).toEqual([]);
    });
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  });

  it("keeps a restored queue when newer session state is active", async () => {
    const sessionKey = "agent:main:dashboard";
    const restoredQueue = [queuedMessage("queued-1", "after active run", {})];
    const expectedSession = { hasActiveRun: true, status: "running" as const, updatedAt: 10 };
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: row(sessionKey, { hasActiveRun: false, status: "done", updatedAt: 5 }),
        },
      },
      sessionKey,
      chatQueue: restoredQueue,
      sessionsResult: createSessionsResult([row(sessionKey, { ...expectedSession, startedAt: 9 })]),
    });
    admitHostQueueItems(host);

    await refreshPageChat(asChatPageHost(host), { scheduleScroll: false });
    await nextMacrotask();

    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expectItems(host.chatQueue, restoredQueue[0]);
    expect(host.sessionsResult?.sessions[0]).toMatchObject(expectedSession);
  });
});

function installPairClientPresentationCommand() {
  replaceSlashCommands(
    buildSlashCommandsFromEntries([
      {
        name: "pair",
        textAliases: ["/pair"],
        description: "Pair a device.",
        source: "plugin",
        scope: "both",
        acceptsArgs: true,
        clientPresentation: {
          when: "no-arguments",
          action: { kind: "device-pairing" },
        },
      },
    ]),
  );
}

describe("handleSendChat", () => {
  registerChatSendPayloadLimitTests();

  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createStorageMock());
  });

  it("preserves another run's inactive tuple when the accepted run finishes before roster updates", async () => {
    const sessionKey = "agent:main:dashboard:terminal-roster-lag";
    const previous: GatewaySessionRow = {
      key: sessionKey,
      agentId: "main",
      sessionId: "terminal-roster-lag",
      kind: "direct",
      updatedAt: 200,
      hasActiveRun: false,
      activeRunIds: [],
      lastRunId: "previous-run",
      status: "failed",
      lastRunError: "Previous run failed",
      startedAt: 100,
      endedAt: 200,
      runtimeMs: 100,
    };
    let authoritativeRow = previous;
    const host = makeChatHost({
      sessionKey,
      currentSessionId: previous.sessionId,
      chatMessage: "Start the next run",
      requestHandlers: {
        "sessions.list": () =>
          sessionListFixture([{ ...authoritativeRow }], authoritativeRow.updatedAt ?? 0),
        "chat.send": (params: unknown) => sendAck(params, "accepted run", "started", 1),
      },
    });
    const stop = host.sessions.subscribe((snapshot) => {
      host.sessionsResult = snapshot.result;
      host.sessionsResultAgentId = snapshot.agentId;
    });
    const query = { agentId: "main", ownerId: "viewer" };
    const stopManaged = host.sessions.subscribeList(query, () => {});
    onTestFinished(() => {
      host.connected = false;
      if (host.chatRunStatusClearTimer) {
        clearTimeout(host.chatRunStatusClearTimer);
      }
      stopManaged();
      stop();
      host.sessions.dispose();
      retireChatMetadataRequests(asChatPageHost(host));
    });
    await host.sessions.refresh({ agentId: "main", force: true });
    await host.sessions.refreshList(query);

    await handleSendChat(host);
    const runId = expectDefined(host.chatRunId, "accepted run identity");
    expect(runId).not.toBe(previous.lastRunId);
    expect(host.sessionsResult?.sessions[0]).toEqual(previous);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);

    // The send ACK is independent of the optional roster start notification.
    handlePageGatewayEvent(asChatPageHost(host), {
      type: "event",
      event: "chat",
      payload: {
        sessionKey,
        agentId: "main",
        runId,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "Current run finished" }] },
      },
    });

    expect(host.chatRunId).toBeNull();
    expect(host.sessionsResult?.sessions[0]).toEqual(previous);
    expect(host.sessions.state.result?.sessions[0]).toEqual(previous);
    expect(host.sessions.listSnapshot(query).result?.sessions[0]).toEqual(previous);

    authoritativeRow = {
      ...previous,
      updatedAt: 400,
      lastRunId: runId,
      status: "done",
      lastRunError: undefined,
      startedAt: 300,
      endedAt: 400,
    };
    await host.sessions.refresh({ agentId: "main", force: true });
    await host.sessions.refreshList(query);
    expect(host.sessionsResult?.sessions[0]).toEqual(authoritativeRow);
    expect(host.sessions.listSnapshot(query).result?.sessions[0]).toEqual(authoritativeRow);
  });

  it.each([
    { input: "stop", message: "stop", runId: "idle-stop" },
    {
      input: "/reset\nsoft please reload system prompt",
      message: "/reset soft please reload system prompt",
    },
  ])(
    "sends $input without aborting or requiring reset confirmation",
    async ({ input, message, runId }) => {
      const host = makeChatHost({
        requestHandlers: { "chat.send": { ...(runId ? { runId } : {}), status: "started" } },
        chatMessage: input,
        sessionKey: "agent:main",
      });

      await handleSendChat(host);

      expectRpc(
        host.request,
        "chat.send",
        expect.objectContaining({ message, sessionKey: "agent:main" }),
      );
      expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
      expect(host.chatMessage).toBe("");
    },
  );

  afterEach(() => {
    replaceSlashCommands(buildFallbackSlashCommands());
  });

  it.each([
    { chatMessage: "/pair :", attached: false },
    { chatMessage: "/pair", attached: true },
    { chatMessage: "/btw summarize this", attached: false },
  ])(
    "routes presentation command $chatMessage with attachments=$attached",
    async ({ chatMessage, attached }) => {
      installPairClientPresentationCommand();
      const dispatchClientPresentation = vi.fn(async () => true);
      const openSessionCompanion = vi.fn();
      const baselineMessages = [{ role: "assistant", content: "Ready." }];
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatMessage,
        chatAttachments: attached
          ? [registerFileAttachment("pairing-notes", "pairing notes", "pairing.txt", "text/plain")]
          : [],
        chatMessages: baselineMessages,
        dispatchClientPresentation,
        openSessionCompanion,
      });

      await handleSendChat(host);

      if (attached) {
        expect(dispatchClientPresentation).not.toHaveBeenCalled();
        expectRpc(host.request, "chat.send", expect.objectContaining({ message: chatMessage }));
      } else {
        if (chatMessage.startsWith("/btw")) {
          expect(openSessionCompanion).toHaveBeenCalledWith("summarize this");
          expect(host.chatLocalInputHistoryBySession[host.sessionKey]?.[0]?.text).toBe(chatMessage);
        } else {
          expect(dispatchClientPresentation).toHaveBeenCalledWith({ kind: "device-pairing" });
        }
        expectNoRpc(host.request, "chat.send");
        expect(host.chatQueue).toStrictEqual([]);
        expect(host.chatMessages).toEqual(baselineMessages);
        expect(host.chatMessage).toBe("");
        expect(host.chatRunId).toBeNull();
      }
    },
  );

  it("does not mutate another session after an awaited presentation is handled", async () => {
    installPairClientPresentationCommand();
    const handled = createDeferred<boolean>();
    const dispatchClientPresentation = vi.fn(() => handled.promise);
    const otherSessionHistory = [{ text: "keep this", ts: 1 }];
    const host = makeChatHost({
      chatMessage: "/pair",
      dispatchClientPresentation,
      sessionKey: "agent:main",
      chatLocalInputHistoryBySession: { "agent:other": otherSessionHistory },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    expect(dispatchClientPresentation).toHaveBeenCalledWith({ kind: "device-pairing" });

    host.sessionKey = "agent:other";
    host.chatMessage = "/pair";
    handled.resolve(true);
    await send;

    expect(host.chatMessage).toBe("/pair");
    expect(host.chatLocalInputHistoryBySession["agent:other"]).toEqual(otherSessionHistory);
    expect(host.chatLocalInputHistoryBySession["agent:main"]).toBeUndefined();
    expect(host.chatQueue).toStrictEqual([]);
  });

  it.each([true, false])(
    "settles a settings-delayed redirect with picker success=%s",
    async (success) => {
      const settingsPatch = createDeferred<boolean>();
      const attachments = success
        ? []
        : [{ id: "redirect-attachment", mimeType: "text/plain", fileName: "notes.txt" }];
      const host = makeChatHost({
        requestHandlers: success
          ? {
              "chat.send": {
                status: "started",
                runId: "redirect-run",
                messageSeq: 2,
                interruptedActiveRun: true,
              },
            }
          : {},
        chatAttachments: attachments,
        chatMessage: "/redirect start over",
        pendingSettingsPatches: { "agent:main": settingsPatch.promise },
        sessionKey: "agent:main",
      });

      const send = handleSendChat(host);
      const duplicate = success ? handleSendChat(host) : undefined;
      expect(await raceWithMacrotask(send)).toBe("pending");
      await duplicate;
      expect(host.request).not.toHaveBeenCalled();
      expect(host.chatMessage).toBe("/redirect start over");

      if (success) {
        host.chatMessage = "new draft";
      }
      settingsPatch.resolve(success);
      await send;
      if (success) {
        expectRpc(host.request, "chat.send", {
          sessionKey: "agent:main",
          message: "start over",
          queueMode: "interrupt",
          idempotencyKey: expect.any(String),
        });
        expect(host.request).toHaveBeenCalledTimes(1);
        expect(host).toMatchObject({ chatMessage: "new draft", chatRunId: "redirect-run" });
      } else {
        expect(host.request).not.toHaveBeenCalled();
        expect(host.chatMessage).toBe("/redirect start over");
        expect(host.chatAttachments).toStrictEqual(attachments);
        expect(host.chatRunId).toBeNull();
      }
    },
  );

  it.each(["timeout", "ok"] as const)(
    "settles a reset's %s ACK without replacing the Sessions table",
    async (status) => {
      const archivedSessions = createSessionsResult([
        row("agent:main:archived", { archived: true, status: "done" }),
      ]);
      const host = makeChatHost({
        requestHandlers: {
          "chat.send": (params: unknown) => {
            const payload = requireRecord(params, "chat send payload");
            return status === "ok" ? { runId: payload.idempotencyKey, status } : { status };
          },
          ...(status === "ok"
            ? {
                "chat.history": idleChatHistory(),
                "sessions.list": () =>
                  createSessionsResult([
                    row("agent:main", { hasActiveRun: false, status: "done" }),
                  ]),
              }
            : {}),
        },
        chatMessage: "/reset",
        sessionKey: "agent:main",
        ...(status === "ok"
          ? {
              sessionsArchivedFilter: "archived" as const,
              sessionsResult: archivedSessions,
            }
          : {}),
      });

      await handleSendChat(host);

      const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
      const runState = host as ChatHost & {
        chatStreamStartedAt?: number | null;
        lastLocalTerminalReconcile?: unknown;
      };
      expect(runState.lastLocalTerminalReconcile).toMatchObject({
        phase: status === "ok" ? "done" : "interrupted",
        runId: String(payload.idempotencyKey),
        sessionKey: "agent:main",
        sessionStatus: status === "ok" ? "done" : "killed",
      });
      if (status === "ok") {
        await waitForFast(() =>
          expect(host.request.mock.calls.some(([method]) => method === "sessions.list")).toBe(true),
        );
        expect(host.sessionsResult).toBe(archivedSessions);
      } else {
        expect(host).toMatchObject({ chatRunId: null, chatStream: null });
        expect(runState.chatStreamStartedAt).toBeNull();
        expect(host.refreshSessionsAfterChat.size).toBe(0);
      }
    },
  );

  it("removes only a reducer-owned optimistic turn after a terminal error ACK", async () => {
    const status = "error";
    const persistedPeer = {
      role: "user",
      content: [{ type: "text", text: "same visible message" }],
      __openclaw: { id: "peer-user", seq: 1, idempotencyKey: "peer-run:user" },
    };
    let rejectedRunId = "";
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "terminal chat send payload");
          rejectedRunId = String(payload.idempotencyKey);
          const scope = { sessionKey: host.sessionKey };
          const projection = reduceSessionProjection(getChatSessionProjection(host, scope), {
            type: "sendPending",
            runId: rejectedRunId,
            message: {
              role: "user",
              content: [{ type: "text", text: "same visible message" }],
              __openclaw: { idempotencyKey: `${rejectedRunId}:user` },
            },
            scope,
          });
          publishChatSessionProjection(host, projection);
          host.chatMessages = [...projection.messages];
          return { runId: rejectedRunId, status };
        },
      },
      chatMessage: "same visible message",
      chatMessages: [persistedPeer],
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    expect(host.chatMessages).toStrictEqual([persistedPeer]);
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      text: "same visible message",
      sendRunId: rejectedRunId,
      sendState: "failed",
    });
    expect(host).toMatchObject({ lastError: null, chatError: null, chatRunId: null });
    expect(
      getChatSessionProjection(host, { sessionKey: host.sessionKey }).entries,
    ).not.toContainEqual(expect.objectContaining({ pendingRunId: rejectedRunId }));
  });

  it("keeps waiting when a late picker barrier cannot be persisted", async () => {
    const queuedText = "do not bypass the late picker";
    const acknowledgment = createDeferred<unknown>();
    const settingsUpdate = createDeferred<unknown>();
    let rejectedBarrier = false;
    rejectStorageWritesWhen((_key, value) => {
      if (
        !rejectedBarrier &&
        value.includes(`"text":"${queuedText}"`) &&
        value.includes('"sendState":"failed"')
      ) {
        rejectedBarrier = true;
        return true;
      }
      return false;
    });
    const host = makeChatHost({
      currentSessionId: "picker-session",
      requestHandlers: {
        "chat.history": idleChatHistory(),
        "chat.send": () => acknowledgment.promise,
        "sessions.patch": () => settingsUpdate.promise,
      },
      chatMessage: queuedText,
      chatQueue: [
        queuedMessage("older-picker-barrier", "already delivered", {
          sessionId: "picker-session",
          sendAttempts: 1,
          sendRunId: "older-picker-run",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        }),
      ],
    });
    admitHostQueueItems(host);

    const send = handleSendChat(host);
    await waitForFast(() => expect(requestCalls(host.request, "chat.send")).toHaveLength(1));
    const patch = patchChatSessionSettings(host, "agent:main", { model: "next" });
    acknowledgment.resolve({ runId: "older-picker-run", status: "ok" });

    await waitForFast(() => expect(rejectedBarrier).toBe(true));
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);

    settingsUpdate.resolve(null);
    await Promise.all([patch, send]);
    await resumeStoredChatOutboxes(host);

    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    expect(host.chatMessage).toBe(queuedText);
    expect(host.chatQueue).toStrictEqual([]);
  });

  it("does not gate a queued local command on an unrelated picker update", async () => {
    const settingsUpdate = createDeferred<boolean>();
    executeSlashCommandMock.mockResolvedValue({ content: "Compaction complete." });
    const host = makeChatHost({
      requestHandlers: {},
      chatMessage: "/compact",
      pendingSettingsPatches: { "agent:main": settingsUpdate.promise },
    });

    await handleSendChat(host);

    expect(executeSlashCommandMock).toHaveBeenCalledOnce();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toStrictEqual([]);
    settingsUpdate.resolve(false);
  });

  it("waits for a settings patch started in another split pane", async () => {
    const thinkingUpdate = createDeferred<unknown>();
    const sessionsResult = createSessionsResult([
      row("agent:work:main", {
        thinkingLevel: "low",
      }),
    ]);
    const request = makeRequestMock({
      "sessions.patch": () => thinkingUpdate.promise,
      "sessions.list": () => Promise.resolve(sessionsResult),
      "chat.send": () => Promise.resolve({ status: "started" }),
    });
    const client = clientWithRequest(request);
    const agentsList = { defaultId: "main", mainKey: "home" };
    const settingsPane = makeChatHost({
      agentsList,
      client,
      sessionKey: "agent:work:main",
      sessionsResult,
    });
    const sendPane = makeChatHost({
      agentsList,
      client,
      chatMessage: "wait for the other pane",
      sessionKey: "agent:work:home",
      sessions: settingsPane.sessions,
      sessionsResult,
    });
    const thinkingPatch = switchChatSetting(settingsPane, { kind: "thinkingLevel", value: "high" });
    const send = handleSendChat(sendPane);

    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(sendPane.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "wait for the other pane",
    });

    thinkingUpdate.resolve({});
    await Promise.all([thinkingPatch, send]);

    expect(requestCalls(request, "chat.send")).toHaveLength(1);
    expect(findRequestPayload(request, "chat.send", "chat send payload")).toMatchObject({
      message: "wait for the other pane",
      sessionKey: "agent:work:home",
    });
  });

  it.each([{ patchKey: "agent:main:main", sendKey: "agent:ops:work" }])(
    "gates $sendKey on its default-main alias patch",
    async ({ patchKey, sendKey }) => {
      const settingsPatch = createDeferred<boolean>();

      const agentsList: AgentsListResult = {
        defaultId: "ops",
        mainKey: "work",
        scope: "per-sender",
        agents: [{ id: "ops" }],
      };
      const settingsPane = makeChatHost({
        agentsList,
        pendingSettingsPatches: { [patchKey]: settingsPatch.promise },
        sessionKey: patchKey,
      });
      const sendPane = makeChatHost({
        requestHandlers: {
          "chat.send": { status: "started" },
        },
        agentsList,
        chatMessage: "wait for the legacy alias patch",
        sessionKey: sendKey,
        sessions: settingsPane.sessions,
      });

      const send = handleSendChat(sendPane);
      expect(await raceWithMacrotask(send)).toBe("pending");
      expect(sendPane.request).not.toHaveBeenCalled();

      settingsPatch.resolve(false);
      await send;

      expect(sendPane.request).not.toHaveBeenCalled();
      expect(sendPane.chatMessage).toBe("wait for the legacy alias patch");
    },
  );

  it.each([
    {
      global: true,
      sendKey: "agent:work:main",
      patchKey: "global",
      message: "send to the agent main session",
    },
    {
      global: false,
      sendKey: "agent:main:matrix:group:!room:Example",
      patchKey: "agent:main:matrix:group:!Room:Example",
      message: "send in other session",
    },
  ])(
    "does not cross-gate $sendKey on a distinct $patchKey patch",
    async ({ global, sendKey, patchKey, message }) => {
      const settingsPatch = createDeferred<boolean>();
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        ...(global
          ? {
              agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" as const },
              assistantAgentId: "work",
              hello: {
                ...gatewayHelloForMethods([], []),
                snapshot: {
                  sessionDefaults: {
                    defaultAgentId: "main",
                    mainKey: "main",
                    mainSessionKey: "global",
                    scope: "global",
                  },
                },
              },
            }
          : {}),
        pendingSettingsPatches: { [patchKey]: settingsPatch.promise },
        sessionKey: sendKey,
        chatMessage: message,
      });

      expect(getPendingChatPickerPatch(host, host.sessionKey)).toBeUndefined();
      const send = handleSendChat(host);
      expect(await raceWithMacrotask(send)).toBe("resolved");
      await send;

      expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
      const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
      expect(payload.sessionKey).toBe(sendKey);
      expect(payload.message).toBe(message);
      settingsPatch.resolve(false);
    },
  );

  it("preserves reader ownership across a settings-delayed send", async () => {
    const settings = createDeferred<boolean>();
    const ack = createDeferred<{ status: string; runId: string }>();
    const container = document.createElement("div");
    Object.defineProperties(container, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 400 },
    });
    container.scrollTop = 1200;
    const scrollToEnd = vi.fn(() => {
      container.scrollTop = 1600;
      return true;
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const host = makeChatHost({
      requestHandlers: { "chat.send": () => ack.promise },
      chatMessage: "send while reading",
      chatRunId: null,
      chatHasAutoScrolled: true,
      chatFollowLocked: true,
      chatUserNearBottom: false,
      chatScrollElement: () => container,
      chatScrollToEnd: scrollToEnd,
      pendingSettingsPatches: { "agent:main": settings.promise },
      settings: { chatFollowUpMode: "steer" },
    });
    const send = handleSendChat(host);
    await waitForFast(() => expect(container.scrollTop).toBe(1600));
    expectNoRpc(host.request, "chat.send");
    container.scrollTop = 1200;
    handleChatScrollTakeover(host);
    expect(host.chatFollowLocked).toBe(true);
    scrollToEnd.mockClear();

    settings.resolve(true);
    await waitForFast(() => expectRpc(host.request, "chat.send"));
    ack.resolve({ status: "started", runId: "accepted-run" });
    await send;
    await Promise.resolve();

    expect(host).toMatchObject({ chatFollowLocked: true, chatHasAutoScrolled: true });
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(1200);
  });

  it("keeps a queued retry failed when its pending settings patch fails", async () => {
    const text = "do not retry stale settings";
    const settingsPatch = createDeferred<boolean>();
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
      },
      chatQueue: [
        queuedMessage("retry-send", text, {
          sendError: "previous failure",
          sendRunId: "retry-run",
          sendState: "failed",
          sessionKey: "agent:main",
        }),
      ],
      pendingSettingsPatches: { "agent:main": settingsPatch.promise },
    });
    admitHostQueueItems(host);
    const retry = retryQueuedChatMessage(host, "retry-send");
    expect(await raceWithMacrotask(retry)).toBe("pending");
    expect(requestCalls(host.request, "chat.history")).toHaveLength(0);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]).toMatchObject({ sendState: "waiting-model", text });

    settingsPatch.resolve(false);
    await retry;

    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]).toMatchObject({
      sendError: "Chat settings update was interrupted. Review and retry when ready.",
      sendState: "failed",
      text,
    });
  });

  it("does not acquire volatile provenance after repeated durable retry read failures", async () => {
    const original = queuedMessage(
      "durable-failed-repeat-read-failure",
      "never bypass the durable row",
      { sendRunId: "durable-failed-run", sendState: "failed", sessionKey: "agent:main" },
    ) satisfies ChatQueueItem;
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const host = makeChatHost({ requestHandlers: {}, chatQueue: [original] });
    admitItem(host, original, original.sessionKey);
    const getItem = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new DOMException("storage unavailable", "SecurityError");
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await retryQueuedChatMessage(host, original.id);
    }

    expect(host.request).not.toHaveBeenCalled();
    const ownedOriginal = {
      ...original,
      storageScope: outboxPayloadStore.outboxStorageScope(host),
    };
    expect(host.chatQueue).toStrictEqual([ownedOriginal]);
    getItem.mockRestore();
    expect(listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue)).toEqual([ownedOriginal]);
  });

  it("keeps slash-command model changes in the canonical row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 })),
    );

    const host = makeChatHost({
      agentsList: { defaultId: "main", mainKey: "main" },
      requestHandlers: {
        "sessions.patch": {
          ok: true,
          key: "main",
          resolved: {
            modelProvider: "openai",
            model: "gpt-5-mini",
          },
        },
        "chat.history": { messages: [], thinkingLevel: null },
        "sessions.list": sessionListResult(
          0,
          [
            row("main", {
              model: "gpt-5-mini",
              modelProvider: "openai",
              modelOverrideSource: "user",
            }),
          ],
          { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        ),
        "models.list": {
          models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
        },
      },
      sessionKey: "main",
      chatMessage: "/model gpt-5-mini",
    });

    await handleSendChat(host);

    expect(host.request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "gpt-5-mini",
    });
    expect(host.sessions.state.modelOverrides.main).toBeUndefined();
    expect(host.sessions.state.result?.sessions[0]).toMatchObject({
      model: "gpt-5-mini",
      modelProvider: "openai",
      modelOverrideSource: "user",
    });
  });

  it.each(["error ACK", "transport rejection"] as const)(
    "fences detached approval recovery after %s and a route change",
    async (failure) => {
      const ack = createDeferred<unknown>();
      const settingsPatch = createDeferred<boolean>();
      const attachments =
        failure === "error ACK"
          ? [registerTextAttachment("approval-session-attachment", "approval", "approval.txt")]
          : [];
      const host = makeChatHost({
        requestHandlers: {
          "chat.send": () => ack.promise,
        },
        chatAttachments: attachments,
        chatMessage: "/approve approval-123 allow-once",
        chatRunId: "run-main",
        chatStream: "Waiting for approval...",
        sessionKey: "agent:main:first",
        ...(failure === "transport rejection"
          ? { pendingSettingsPatches: { "agent:main:first": settingsPatch.promise } }
          : {}),
      });

      const send = handleSendChat(host);
      if (failure === "transport rejection") {
        host.chatMessage = "newer first-session draft";
        settingsPatch.resolve(true);
      }
      await waitForFast(() => expect(host.request).toHaveBeenCalledOnce());
      host.sessionKey = "agent:main:second";
      host.chatMessage = "second session draft";
      host.lastError = "second session error";
      host.chatError = "second session error";

      if (failure === "error ACK") {
        ack.resolve({ runId: "approval-command", status: "error" });
      } else {
        ack.reject(new Error("transport failed"));
      }
      await send;

      expect(host.chatMessage).toBe("second session draft");
      expect(host.lastError).toBe("second session error");
      expect(host.chatError).toBe("second session error");

      if (failure === "error ACK") {
        const fallback = Object.values(host.chatComposerFallbackByScope)[0];
        expect(fallback?.message).toBe("/approve approval-123 allow-once");
        expectItems(fallback?.attachments, { id: attachments[0]!.id });
        expect(getChatAttachmentDataUrl(fallback!.attachments[0]!)).toBe(
          "data:text/plain;base64,YXBwcm92YWw=",
        );
      } else {
        expect(host.chatComposerFallbackByScope).toEqual({});
      }
    },
  );

  it.each([false, true])(
    "settles only the submitted command's attachments and fallback on success=%s",
    async (success) => {
      const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
      executeSlashCommandMock.mockImplementationOnce(() => command.promise);
      const submittedAttachment = registerTextAttachment(
        "submitted-command-attachment",
        success ? "success" : "submitted",
      );
      const newerAttachments = success
        ? []
        : [registerTextAttachment("newer-draft-attachment", "newer")];
      const host = makeChatHost({
        chatAttachments: [submittedAttachment],
        chatMessage: "/redirect start over",
        client: clientWithRequest(vi.fn()),
        connectionEpoch: 1,
        sessionKey: "agent:main:first",
      });
      if (success) {
        const scopeKey = storedChatOutboxScopeKey(
          resolveUiConversationIdentity(host, host.sessionKey),
        );
        host.chatComposerFallbackByScope = {
          [scopeKey]: {
            message: host.chatMessage,
            attachments: [submittedAttachment],
            storageFailed: false,
            sequence: 41,
          },
        };
      }
      const send = handleSendChat(host);
      await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledOnce());
      if (!success) {
        host.chatAttachments = newerAttachments;
      }
      command.resolve({ content: success ? "Redirected." : "Redirect failed.", failed: !success });
      await send;

      expect(host.chatMessage).toBe("");
      expect(host.chatComposerFallbackByScope).toEqual({});
      expect(getChatAttachmentDataUrl(submittedAttachment)).toBeNull();
      if (!success) {
        expect(host.chatAttachments).toEqual(newerAttachments);
        expect(getChatAttachmentDataUrl(newerAttachments[0]!)).toBe(
          "data:text/plain;base64,bmV3ZXI=",
        );
      }
    },
  );

  it.each([
    { previousRunId: null, adoption: "status" },
    { previousRunId: "previous-run", adoption: "ack" },
  ])(
    "preserves pre-ACK activity through $adoption adoption after $previousRunId",
    async ({ previousRunId, adoption }) => {
      const acknowledgement = createDeferred<{ status: string; runId: string }>();
      const host = makeChatHost({
        requestHandlers: { "chat.send": () => acknowledgement.promise },
        chatMessage: "Inspect the workspace",
        chatRunId: previousRunId,
        chatFollowUpMode: "interrupt",
      });
      const emitActivity = (runId: string) => {
        const base = { runId, sessionKey: host.sessionKey, ts: 1 };
        handleAgentEvent(host, {
          ...base,
          seq: 2,
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: `tool-${runId}`,
            name: "exec",
            args: { command: "pwd" },
          },
        });
        handleAgentEvent(host, {
          ...base,
          seq: 3,
          stream: "lifecycle",
          data: {
            phase: "waiting-approval",
            approvalId: `approval-${runId}`,
            toolCallId: `tool-${runId}`,
          },
        });
        handleAgentEvent(host, { ...base, seq: 4, stream: "compaction", data: { phase: "start" } });
      };
      if (previousRunId) {
        emitActivity(previousRunId);
      }
      const sending = handleSendChat(host);
      await waitForFast(() => expectRpc(host.request, "chat.send"));
      const payload = findRequestPayload(host.request, "chat.send", "pending send");
      const runId = payload.idempotencyKey;
      if (typeof runId !== "string") {
        throw new Error("expected the admitted client run id");
      }
      try {
        expect(host.chatRunId).toBe(previousRunId);
        if (previousRunId) {
          expect(host.chatRunStartup).toEqual({ state: "activity", runId: previousRunId, seq: 2 });
          expect(host.waitingApprovalStatuses?.has(`approval-${previousRunId}`)).toBe(true);
        }
        emitActivity(runId);
        const identity = buildToolStreamIdentity(runId, `tool-${runId}`);
        const tool = structuredClone(
          expectDefined(host.toolStreamById.get(identity), "expected incoming pre-ACK tool"),
        );
        const approval = structuredClone(host.waitingApprovalStatuses?.get(`approval-${runId}`));
        const compaction = structuredClone(host.compactionStatus);
        expect(tool).toMatchObject({ runId, toolCallId: `tool-${runId}`, name: "exec" });
        expect(approval).toMatchObject({ runId });
        expect(compaction).toMatchObject({ runId, phase: "active" });
        await waitForFast(() => expect(host.chatToolMessages).toContainEqual(tool.message));
        const assertIncomingActivity = () => {
          expect(host.toolStreamById.get(identity)).toEqual(tool);
          expect(host.chatToolMessages).toContainEqual(tool.message);
          expect(host.waitingApprovalStatuses?.get(`approval-${runId}`)).toEqual(approval);
          expect(host.compactionStatus).toEqual(compaction);
          expect(host.knownAgentRunIds?.has(runId)).toBe(true);
        };
        if (adoption === "status") {
          handleChatGatewayEvent(host, {
            sessionKey: host.sessionKey,
            runId,
            seq: 1,
            state: "status",
            phase: "starting_model",
          });
          expect(host.chatRunId).toBe(runId);
          assertIncomingActivity();
        }
        acknowledgement.resolve({ status: "started", runId });
        await sending;
        expect(host.chatRunId).toBe(runId);
        assertIncomingActivity();
        expect(host.toolStreamById.size).toBe(1);
        expect(host.waitingApprovalStatuses?.size).toBe(1);
        if (previousRunId) {
          expect(host.knownAgentRunIds?.has(previousRunId)).toBe(false);
          expect(host.chatRunStartup?.runId).not.toBe(previousRunId);
        }
      } finally {
        acknowledgement.resolve({ status: "started", runId });
        await sending;
        if (host.compactionClearTimer != null) {
          window.clearTimeout(host.compactionClearTimer);
        }
      }
    },
  );

  it("adopts a steer-mode ACK when no run is active", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started", runId: "started-run" },
      },
      chatMessage: "start through steer mode",
      chatStreamSegments: [{ text: "stale commentary", ts: 1, itemId: "stale" }],
      chatToolMessages: [{ role: "toolResult", toolCallId: "stale-tool", content: "stale output" }],
    });

    await handleSendChat(host, undefined, { followUpMode: "steer" });

    expect(host.chatRunId).toBe("started-run");
    expect(host.chatStreamSegments).toEqual([]);
    expect(host.chatToolMessages).toEqual([]);
  });

  it("skips the full-history reconcile for a never-attempted head behind a known active run", async () => {
    // Every transcript event re-runs the outbox resume; without the session-row
    // gate each wakeup issued a 1000-message chat.history only to learn the run
    // is still active.
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => {
          throw new Error("reconcile must not fetch history while the session row is active");
        },
      },
      chatQueue: [
        queuedMessage("queued-behind-run", "wait for the active run", {
          sendRunId: "queued-behind-run-send",
          sendState: "waiting-idle",
          sessionKey: "agent:main",
        }),
      ],
      sessionsResult: createSessionsResult([
        row("agent:main", { hasActiveRun: true, status: "running", updatedAt: 10 }),
      ]),
    });
    admitHostQueueItems(host);

    await resumeStoredChatOutboxes(host);

    expect(requestCalls(host.request, "chat.history")).toHaveLength(0);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-idle",
      text: "wait for the active run",
    });

    // Once the row goes idle the same head reconciles through history again.
    const idleRow = row("agent:main", { hasActiveRun: false, status: "done", updatedAt: 11 });
    host.sessions.reconcile(idleRow);
    host.sessionsResult = createSessionsResult([idleRow]);
    host.request.mockImplementation((method: string) =>
      method === "chat.history"
        ? Promise.resolve(idleChatHistory("agent:main"))
        : Promise.resolve({ runId: "queued-behind-run-send", status: "ok" }),
    );
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "chat.history").length).toBeGreaterThan(0);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  });

  it("keeps visible sending state owned by its scope while an inactive outbox finishes", async () => {
    const visibleAck = createDeferred<unknown>();
    const sentSessions: string[] = [];
    const visibleSessionKey = "agent:main:visible";
    const inactiveSessionKey = "agent:main:inactive";
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": (params: unknown) => {
          const payload = requireRecord(params, "chat.history payload");
          return {
            messages: [],
            sessionInfo: row(String(payload.sessionKey), {
              hasActiveRun: false,
              status: "done",
            }),
          };
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat.send payload");
          const sessionKey = String(payload.sessionKey);
          sentSessions.push(sessionKey);
          return sessionKey === visibleSessionKey
            ? visibleAck.promise
            : { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
        },
      },
      sessionKey: visibleSessionKey,
    });

    const visibleSend = handleSendChat(host, "visible pending send");
    await waitForFast(() => expect(sentSessions).toContain(visibleSessionKey));
    expect(host.chatSending).toBe(true);

    const inactiveItem = queuedMessage("inactive-send-finishes-first", "inactive send", {
      createdAt: 2,
      sessionKey: inactiveSessionKey,
    });
    admitItem(host, inactiveItem, inactiveSessionKey);
    const resume = resumeStoredChatOutboxes(host);

    await waitForFast(() => expect(sentSessions).toContain(inactiveSessionKey));
    expect(host.chatSending).toBe(true);

    const visibleRunId = host.chatQueue[0]?.sendRunId;
    visibleAck.resolve({ runId: visibleRunId, status: "started", messageSeq: 1 });
    await Promise.all([visibleSend, resume]);

    expect(host.chatSending).toBe(false);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("claims one local command across split panes when the first pane is hidden", async () => {
    executeSlashCommandMock.mockResolvedValue({ content: "Thinking level set." });
    const request = makeRequestMock({ "chat.history": () => idleChatHistory() });
    const client = clientWithRequest(request);
    const item = createQueuedLocalCommand("shared-local-command", "/think high");
    const firstHost = makeChatHost({ client, chatQueue: [item] });
    const secondHost = makeChatHost({ client, chatQueue: [{ ...item }] });
    admitItem(firstHost, item);
    firstHost.sessionKey = "agent:main:inactive";
    secondHost.connectionEpoch = 7;

    await Promise.all([resumeStoredChatOutboxes(firstHost), resumeStoredChatOutboxes(secondHost)]);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(listStoredChatOutboxes(firstHost)).toStrictEqual([]);
  });

  it("keeps an edited row under its original account when another pane changes identity", async () => {
    const request = makeRequestMock({
      "chat.history": () => idleChatHistory(),
      "chat.send": { runId: "edited-across-panes-run", status: "started" },
    });
    const client = clientWithRequest(request);
    const item = queuedMessage("edited-across-panes", "the text being rewritten", {
      sessionKey: "agent:main",
    });
    // Two panes on one session: the composer holding the edit is pane-local, but
    // the outbox and the drain lane are shared, and either pane can own the lane.
    const editing = makeChatHost({ client, chatQueue: [item] });
    const peer = makeChatHost({ client, chatQueue: [] });
    const stopEditing = chatOutboxOwner(editing).subscribe(editing);
    const stopPeer = chatOutboxOwner(peer).subscribe(peer);
    try {
      admitItem(editing, item);
      expect(beginQueuedMessageEdit(editing, item.id)).toBe("started");
      const originalOwner = client.recoveryScope;
      const recovery = vi
        .spyOn(client, "recoveryScope", "get")
        .mockReturnValue("replacement-recovery-scope");
      // The peer wakes first; the editing pane has not handled its reconnect yet.
      await resumeStoredChatOutboxes(peer);

      expect(requestCalls(request, "chat.send")).toHaveLength(0);
      expect(listStoredChatOutboxes(peer)).toEqual([]);
      stopEditing();
      await resumeStoredChatOutboxes(peer);
      expect(requestCalls(request, "chat.send")).toHaveLength(0);
      recovery.mockReturnValue(originalOwner);
      expectItems(listStoredChatOutboxes(peer)[0]?.queue, { id: item.id, text: item.text });
      await resumeStoredChatOutboxes(peer);
      expect(requestCalls(request, "chat.send")).toHaveLength(1);
    } finally {
      stopPeer();
      stopEditing();
    }
  });

  it("returns a confirmed clear to waiting-idle when a run starts during the dialog", async () => {
    const confirmation = createDeferred<boolean>();

    const item = createQueuedLocalCommand("clear-confirmation-race", "/clear");
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
      },
      chatQueue: [item],
      confirmConversationReset: vi.fn(async () => await confirmation.promise),
    });
    const reset = vi.spyOn(host.sessions, "reset");
    admitHostQueueItems(host);

    const draining = resumeStoredChatOutboxes(host);
    await waitForFast(() => expect(host.chatQueue[0]?.sendState).toBe("executing-command"));
    host.chatRunId = "run-started-during-confirmation";
    confirmation.resolve(true);
    await draining;

    expect(host.chatQueue[0]?.sendState).toBe("waiting-idle");
    expect(reset).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "route changed", "Gateway replaced"] as const)(
    "keeps reset confirmation scoped when %s",
    async (outcome) => {
      const confirmation = createDeferred<boolean>();
      const item = createQueuedLocalCommand("queued-reset", "/reset", {
        sessionKey: outcome === "route changed" ? "agent:main:first" : "agent:main",
      });
      const replacementRequest = makeRequestMock({ "chat.send": () => ({ status: "ok" }) });
      const confirmConversationReset = vi.fn(async () => await confirmation.promise);
      const host = makeChatHost({
        requestHandlers: {
          "chat.history": () => idleChatHistory(item.sessionKey),
          ...(outcome === "Gateway replaced" ? { "chat.send": () => ({ status: "ok" }) } : {}),
        },
        chatQueue: [item],
        confirmConversationReset,
        sessionKey: item.sessionKey,
        ...(outcome === "Gateway replaced"
          ? { connectionEpoch: 1, hello: gatewayHelloForMethods(["chat.send"]) }
          : {}),
      });
      admitHostQueueItems(host);

      const draining = resumeStoredChatOutboxes(host);
      await waitForFast(() => expect(confirmConversationReset).toHaveBeenCalledOnce());
      if (outcome === "route changed") {
        host.sessionKey = "agent:main:second";
      } else if (outcome === "Gateway replaced") {
        host.client = clientWithRequest(replacementRequest);
        host.connectionEpoch = 2;
      }
      confirmation.resolve(outcome === "Gateway replaced");
      await draining;

      expectNoRpc(host.request, "chat.send");
      expectNoRpc(replacementRequest, "chat.send");
      if (outcome === "cancelled") {
        expect(listStoredChatOutboxes(host)).toStrictEqual([]);
      } else if (outcome === "route changed") {
        expectItems(listStoredChatOutboxes(host), {
          sessionKey: item.sessionKey,
          queue: [expect.objectContaining({ id: item.id, sendState: "waiting-idle" })],
        });
      } else {
        expect(listStoredChatOutboxes(host)[0]?.queue[0]).toEqual(
          expect.objectContaining({ id: item.id, localCommandName: "reset", sendState: "failed" }),
        );
      }
    },
  );

  it("does not apply a queued reset acknowledgement from a replaced Gateway", async () => {
    const ack = createDeferred<{ runId: string; status: "ok" }>();
    const replacementRequest = makeRequestMock();
    const item = createQueuedLocalCommand("queued-reset-ack-reconnect", "/reset");
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": () => ack.promise,
      },
      chatQueue: [item],
      connectionEpoch: 1,
      confirmConversationReset: vi.fn(async () => true),
      hello: gatewayHelloForMethods(["chat.send"]),
    });
    const refreshSessions = vi.spyOn(host.sessions, "refresh");
    admitHostQueueItems(host);

    const draining = resumeStoredChatOutboxes(host);
    await waitForFast(() => expect(requestCalls(host.request, "chat.send")).toHaveLength(1));

    host.client = clientWithRequest(replacementRequest);
    host.connectionEpoch = 2;
    markQueuedChatSendsWaitingForReconnect(host);
    host.chatMessages = [{ role: "assistant", content: "Replacement Gateway transcript" }];
    const replacementState = {
      chatRunId: "replacement-run",
      chatStream: "Replacement Gateway stream",
      chatSending: true,
      chatSendingScopeKey: storedChatOutboxScopeKey({ sessionKey: item.sessionKey }),
      lastError: "Replacement Gateway error",
      chatError: "Replacement Gateway error",
    };
    Object.assign(host, replacementState);
    const replacementMessages = host.chatMessages;

    ack.resolve({ runId: "old-gateway-reset-run", status: "ok" });
    await draining;

    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toEqual(
      expect.objectContaining({
        id: item.id,
        localCommandName: "reset",
        sendState: "waiting-reconnect",
      }),
    );
    expect(host.chatMessages).toBe(replacementMessages);
    expect(host).toMatchObject(replacementState);
    expect(host.refreshSessionsAfterChat).toEqual(new Map());
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("reconciles a duplicate ACK into its already loaded collected transcript row", async () => {
    const sessionKey = "agent:main:collected";
    const sessionId = "collected-physical-session";
    const source = queuedMessage("collected-source", "The accepted source", {
      sendRunId: "collected-source-run",
      sendAttempts: 1,
      sendState: "waiting-reconnect",
      queueMode: "collect",
      sessionKey,
      sessionId,
    });
    const aggregate = {
      role: "user",
      content: "Collected inputs",
      __openclaw: {
        id: "aggregate",
        seq: 1,
        idempotencyKey: "followup-collect:session:batch",
      },
    };
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      chatHistoryPagination: { hasMore: false, completeSnapshot: true },
      chatMessages: [aggregate],
      chatQueue: [source],
      requestHandlers: {
        "chat.send": { runId: source.sendRunId, status: "ok" },
        "chat.history": {
          sessionId,
          messages: [aggregate],
          pendingInputs: { items: [], total: 0 },
          inputReceipts: [
            { runId: source.sendRunId, state: "consumed", consumedByEventId: "aggregate" },
          ],
          sessionInfo: row(sessionKey, {
            sessionId,
            hasActiveRun: false,
            status: "done",
            lastRunId: "aggregate-run",
          }),
        },
      },
    });
    admitHostQueueItems(host);

    await resumeStoredChatOutboxes(host);

    await waitForFast(() => {
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(host.chatQueue).toEqual([]);
      expect(host.chatMessages).toEqual([aggregate]);
    });
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    expect(
      findRequestPayload(host.request, "chat.history", "duplicate input hydration"),
    ).toMatchObject({ inputRunIds: [source.sendRunId] });
  });

  it("routes an unscoped global terminal to the default agent outbox", async () => {
    const runId = "shared-global-terminal-run";
    const selected = queuedMessage("selected-global-terminal", "keep the selected agent prompt", {
      sendAttempts: 1,
      sendRunId: runId,
      sendState: "sending" as const,
      sessionKey: "global",
      agentId: "work",
    });
    const defaultAgent = {
      ...selected,
      id: "default-global-terminal",
      text: "retire the default agent prompt",
      agentId: "main",
    };
    let consumed = false;
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": (params: unknown) => ({
          messages: [],
          inputReceipts:
            consumed && requireRecord(params, "global terminal receipt scope").agentId === "main"
              ? [{ runId, state: "consumed", consumedByEventId: "default-user" }]
              : [],
        }),
      },
      assistantAgentId: selected.agentId,
      chatMessagesBySession: new Map(),
      chatQueue: [selected],
      chatRunId: runId,
      sessionKey: "global",
    });
    Object.assign(host, {
      connectionEpoch: 1,
      pendingSessionMessageReloadSessionKey: null,
    });
    admitItem(host, selected, selected.sessionKey, selected.agentId);
    admitItem(host, defaultAgent, defaultAgent.sessionKey, defaultAgent.agentId);

    handlePageGatewayEvent(asChatPageHost(host), {
      event: "chat",
      payload: {
        state: "final",
        runId,
        sessionKey: "global",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "default agent reply" }],
        },
      },
    } as Parameters<typeof handlePageGatewayEvent>[1]);

    expect(host.chatMessages).toStrictEqual([]);
    expectItems(host.chatQueue, { id: selected.id });
    expect(
      listStoredChatOutboxes(host)
        .flatMap((outbox) => outbox.queue)
        .map((item) => item.id),
    ).toEqual(expect.arrayContaining([selected.id, defaultAgent.id]));

    consumed = true;
    const mainPane = makeChatHost({
      client: host.client!,
      assistantAgentId: "main",
      sessionKey: "global",
    });
    chatOutboxOwner(mainPane).syncHost(mainPane);
    await loadChatHistory(mainPane);

    expectItems(listStoredChatOutboxes(host), {
      agentId: selected.agentId,
      queue: [expect.objectContaining({ id: selected.id })],
      sessionKey: selected.sessionKey,
    });
  });

  it("preserves terminal user-turn ordering when an inactive split pane handles the event first", async () => {
    const item = queuedMessage("split-terminal-delivery", "prompt from the visible pane", {
      sendAttempts: 1,
      sendRunId: "split-terminal-delivery-run",
      sendState: "sending" as const,
      sessionKey: "agent:main:visible",
    });
    let consumed = false;
    const client = clientWithRequest(
      makeRequestMock({
        "chat.history": () => ({
          messages: [],
          inputReceipts: consumed
            ? [{ runId: item.sendRunId, state: "consumed", consumedByEventId: "ordered-user" }]
            : [],
        }),
      }),
    );
    const visible = makeChatHost({
      chatQueue: [item],
      chatRunId: item.sendRunId,
      client,
      sessionKey: item.sessionKey,
    });
    const inactive = makeChatHost({
      chatQueue: [],
      client,
      chatSubmissions: visible.chatSubmissions,
      sessionKey: "agent:main:inactive",
    });
    for (const host of [visible, inactive]) {
      Object.assign(host, {
        chatMessagesBySession: new Map(),
        connectionEpoch: 1,
        pendingSessionMessageReloadSessionKey: null,
      });
    }
    cacheEmptyChatSnapshot(inactive, item.sessionKey);
    admitItem(visible, item, item.sessionKey);
    const event = {
      event: "chat",
      payload: {
        state: "final",
        runId: item.sendRunId,
        sessionKey: item.sessionKey,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "terminal reply" }],
          timestamp: 2,
        },
      },
    } as Parameters<typeof handlePageGatewayEvent>[1];

    handlePageGatewayEvent(asChatPageHost(inactive), event);
    handlePageGatewayEvent(asChatPageHost(visible), event);
    handlePageGatewayEvent(asChatPageHost(inactive), event);

    expect(
      visible.chatMessages.map((message) => requireRecord(message, "terminal transcript").role),
    ).toEqual(["user", "assistant"]);
    const inactiveCached = readChatMessagesFromCache(
      inactive.chatMessagesBySession ?? new Map(),
      inactive,
      { sessionKey: item.sessionKey },
    );
    expect(
      inactiveCached
        .slice(0, 2)
        .map((message) => requireRecord(message, "inactive terminal transcript").role),
    ).toEqual(["user", "assistant"]);
    expect(
      inactiveCached.filter((message) => {
        const marker = requireRecord(message, "cached terminal transcript")["__openclaw"];
        return (
          marker &&
          typeof marker === "object" &&
          requireRecord(marker, "cached terminal marker").idempotencyKey ===
            `${item.sendRunId}:user`
        );
      }),
    ).toHaveLength(1);
    expect(listStoredChatOutboxes(visible)[0]?.queue[0]?.id).toBe(item.id);
    consumed = true;
    await loadChatHistory(visible);
    expect(listStoredChatOutboxes(visible)).toStrictEqual([]);
  });

  it("does not execute a stored local command when its durable claim fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    executeSlashCommandMock.mockResolvedValue({ content: "Thinking level set." });

    const item = createQueuedLocalCommand("local-command-claim-failure", "/think high");
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
      },
      chatQueue: [item],
    });
    admitItem(host, item);
    let failedClaims = 0;
    rejectStorageWritesWhen((_key, value) => {
      if (value.includes(item.id) && value.includes('"sendState":"failed"') && failedClaims === 0) {
        failedClaims += 1;
        return true;
      }
      return false;
    }, storage);

    await resumeStoredChatOutboxes(host);

    expect(failedClaims).toBe(1);
    expect(executeSlashCommandMock).not.toHaveBeenCalled();
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.id).toBe(item.id);
  });

  it("holds a legacy unconfirmed local command until explicit retry", async () => {
    executeSlashCommandMock.mockResolvedValue({ content: "Thinking level set." });
    const host = makeChatHost({
      requestHandlers: { "chat.history": () => idleChatHistory() },
    });
    const item = createQueuedLocalCommand("legacy-unconfirmed-command", "/think high");
    const target = storageTargetForComposer(host);
    const scopeKey = storedChatOutboxScopeKey(resolveUiConversationIdentity(host, host.sessionKey));
    sessionStorage.setItem(
      target.key,
      JSON.stringify({
        version: 4,
        gatewayOwner: target.gatewayOwner,
        recovery: {},
        sessions: {
          [scopeKey]: {
            updatedAt: 1,
            queue: [
              {
                ...item,
                storageScope: outboxPayloadStore.outboxStorageScope(host),
                sendState: "unconfirmed",
                sendAttempts: 1,
              },
            ],
          },
        },
      }),
    );

    await resumeStoredChatOutboxes(host);

    expect(executeSlashCommandMock).not.toHaveBeenCalled();
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
      id: item.id,
      sendState: "failed",
      sendError: "Command was interrupted. Review the conversation before retrying.",
    });

    await retryQueuedChatMessage(host, item.id);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(listStoredChatOutboxes(host)).toEqual([]);
  });

  it("keeps a failed stored local command retryable after a transient disconnect", async () => {
    const events: string[] = [];
    executeSlashCommandMock
      .mockImplementationOnce(async () => {
        events.push("think-failed");
        return {
          content: "Failed to set thinking level: gateway closed during command",
          failed: true,
        };
      })
      .mockImplementationOnce(async () => {
        events.push("think-retried");
        return { content: "Thinking level set." };
      });

    const item = createQueuedLocalCommand("retry-local-command-after-disconnect", "/think high");
    const following = queuedMessage("prompt-after-retried-command", "use the new thinking level", {
      createdAt: 2,
      sessionKey: "agent:main",
    });
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": (params: unknown) => {
          events.push("following-prompt");
          const payload = requireRecord(params, "following prompt payload");
          return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
        },
      },
      chatQueue: [item, following],
    });
    admitItem(host, item);
    admitItem(host, following);

    await resumeStoredChatOutboxes(host);

    expect(host.chatQueue[0]).toMatchObject({
      id: item.id,
      sendState: "failed",
    });
    expect(listStoredChatOutboxes(host)[0]?.queue.map((entry) => entry.id)).toEqual([
      item.id,
      following.id,
    ]);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendState).toBe("failed");

    await resumeStoredChatOutboxes(host);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["think-failed"]);

    await retryQueuedChatMessage(host, item.id);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["think-failed", "think-retried", "following-prompt"]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("fails closed when history refresh rejects after an uncertain clear", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": () => {
          throw new Error("post-commit lifecycle failed");
        },
        "chat.history": () => {
          throw new Error("history unavailable");
        },
      },
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "possibly cleared" }],
    });

    await handleSendChat(host);

    expect(host.chatMessages).toEqual([]);
    expect(host.lastError).toContain("clear request may have completed");
    expect(host.lastError).toContain("could not be refreshed");
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("keeps the uncertain clear as a durable barrier when parking its successor fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    let resetIssued = false;
    let failedBarrierWrites = 0;

    const clear = createQueuedLocalCommand("uncertain-clear-storage-barrier", "/clear");
    const successor = queuedMessage("successor-storage-barrier", "must stay parked", {
      createdAt: 2,
      sessionKey: "agent:main",
    });
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": () => {
          resetIssued = true;
          throw new Error("post-commit lifecycle failed");
        },
        "chat.history": idleChatHistory(),
      },
      chatQueue: [clear, successor],
    });
    admitItem(host, clear);
    admitItem(host, successor);
    rejectStorageWritesWhen((_key, value) => {
      const successorIndex = value.indexOf(`"id":"${successor.id}"`);
      const successorRecord =
        successorIndex >= 0 ? value.slice(successorIndex, successorIndex + 500) : "";
      if (
        resetIssued &&
        failedBarrierWrites === 0 &&
        successorRecord.includes('"sendState":"held"')
      ) {
        failedBarrierWrites += 1;
        return true;
      }
      return false;
    }, storage);

    await resumeStoredChatOutboxes(host);

    expect(failedBarrierWrites).toBe(1);
    expect(requestCalls(host.request, "sessions.reset")).toHaveLength(1);
    expectItems(
      listStoredChatOutboxes(host)[0]?.queue,
      { id: clear.id, sendState: "failed" },
      { id: successor.id },
    );

    await resumeStoredChatOutboxes(host);

    expect(requestCalls(host.request, "sessions.reset")).toHaveLength(1);
  });

  it("keeps later inputs behind an uncertain clear's successor until explicit review", async () => {
    const clear = createQueuedLocalCommand("uncertain-clear-review", "/clear");
    const successor = queuedMessage("review-after-clear", "Review this input first", {
      createdAt: 2,
      sessionKey: "agent:main",
    });
    const later = queuedMessage("later-after-clear", "Then send this input", {
      createdAt: 3,
      sessionKey: "agent:main",
    });
    const sends: string[] = [];
    const host = makeChatHost({
      chatQueue: [clear, successor, later],
      requestHandlers: {
        "sessions.reset": () => {
          throw new Error("post-commit lifecycle failed");
        },
        "chat.history": idleChatHistory(),
        "chat.send": (params: unknown) => {
          sends.push(String(requireRecord(params, "reviewed clear successor").message));
          return sendAck(params, "reviewed clear successor", "ok", 1);
        },
      },
    });
    admitHostQueueItems(host);

    await resumeStoredChatOutboxes(host);
    expectItems(
      listStoredChatOutboxes(host)[0]?.queue,
      { id: successor.id, sendState: "held" },
      { id: later.id },
    );
    await resumeStoredChatOutboxes(host);
    expect(sends).toEqual([]);
    expect(requestCalls(host.request, "sessions.reset")).toHaveLength(1);

    await retryQueuedChatMessage(host, successor.id);
    await waitForFast(() => expect(sends).toEqual([successor.text, later.text]));
    expect(listStoredChatOutboxes(host)).toEqual([]);
  });

  it("does not resurrect a send deleted by another pane before its ACK", async () => {
    const ack = createDeferred<unknown>();
    const request = makeRequestMock({
      "chat.send": () => ack.promise,
    });
    const client = clientWithRequest(request);
    const sendingHost = makeChatHost({ client });
    const staleHost = makeChatHost({ client });
    const send = handleSendChat(sendingHost, "delete before ack");
    await waitForFast(() => expect(sendingHost.chatQueue[0]?.sendState).toBe("sending"));
    const { id = "missing", sendRunId: runId } = sendingHost.chatQueue[0] ?? {};
    staleHost.chatQueue =
      loadChatComposerState(staleHost, staleHost.sessionKey).snapshot?.queue ?? [];

    removeQueuedMessage(staleHost, id);
    ack.resolve({ runId, status: "started" });
    await send;

    expect(listStoredChatOutboxes(sendingHost)).toStrictEqual([]);
    expect(requestCalls(request, "chat.send")).toHaveLength(1);
  });

  it("keeps an acknowledged send pending when durable retirement fails", async () => {
    const storage = createStorageMock();
    const write = storage.setItem.bind(storage);
    const remove = storage.removeItem.bind(storage);
    let rejectWrites = false;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (rejectWrites) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    vi.spyOn(storage, "removeItem").mockImplementation((key) => {
      if (rejectWrites) {
        throw new DOMException("storage blocked", "SecurityError");
      }
      remove(key);
    });
    vi.stubGlobal("sessionStorage", storage);

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          rejectWrites = true;
          const payload = requireRecord(params, "acknowledged durable send payload");
          return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
        },
      },
      chatMessage: "keep until durable retirement succeeds",
    });

    await handleSendChat(host);

    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    expectItems(host.chatQueue, {
      sendAttempts: 1,
      sendState: "sending",
      text: "keep until durable retirement succeeds",
    });
    expect(host.lastError).toBe(storageError);
    expect(host.applySettings).not.toHaveBeenCalled();
  });

  it("retains an ambiguous pre-ack send id when browser storage rejects recovery", async () => {
    let rejectWrites = false;
    const setItemSpy = rejectStorageWritesWhen(() => rejectWrites);
    let attemptedRunId: unknown;
    let sendAttempts = 0;

    const replyTarget = {
      messageId: "reply-before-ack",
      text: "quoted body",
      senderLabel: "User",
    };
    const host = makeChatHost({
      currentSessionId: "ambiguous-session",
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat send payload");
          attemptedRunId ??= payload.idempotencyKey;
          sendAttempts += 1;
          if (sendAttempts === 1) {
            rejectWrites = true;
            throw new Error("gateway closed (1006): network lost");
          }
          return { runId: payload.idempotencyKey, status: "started" };
        },
        "chat.history": idleChatHistory(),
      },
      chatMessage: "retry after reconnect",
      chatReplyTarget: replyTarget,
    });

    await handleSendChat(host);

    expect(attemptedRunId).toEqual(expect.stringMatching(uuidPattern));
    expect(host.chatMessage).toBe("");
    expectItems(host.chatQueue, {
      sendAttempts: 1,
      text: "> **User:** quoted body\n\nretry after reconnect",
      sendRunId: attemptedRunId,
      sendState: "waiting-reconnect",
    });
    expect(host.chatReplyTarget).toBeNull();
    expect(host.lastError).toBe(storageError);

    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);

    rejectWrites = false;
    setItemSpy.mockRestore();
    await retryQueuedChatMessage(host, host.chatQueue[0]?.id ?? "missing");

    const sendPayloads = requestCalls(host.request, "chat.send").map((call) =>
      requireRecord(call[1], "manual retry payload"),
    );
    expect(sendPayloads).toHaveLength(2);
    expect(sendPayloads[1]?.idempotencyKey).toBe(attemptedRunId);
    await waitForFast(() => expect(host.chatQueue).toEqual([]));
  });

  it.each([
    { caller: "wrong queue", reason: "missing" },
    { caller: "wrong source tab", reason: "missing" },
    { caller: "wrong reference recovery scope", reason: "missing" },
    { caller: "Incognito", reason: "unavailable" },
    { caller: "unobserved owner", reason: "unavailable" },
    { caller: "incomplete attachment metadata", reason: "missing" },
    { caller: "wrong attachment MIME type", reason: "missing" },
    { caller: "wrong attachment filename", reason: "missing" },
    { caller: "wrong attachment size", reason: "missing" },
    { caller: "matching owner", reason: null },
    { caller: "remembered offline owner", reason: null },
  ] as const)(
    "validates a concurrent payload caller independently ($caller)",
    async ({ caller, reason }) => {
      const { attachments, dataUrls } = createDeliveryAttachmentBatch();
      const request = makeRequestMock();
      const client = clientWithRequest(request);
      const source = makeChatHost({
        client,
        connected: false,
        chatMessage: "one immutable attachment input",
        chatAttachments: attachments,
      });
      const write = vi.spyOn(outboxPayloadStore, "writeOutboxPayload");
      await handleSendChat(source);
      const original = expectDefined(
        listStoredChatOutboxes(source)[0]?.queue[0],
        "admitted shared input",
      );
      const reference = expectDefined(original.attachmentPayload, "shared input reference");
      const [payloadOwner] = expectDefined(write.mock.calls[0], "actual shared payload owner");
      const other = makeChatHost({ client, connected: false });
      const candidate: ChatQueueItem = {
        ...original,
        attachmentPayload: { ...reference },
        attachments: original.attachments?.map((attachment) => ({ ...attachment })),
      };
      switch (caller) {
        case "wrong queue":
          candidate.id = `${original.id}-other`;
          break;
        case "wrong source tab":
          candidate.attachmentPayload = { ...reference, tabId: "other-source-tab" };
          break;
        case "wrong reference recovery scope":
          candidate.attachmentPayload = { ...reference, recoveryScope: "other-reference-owner" };
          break;
        case "Incognito":
          other.selectedChatSessionIncognito = true;
          break;
        case "unobserved owner":
          other.client = clientWithRequest(request);
          vi.spyOn(other.client, "recoveryScopeReady", "get").mockReturnValue(false);
          break;
        case "incomplete attachment metadata":
          candidate.attachments = candidate.attachments?.slice(0, 1);
          break;
        case "wrong attachment MIME type":
          Object.assign(expectDefined(candidate.attachments?.[0], "first attachment metadata"), {
            mimeType: "text/plain",
          });
          break;
        case "wrong attachment filename":
          Object.assign(expectDefined(candidate.attachments?.[0], "first attachment metadata"), {
            fileName: "other-file.png",
          });
          break;
        case "wrong attachment size":
          Object.assign(expectDefined(candidate.attachments?.[0], "first attachment metadata"), {
            sizeBytes: 1,
          });
          break;
        case "remembered offline owner":
          vi.spyOn(client, "recoveryScopeReady", "get").mockReturnValue(false);
          break;
        case "matching owner":
          break;
      }
      const expected = reason ? { status: "failed", reason } : { status: "ready" };
      expect(await prepareOutboxPayload(other, candidate)).toMatchObject(expected);

      const readPayload = outboxPayloadStore.readOutboxPayload;
      const pending: Array<ReturnType<typeof prepareOutboxPayload>> = [];
      const { read, readStarted, releaseRead } = holdNextPayloadRead();
      try {
        const first = prepareOutboxPayload(source, original);
        pending.push(first);
        await readStarted.promise;
        const second = prepareOutboxPayload(other, candidate);
        pending.push(second);
        releaseRead.resolve();
        const [valid, joined] = await Promise.all([first, second]);
        expect(valid).toMatchObject({ status: "ready", update: { attachmentPayload: reference } });
        expect(
          valid.status === "ready" ? valid.update.attachments?.map(getChatAttachmentDataUrl) : [],
        ).toEqual(dataUrls);
        const stored = await readPayload(payloadOwner, reference);
        const retained = expectDefined(
          stored.status === "ready" ? stored.value : undefined,
          "retained shared bytes",
        );
        expect(
          await Promise.all(
            retained.map(async (attachment) =>
              Buffer.from(await attachment.blob.arrayBuffer()).toString("base64"),
            ),
          ),
        ).toEqual(dataUrls.map((url) => url.split(",")[1]));
        expect(requestCalls(request, "chat.send")).toHaveLength(0);
        expect(joined).toMatchObject(expected);
        if (!reason) {
          expect(read).toHaveBeenCalledTimes(1);
          expect(
            joined.status === "ready"
              ? joined.update.attachments?.map(getChatAttachmentDataUrl)
              : [],
          ).toEqual(dataUrls);
        }
      } finally {
        releaseRead.resolve();
        await Promise.allSettled(pending);
      }
    },
  );

  it("preserves inline bytes across a capacity migration failure and reload before retry", async () => {
    const reason = "capacity";
    const { attachments, dataUrls } = createDeliveryAttachmentBatch();
    const request = makeRequestMock({
      "chat.history": () => idleChatHistory(),
      "chat.send": (params: unknown) => sendAck(params, "migrated attachment send", "started"),
    });
    const source = makeChatHost({ client: clientWithRequest(request) });
    const item: ChatQueueItem = queuedMessage("inline-payload-retry", "migrate all attachments", {
      attachments,
      sendRunId: "inline-payload-run",
      sendAttempts: 0,
      sendState: "waiting-reconnect",
      sessionKey: source.sessionKey,
    });
    const stopSource = chatOutboxOwner(source).subscribe(source);
    let stopRecovered = () => {};
    try {
      admitItem(source, item, source.sessionKey, item.agentId);
      vi.spyOn(outboxPayloadStore, "writeOutboxPayload").mockResolvedValueOnce({
        status: "failed",
        reason,
      });
      await resumeStoredChatOutboxes(source);
      expect(requestCalls(request, "chat.send")).toHaveLength(0);
      stopSource();
      releaseChatAttachmentPayloads(attachments);
      const readback = expectDefined(
        loadChatComposerState(source, source.sessionKey).snapshot,
        "inline failed migration readback",
      );
      expect(readback.queue[0]?.attachmentStorageError).toBe(reason);
      expect(readback.queue[0]?.attachmentPayload).toBeUndefined();
      expect(readback.queue[0]?.attachments?.map((attachment) => attachment.dataUrl)).toEqual(
        dataUrls,
      );
      const recovered = makeChatHost({
        client: clientWithRequest(request),
        chatQueue: readback.queue,
      });
      stopRecovered = chatOutboxOwner(recovered).subscribe(recovered);
      await retryQueuedChatMessage(recovered, item.id);
      await waitForFast(() => expect(recovered.chatQueue).toEqual([]));
      expect(listStoredChatOutboxes(recovered)).toEqual([]);
      const sends = requestCalls(request, "chat.send");
      expect(sends).toHaveLength(1);
      expect(requireRecord(sends[0]?.[1], "migration retry payload").attachments).toEqual(
        wireAttachments(attachments, dataUrls),
      );
    } finally {
      stopRecovered();
      stopSource();
    }
  });

  it.each(["accepted", "interrupted"] as const)(
    "resumes a copied attachment after shared adoption without repeating its %s send",
    async (outcome) => {
      const id = "copied-attachment";
      const body = "Complete copied bytes";
      const attachment = {
        blob: new Blob([body], { type: "text/plain" }),
        mimeType: "text/plain",
        fileName: "copied.txt",
      };
      const sourceOwner = {
        tabId: "original-document",
        gatewayOwner: "default",
        recoveryScope: "test-recovery-scope",
        queueId: id,
      };
      const source = await outboxPayloadStore.writeOutboxPayload(sourceOwner, [attachment]);
      expect(source.status).toBe("ready");
      if (source.status !== "ready") {
        throw new Error("Expected source attachment bytes");
      }
      const send = createDeferred<unknown>();
      const host = makeChatHost({
        currentSessionId: "copied-session",
        requestHandlers: { "chat.send": () => send.promise },
      });
      const { readStarted, releaseRead } = holdNextPayloadRead();
      const preparation = vi.spyOn(await import("./outbox-payloads.ts"), "prepareOutboxPayload");
      admitItem(
        host,
        queuedMessage(id, "Copied pending input", {
          sessionId: "copied-session",
          sendRunId: "original-copy-key",
          sendAttempts: 1,
          sendState: "waiting-reconnect",
          attachmentPayload: source.value,
          attachments: [
            { id: "copied-file", mimeType: attachment.mimeType, fileName: attachment.fileName },
          ],
        }),
      );
      const stop = chatOutboxOwner(host).subscribe(host);
      const drain = resumeStoredChatOutboxes(host);
      try {
        await readStarted.promise;
        await waitForFast(() => expect(preparation.mock.calls.length).toBeGreaterThanOrEqual(2));
        releaseRead.resolve();
        await waitForFast(() => expect(requestCalls(host.request, "chat.send")).toHaveLength(1));
        const current = expectDefined(host.chatQueue[0], "adopted pending input");
        expect(current.attachmentPayload?.key).not.toBe(source.value.key);
        const sent = findRequestPayload(host.request, "chat.send", "copied attachment replay");
        expect(sent).toMatchObject({
          sessionId: "copied-session",
          idempotencyKey: "original-copy-key",
          attachments: [
            { type: "file", mimeType: "text/plain", fileName: "copied.txt", content: btoa(body) },
          ],
        });
        if (outcome === "interrupted") {
          // Another completed adoption must not turn a lost ACK into a tight retry.
          const copy = await outboxPayloadStore.writeOutboxPayload(
            {
              ...sourceOwner,
              tabId: await outboxPayloadStore.outboxPayloadTab(),
            },
            [attachment],
          );
          expect(copy.status).toBe("ready");
          if (copy.status !== "ready") {
            throw new Error("Expected replacement attachment bytes");
          }
          updateQueuedMessage(host, id, (item) => ({ ...item, attachmentPayload: copy.value }));
          send.reject(new Error("gateway disconnected after send"));
        } else {
          send.resolve({ runId: "original-copy-key", status: "ok" });
        }
        await drain;
        expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
        if (outcome === "interrupted") {
          expect(host.chatQueue[0]).toMatchObject({
            sendRunId: "original-copy-key",
            sendAttempts: 2,
            sendState: "waiting-reconnect",
          });
        } else {
          expect(host.chatQueue).toEqual([]);
        }
      } finally {
        releaseRead.resolve();
        send.resolve({ runId: "original-copy-key", status: "ok" });
        await drain;
        stop();
      }
    },
  );

  it.each(["move", "remove", "edit"] as const)(
    "honors a queue %s while attachment hydration is pending",
    async (action) => {
      const { attachments, dataUrls } = createDeliveryAttachmentBatch();
      const request = makeRequestMock({
        "chat.history": () => idleChatHistory(),
        "chat.send": (params: unknown) => sendAck(params, "reordered attachment send", "ok", 1),
      });
      sessionStorage.setItem("openclaw.control.outboxTab.v1", "test-outbox-tab");
      const host = makeChatHost({
        client: clientWithRequest(request),
        connected: false,
        chatMessage: "attachment A",
        chatAttachments: attachments,
      });
      const unsubscribe = chatOutboxOwner(host).subscribe(host);
      const readStarted = createDeferred();
      const releaseRead = createDeferred();
      let drain: Promise<void> | undefined;
      try {
        await handleSendChat(host);
        host.chatMessage = "text B";
        await handleSendChat(host);
        const [first, second] = host.chatQueue;
        expect(first?.attachmentPayload).toBeDefined();
        expect(second?.text).toBe("text B");
        holdNextPayloadRead(readStarted, releaseRead);
        host.connected = true;
        drain = resumeStoredChatOutboxes(host);
        await readStarted.promise;
        if (action === "move") {
          expect(moveQueuedChatMessage(host, second!.id, first!.id)).toBe("moved");
        } else if (action === "remove") {
          expect(removeQueuedMessage(host, first!.id)).toBe("removed");
        } else {
          expect(beginQueuedMessageEdit(host, first!.id)).toBe("started");
          updateQueuedMessageEdit(host, "unfinished correction");
        }
        const expected =
          action === "move"
            ? ["text B", "attachment A"]
            : action === "remove"
              ? ["text B"]
              : ["attachment A", "text B"];
        expect(listStoredChatOutboxes(host)[0]?.queue.map((item) => item.text)).toEqual(expected);
        expect(requestCalls(request, "chat.send")).toHaveLength(0);
        releaseRead.resolve();
        await drain;
        if (action === "edit") {
          expect(requestCalls(request, "chat.send")).toHaveLength(0);
          expect(host.chatQueuedEdit?.draftText).toBe("unfinished correction");
          expect(cancelQueuedMessageEdit(host)).toBe(true);
          await resumeStoredChatOutboxes(host);
        }
        const sends = requestCalls(request, "chat.send").map(([, params]) =>
          requireRecord(params, "reordered delivery"),
        );
        expect(sends.map((params) => params.message)).toEqual(expected);
        if (action !== "remove") {
          expect(sends.find((params) => params.message === "attachment A")?.attachments).toEqual(
            wireAttachments(attachments, dataUrls),
          );
        }
        expect(listStoredChatOutboxes(host)).toEqual([]);
      } finally {
        releaseRead.resolve();
        await drain;
        unsubscribe();
      }
    },
  );

  it.each([
    { reason: "unavailable", action: "retry" },
    { reason: "missing", action: "retry" },
    { reason: "unavailable", action: "discard" },
    { reason: "missing", action: "discard" },
  ] as const)(
    "keeps an uncertain send id and FIFO across $reason payload retries until $action",
    async ({ reason, action }) => {
      const { attachments, dataUrls } = createDeliveryAttachmentBatch();
      let wireAttempts = 0;
      const request = makeRequestMock({
        "chat.history": () => idleChatHistory(),
        "chat.send": (params: unknown) => {
          wireAttempts += 1;
          if (wireAttempts === 1) {
            throw new Error("gateway disconnected");
          }
          return {
            runId: requireRecord(params, "uncertain attachment retry").idempotencyKey,
            status: "started",
          };
        },
      });
      const source = makeChatHost({
        client: clientWithRequest(request),
        currentSessionId: "attachment-session",
        chatMessage: "retain this uncertain attachment batch",
        chatAttachments: attachments,
      });
      const stopSource = chatOutboxOwner(source).subscribe(source);
      let stopRecovered = () => {};
      try {
        await handleSendChat(source);
        const original = expectDefined(
          loadChatComposerState(source, source.sessionKey).snapshot?.queue[0],
          "uncertain attachment send",
        );
        expect(original.sendAttempts).toBe(1);
        expect(source.chatRunId).toBeNull();
        source.connected = false;
        await handleSendChat(source, "later queued input");
        const successor = expectDefined(source.chatQueue[1], "queued successor");
        stopSource();
        reloadChatDocumentStorage(attachments);
        const host = makeChatHost({
          client: clientWithRequest(request),
          currentSessionId: "attachment-session",
        });
        const read = vi
          .spyOn(outboxPayloadStore, "readOutboxPayload")
          .mockResolvedValue({ status: "failed", reason });
        stopRecovered = chatOutboxOwner(host).subscribe(host);
        expect(host.chatQueue[0]?.attachments?.map(getChatAttachmentDataUrl)).toEqual([null, null]);
        await waitForFast(() =>
          expect(loadChatComposerState(host, host.sessionKey).snapshot?.queue[0]).toMatchObject({
            attachmentStorageError: reason,
            sendState: "held",
            sendRunId: original.sendRunId,
          }),
        );
        await resumeStoredChatOutboxes(host);
        expect(wireAttempts).toBe(1);
        expect(host.chatQueue).toHaveLength(2);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await retryQueuedChatMessage(host, original.id);
          await waitForFast(() =>
            expect(loadChatComposerState(host, host.sessionKey).snapshot?.queue[0]).toMatchObject({
              attachmentStorageError: reason,
              sendState: "held",
              sendRunId: original.sendRunId,
              sendAttempts: 1,
            }),
          );
          expect(wireAttempts).toBe(1);
        }
        read.mockRestore();
        if (action === "retry") {
          await retryQueuedChatMessage(host, original.id);
          expectItems(host.chatQueue, { id: successor.id, sendAttempts: 0 });
          const resent = requireRecord(
            requestCalls(request, "chat.send")[1]?.[1],
            "same-id recovered attachment payload",
          );
          expect(resent.idempotencyKey).toBe(original.sendRunId);
          expect(resent.attachments).toEqual(wireAttachments(attachments, dataUrls));
          handleChatGatewayEvent(host, {
            sessionKey: host.sessionKey,
            runId: original.sendRunId!,
            state: "final",
          });
        } else {
          expect(removeQueuedMessage(host, original.id)).toBe("removed");
        }
        await resumeStoredChatOutboxes(host);
        await waitForFast(() => expect(host.chatQueue).toEqual([]));
        const sends = requestCalls(request, "chat.send");
        expect(sends.map(([, params]) => requireRecord(params, "FIFO delivery").message)).toEqual([
          original.text,
          ...(action === "retry" ? [original.text] : []),
          "later queued input",
        ]);
        expect(sends.at(-1)?.[1]).toMatchObject({ idempotencyKey: successor.sendRunId });
      } finally {
        stopRecovered();
        stopSource();
      }
    },
  );

  it.each([
    ["waiting-reconnect", "agent:main:main"],
    ["waiting-reconnect", "main"],
    ["waiting-reconnect", "global"],
    ["failed", "agent:main"],
  ] as const)(
    "retries a %s volatile send from %s with the appropriate run identity",
    async (state, sessionKey) => {
      const message =
        state === "failed" ? "retry after definite failure" : "retry the oversized turn";
      const error = state === "failed" ? "send rejected" : "gateway closed (1006): network lost";
      installQuotaExceededStorage();
      const firstAttempt = createDeferred<unknown>();
      const runIds: unknown[] = [];
      const targets: unknown[] = [];

      const host = makeChatHost({
        sessionKey,
        ...(state === "waiting-reconnect"
          ? {
              agentsList: { defaultId: "main", mainKey: "workspace", scope: "per-sender" as const },
            }
          : {}),
        requestHandlers: {
          "chat.send": (params: unknown) => {
            const payload = requireRecord(params, "volatile retry payload");
            runIds.push(payload.idempotencyKey);
            targets.push(payload.sessionKey);
            if (runIds.length === 1) {
              return firstAttempt.promise;
            }
            return { runId: payload.idempotencyKey, status: "started" };
          },
        },
        chatMessage: message,
      });

      const sending = handleSendChat(host);
      await waitForFast(() => expect(host.request).toHaveBeenCalledOnce());
      if (state === "failed") {
        host.chatMessage = "newer composer input";
      }
      firstAttempt.reject(new Error(error));
      await sending;

      const itemId = host.chatQueue[0]?.id ?? "missing-volatile-retry";
      const originalRunId = host.chatQueue[0]?.sendRunId;
      expectItems(host.chatQueue, { sendRunId: originalRunId, sendState: state });

      if (state === "waiting-reconnect") {
        host.connected = false;
        await resumeStoredChatOutboxes(host);
        expect(runIds).toEqual([originalRunId]);
        host.connected = true;
        host.connectionEpoch += 1;
        await resumeStoredChatOutboxes(host);
      } else {
        expect(host.chatMessage).toBe("newer composer input");
      }

      if (state === "failed") {
        await retryQueuedChatMessage(host, itemId);
      }

      expect(runIds).toHaveLength(2);
      expect(runIds[0]).toBe(originalRunId);
      expect(runIds[1] === originalRunId).toBe(state === "waiting-reconnect");
      expect(host.chatQueue).toStrictEqual([]);
      if (state === "waiting-reconnect") {
        expect(targets).toEqual(
          Array(2).fill(sessionKey === "global" ? "global" : "agent:main:workspace"),
        );
        expect(host.chatRunId).toBe(originalRunId);
        expect(
          host.chatMessages.map((entry) => requireRecord(entry, "retried transcript").role),
        ).toEqual(["user"]);
      } else {
        expect(host.chatMessage).toBe("newer composer input");
      }
    },
  );

  it("keeps a pre-ack send queued when newer composer input blocks restoration", async () => {
    let rejectWrites = false;
    rejectStorageWritesWhen(() => rejectWrites);
    const sent = createDeferred<unknown>();

    const host = makeChatHost({
      currentSessionId: "pre-ack-session",
      requestHandlers: {
        "chat.send": () => {
          rejectWrites = true;
          return sent.promise;
        },
      },
      chatMessage: "original send",
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatMessage = "new draft";
    sent.reject(new Error("gateway closed (1006): network lost"));
    await send;

    expect(host.chatMessage).toBe("new draft");
    expectItems(host.chatQueue, {
      text: "original send",
      sendAttempts: 1,
      sendState: "waiting-reconnect",
    });
    expect(host.lastError).toBe(storageError);
  });

  it.each(["text", "file", "offline command", "cold file"] as const)(
    "retains rejected %s input when durable storage is unavailable",
    async (kind) => {
      installQuotaExceededStorage();
      const offline = kind === "offline command" || kind === "cold file";
      const attachment =
        kind === "file"
          ? {
              id: "file",
              dataUrl: "data:application/pdf;base64,JVBERi0xLjQ=",
              fileName: "large.pdf",
              mimeType: "application/pdf",
              sizeBytes: 20 * 1024 * 1024,
            }
          : {
              id: "image",
              dataUrl: "data:image/png;base64,AAA",
              fileName: "offline.png",
              mimeType: "image/png",
              sizeBytes: 3,
            };
      const message =
        kind === "offline command" ? "/think high" : kind === "cold file" ? "" : "retained input";
      const replyTarget = { messageId: "quote", text: "Keep the rejected quote" };
      const attachments = kind === "file" || kind === "cold file" ? [attachment] : [];
      const host = makeChatHost({
        requestHandlers: offline
          ? {}
          : {
              "chat.send": (params: unknown) => {
                if (kind === "text") {
                  throw new Error("gateway not connected");
                }
                return sendAck(params, "quota send", "started");
              },
            },
        ...(offline ? { client: null, connected: false } : {}),
        chatMessage: message,
        chatAttachments: attachments,
        ...(kind === "file" || kind === "offline command" ? { chatReplyTarget: replyTarget } : {}),
      });
      await handleSendChat(host);
      expect(host.chatMessage).toBe(message);
      expect(host.chatQueue).toStrictEqual([]);
      if (kind === "text") {
        expect(host.request).toHaveBeenCalledTimes(1);
      } else {
        expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
        expect(host.chatAttachments).toStrictEqual(attachments);
        expect(host.lastError).toBe(
          kind === "cold file"
            ? "Browser attachment storage is unavailable. Allow browser storage and close older dashboard tabs before reconnecting and retrying. No new message was sent."
            : storageError,
        );
      }
      if (kind === "file" || kind === "offline command") {
        expect(host.chatReplyTarget).toEqual(replyTarget);
      }
      if (kind === "file") {
        expect(host.chatRunId).toBeNull();
      }
    },
  );

  it("keeps a reconnect send queued when attempt persistence fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => ({
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        }),
      },
      connected: true,
      chatQueue: [
        queuedMessage("queued-retry-storage-failure", "keep this queued message", {
          sendRunId: "run-retry-storage-failure",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        }),
      ],
    });
    admitHostQueueItems(host);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    await resumeStoredChatOutboxes(host);

    expectItems(host.chatQueue, {
      id: "queued-retry-storage-failure",
      sendState: "waiting-reconnect",
    });
    expect(host.chatQueue[0]?.sendAttempts).toBeUndefined();
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.lastError).toBe(storageError);
  });

  it("defers queued global send agent selection until defaults are known", async () => {
    const request = makeRequestMock({
      "chat.history": () =>
        Promise.resolve({
          sessionInfo: row("global", { kind: "global", hasActiveRun: false, status: "done" }),
        }),
      "chat.send": () => Promise.resolve({ runId: "run-work", status: "started" }),
    });
    const host = makeChatHost({
      requestHandlers: {},
      connected: false,
      sessionKey: "global",
      chatMessage: "send to default later",
    });

    await handleSendChat(host);

    expect(host.chatQueue[0]).toMatchObject({
      text: "send to default later",
      sessionKey: "global",
      sendState: "waiting-reconnect",
    });
    expect(host.chatQueue[0]?.agentId).toBeUndefined();

    host.agentsList = { defaultId: "work" };
    host.client = clientWithRequest(request);
    host.connected = true;
    await resumeStoredChatOutboxes(host);

    const payload = findRequestPayload(request, "chat.send", "queued global send payload");
    expect(payload).toMatchObject({ sessionKey: "global", agentId: "work" });
    expect(
      loadChatComposerState({ ...host, assistantAgentId: "main" }, "global").snapshot,
    ).toBeNull();
    expect(
      loadChatComposerState({ ...host, assistantAgentId: "work" }, "global").snapshot?.queue ?? [],
    ).toEqual([]);
  });

  it("marks saved session queued sends waiting after a disconnect", () => {
    const host = makeChatHost({ requestHandlers: {}, chatQueue: [] });
    keepVolatileQueuedMessage(
      host,
      "agent:a",
      queuedMessage("pending-send-a", "pending", {
        sendRunId: "run-a",
        sendState: "sending",
        sessionKey: "agent:a",
      }),
    );

    markQueuedChatSendsWaitingForReconnect(host);

    expect(readChatQueueForScope(host, "agent:a")[0]).toMatchObject({
      sendRunId: "run-a",
      sendState: "waiting-reconnect",
    });
  });

  it("preserves a foreground leaf past an earlier outbox row", async () => {
    const sends: Record<string, unknown>[] = [];
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": idleChatHistory(),
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "queued foreground send payload");
          sends.push(payload);
          if (sends.length === 1) {
            // A fast predecessor can finish before its ACK reaches the browser;
            // the same drain then retains the foreground submit's leaf binding.
            handleChatGatewayEvent(host, {
              state: "final",
              runId: String(payload.idempotencyKey),
              sessionKey: host.sessionKey,
              message: { role: "assistant", content: "First turn complete" },
            });
          }
          return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
        },
      },
      chatDisplayedLeafEntryId: "leaf-before-queue",
      chatBranches: [
        { leafEntryId: "leaf-before-queue", headline: "Current", messageCount: 2, active: true },
      ],
      chatBranchesSessionKey: "agent:main",
      chatMessage: "second message",
      chatQueue: [
        queuedMessage("earlier-row", "first message", {
          sendAttempts: 0,
          sendRunId: "earlier-run",
          sendState: "waiting-idle",
          sessionKey: "agent:main",
        }),
      ],
    });
    admitHostQueueItems(host);

    await handleSendChat(host);

    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ message: "second message" });
    expect(sends[1]).toMatchObject({ expectedLeafEntryId: "leaf-before-queue" });
  });

  it("parks an active-leaf rejection and retries against the refreshed physical session", async () => {
    const host = makeChatHost({
      currentSessionId: "original-session",
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "retried physical-session send");
          if (payload.sessionId !== "replacement-session") {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "active branch changed; review and resend",
              details: { reason: "active-leaf-changed" },
            });
          }
          return { runId: payload.idempotencyKey, status: "started" };
        },
        "chat.history": {
          ...idleChatHistory(),
          sessionId: "replacement-session",
          sessionInfo: row("agent:main", {
            sessionId: "replacement-session",
            hasActiveRun: false,
            status: "done",
          }),
        },
        "sessions.branches.list": { branches: [] },
      },
      chatDisplayedLeafEntryId: "leaf-stale",
      chatBranches: [
        { leafEntryId: "leaf-stale", headline: "Stale", messageCount: 2, active: true },
      ],
      chatBranchesSessionKey: "agent:main",
      chatMessage: "stale branch prompt",
    });

    await handleSendChat(host);
    await waitForFast(() => {
      expect(host.request).toHaveBeenCalledWith(
        "chat.history",
        {
          sessionKey: "agent:main",
          ...historyBudget,
          knownState: {},
          inputRunIds: [
            findRequestPayload(host.request, "chat.send", "rejected send").idempotencyKey,
          ],
        },
        { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
      );
      expect(host.request).toHaveBeenCalledWith("sessions.branches.list", {
        sessionKey: "agent:main",
      });
    });

    expect(host.chatMessage).toBe("");
    expectItems(host.chatQueue, {
      sendError: "The session switched branches — review and resend.",
      sendState: "failed",
    });
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    await waitForFast(() => expect(host.currentSessionId).toBe("replacement-session"));
    const original = expectDefined(host.chatQueue[0], "rejected physical-session send");

    await retryQueuedChatMessage(host, original.id);

    await waitForFast(() => expect(requestCalls(host.request, "chat.send")).toHaveLength(2));
    const retried = requireRecord(
      requestCalls(host.request, "chat.send")[1]?.[1],
      "fresh physical-session retry",
    );
    expect(retried.sessionId).toBe("replacement-session");
    expect(retried.idempotencyKey).not.toBe(original.sendRunId);
    await waitForFast(() => expect(host.chatQueue).toEqual([]));
  });

  it.each([
    { sessionKey: "main", agentId: undefined },
    { sessionKey: "global", agentId: "work" },
  ])(
    "clears only the selected $sessionKey history and branch state",
    async ({ sessionKey, agentId }) => {
      const target = { sessionKey, ...(agentId ? { agentId } : {}) };
      const host = makeChatHost({
        agentsList: { defaultId: "main", ...(agentId ? {} : { mainKey: "main" }) },
        requestHandlers: {
          "sessions.reset": { ok: true },
          "chat.history": {
            messages: [],
            thinkingLevel: null,
            ...(agentId ? {} : { sessionInfo: { activeLeafEntryId: null } }),
          },
          ...(!agentId
            ? {
                "chat.send": (params: unknown) =>
                  sendAck(params, "post-clear send payload", "started"),
              }
            : {}),
        },
        sessionKey,
        chatMessage: "/clear",
        chatMessages: [{ role: "user", content: "hello", timestamp: 1 }],
        ...(agentId
          ? { assistantAgentId: agentId, chatMessagesBySession: new Map() }
          : {
              chatDisplayedLeafEntryId: "leaf-before-clear",
              chatRunError: { summary: "Error: previous run failed" },
            }),
      });
      if (agentId) {
        const cache = requireChatMessageCache(host);
        cacheChatMessages(cache, host, target, [{ role: "assistant", content: "work history" }]);
        cacheChatMessages(cache, host, { sessionKey, agentId: "main" }, [
          { role: "assistant", content: "main history" },
        ]);
      }

      await handleSendChat(host);

      expect(host.request).toHaveBeenCalledWith("sessions.reset", {
        key: sessionKey,
        ...(agentId ? { agentId } : {}),
      });
      expect(host.chatMessages).toStrictEqual([]);
      if (agentId) {
        expect(host.request).toHaveBeenCalledWith(
          "chat.history",
          { ...target, ...historyBudget, knownState: {} },
          { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
        );
        expect(host.chatMessagesBySession?.has(resolveChatSnapshotKey(host, target))).toBe(false);
        expect(
          host.chatMessagesBySession?.has(
            resolveChatSnapshotKey(host, { sessionKey, agentId: "main" }),
          ),
        ).toBe(true);
      } else {
        expect(host).toMatchObject({ chatRunError: null, chatRunId: null, chatStream: null });
        expect(host.chatDisplayedLeafEntryId).toBeUndefined();
        host.chatMessage = "after clear";
        await handleSendChat(host);
        expect(findRequestPayload(host.request, "chat.send", "post-clear send")).not.toHaveProperty(
          "expectedLeafEntryId",
        );
      }
    },
  );

  it("does not apply uncertain clear feedback after a connection change during history refresh", async () => {
    const reset = createDeferred<unknown>();
    const history = createDeferred<unknown>();
    const sourceSessionKey = "agent:main:source";
    const replacementRequest = makeRequestMock({
      "chat.history": () => history.promise,
    });
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": () => reset.promise,
      },
      connectionEpoch: 1,
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "source history" }],
      sessionKey: sourceSessionKey,
    });

    const clearing = handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("sessions.reset", { key: sourceSessionKey }),
    );
    host.client = clientWithRequest(replacementRequest);
    host.connectionEpoch = 2;
    reset.resolve({ ok: true });
    await waitForFast(() =>
      expect(replacementRequest).toHaveBeenCalledWith(
        "chat.history",
        {
          sessionKey: sourceSessionKey,
          ...historyBudget,
          knownState: {},
        },
        { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
      ),
    );
    const afterCommit = vi.spyOn(host.renderLifecycle, "afterCommit");

    host.client = clientWithRequest(makeRequestMock());
    host.connectionEpoch = 3;
    host.lastError = "Replacement session error";
    host.chatError = "Replacement session error";
    history.resolve({ messages: [], thinkingLevel: null });
    await clearing;

    expect(host.lastError).toBe("Replacement session error");
    expect(host.chatError).toBe("Replacement session error");
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it("does not add a run-lifetime queue item for an accepted /steer", async () => {
    const host = makeChatHost({
      client: clientWithRequest(
        makeRequestMock({
          "chat.send": { status: "started", runId: "steer-input", messageSeq: 2 },
        }),
      ),
      chatRunId: "run-1",
      chatMessage: "/steer tighten the plan",
      sessionKey: "agent:main:main",
      sessionsResult: createSessionsResult([
        row("agent:main:main", {
          activeLeafEntryId: "leaf-active",
          activeRunIds: ["run-1"],
          hasActiveRun: true,
          status: "running",
        }),
      ]),
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(0);
    expect(host.chatRunId).toBe("run-1");
  });

  it("sends a queued row through the generic outbox with only its durable steer mode", async () => {
    const ack = createDeferred<unknown>();
    const original = queuedMessage("queued-steer", "tighten the plan", {
      sendRunId: "stable-steer-send",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    const host = makeChatHost({
      currentSessionId: "steer-session",
      requestHandlers: { "chat.send": () => ack.promise },
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: original.sessionKey,
    });
    admitItem(host, original, host.sessionKey, original.agentId);

    const sending = steerQueuedChatMessage(host, original.id);
    await waitForFast(() => expectRpc(host.request, "chat.send"));

    const payload = findRequestPayload(host.request, "chat.send", "queued steer payload");
    expect(payload).toMatchObject({
      sessionKey: original.sessionKey,
      message: original.text,
      queueMode: "steer",
      idempotencyKey: original.sendRunId,
    });
    expect(payload).not.toHaveProperty("expectedRunId");
    expect(payload).not.toHaveProperty("expectedLeafEntryId");
    expectItems(host.chatQueue, {
      id: original.id,
      queueMode: "steer",
      sendRunId: original.sendRunId,
      sendState: "sending",
    });
    expectItems(loadChatComposerState(host, host.sessionKey).snapshot?.queue, {
      id: original.id,
      queueMode: "steer",
      sendRunId: original.sendRunId,
      sendState: "waiting-reconnect",
    });

    ack.resolve({ runId: original.sendRunId, status: "started" });
    await sending;
  });

  it("releases queued attachment payloads once across duplicate removal", () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:queued");
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const attachment = registerFileAttachment(
      "queued-att",
      "%PDF-1.4\n",
      "brief.pdf",
      "application/pdf",
    );
    const host = makeChatHost({ requestHandlers: {}, chatQueue: [] });
    for (const item of [
      queuedMessage("queued", "later", { attachments: [attachment] }),
      queuedMessage("sibling", "keep me", { createdAt: 2 }),
    ]) {
      keepVolatileQueuedMessage(host, host.sessionKey, item);
    }
    expect(getChatAttachmentPreviewUrl(attachment)).toBe("blob:queued");

    expect(removeQueuedMessage(host, "queued")).toBe("removed");
    expect(removeQueuedMessage(host, "queued")).toBe("absent");

    expectItems(host.chatQueue, { id: "sibling" });
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:queued");
  });

  it.each([0, 1])(
    "settles a non-retryable readiness or send rejection with %s previous sends",
    async (sendAttempts) => {
      const sends: string[] = [];
      let historyCalls = 0;
      const host = makeChatHost({
        requestHandlers: {
          "chat.history": () => {
            historyCalls += 1;
            if (sendAttempts || historyCalls === 1) {
              throw new GatewayRequestError({
                code: "UNAUTHORIZED",
                message: "gateway auth failed",
                retryable: false,
              });
            }
            return idleChatHistory();
          },
          "chat.send": (params: unknown) => {
            if (sendAttempts) {
              throw new GatewayRequestError({
                code: "UNAUTHORIZED",
                message: "gateway auth failed",
                retryable: false,
              });
            }
            const payload = requireRecord(params, "post-unblock send payload");
            sends.push(String(payload.message));
            return { runId: payload.idempotencyKey, status: "ok" };
          },
        },
        chatQueue: [
          queuedMessage("wedged-head", "head the gateway rejects", {
            sessionId: "rejected-session",
            sendAttempts,
            sendRunId: "wedged-head-run",
            sendState: sendAttempts ? "waiting-reconnect" : "waiting-idle",
            sessionKey: "agent:main",
          }),
          ...(!sendAttempts
            ? [
                queuedMessage("queued-behind-head", "message stuck behind the head", {
                  createdAt: 2,
                  sendAttempts: 0,
                  sendRunId: "queued-behind-run",
                  sendState: "waiting-idle" as const,
                  sessionKey: "agent:main",
                }),
              ]
            : []),
        ],
      });
      admitHostQueueItems(host);
      const surfacedErrors: (string | null)[] = [];
      let trackedError: string | null = host.lastError ?? null;
      Object.defineProperty(host, "lastError", {
        get: () => trackedError,
        set: (value: string | null) => {
          trackedError = value;
          surfacedErrors.push(value);
        },
      });

      await resumeStoredChatOutboxes(host);

      const stored = listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue);
      expect(stored.find((entry) => entry.id === "wedged-head")).toMatchObject({
        sendState: "failed",
        sendError: "gateway auth failed",
      });
      if (sendAttempts) {
        expect(requestCalls(host.request, "chat.history")).toHaveLength(0);
        expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
      } else {
        expect(surfacedErrors).toContain("gateway auth failed");
        await waitForFast(() => expect(sends).toContain("message stuck behind the head"));
      }
    },
  );

  it("surfaces a failed local command globally after a route switch", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const item = createQueuedLocalCommand("route-switched-command", "/think", {
      sessionKey: "agent:main:first",
    });
    // The dispatcher reports failure after the operator navigated away, so its
    // stale-scope guard withholds the inline error.
    executeSlashCommandMock.mockImplementation(async () => {
      host.sessionKey = "agent:main:second";
      return { failed: true, content: "think mode rejected" };
    });
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory("agent:main:first"),
      },
      chatQueue: [item],
      sessionKey: item.sessionKey,
    });
    admitHostQueueItems(host);

    await resumeStoredChatOutboxes(host);

    expect(host.lastError).toBeNull();
    await toastHost.updateComplete;
    await vi.dynamicImportSettled();
    await waitForSolid(() => expect(document.body.textContent).toContain("Command /think failed."));
    expectItems(
      listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue),
      { id: item.id, sendState: "failed" },
    );
    document.body.replaceChildren();
  });

  it("names the failed agent's global session in the toast, not another agent's row", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": idleChatHistory("global"),
        "chat.send": () => {
          throw new GatewayRequestError({
            code: "UNAUTHORIZED",
            message: "gateway auth failed",
            retryable: false,
          });
        },
      },
      chatQueue: [
        queuedMessage("global-agent-scoped-failure", "fails on the second agent's global session", {
          sendAttempts: 0,
          sendRunId: "global-agent-scoped-run",
          sendState: "waiting-idle",
          sessionKey: "global",
          agentId: "writer",
        }),
      ],
      sessionKey: "agent:main:elsewhere",
      sessionsResult: createSessionsResult([
        row("global", { agentId: "main", label: "Main global chat" }),
        row("global", { agentId: "writer", label: "Writer global chat" }),
      ]),
    });
    admitHostQueueItems(host);

    await resumeStoredChatOutboxes(host);

    await toastHost.updateComplete;
    await vi.dynamicImportSettled();
    await waitForSolid(() => expect(document.body.textContent).toContain("gateway auth failed"));
    // Global rows share one key; the toast must borrow the failed agent's label.
    expect(document.body.textContent).toContain("Writer global chat");
    expect(document.body.textContent).not.toContain("Main global chat");
    document.body.replaceChildren();
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
