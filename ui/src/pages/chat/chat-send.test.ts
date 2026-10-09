import { reduceSessionProjection } from "@openclaw/gateway-client/browser";
/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { peekChatMetadata } from "../../lib/chat/chat-metadata-store.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  replaceSlashCommands,
} from "../../lib/chat/commands.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import * as outboxPayloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult as sessionListFixture,
} from "../../lib/sessions/session-capability.test-support.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createResolvedModelPatch } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient as clientWithRequest } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
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
  findRequestPayload,
  makeChatHost,
  makeRequestMock,
  requestCalls,
  requireRecord,
} from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { admitHostQueueItems, idleChatHistory, row } from "./chat-outbox-recovery.test-support.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import { markQueuedChatSendsWaitingForReconnect } from "./chat-queue-reconnect.ts";
import {
  keepVolatileQueuedMessage,
  readChatQueueForScope,
  removeQueuedMessage,
} from "./chat-queue.ts";
import {
  flushChatQueueForEvent,
  moveQueuedChatMessage,
  resumeStoredChatOutboxes,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
} from "./chat-send-actions.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import * as chatSendSupport from "./chat-send-support.ts";
import { recordChatSendServerTiming } from "./chat-send-timing.ts";
import { switchChatFastMode, switchChatThinkingLevel } from "./chat-session.ts";
import { getPendingChatPickerPatch, patchChatSessionSettings } from "./chat-settings-patches.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  refreshChatMetadata,
  refreshPageChat,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  listStoredChatOutboxes,
  loadChatComposerSnapshot,
  storedChatOutboxScopeKey,
  updateStoredChatComposerQueueItems,
} from "./composer-persistence.ts";
import { getChatSessionProjection, publishChatSessionProjection } from "./history-merge.ts";
import { handleChatInputHistoryKey } from "./input-history.ts";
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

function createQueuedLocalCommand(
  id: string,
  text: string,
  options: { createdAt?: number; sessionKey?: string } = {},
) {
  const [name, ...args] = text.slice(1).split(" ");
  return {
    id,
    text,
    createdAt: options.createdAt ?? 1,
    localCommandArgs: args.join(" "),
    localCommandName: name ?? "",
    sessionKey: options.sessionKey ?? "agent:main",
  };
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
  const storage = createStorageMock();
  vi.spyOn(storage, "setItem").mockImplementation(() => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  });
  vi.stubGlobal("sessionStorage", storage);
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

function navigateChatInputHistory(host: TestChatHost, direction: "up" | "down"): boolean {
  return handleChatInputHistoryKey(host, {
    key: direction === "up" ? "ArrowUp" : "ArrowDown",
    selectionStart: 0,
    selectionEnd: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: direction === "up" ? 38 : 40,
  }).handled;
}

function createJsonResponse(body: unknown, options: { ok?: boolean } = {}): Response {
  const response = new Response(null, { status: options.ok === false ? 500 : 200 });
  response.json = async () => await body;
  return response;
}

function eventPayloads(host: TestChatHost, event: string): Array<Record<string, unknown>> {
  return (host.eventLogBuffer ?? [])
    .filter((entry): entry is { event: string; payload: Record<string, unknown> } => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const candidate = entry as { event?: unknown; payload?: unknown };
      return (
        candidate.event === event &&
        Boolean(candidate.payload && typeof candidate.payload === "object")
      );
    })
    .map((entry) => entry.payload);
}

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
    placement: {
      state: "active",
      generation: 4,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
      environmentId: "environment-device",
      activeOwnerEpoch: 7,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "manifest-device",
      remoteWorkspaceDir: "/workspace",
      runner: { kind: "device", status },
    },
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

    const refresh = refreshPageChat(asChatPageHost(host), {
      awaitHistory: true,
      deferBranches: true,
      startup: true,
    });
    const reobserved = refreshChatMetadata(asChatPageHost(host), { automatic: true });
    startup.resolve({ messages: [message] });
    await expect(refresh).resolves.toBeUndefined();
    const joined = refreshChatMetadata(asChatPageHost(host), { automatic: true });
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
    const refresh = refreshPageChat(asChatPageHost(host), {
      startup: true,
      awaitHistory: true,
      deferBranches: true,
    });
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
        "chat.metadata": () => metadata.promise,
        "models.list": () => metadata.promise,
        "chat.startup": () => startup.promise,
      },
    });
    const opening = makeChatHost({ client: retained.client });
    const kept = asChatPageHost(retained);
    const closed = asChatPageHost(opening);
    kept.chatModelCatalog = [{ ...ready, available: false, unavailableReason: "missing-auth" }];
    const restoring = refreshChatMetadata(kept);
    const loading = refreshPageChat(closed, {
      startup: true,
      awaitHistory: true,
      deferBranches: true,
    });
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
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(host.chatRunId).toBe(runId);
    expect(host.chatStream).toBe("Still working after navigation.");
    expect(host.sessionsResult?.sessions[0]).toMatchObject({
      hasActiveRun: false,
      status: "done",
      updatedAt: 10,
    });
  });

  it("keeps a newer canonical offline runner row over coalesced stale startup hydration", async () => {
    const key = "agent:main:device-session";
    const deviceRow = (status: "available" | "offline") =>
      deviceSessionRow(key, status, {
        sessionId: "device-session-incarnation",
      });
    const staleAvailable = deviceRow("available");
    const startup = createDeferred<unknown>();
    const initialSessions = createSessionsResult([staleAvailable]);
    const request = makeRequestMock({
      "chat.startup": () => startup.promise,
      "sessions.list": createSessionsResult([deviceRow("offline")]),
    });
    const client = clientWithRequest(request);
    const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
    sessions.reconcile(staleAvailable, initialSessions.defaults);
    const first = createTestChatPane({ client, sessions });
    const second = createTestChatPane({ client, sessions });
    const firstPane = first.state;
    const secondPane = second.state;
    const pending: Promise<unknown>[] = [];
    const releases = [first, second].map(({ pane, state }) => {
      state.sessionKey = key;
      state.hello = gatewayHelloForMethods(["chat.startup"], []);
      pane.presented = false;
      pane.applySessionsState(sessions.state);
      return sessions.subscribe(pane.applySessionsState.bind(pane));
    });
    onTestFinished(async () => {
      releases.forEach((release) => release());
      sessions.dispose();
      startup.resolve({ messages: [] });
      await Promise.allSettled(pending);
    });
    const options = {
      awaitHistory: true,
      deferBranches: true,
      scheduleScroll: false,
      startup: true,
    } as const;
    const firstRefresh = refreshPageChat(firstPane, options);
    pending.push(firstRefresh);
    await vi.waitFor(() => expect(requestCalls(request, "chat.startup")).toHaveLength(1));
    await firstPane.sessions.refresh({ force: true });
    expect(firstPane.sessions.canonicalListRevision).toBe(1);
    expect(firstPane.sessions.state.result?.sessions[0]?.placement).toMatchObject({
      runner: { kind: "device", status: "offline" },
    });

    const joinedRefresh = refreshPageChat(secondPane, options);
    pending.push(joinedRefresh);
    startup.resolve({
      messages: [{ role: "assistant", content: "Stale startup transcript was consumed." }],
      sessionInfo: staleAvailable,
    });
    await Promise.all([firstRefresh, joinedRefresh]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(requestCalls(request, "chat.startup")).toHaveLength(1);
    for (const pane of [firstPane, secondPane]) {
      expect(pane.chatMessages.map((message) => extractText(message))).toContain(
        "Stale startup transcript was consumed.",
      );
      expect(pane.sessionsResult?.sessions[0]?.placement).toMatchObject({
        runner: { kind: "device", status: "offline" },
      });
      expect(selectedChatSessionRow(pane)?.placement).toMatchObject({
        runner: { kind: "device", status: "offline" },
      });
    }
    expect(firstPane.sessions.state.result?.sessions[0]?.placement).toMatchObject({
      runner: { kind: "device", status: "offline" },
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
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(host.sessions.state.result?.sessions).toEqual([
      expect.objectContaining({ key, archived: true }),
    ]);
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

  it.each([
    {
      name: "drains a restored queue after history proves the selected session is idle",
      history: () => idleChatHistory("agent:main:dashboard"),
      overrides: { sessionKey: "agent:main:dashboard" },
      message: "after reload",
      expectedSend: { sessionKey: "agent:main:dashboard", message: "after reload" },
    },
    {
      name: "drains a restored queue from history metadata when rows are scoped elsewhere",
      history: () => idleChatHistory("agent:work:dashboard"),
      overrides: {
        sessionKey: "agent:work:dashboard",
        sessionsResult: createSessionsResult([
          row("agent:main:main", { hasActiveRun: false, status: "done" }),
        ]),
        sessionsResultAgentId: "main",
      },
      message: "after scoped reload",
      expectedSend: { sessionKey: "agent:work:dashboard", message: "after scoped reload" },
    },
    {
      name: "drains a restored queue when global history answers an agent main alias",
      history: {
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
      },
      overrides: {
        sessionKey: "agent:work:main",
        agentsList: { defaultId: "main", mainKey: "main", scope: "global" as const },
        sessionsResult: createSessionsResult([
          row("agent:main:main", { hasActiveRun: false, status: "done" }),
        ]),
        sessionsResultAgentId: "main",
      },
      message: "after global alias reload",
      expectedSend: { sessionKey: "global", agentId: "work", message: "after global alias reload" },
    },
  ])("$name", async ({ history, overrides, message, expectedSend }) => {
    const sendRequested = createDeferred();
    const host = makeChatHost({
      ...overrides,
      requestHandlers: {
        "chat.history": history,
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "restored send payload");
          sendRequested.resolve();
          return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
        },
      },
      chatQueue: [{ id: "queued-1", text: message, createdAt: 1 }],
    });
    if (overrides.sessionsResultAgentId) {
      for (const session of overrides.sessionsResult.sessions) {
        host.sessions.reconcile(session, overrides.sessionsResult.defaults, {
          resultAgentId: overrides.sessionsResultAgentId,
        });
      }
    }
    const primaryResult = host.sessions.state.result;
    admitHostQueueItems(host);

    await refreshPageChat(asChatPageHost(host), { scheduleScroll: false });
    await sendRequested.promise;
    await resumeStoredChatOutboxes(host);
    expect(host.request).toHaveBeenCalledWith("chat.send", expect.objectContaining(expectedSend), {
      timeoutMs: 30_000,
    });
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
  });

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
        "chat.send": (params: unknown) => ({
          runId: requireRecord(params, "recovered send").idempotencyKey,
          status: "started",
          messageSeq: 1,
        }),
      },
    });
    try {
      const initialLoad = loadChatHistory(host, { startup: true, deferBranches: true });
      const send = handleSendChat(host);
      await vi.advanceTimersByTimeAsync(0);
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ text: "Send after recovery", sendState: "waiting-idle" }),
      ]);
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
      expect(host.chatLoading).toBe(false);
      expect(host.chatMessage).toBe("Keep my next draft");
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
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "startup send payload");
          return { runId: payload.idempotencyKey, status: "started", messageSeq: 1 };
        },
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
    expect(host.chatQueue).toEqual([
      expect.objectContaining({ text: message, sendState: "waiting-idle" }),
    ]);
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
      timeoutMs: 30_000,
    });

    startup.resolve(idleHistory);
    await refresh;
    await waitForFast(() => {
      expect(host.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({ sessionKey, sessionId: "dashboard-session", message }),
        { timeoutMs: 30_000 },
      );
      expect(host.chatQueue).toEqual([]);
    });
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  });

  it("keeps a restored queue when newer session state is active", async () => {
    const sessionKey = "agent:main:dashboard";
    const restoredQueue = [{ id: "queued-1", text: "after active run", createdAt: 1 }];
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
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.chatQueue).toEqual([expect.objectContaining(restoredQueue[0])]);
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
        "chat.send": (params: unknown) => ({
          runId: requireRecord(params, "accepted run").idempotencyKey,
          status: "started",
          messageSeq: 1,
        }),
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

      expect(host.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({ message, sessionKey: "agent:main" }),
        { timeoutMs: 30_000 },
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
  ])(
    "routes presentation command $chatMessage with attachments=$attached",
    async ({ chatMessage, attached }) => {
      installPairClientPresentationCommand();
      const dispatchClientPresentation = vi.fn(async () => true);
      const baselineMessages = [{ role: "assistant", content: "Ready." }];
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatMessage,
        chatAttachments: attached
          ? [registerFileAttachment("pairing-notes", "pairing notes", "pairing.txt", "text/plain")]
          : [],
        chatMessages: baselineMessages,
        dispatchClientPresentation,
      });

      await handleSendChat(host);

      if (attached) {
        expect(dispatchClientPresentation).not.toHaveBeenCalled();
        expect(host.request).toHaveBeenCalledWith(
          "chat.send",
          expect.objectContaining({ message: chatMessage }),
          { timeoutMs: 30_000 },
        );
      } else {
        expect(dispatchClientPresentation).toHaveBeenCalledWith({ kind: "device-pairing" });
        expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
          timeoutMs: 30_000,
        });
        expect(host.chatQueue).toStrictEqual([]);
        expect(host.chatMessages).toEqual(baselineMessages);
        expect(host.chatMessage).toBe("");
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

  it("restores typed /new when session creation is cancelled", async () => {
    const createChatSession = vi.fn(async () => false);
    const host = makeChatHost({
      chatMessage: "/new",
      sessionKey: "agent:main",
      createChatSession,
    });

    await handleSendChat(host);

    expect(createChatSession).toHaveBeenCalledOnce();
    expect(host.chatMessage).toBe("/new");
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
        expect(host.request).toHaveBeenCalledWith("chat.send", {
          sessionKey: "agent:main",
          message: "start over",
          queueMode: "interrupt",
          idempotencyKey: expect.any(String),
        });
        expect(host.request).toHaveBeenCalledTimes(1);
        expect(host.chatMessage).toBe("new draft");
        expect(host.chatRunId).toBe("redirect-run");
      } else {
        expect(host.request).not.toHaveBeenCalled();
        expect(host.chatMessage).toBe("/redirect start over");
        expect(host.chatAttachments).toStrictEqual(attachments);
        expect(host.chatRunId).toBeNull();
      }
    },
  );

  it("does not seed refreshSessionsAfterChat for a terminal timeout ack on a refreshing send", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "timeout" },
      },
      chatMessage: "/reset",
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    const runId = String(payload.idempotencyKey);
    const runState = host as ChatHost & {
      chatStreamStartedAt?: number | null;
      lastLocalTerminalReconcile?: unknown;
    };
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(runState.chatStreamStartedAt).toBeNull();
    expect(runState.lastLocalTerminalReconcile).toMatchObject({
      phase: "interrupted",
      runId,
      sessionKey: "agent:main",
      sessionStatus: "killed",
    });
    expect(host.refreshSessionsAfterChat.size).toBe(0);
  });

  it("keeps a completed reset successful without replacing the Sessions table", async () => {
    const archivedSessions = createSessionsResult([
      row("agent:main:archived", { archived: true, status: "done" }),
    ]);
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat send payload");
          return { runId: payload.idempotencyKey, status: "ok" };
        },
        "chat.history": idleChatHistory(),
        "sessions.list": () =>
          createSessionsResult([row("agent:main", { hasActiveRun: false, status: "done" })]),
      },
      chatMessage: "/reset",
      sessionKey: "agent:main",
      sessionsArchivedFilter: "archived",
      sessionsResult: archivedSessions,
    });

    await handleSendChat(host);

    const runState = host as ChatHost & { lastLocalTerminalReconcile?: unknown };
    expect(runState.lastLocalTerminalReconcile).toMatchObject({
      phase: "done",
      sessionKey: "agent:main",
      sessionStatus: "done",
    });
    await waitForFast(() =>
      expect(host.request.mock.calls.some(([method]) => method === "sessions.list")).toBe(true),
    );
    expect(host.sessionsResult).toBe(archivedSessions);
  });

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
    expect(host.lastError).toBeNull();
    expect(host.chatError).toBeNull();
    expect(host.chatRunId).toBeNull();
    expect(
      getChatSessionProjection(host, { sessionKey: host.sessionKey }).entries,
    ).not.toContainEqual(expect.objectContaining({ pendingRunId: rejectedRunId }));
  });

  it("records visible send timing through Gateway post-ACK milestones", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": {
          status: "started",
          serverTiming: {
            receivedToAckMs: 17,
            loadSessionMs: 4,
            prepareAttachmentsMs: 0.5,
          },
        },
      },
      chatMessage: "measure first send",
      eventLogBuffer: [],
    });

    await handleSendChat(host);

    const sendEvents = eventPayloads(host, "control-ui.chat.send");
    expect(sendEvents.map((payload) => payload.phase)).toEqual(
      expect.arrayContaining(["pending-visible", "request-start", "ack"]),
    );
    const ack = sendEvents.find((payload) => payload.phase === "ack");
    expect(ack).toMatchObject({
      ackStatus: "started",
      sessionKey: "agent:main",
      sendState: "sending",
    });
    expect(ack?.durationMs).toEqual(expect.any(Number));
    expect(ack?.requestDurationMs).toEqual(expect.any(Number));
    expect(ack).toMatchObject({
      serverReceivedToAckMs: 17,
      serverLoadSessionMs: 4,
      serverPrepareAttachmentsMs: 0.5,
    });
    const runId = typeof ack?.runId === "string" ? ack.runId : "";
    expect(runId).toMatch(uuidPattern);

    recordChatSendServerTiming(host, {
      phase: "agent-run-started",
      runId,
      sessionKey: "agent:main",
      agentId: "main",
      ackToPhaseMs: 12,
      receivedToPhaseMs: 25,
      dispatchStartedToPhaseMs: 8,
      agentRunId: "agent-run-1",
    });

    expect(eventPayloads(host, "control-ui.chat.send")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "server-agent-run-started",
          runId,
          sessionKey: "agent:main",
          agentId: "main",
          ackStatus: "started",
          serverPhase: "agent-run-started",
          serverAckToPhaseMs: 12,
          serverReceivedToPhaseMs: 25,
          serverDispatchStartedToPhaseMs: 8,
          agentRunId: "agent-run-1",
        }),
      ]),
    );
  });

  it("waits for every pending reasoning and speed patch before sending chat", async () => {
    const thinkingUpdate = createDeferred<unknown>();
    const fastModeUpdate = createDeferred<unknown>();
    const sessionsResult = createSessionsResult([
      row("agent:main", {
        effectiveFastMode: false,
        fastMode: false,
        thinkingLevel: "low",
      }),
    ]);
    const host = makeChatHost({
      requestHandlers: {
        "sessions.patch": (params: unknown) => {
          const patch = requireRecord(params, "session settings patch");
          if (Object.hasOwn(patch, "thinkingLevel")) {
            return thinkingUpdate.promise;
          }
          if (Object.hasOwn(patch, "fastMode")) {
            return fastModeUpdate.promise;
          }
          throw new Error("Unexpected sessions.patch payload");
        },
        "sessions.list": () => Promise.resolve(sessionsResult),
        "chat.send": () => Promise.resolve({ status: "started" }),
      },
      chatMessage: "use the new reasoning and speed",
      sessionsResult,
    });
    const settingsHost: Parameters<typeof switchChatThinkingLevel>[0] = host;

    const thinkingPatch = switchChatThinkingLevel(settingsHost, "high");
    const fastModePatch = switchChatFastMode(settingsHost, "on");
    const send = handleSendChat(host);
    await Promise.resolve();

    expect(requestCalls(host.request, "sessions.patch")).toHaveLength(1);
    expect(requestCalls(host.request, "chat.send")).toStrictEqual([]);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "use the new reasoning and speed",
    });

    thinkingUpdate.resolve({});
    await thinkingPatch;
    await waitForFast(() => expect(requestCalls(host.request, "sessions.patch")).toHaveLength(2));
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);

    fastModeUpdate.resolve({});
    await Promise.all([fastModePatch, send]);
    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    expect(payload).toMatchObject({
      message: "use the new reasoning and speed",
      sessionKey: "agent:main",
    });
  });

  it("retires a failed queued picker back to the preceding confirmed session row", async () => {
    const firstPatch = createDeferred<unknown>();
    let patchCount = 0;
    const host = makeChatHost({
      requestHandlers: {
        "sessions.list": createSessionsResult([
          row("agent:main", {
            model: "gpt-5-mini",
            modelProvider: "openai",
            modelOverrideSource: "user",
          }),
        ]),
        "sessions.patch": () => {
          patchCount += 1;
          if (patchCount === 1) {
            return firstPatch.promise;
          }
          throw new Error("picker rejected");
        },
      },
    });

    const slash = patchChatSessionSettings(host, host.sessionKey, { model: "openai/gpt-5-mini" });
    await waitForFast(() => expect(patchCount).toBe(1));
    const picker = patchChatSessionSettings(host, host.sessionKey, {
      model: "openai/gpt-5",
    });

    expect(host.sessions.state.modelOverrides[host.sessionKey]).toBe("openai/gpt-5-mini");
    firstPatch.resolve(createResolvedModelPatch("gpt-5-mini", "openai"));
    await expect(slash).resolves.toBeTruthy();
    await expect(picker).rejects.toThrow("picker rejected");
    expect(host.sessions.state.modelOverrides[host.sessionKey]).toBeUndefined();
    expect(host.sessions.state.result?.sessions[0]).toMatchObject({
      model: "gpt-5-mini",
      modelProvider: "openai",
      modelOverrideSource: "user",
    });
  });

  it("keeps waiting when a late picker barrier cannot be persisted", async () => {
    const queuedText = "do not bypass the late picker";
    const history = createDeferred<unknown>();
    const settingsUpdate = createDeferred<unknown>();
    const storage = createStorageMock();
    const write = storage.setItem.bind(storage);
    let rejectedBarrier = false;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (
        !rejectedBarrier &&
        value.includes(`"text":"${queuedText}"`) &&
        value.includes('"sendState":"failed"')
      ) {
        rejectedBarrier = true;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started" },
        "sessions.patch": () => settingsUpdate.promise,
      },
      chatMessage: queuedText,
      chatQueue: [
        {
          id: "older-picker-barrier",
          text: "already delivered",
          createdAt: 1,
          sendAttempts: 1,
          sendRunId: "older-picker-run",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    const send = handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything(), {
        timeoutMs: 30_000,
      }),
    );
    const patch = patchChatSessionSettings(host, "agent:main", { model: "next" });
    history.resolve({
      messages: [{ role: "user", __openclaw: { idempotencyKey: "older-picker-run:user" } }],
      sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
    });

    await waitForFast(() => expect(rejectedBarrier).toBe(true));
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);

    settingsUpdate.resolve(null);
    await Promise.all([patch, send]);
    await resumeStoredChatOutboxes(host);

    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
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
    const settingsHost: Parameters<typeof switchChatThinkingLevel>[0] = settingsPane;

    const thinkingPatch = switchChatThinkingLevel(settingsHost, "high");
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
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
      timeoutMs: 30_000,
    });
    container.scrollTop = 1200;
    handleChatScrollTakeover(host);
    expect(host.chatFollowLocked).toBe(true);
    scrollToEnd.mockClear();

    settings.resolve(true);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("chat.send", expect.anything(), {
        timeoutMs: 30_000,
      }),
    );
    ack.resolve({ status: "started", runId: "accepted-run" });
    await send;
    await Promise.resolve();

    expect(host.chatFollowLocked).toBe(true);
    expect(host.chatHasAutoScrolled).toBe(true);
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
        {
          id: "retry-send",
          text,
          createdAt: 1,
          sendError: "previous failure",
          sendRunId: "retry-run",
          sendState: "failed",
          sessionKey: "agent:main",
        },
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
    const original = {
      id: "durable-failed-repeat-read-failure",
      text: "never bypass the durable row",
      createdAt: 1,
      sendRunId: "durable-failed-run",
      sendState: "failed",
      sessionKey: "agent:main",
    } satisfies ChatQueueItem;
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const host = makeChatHost({ requestHandlers: {}, chatQueue: [original] });
    const admission = captureChatOutboxAdmission(host, original.sessionKey);
    expect(admitQueuedMessageForSession(host, admission, original)).toBe(true);
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

  it("keeps slash-command model changes in the canonical row and refreshes tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse({}, { ok: false })),
    );

    const refreshCurrentSessionTools = vi.fn();
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
        "sessions.list": {
          ts: 0,
          path: "",
          count: 1,
          defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
          sessions: [
            row("main", {
              model: "gpt-5-mini",
              modelProvider: "openai",
              modelOverrideSource: "user",
            }),
          ],
        },
        "models.list": {
          models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
        },
      },
      sessionKey: "main",
      chatMessage: "/model gpt-5-mini",
      refreshCurrentSessionTools,
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
    expect(refreshCurrentSessionTools).toHaveBeenCalledTimes(1);
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
        expect(fallback?.attachments).toEqual([
          expect.objectContaining({ id: attachments[0]!.id }),
        ]);
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

  it("routes /btw without adopting a main chat run when idle", async () => {
    const openSessionCompanion = vi.fn();
    const host = makeChatHost({
      chatMessage: "/btw summarize this",
      openSessionCompanion,
    });

    await handleSendChat(host);

    expect(openSessionCompanion).toHaveBeenCalledWith("summarize this");
    expect(host.chatRunId).toBeNull();
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatMessage).toBe("");
    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("/btw summarize this");
  });

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
      await waitForFast(() =>
        expect(host.request).toHaveBeenCalledWith("chat.send", expect.anything(), {
          timeoutMs: 30_000,
        }),
      );
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
        expect(approval).toMatchObject({ runId, approvalId: `approval-${runId}` });
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
        {
          id: "queued-behind-run",
          text: "wait for the active run",
          createdAt: 1,
          sendRunId: "queued-behind-run-send",
          sendState: "waiting-idle",
          sessionKey: "agent:main",
        },
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
          return Promise.resolve({
            messages: [],
            sessionInfo: row(String(payload.sessionKey), {
              hasActiveRun: false,
              status: "done",
            }),
          });
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat.send payload");
          const sessionKey = String(payload.sessionKey);
          sentSessions.push(sessionKey);
          return sessionKey === visibleSessionKey
            ? visibleAck.promise
            : Promise.resolve({ runId: payload.idempotencyKey, status: "started", messageSeq: 1 });
        },
      },
      sessionKey: visibleSessionKey,
    });

    const visibleSend = handleSendChat(host, "visible pending send");
    await waitForFast(() => expect(sentSessions).toContain(visibleSessionKey));
    expect(host.chatSending).toBe(true);

    const inactiveItem = {
      id: "inactive-send-finishes-first",
      text: "inactive send",
      createdAt: 2,
      sessionKey: inactiveSessionKey,
    };
    const inactiveAdmission = captureChatOutboxAdmission(host, inactiveSessionKey);
    expect(admitQueuedMessageForSession(host, inactiveAdmission, inactiveItem)).toBe(true);
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
    const admission = captureChatOutboxAdmission(firstHost, firstHost.sessionKey);
    expect(admitQueuedMessageForSession(firstHost, admission, item)).toBe(true);
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
    const item = {
      id: "edited-across-panes",
      text: "the text being rewritten",
      createdAt: 1,
      sessionKey: "agent:main",
    };
    // Two panes on one session: the composer holding the edit is pane-local, but
    // the outbox and the drain lane are shared, and either pane can own the lane.
    const editing = makeChatHost({ client, chatQueue: [item] });
    const peer = makeChatHost({ client, chatQueue: [] });
    const stopEditing = chatOutboxOwner(editing).subscribe(editing);
    const stopPeer = chatOutboxOwner(peer).subscribe(peer);
    try {
      const admission = captureChatOutboxAdmission(editing, editing.sessionKey);
      expect(admitQueuedMessageForSession(editing, admission, item)).toBe(true);
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
      expect(listStoredChatOutboxes(peer)[0]?.queue).toEqual([
        expect.objectContaining({ id: item.id, text: item.text }),
      ]);
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

      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
        timeoutMs: 30_000,
      });
      expect(replacementRequest).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
        timeoutMs: 30_000,
      });
      if (outcome === "cancelled") {
        expect(listStoredChatOutboxes(host)).toStrictEqual([]);
      } else if (outcome === "route changed") {
        expect(listStoredChatOutboxes(host)).toEqual([
          expect.objectContaining({
            sessionKey: item.sessionKey,
            queue: [expect.objectContaining({ id: item.id, sendState: "waiting-idle" })],
          }),
        ]);
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
    host.chatRunId = "replacement-run";
    host.chatStream = "Replacement Gateway stream";
    host.chatSending = true;
    host.chatSendingScopeKey = storedChatOutboxScopeKey({
      sessionKey: item.sessionKey,
    });
    host.lastError = "Replacement Gateway error";
    host.chatError = "Replacement Gateway error";
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
    expect(host.chatRunId).toBe("replacement-run");
    expect(host.chatStream).toBe("Replacement Gateway stream");
    expect(host.chatSending).toBe(true);
    expect(host.chatSendingScopeKey).toBe(
      storedChatOutboxScopeKey({
        sessionKey: item.sessionKey,
      }),
    );
    expect(host.lastError).toBe("Replacement Gateway error");
    expect(host.chatError).toBe("Replacement Gateway error");
    expect(host.refreshSessionsAfterChat).toEqual(new Map());
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("keeps consumed outbox input retired outside the history tail", async () => {
    const sessionKey = "agent:main:long-conversation";
    const sessionId = "long-conversation-session";
    const item: ChatQueueItem = {
      id: "old-submission",
      text: "land PR",
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: "original-submission",
      sendState: "waiting-reconnect",
      sessionKey,
      sessionId,
      sender: { id: "local", name: "Local Author" },
    };
    const user = {
      role: "user",
      content: item.text,
      timestamp: 1,
      __openclaw: { id: "canonical-user", seq: 1, idempotencyKey: `${item.sendRunId}:user` },
    };
    const final = {
      role: "assistant",
      content: "The PR is merged.",
      timestamp: 200,
      __openclaw: { id: "canonical-final", seq: 120, runId: "queued-execution" },
    };
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      chatMessages: [final],
      chatQueue: [item],
      requestHandlers: {
        "chat.history": (params: unknown) => ({
          messages:
            requireRecord(params, "receipt history").limit === 1000 ? [user, final] : [final],
          sessionId,
          sessionInfo: row(sessionKey, { sessionId, status: "done", hasActiveRun: false }),
          hasMore: true,
          nextOffset: 80,
          totalMessages: 120,
        }),
      },
    });
    admitHostQueueItems(host);
    expect(
      await chatSendSupport.retireDeliveredQueuedUserTurn(
        host,
        item.sendRunId,
        { sessionKey },
        {
          retainUntilConsumed: true,
        },
      ),
    ).toBe("retained");

    await resumeStoredChatOutboxes(host);

    await waitForFast(() => {
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(host.chatMessages).toEqual([final]);
    });
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
      timeoutMs: 30_000,
    });
  });

  it("routes an unscoped global terminal to the default agent outbox", async () => {
    const runId = "shared-global-terminal-run";
    const selected = {
      id: "selected-global-terminal",
      text: "keep the selected agent prompt",
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: runId,
      sendState: "sending" as const,
      sessionKey: "global",
      agentId: "work",
    };
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
      requestUpdate: vi.fn(),
    });
    const selectedAdmission = captureChatOutboxAdmission(
      host,
      selected.sessionKey,
      selected.agentId,
    );
    expect(admitQueuedMessageForSession(host, selectedAdmission, selected)).toBe(true);
    const defaultAgentAdmission = captureChatOutboxAdmission(
      host,
      defaultAgent.sessionKey,
      defaultAgent.agentId,
    );
    expect(admitQueuedMessageForSession(host, defaultAgentAdmission, defaultAgent)).toBe(true);

    expect(
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
      } as Parameters<typeof handlePageGatewayEvent>[1]),
    ).toBeUndefined();

    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatQueue).toEqual([expect.objectContaining({ id: selected.id })]);
    expect(
      listStoredChatOutboxes(host)
        .flatMap((outbox) => outbox.queue)
        .map((item) => item.id),
    ).toEqual(expect.arrayContaining([selected.id, defaultAgent.id]));

    consumed = true;
    await resumeStoredChatOutboxes(host);

    expect(listStoredChatOutboxes(host)).toEqual([
      expect.objectContaining({
        agentId: selected.agentId,
        queue: [expect.objectContaining({ id: selected.id })],
        sessionKey: selected.sessionKey,
      }),
    ]);
  });

  it("preserves terminal user-turn ordering when an inactive split pane handles the event first", async () => {
    const item = {
      id: "split-terminal-delivery",
      text: "prompt from the visible pane",
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: "split-terminal-delivery-run",
      sendState: "sending" as const,
      sessionKey: "agent:main:visible",
    };
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
        requestUpdate: vi.fn(),
      });
    }
    cacheEmptyChatSnapshot(inactive, item.sessionKey);
    const admission = captureChatOutboxAdmission(visible, item.sessionKey);
    expect(admitQueuedMessageForSession(visible, admission, item)).toBe(true);
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

    expect(handlePageGatewayEvent(asChatPageHost(inactive), event)).toBeUndefined();
    expect(handlePageGatewayEvent(asChatPageHost(visible), event)).toBeUndefined();
    expect(handlePageGatewayEvent(asChatPageHost(inactive), event)).toBeUndefined();

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
    await resumeStoredChatOutboxes(visible);
    expect(listStoredChatOutboxes(visible)).toStrictEqual([]);
  });

  it("does not execute a stored local command when its durable claim fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const write = storage.setItem.bind(storage);
    executeSlashCommandMock.mockResolvedValue({ content: "Thinking level set." });

    const item = createQueuedLocalCommand("local-command-claim-failure", "/think high");
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
      },
      chatQueue: [item],
    });
    const admission = captureChatOutboxAdmission(host, host.sessionKey);
    expect(admitQueuedMessageForSession(host, admission, item)).toBe(true);
    let failedClaims = 0;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (value.includes(item.id) && value.includes('"unconfirmed"') && failedClaims === 0) {
        failedClaims += 1;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });

    await resumeStoredChatOutboxes(host);

    expect(failedClaims).toBe(1);
    expect(executeSlashCommandMock).not.toHaveBeenCalled();
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.id).toBe(item.id);
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
    const following = {
      id: "prompt-after-retried-command",
      text: "use the new thinking level",
      createdAt: 2,
      sessionKey: "agent:main",
    };
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
    const admission = captureChatOutboxAdmission(host, host.sessionKey);
    expect(admitQueuedMessageForSession(host, admission, item)).toBe(true);
    const followingAdmission = captureChatOutboxAdmission(host, host.sessionKey);
    expect(admitQueuedMessageForSession(host, followingAdmission, following)).toBe(true);

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
    const write = storage.setItem.bind(storage);
    let resetIssued = false;
    let failedBarrierWrites = 0;

    const clear = createQueuedLocalCommand("uncertain-clear-storage-barrier", "/clear");
    const successor = {
      id: "successor-storage-barrier",
      text: "must stay parked",
      createdAt: 2,
      sessionKey: "agent:main",
    };
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
    const clearAdmission = captureChatOutboxAdmission(host, host.sessionKey);
    expect(admitQueuedMessageForSession(host, clearAdmission, clear)).toBe(true);
    const successorAdmission = captureChatOutboxAdmission(host, host.sessionKey);
    expect(admitQueuedMessageForSession(host, successorAdmission, successor)).toBe(true);
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      const successorIndex = value.indexOf(`"id":"${successor.id}"`);
      const successorRecord =
        successorIndex >= 0 ? value.slice(successorIndex, successorIndex + 500) : "";
      if (
        resetIssued &&
        failedBarrierWrites === 0 &&
        successorRecord.includes('"sendState":"unconfirmed"')
      ) {
        failedBarrierWrites += 1;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });

    await resumeStoredChatOutboxes(host);

    expect(failedBarrierWrites).toBe(1);
    expect(requestCalls(host.request, "sessions.reset")).toHaveLength(1);
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([
      expect.objectContaining({ id: clear.id, sendState: "unconfirmed" }),
      expect.objectContaining({ id: successor.id }),
    ]);

    await resumeStoredChatOutboxes(host);

    expect(requestCalls(host.request, "sessions.reset")).toHaveLength(1);
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
    const id = sendingHost.chatQueue[0]?.id ?? "missing";
    const runId = sendingHost.chatQueue[0]?.sendRunId;
    staleHost.chatQueue = loadChatComposerSnapshot(staleHost, staleHost.sessionKey)?.queue ?? [];

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
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        sendAttempts: 1,
        sendState: "sending",
        text: "keep until durable retirement succeeds",
      }),
    ]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
    expect(host.applySettings).not.toHaveBeenCalled();
  });

  it("retains an ambiguous pre-ack send id when browser storage rejects recovery", async () => {
    const storage = createStorageMock();
    const setItem = storage.setItem.bind(storage);
    let rejectWrites = false;
    const setItemSpy = vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (rejectWrites) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      setItem(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    let attemptedRunId: unknown;
    let sendAttempts = 0;

    const replyTarget = {
      messageId: "reply-before-ack",
      text: "quoted body",
      senderLabel: "User",
    };
    const host = makeChatHost({
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
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        sendAttempts: 1,
        text: "> **User:** quoted body\n\nretry after reconnect",
        sendRunId: attemptedRunId,
        sendState: "waiting-reconnect",
      }),
    ]);
    expect(host.chatReplyTarget).toBeNull();
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );

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
    expect(host.chatQueue).toEqual([
      expect.objectContaining({ sendRunId: attemptedRunId, sendState: "sending" }),
    ]);
  });

  it("restores input when a volatile send fails before transport", async () => {
    installQuotaExceededStorage();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => {
          throw new Error("gateway not connected");
        },
      },
      chatMessage: "safe to restore",
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("safe to restore");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.request).toHaveBeenCalledTimes(1);
  });

  it("retains a connected attachment when browser quota rejects durable admission", async () => {
    installQuotaExceededStorage();
    const replyTarget = { messageId: "quota-quote", text: "Keep the rejected quote" };

    const attachment = {
      id: "large-connected-attachment",
      dataUrl: "data:application/pdf;base64,JVBERi0xLjQ=",
      fileName: "large.pdf",
      mimeType: "application/pdf",
      sizeBytes: 20 * 1024 * 1024,
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "volatile connected send payload");
          return { runId: payload.idempotencyKey, status: "started" };
        },
      },
      chatAttachments: [attachment],
      chatMessage: "send the large file",
      chatReplyTarget: replyTarget,
    });

    await handleSendChat(host);

    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.chatAttachments).toStrictEqual([attachment]);
    expect(host.chatMessage).toBe("send the large file");
    expect(host.chatReplyTarget).toEqual(replyTarget);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBeNull();
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
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
      const readStarted = createDeferred();
      const releaseRead = createDeferred();
      const pending: Array<ReturnType<typeof prepareOutboxPayload>> = [];
      const read = vi
        .spyOn(outboxPayloadStore, "readOutboxPayload")
        .mockImplementationOnce(async (...args) => {
          const result = await readPayload(...args);
          readStarted.resolve();
          await releaseRead.promise;
          return result;
        });
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
      "chat.send": (params: unknown) => ({
        runId: requireRecord(params, "migrated attachment send").idempotencyKey,
        status: "started",
      }),
    });
    const source = makeChatHost({ client: clientWithRequest(request) });
    const item: ChatQueueItem = {
      id: "inline-payload-retry",
      text: "migrate all attachments",
      createdAt: 1,
      attachments,
      sendRunId: "inline-payload-run",
      sendAttempts: 0,
      sendState: "waiting-reconnect",
      sessionKey: source.sessionKey,
    };
    const stopSource = chatOutboxOwner(source).subscribe(source);
    let stopRecovered = () => {};
    try {
      const admission = captureChatOutboxAdmission(source, source.sessionKey, item.agentId);
      expect(admitQueuedMessageForSession(source, admission, item)).toBe(true);
      vi.spyOn(outboxPayloadStore, "writeOutboxPayload").mockResolvedValueOnce({
        status: "failed",
        reason,
      });
      await resumeStoredChatOutboxes(source);
      expect(requestCalls(request, "chat.send")).toHaveLength(0);
      stopSource();
      releaseChatAttachmentPayloads(attachments);
      const readback = expectDefined(
        loadChatComposerSnapshot(source, source.sessionKey),
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
      const stored = expectDefined(
        loadChatComposerSnapshot(recovered, recovered.sessionKey)?.queue[0],
        "retried migrated attachment row",
      );
      expect(stored.attachmentPayload).toBeDefined();
      expect(stored.attachmentStorageError).toBeUndefined();
      const sends = requestCalls(request, "chat.send");
      expect(sends).toHaveLength(1);
      expect(requireRecord(sends[0]?.[1], "migration retry payload").attachments).toEqual(
        attachments.map((attachment, index) => ({
          type: attachment.mimeType.startsWith("image/") ? "image" : "file",
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
          content: dataUrls[index]!.split(",")[1],
        })),
      );
    } finally {
      stopRecovered();
      stopSource();
    }
  });

  it.each(["move", "remove", "edit"] as const)(
    "honors a queue %s while attachment hydration is pending",
    async (action) => {
      const { attachments, dataUrls } = createDeliveryAttachmentBatch();
      const request = makeRequestMock({
        "chat.history": () => idleChatHistory(),
        "chat.send": (params: unknown) => ({
          runId: requireRecord(params, "reordered attachment send").idempotencyKey,
          status: "ok",
          messageSeq: 1,
        }),
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
        const readPayload = outboxPayloadStore.readOutboxPayload;
        vi.spyOn(outboxPayloadStore, "readOutboxPayload").mockImplementationOnce(
          async (...args) => {
            const result = await readPayload(...args);
            readStarted.resolve();
            await releaseRead.promise;
            return result;
          },
        );
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
            attachments.map((attachment, index) => ({
              type: attachment.mimeType.startsWith("image/") ? "image" : "file",
              mimeType: attachment.mimeType,
              fileName: attachment.fileName,
              content: dataUrls[index]!.split(",")[1],
            })),
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

  it.each(["unavailable", "missing"] as const)(
    "keeps an uncertain send id across repeated %s payload retries",
    async (reason) => {
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
        chatMessage: "retain this uncertain attachment batch",
        chatAttachments: attachments,
      });
      const stopSource = chatOutboxOwner(source).subscribe(source);
      let stopRecovered = () => {};
      try {
        await handleSendChat(source);
        const original = expectDefined(
          loadChatComposerSnapshot(source, source.sessionKey)?.queue[0],
          "uncertain attachment send",
        );
        expect(original.sendAttempts).toBe(1);
        expect(source.chatRunId).toBeNull();
        stopSource();
        reloadChatDocumentStorage(attachments);
        const host = makeChatHost({ client: clientWithRequest(request) });
        const read = vi
          .spyOn(outboxPayloadStore, "readOutboxPayload")
          .mockResolvedValue({ status: "failed", reason });
        stopRecovered = chatOutboxOwner(host).subscribe(host);
        expect(host.chatQueue[0]?.attachments?.map(getChatAttachmentDataUrl)).toEqual([null, null]);
        await waitForFast(() =>
          expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue[0]).toMatchObject({
            attachmentStorageError: reason,
            sendState: "unconfirmed",
            sendRunId: original.sendRunId,
          }),
        );
        await resumeStoredChatOutboxes(host);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await retryQueuedChatMessage(host, original.id);
          expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue[0]).toMatchObject({
            attachmentStorageError: reason,
            sendState: "unconfirmed",
            sendRunId: original.sendRunId,
            sendAttempts: 1,
          });
          expect(wireAttempts).toBe(1);
        }
        read.mockRestore();
        await retryQueuedChatMessage(host, original.id);
        const stored = expectDefined(
          loadChatComposerSnapshot(host, host.sessionKey)?.queue[0],
          "recovered uncertain row",
        );
        expect(stored.attachmentStorageError).toBeUndefined();
        expect(stored.sendRunId).toBe(original.sendRunId);
        expect(stored.sendAttempts).toBe(2);
        const sends = requestCalls(request, "chat.send");
        expect(sends).toHaveLength(2);
        const resent = requireRecord(sends[1]?.[1], "same-id recovered attachment payload");
        expect(resent.idempotencyKey).toBe(original.sendRunId);
        expect(resent.attachments).toEqual(
          attachments.map((attachment, index) => ({
            type: attachment.mimeType.startsWith("image/") ? "image" : "file",
            mimeType: attachment.mimeType,
            fileName: attachment.fileName,
            content: dataUrls[index]!.split(",")[1],
          })),
        );
      } finally {
        stopRecovered();
        stopSource();
      }
    },
  );

  it.each(["agent:main:main", "main", "global"])(
    "retries an unconfirmed volatile send from %s with the same run id",
    async (sessionKey) => {
      installQuotaExceededStorage();
      const runIds: unknown[] = [];
      const targets: unknown[] = [];

      const host = makeChatHost({
        sessionKey,
        agentsList: { defaultId: "main", mainKey: "workspace", scope: "per-sender" },
        requestHandlers: {
          "chat.send": (params: unknown) => {
            const payload = requireRecord(params, "volatile retry payload");
            runIds.push(payload.idempotencyKey);
            targets.push(payload.sessionKey);
            if (runIds.length === 1) {
              throw new Error("gateway closed (1006): network lost");
            }
            return { runId: payload.idempotencyKey, status: "started" };
          },
        },
        chatMessage: "retry the oversized turn",
      });

      await handleSendChat(host);

      const itemId = host.chatQueue[0]?.id ?? "missing-volatile-retry";
      const originalRunId = host.chatQueue[0]?.sendRunId;
      expect(host.chatQueue).toEqual([
        expect.objectContaining({ sendRunId: originalRunId, sendState: "unconfirmed" }),
      ]);

      await resumeStoredChatOutboxes(host);
      expect(runIds).toEqual([originalRunId]);

      await retryQueuedChatMessage(host, itemId);

      expect(runIds).toEqual([originalRunId, originalRunId]);
      expect(targets).toEqual(
        Array(2).fill(sessionKey === "global" ? "global" : "agent:main:workspace"),
      );
      expect(host.chatQueue).toStrictEqual([]);
      expect(host.chatRunId).toBe(originalRunId);
      expect(
        host.chatMessages.map((message) => requireRecord(message, "retried transcript").role),
      ).toEqual(["user"]);
    },
  );

  it("retries a failed volatile send with a fresh run id", async () => {
    installQuotaExceededStorage();
    const firstAttempt = createDeferred<unknown>();
    const runIds: unknown[] = [];

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "failed volatile retry payload");
          runIds.push(payload.idempotencyKey);
          return runIds.length === 1
            ? firstAttempt.promise
            : Promise.resolve({ runId: payload.idempotencyKey, status: "started" });
        },
      },
      chatMessage: "retry after definite failure",
    });

    const sending = handleSendChat(host);
    await waitForFast(() => expect(host.request).toHaveBeenCalledOnce());
    host.chatMessage = "newer composer input";
    firstAttempt.reject(new Error("send rejected"));
    await sending;

    const itemId = host.chatQueue[0]?.id ?? "missing-failed-volatile-retry";
    expect(host.chatQueue[0]?.sendState).toBe("failed");
    expect(host.chatMessage).toBe("newer composer input");

    await retryQueuedChatMessage(host, itemId);

    expect(runIds).toHaveLength(2);
    expect(runIds[1]).not.toBe(runIds[0]);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatMessage).toBe("newer composer input");
  });

  it("keeps a pre-ack send queued when newer composer input blocks restoration", async () => {
    const storage = createStorageMock();
    const setItem = storage.setItem.bind(storage);
    let rejectWrites = false;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (rejectWrites) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      setItem(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const sent = createDeferred<unknown>();

    const host = makeChatHost({
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
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        text: "original send",
        sendAttempts: 1,
        sendState: "waiting-reconnect",
      }),
    ]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("restores an offline local command when durable admission fails", async () => {
    installQuotaExceededStorage();
    const replyTarget = { messageId: "command-quote", text: "Keep the rejected quote" };
    const host = makeChatHost({
      client: null,
      connected: false,
      chatMessage: "/think high",
      chatReplyTarget: replyTarget,
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("/think high");
    expect(host.chatReplyTarget).toEqual(replyTarget);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("retains cold-offline attachments until a recovery owner is known", async () => {
    installQuotaExceededStorage();
    const attachment = {
      id: "offline-attachment",
      mimeType: "image/png",
      fileName: "offline.png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AAA",
    };
    const host = makeChatHost({
      client: null,
      connected: false,
      chatAttachments: [attachment],
    });

    await handleSendChat(host);

    expect(host.chatAttachments).toEqual([attachment]);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.lastError).toBe(
      "Browser attachment storage is unavailable. Allow browser storage and close older dashboard tabs before reconnecting and retrying. No new message was sent.",
    );
  });

  it("keeps a reconnect send queued when attempt persistence fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () =>
          Promise.resolve({
            sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
          }),
      },
      connected: true,
      chatQueue: [
        {
          id: "queued-retry-storage-failure",
          text: "keep this queued message",
          createdAt: 1,
          sendRunId: "run-retry-storage-failure",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    await resumeStoredChatOutboxes(host);

    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: "queued-retry-storage-failure",
        sendState: "waiting-reconnect",
      }),
    ]);
    expect(host.chatQueue[0]?.sendAttempts).toBeUndefined();
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it.each(["waiting-reconnect", "unconfirmed"] as const)(
    "removes a %s send with history proof before stale local busy state blocks it",
    async (sendState) => {
      const host = makeChatHost({
        requestHandlers: {
          "chat.history": () =>
            Promise.resolve({
              messages: [
                {
                  role: "user",
                  __openclaw: { idempotencyKey: "ambiguous-run:user" },
                },
              ],
              sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
            }),
        },
        chatRunId: "ambiguous-run",
        chatQueue: [
          {
            id: "ambiguous-delivered",
            text: "already delivered",
            createdAt: 1,
            sendAttempts: 1,
            sendRunId: "ambiguous-run",
            sendState,
            sessionKey: "agent:main",
          },
        ],
      });
      admitHostQueueItems(host);

      await resumeStoredChatOutboxes(host);

      expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
      expect(host.chatQueue).toStrictEqual([]);
    },
  );

  it.each([
    { correlation: "completed run", active: false, retry: false },
    { correlation: "completed run during explicit retry", active: false, retry: true },
  ])(
    "retains reconnect payload with only $correlation correlation until consumption",
    async ({ active, retry }) => {
      const { attachments } = createDeliveryAttachmentBatch();
      const preview = createDeferred();
      let pendingPreview: ReturnType<typeof outboxPayloadStore.readOutboxPayload> | undefined;
      let runId = "";
      let recovering = false;
      let consumed = false;
      const request = makeRequestMock({
        "chat.send": (params: unknown) => {
          runId = String(requireRecord(params, "reconnect attachment send").idempotencyKey);
          return { runId, status: "started" };
        },
        "chat.history": () => {
          if (!recovering) {
            return idleChatHistory();
          }
          return {
            messages: [],
            inputReceipts: consumed
              ? [{ runId, state: "consumed", consumedByEventId: "persisted-user" }]
              : [],
            sessionInfo: row("agent:main", {
              hasActiveRun: active,
              status: active ? "running" : "done",
              ...(active ? { activeRunIds: [runId] } : { lastRunId: runId }),
            }),
          };
        },
      });
      sessionStorage.setItem("openclaw.control.outboxTab.v1", "test-outbox-tab");
      const source = makeChatHost({
        client: clientWithRequest(request),
        chatMessage: "keep my admitted message visible",
        chatAttachments: attachments,
      });
      const stopSource = chatOutboxOwner(source).subscribe(source);
      let stopRecovered = () => {};
      try {
        await handleSendChat(source);
        const stored = expectDefined(
          loadChatComposerSnapshot(source, source.sessionKey)?.queue[0],
          "Blob-backed reconnect send",
        );
        const reference = expectDefined(stored.attachmentPayload, "reconnect payload reference");
        markQueuedChatSendsWaitingForReconnect(source);
        if (retry) {
          const unconfirmed: typeof stored = { ...stored, sendState: "unconfirmed" };
          expect(
            updateStoredChatComposerQueueItems(
              source,
              source.sessionKey,
              [{ expected: stored, next: unconfirmed }],
              stored.agentId,
            ),
          ).toBe(true);
        }
        stopSource();
        reloadChatDocumentStorage(attachments);
        recovering = true;
        const host = makeChatHost({
          client: clientWithRequest(request),
          chatMessagesBySession: new Map(),
        });
        const readPayload = outboxPayloadStore.readOutboxPayload;
        const read = vi
          .spyOn(outboxPayloadStore, "readOutboxPayload")
          .mockImplementationOnce((...args) => {
            pendingPreview = preview.promise.then(() => readPayload(...args));
            return pendingPreview;
          });
        stopRecovered = chatOutboxOwner(host).subscribe(host);
        await waitForFast(() => expect(read).toHaveBeenCalledTimes(1));
        if (retry) {
          // An explicit resend needs the attachment bytes. Passive consumption
          // below is the separate path that must not wait for preview hydration.
          preview.resolve();
          await pendingPreview;
          await retryQueuedChatMessage(host, stored.id);
        } else {
          await resumeStoredChatOutboxes(host);
        }

        expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
          id: stored.id,
          attachmentPayload: reference,
          sendRunId: runId,
        });
        await expect(
          readPayload(
            {
              tabId: reference.tabId,
              gatewayOwner: "default",
              recoveryScope: "test-recovery-scope",
              queueId: stored.id,
            },
            reference,
          ),
        ).resolves.toMatchObject({ status: "ready" });
        expect(requestCalls(request, "chat.send")).toHaveLength(retry ? 2 : 1);

        // Consumption retires retry bytes without resurrecting a source absent
        // from the current transcript page, even while preview hydration waits.
        consumed = true;
        await resumeStoredChatOutboxes(host);

        expect(listStoredChatOutboxes(host)).toStrictEqual([]);
        expect(host.chatQueue).toStrictEqual([]);
        expect(host.chatMessages).toEqual([]);
        expect(host.lastError).toBeNull();
        expect(host.chatError).toBeNull();
        expect(requestCalls(request, "chat.send")).toHaveLength(retry ? 2 : 1);
        await expect(
          readPayload(
            {
              tabId: reference.tabId,
              gatewayOwner: "default",
              recoveryScope: "test-recovery-scope",
              queueId: stored.id,
            },
            reference,
          ),
        ).resolves.toEqual({ status: "failed", reason: "missing" });
      } finally {
        preview.resolve();
        await pendingPreview;
        stopRecovered();
        stopSource();
      }
    },
  );

  it.each([
    { state: "queued", sessionKey: "agent:work:background", agentId: "work" },
    { state: "interrupted", sessionKey: "global", agentId: "work" },
    { state: "cancelled", sessionKey: "agent:work:background", agentId: "work" },
    { state: "queued", sessionKey: "agent:main:visible", agentId: "main" },
  ])("retains $state custody in $sessionKey until consumption or cancellation", async (target) => {
    const visible = target.sessionKey === "agent:main:visible";
    const physicalSessionId = visible ? "accepted-physical-session" : "visible-physical-session";
    let historyReads = 0;
    let consumed = false;
    const currentMessages = [{ role: "assistant", content: "The visible conversation" }];
    const host = makeChatHost({
      sessionKey: "agent:main:visible",
      currentSessionId: physicalSessionId,
      chatMessages: currentMessages,
      chatRunId: "visible-run",
      chatStream: "Still working",
      requestHandlers: {
        "chat.history": () => {
          if (++historyReads > 1 && !consumed) {
            throw new Error("History refresh unavailable");
          }
          return {
            sessionId: "accepted-physical-session",
            messages: [],
            sessionInfo: row(target.sessionKey, {
              sessionId: "accepted-physical-session",
              hasActiveRun: true,
              status: "running",
            }),
            pendingInputs: {
              items: consumed
                ? []
                : [
                    {
                      id: "accepted-input",
                      runId: "accepted-source",
                      acceptedAt: 1,
                      state: target.state,
                      message: { role: "user", content: "Keep this accepted source" },
                    },
                  ],
              total: consumed ? 0 : 1,
            },
            inputReceipts: [
              consumed
                ? {
                    runId: "accepted-source",
                    state: "consumed",
                    consumedByEventId: "accepted-user-message",
                  }
                : { runId: "accepted-source", state: "pending" },
            ],
          };
        },
      },
      chatQueue: [
        {
          id: "accepted-source-outbox",
          text: "Keep this accepted source",
          createdAt: 1,
          sendRunId: "accepted-source",
          sendAttempts: 1,
          sendState: "waiting-reconnect",
          sessionId: "accepted-physical-session",
          sessionKey: target.sessionKey,
          agentId: target.agentId,
        },
      ],
    });
    admitHostQueueItems(host);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sessionId).toBe("accepted-physical-session");

    await resumeStoredChatOutboxes(host);

    if (target.state === "cancelled") {
      expect(listStoredChatOutboxes(host)).toEqual([]);
    } else {
      expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([
        expect.objectContaining({
          id: "accepted-source-outbox",
          text: "Keep this accepted source",
          sendRunId: "accepted-source",
        }),
      ]);
    }
    expect(host.chatMessages).toBe(currentMessages);
    expect(host.currentSessionId).toBe(physicalSessionId);
    expect(host.chatRunId).toBe("visible-run");
    expect(host.chatStream).toBe("Still working");
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      {
        sessionKey: target.sessionKey,
        ...(target.sessionKey === "global" ? { agentId: "work" } : {}),
        limit: 1000,
        inputRunIds: ["accepted-source"],
      },
      { timeoutMs: 30_000 },
    );
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
      timeoutMs: 30_000,
    });
    if (visible) {
      expect(historyReads).toBe(1);
      expect(getChatPendingInputs(host)?.page.items).toEqual([
        expect.objectContaining({ id: "accepted-input", state: target.state }),
      ]);
    } else {
      expect(getChatPendingInputs(host)).toBeUndefined();
    }
    if (target.state !== "cancelled") {
      consumed = true;
      await resumeStoredChatOutboxes(host);
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
        timeoutMs: 30_000,
      });
    }
  });

  it.each(["ok replay", "replacement session"])(
    "retires a collected source through consumption history on %s",
    async (recovery) => {
      let replayed = false;
      const source = {
        id: "collected-source",
        text: "The accepted source",
        createdAt: 1,
        sendRunId: "collected-source-run",
        sendAttempts: 1,
        sendState: "unconfirmed" as const,
        queueMode: "collect" as const,
        sessionKey: "agent:main:collected",
        sessionId: "collected-physical-session",
        ...(recovery === "replacement session"
          ? { intent: { kind: "session-goal-start" as const, version: 1 as const, issuedAtMs: 1 } }
          : {}),
        sender: { id: "author", name: "Author" },
        replyToId: "reply",
      };
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
        sessionKey: source.sessionKey,
        currentSessionId: source.sessionId,
        chatHistoryPagination: { hasMore: false, completeSnapshot: true },
        chatMessages: [aggregate],
        chatQueue: [source],
        requestHandlers: {
          "chat.send": () => {
            replayed = true;
            return { runId: source.sendRunId, status: "ok" };
          },
          "chat.history": () => ({
            sessionId: recovery === "replacement session" ? "replacement" : source.sessionId,
            messages: [aggregate],
            pendingInputs: { items: [], total: 0 },
            inputReceipts:
              recovery === "ok replay" && !replayed
                ? []
                : [
                    {
                      runId: source.sendRunId,
                      state: "consumed",
                      consumedByEventId: "aggregate",
                    },
                  ],
            sessionInfo: row(source.sessionKey, {
              sessionId: recovery === "replacement session" ? "replacement" : source.sessionId,
              hasActiveRun: false,
              status: "done",
              lastRunId: "aggregate-run",
            }),
          }),
        },
      });
      admitHostQueueItems(host);
      if (recovery === "replacement session") {
        // Structured admissions retain a physical-session binding in the durable outbox.
        expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
          sessionId: source.sessionId,
        });
      }
      if (recovery === "ok replay") {
        await retryQueuedChatMessage(host, source.id);
      } else {
        await resumeStoredChatOutboxes(host);
      }
      if (recovery === "replacement session") {
        expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([
          expect.objectContaining({ id: source.id }),
        ]);
        expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
          timeoutMs: 30_000,
        });
        return;
      }
      await waitForFast(() => {
        expect(listStoredChatOutboxes(host)).toEqual([]);
        expect(host.chatQueue).toEqual([]);
        expect(host.chatMessages).toEqual([aggregate]);
      });
      expect(getChatPendingInputs(host)?.page.items ?? []).toEqual([]);
      expect(requestCalls(host.request, "chat.send")).toHaveLength(
        recovery === "ok replay" ? 1 : 0,
      );
      expect(host.request).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({
          inputRunIds: [source.sendRunId],
        }),
        { timeoutMs: 30_000 },
      );
    },
  );

  it("stops delivered-send reconciliation when durable removal fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const remove = storage.removeItem.bind(storage);

    const item = {
      id: "delivered-removal-failure",
      text: "already delivered but still durable",
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: "delivered-removal-failure",
      sendState: "waiting-reconnect" as const,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () =>
          Promise.resolve({
            messages: [
              {
                role: "user",
                __openclaw: { idempotencyKey: "delivered-removal-failure:user" },
              },
            ],
            sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
          }),
      },
      chatQueue: [item],
    });
    admitHostQueueItems(host);
    let failedDeletes = 0;
    vi.spyOn(storage, "removeItem").mockImplementation((key) => {
      if (failedDeletes === 0) {
        failedDeletes += 1;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      remove(key);
    });

    await resumeStoredChatOutboxes(host);

    expect(requestCalls(host.request, "chat.history")).toHaveLength(1);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    expect(failedDeletes).toBe(1);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.id).toBe(item.id);
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
    expect(payload.sessionKey).toBe("global");
    expect(payload.agentId).toBe("work");
    expect(loadChatComposerSnapshot({ ...host, assistantAgentId: "main" }, "global")).toBeNull();
    expect(
      loadChatComposerSnapshot({ ...host, assistantAgentId: "work" }, "global")?.queue,
    ).toEqual([expect.objectContaining({ sendAttempts: 1, sendState: "waiting-reconnect" })]);
  });

  it("marks saved session queued sends waiting after a disconnect", () => {
    const host = makeChatHost({ requestHandlers: {}, chatQueue: [] });
    keepVolatileQueuedMessage(host, "agent:a", {
      id: "pending-send-a",
      text: "pending",
      createdAt: 1,
      sendRunId: "run-a",
      sendState: "sending",
      sessionKey: "agent:a",
    });

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
        {
          id: "earlier-row",
          text: "first message",
          createdAt: 1,
          sendAttempts: 0,
          sendRunId: "earlier-run",
          sendState: "waiting-idle",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    await handleSendChat(host);

    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ message: "second message" });
    expect(sends[1]).toMatchObject({ expectedLeafEntryId: "leaf-before-queue" });
  });

  it("parks an active-leaf rejection inline and refreshes branch state", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "active branch changed; review and resend",
            details: { reason: "active-leaf-changed" },
          });
        },
        "chat.history": idleChatHistory(),
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
          limit: 80,
          maxBytes: 256 * 1024,
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
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        sendError: "The session switched branches — review and resend.",
        sendState: "failed",
      }),
    ]);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  });

  it("clears chat state when /clear resets chat history", async () => {
    const host = makeChatHost({
      agentsList: { defaultId: "main", mainKey: "main" },
      requestHandlers: {
        "sessions.reset": { ok: true },
        "chat.history": {
          messages: [],
          thinkingLevel: null,
          sessionInfo: { activeLeafEntryId: null },
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "post-clear send payload");
          return { runId: payload.idempotencyKey, status: "started" };
        },
      },
      sessionKey: "main",
      chatDisplayedLeafEntryId: "leaf-before-clear",
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "hello", timestamp: 1 }],
      chatRunError: { summary: "Error: previous run failed" },
    });

    await handleSendChat(host);

    expect(host.request).toHaveBeenCalledWith("sessions.reset", { key: "main" });
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatRunError).toBeNull();
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatDisplayedLeafEntryId).toBeUndefined();

    host.chatMessage = "after clear";
    await handleSendChat(host);

    expect(findRequestPayload(host.request, "chat.send", "post-clear send")).not.toHaveProperty(
      "expectedLeafEntryId",
    );
  });

  it("scopes /clear resets for selected-agent global sessions", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": { ok: true },
        "chat.history": { messages: [], thinkingLevel: null },
      },
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "hello", timestamp: 1 }],
      chatMessagesBySession: new Map(),
    });
    const cache = requireChatMessageCache(host);
    cacheChatMessages(cache, host, { sessionKey: "global", agentId: "work" }, [
      { role: "assistant", content: "work history" },
    ]);
    cacheChatMessages(cache, host, { sessionKey: "global", agentId: "main" }, [
      { role: "assistant", content: "main history" },
    ]);

    await handleSendChat(host);

    expect(host.request).toHaveBeenCalledWith("sessions.reset", {
      key: "global",
      agentId: "work",
    });
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      {
        sessionKey: "global",
        agentId: "work",
        limit: 80,
        maxBytes: 256 * 1024,
      },
      { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
    );
    expect(host.chatMessages).toStrictEqual([]);
    expect(
      host.chatMessagesBySession?.has(
        resolveChatSnapshotKey(host, { sessionKey: "global", agentId: "work" }),
      ),
    ).toBe(false);
    expect(
      host.chatMessagesBySession?.has(
        resolveChatSnapshotKey(host, { sessionKey: "global", agentId: "main" }),
      ),
    ).toBe(true);
  });

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
          limit: 80,
          maxBytes: 256 * 1024,
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

  it("shows a visible pending item for /steer on the active run", async () => {
    const host = makeChatHost({
      client: clientWithRequest(
        makeRequestMock({
          "chat.send": { status: "started", runId: "run-1", messageSeq: 2 },
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

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("/steer tighten the plan");
    expect(host.chatQueue[0]?.pendingRunId).toBe("run-1");
  });

  it("sends a queued row through the generic outbox with only its durable steer mode", async () => {
    const ack = createDeferred<unknown>();
    const original = {
      id: "queued-steer",
      text: "tighten the plan",
      createdAt: 1,
      sendRunId: "stable-steer-send",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:main",
      agentId: "main",
    };
    const host = makeChatHost({
      requestHandlers: { "chat.send": () => ack.promise },
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: original.sessionKey,
    });
    const originalAdmission = captureChatOutboxAdmission(host, host.sessionKey, original.agentId);
    expect(admitQueuedMessageForSession(host, originalAdmission, original)).toBe(true);

    const sending = steerQueuedChatMessage(host, original.id);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("chat.send", expect.anything(), {
        timeoutMs: 30_000,
      }),
    );

    const payload = findRequestPayload(host.request, "chat.send", "queued steer payload");
    expect(payload).toMatchObject({
      sessionKey: original.sessionKey,
      message: original.text,
      queueMode: "steer",
      idempotencyKey: original.sendRunId,
    });
    expect(payload).not.toHaveProperty("expectedRunId");
    expect(payload).not.toHaveProperty("expectedLeafEntryId");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: original.id,
        queueMode: "steer",
        sendRunId: original.sendRunId,
        sendState: "sending",
      }),
    ]);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue).toEqual([
      expect.objectContaining({
        id: original.id,
        queueMode: "steer",
        sendRunId: original.sendRunId,
        sendState: "waiting-reconnect",
      }),
    ]);

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
      { id: "queued", text: "later", createdAt: 1, attachments: [attachment] },
      { id: "sibling", text: "keep me", createdAt: 2 },
    ]) {
      keepVolatileQueuedMessage(host, host.sessionKey, item);
    }
    expect(getChatAttachmentPreviewUrl(attachment)).toBe("blob:queued");

    expect(removeQueuedMessage(host, "queued")).toBe("removed");
    expect(removeQueuedMessage(host, "queued")).toBe("absent");

    expect(host.chatQueue).toEqual([expect.objectContaining({ id: "sibling" })]);
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:queued");
  });

  it.each([0, 1])(
    "settles a non-retryable head reconciliation with %s previous sends",
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
          ...(!sendAttempts
            ? {
                "chat.send": (params: unknown) => {
                  const payload = requireRecord(params, "post-unblock send payload");
                  sends.push(String(payload.message));
                  return { runId: payload.idempotencyKey, status: "ok" };
                },
              }
            : {}),
        },
        chatQueue: [
          {
            id: "wedged-head",
            text: "head the gateway rejects",
            createdAt: 1,
            sendAttempts,
            sendRunId: "wedged-head-run",
            sendState: sendAttempts ? "waiting-reconnect" : "waiting-idle",
            sessionKey: "agent:main",
          },
          ...(!sendAttempts
            ? [
                {
                  id: "queued-behind-head",
                  text: "message stuck behind the head",
                  createdAt: 2,
                  sendAttempts: 0,
                  sendRunId: "queued-behind-run",
                  sendState: "waiting-idle" as const,
                  sessionKey: "agent:main",
                },
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
      if (sendAttempts) {
        expect(host.lastError).toBeNull();
        expect(stored.find((entry) => entry.id === "wedged-head")).toMatchObject({
          sendState: "unconfirmed",
          sendError:
            "Delivery has not been confirmed. Check the conversation — retry only if your message didn't arrive.",
        });
        expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
      } else {
        expect(surfacedErrors).toContain("gateway auth failed");
        expect(stored.find((entry) => entry.id === "wedged-head")).toMatchObject({
          sendState: "failed",
          sendError: "gateway auth failed",
        });
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

    // Pre-fix: the failure was recorded on the queue item with no visible outcome.
    expect(host.lastError).toBeNull();
    await waitForFast(() => expect(document.body.textContent).toContain("Command /think failed."));
    expect(listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue)).toEqual([
      expect.objectContaining({ id: item.id, sendState: "failed" }),
    ]);
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
        {
          id: "global-agent-scoped-failure",
          text: "fails on the second agent's global session",
          createdAt: 1,
          sendAttempts: 0,
          sendRunId: "global-agent-scoped-run",
          sendState: "waiting-idle",
          sessionKey: "global",
          agentId: "writer",
        },
      ],
      sessionKey: "agent:main:elsewhere",
      sessionsResult: createSessionsResult([
        row("global", { agentId: "main", label: "Main global chat" }),
        row("global", { agentId: "writer", label: "Writer global chat" }),
      ]),
    });
    admitHostQueueItems(host);

    await resumeStoredChatOutboxes(host);

    await waitForFast(() => expect(document.body.textContent).toContain("gateway auth failed"));
    // Global rows share one key; the toast must borrow the failed agent's label.
    expect(document.body.textContent).toContain("Writer global chat");
    expect(document.body.textContent).not.toContain("Main global chat");
    document.body.replaceChildren();
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
