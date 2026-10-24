import { expect, onTestFinished, vi } from "vitest";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { UiSettings } from "../../app/settings.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestMock,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatComposerMemoryFallback } from "./chat-state-host.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";

type RequestHandlers = Record<string, unknown>;

export function makeRequestMock(handlers: RequestHandlers = {}): GatewayRequestMock {
  return createGatewayRequestMock((method: string, params?: unknown) => {
    if (!Object.hasOwn(handlers, method)) {
      // Keep unrelated Gateway traffic inert so each test declares only the responses it observes.
      return Promise.resolve(method === "models.list" ? { models: [] } : {});
    }
    try {
      const handler = handlers[method];
      const response = typeof handler === "function" ? handler(params) : handler;
      return Promise.resolve(response);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

type RequestMock = ReturnType<typeof makeRequestMock>;

type MockCallSource<Call extends ReadonlyArray<unknown> = ReadonlyArray<unknown>> = {
  mock: {
    calls: ArrayLike<Call>;
  };
};

export function requestCalls<Call extends ReadonlyArray<unknown>>(
  source: MockCallSource<Call>,
  method: string,
): Call[] {
  return Array.from(source.mock.calls).filter(([calledMethod]) => calledMethod === method);
}

export function expectRequestCounts(request: MockCallSource, counts: Record<string, number>) {
  for (const [method, count] of Object.entries(counts)) {
    expect(requestCalls(request, method)).toHaveLength(count);
  }
}

export function expectRpc(
  request: unknown,
  method: string,
  payload: unknown = expect.anything(),
): void {
  expect(request).toHaveBeenCalledWith(
    method,
    payload,
    method === "chat.send"
      ? {
          timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS,
          signal: expect.any(AbortSignal),
          retainSentResultOnAbort: true,
        }
      : { timeoutMs: 30_000 },
  );
}

export function expectNoRpc(
  request: unknown,
  method: string,
  payload: unknown = expect.anything(),
): void {
  expect(request).not.toHaveBeenCalledWith(method, payload, expect.anything());
}

export const requireRecord = createRequireRecord("object", "expected-label");

export function findRequestPayload(source: MockCallSource, method: string, label: string) {
  const call = Array.from(source.mock.calls).find((candidate) => candidate[0] === method);
  if (!call) {
    throw new Error(`expected request call: ${label}`);
  }
  return requireRecord(call[1], label);
}

export function createBrowserAnnotationAttachment(
  id: string,
  modelContext: string,
): ChatAttachment {
  return {
    id,
    dataUrl: "data:image/png;base64,aQ==",
    mimeType: "image/png",
    browserAnnotation: {
      modelContext,
      title: `Page ${id}`,
      displayUrl: `https://example.com/${id}`,
      markedRegionCount: 1,
      inspectedElement: false,
    },
  };
}

export function findChatSendPayload(host: {
  request: { mock: { calls: ReadonlyArray<Readonly<Parameters<GatewayRequestHandler>>> } };
}): Record<string, unknown> {
  return findRequestPayload(host.request, "chat.send", "chat.send payload");
}

function composerDefaults(chatMessage = "", chatAttachments: ChatAttachment[] = []) {
  return {
    connected: true,
    sessionKey: "agent:main",
    chatLoading: false,
    chatMessage,
    chatMessages: [],
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    chatAttachments,
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatModelCatalog: [],
    refreshSessionsAfterChat: new Map(),
  };
}

export function createImmediateCommandHost(
  command: string,
  attachment: ChatAttachment,
  overrides: Partial<ChatHost> = {},
): ChatHost {
  const host = {
    ...composerDefaults(command, [attachment]),
    sessions: createTestSessionCapability({
      snapshot: { client: null, phase: "reconnecting", hello: null },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    }),
    client: null,
    hello: null,
    ...overrides,
  } satisfies Partial<ChatHost>;
  return host as ChatHost;
}

type TestChatHost = ChatHost & {
  selectedChatSessionIncognito: boolean;
  basePath: string;
  resourceBasePath: string;
  chatAvatarUrl: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarReason?: string | null;
  chatComposerFallbackByScope: Record<string, ChatComposerMemoryFallback>;
  chatModelSwitchPromises?: Record<string, Promise<boolean>>;
  sessionsError?: string | null;
  sessionsArchivedFilter?: "active" | "archived" | "all";
  password?: string;
  pendingSettingsPatches?: Record<string, Promise<boolean>>;
};

function createPendingSettingsSessionCapability(
  sessions: ChatHost["sessions"],
  pendingSettingsPatches: Record<string, Promise<boolean>>,
): ChatHost["sessions"] {
  const pendingBySession = new Map(Object.entries(pendingSettingsPatches));
  const wrapped = Object.create(sessions) as ChatHost["sessions"];
  wrapped.patch = async (sessionKey, patch, options) => {
    const pendingPatch = pendingBySession.get(sessionKey);
    if (!pendingPatch) {
      return sessions.patch(sessionKey, patch, options);
    }
    pendingBySession.delete(sessionKey);
    if (!(await pendingPatch)) {
      return null;
    }
    return {
      ok: true,
      path: "",
      key: sessionKey,
      entry: { sessionId: "pending-settings-test" },
    };
  };
  return wrapped;
}

type TestChatHostWithRequest = TestChatHost & { request: RequestMock };
type MakeHostOverrides = Partial<Omit<TestChatHost, "settings">> & {
  requestHandlers?: RequestHandlers;
  settings?: Partial<UiSettings>;
};

export function makeChatHost(
  overrides: MakeHostOverrides & { requestHandlers: RequestHandlers },
): TestChatHostWithRequest;
export function makeChatHost(overrides?: MakeHostOverrides): TestChatHost;
export function makeChatHost(
  overrides?: MakeHostOverrides,
): TestChatHost | TestChatHostWithRequest {
  const { requestHandlers, ...hostOverrides } = overrides ?? {};
  const request = requestHandlers ? makeRequestMock(requestHandlers) : undefined;
  const settings = { lastActiveSessionKey: "", ...hostOverrides.settings };
  let disposed = false;
  const pendingEffects = new Set<() => void>();
  const renderLifecycle: Pick<RenderLifecycle, "afterCommit"> = {
    afterCommit: (effect, onCancel) => {
      if (disposed) {
        onCancel?.();
        return () => undefined;
      }
      let cleanup = onCancel;
      const complete = () => {
        cleanup = undefined;
        pendingEffects.delete(cancel);
      };
      const cancel = () => {
        if (pendingEffects.delete(cancel)) {
          const release = cleanup;
          cleanup = undefined;
          release?.();
        }
      };
      pendingEffects.add(cancel);
      queueMicrotask(() => {
        if (!pendingEffects.has(cancel)) {
          return;
        }
        cleanup = undefined;
        try {
          const nextCleanup = effect(complete);
          if (typeof nextCleanup === "function") {
            if (pendingEffects.has(cancel)) {
              cleanup = nextCleanup;
            } else {
              nextCleanup();
            }
          } else {
            complete();
          }
        } catch (error) {
          complete();
          throw error;
        }
      });
      return cancel;
    },
  };
  const host = {
    ...composerDefaults(),
    selectedChatSessionIncognito: false,
    chatSubmissions: createChatSubmissions(),
    client: request ? createTestGatewayClient(request) : null,
    chatDisplayedLeafEntryId: undefined,
    chatStreamSegments: [],
    chatToolMessages: [],
    connectionEpoch: 0,
    canRestoreComposer: () => true,
    chatVerboseLevel: null,
    chatComposerFallbackByScope: {},
    chatStreamStartedAt: null,
    lastError: null,
    sidebarLayout: { columns: [] },
    basePath: "",
    resourceBasePath: "",
    hello: sessionMutationGatewayHello(),
    chatAvatarUrl: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    sessionsLoading: false,
    sessionsResult: null,
    sessionsResultAgentId: null,
    sessionsError: null,
    sessionsArchivedFilter: "active" as const,
    chatModelsLoading: false,
    chatModelCatalogError: null,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    renderLifecycle,
    querySelector: () => null,
    chatLastScrollTop: 0,
    chatLastScrollHeight: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatReadingHistory: false,
    chatNewMessagesBelow: false,
    applySettings: vi.fn((patch: Partial<UiSettings>) => {
      // Chat pages own display/layout settings; active-session persistence belongs to pane bindings.
      const next = { ...settings, ...patch };
      Object.assign(settings, {
        chatShowThinking: next.chatShowThinking,
        chatShowToolCalls: next.chatShowToolCalls,
        chatPersistCommentary: next.chatPersistCommentary,
        chatSendShortcut: next.chatSendShortcut,
        chatBubbleSessionKeys: next.chatBubbleSessionKeys,
        chatBubbleDisabledSessionKeys: next.chatBubbleDisabledSessionKeys,
      });
    }),
    ...hostOverrides,
    settings,
  };
  const sessions =
    hostOverrides.sessions ??
    createTestSessionCapability({
      snapshot: {
        client: host.client,
        phase: host.connected ? "connected" : "reconnecting",
        hello: host.hello,
        sessionKey: host.sessionKey,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });
  for (const session of host.sessionsResult?.sessions ?? []) {
    sessions.reconcile(session, host.sessionsResult?.defaults, {
      selectedGlobalAgentId: host.assistantAgentId,
      archivedFilter: host.sessionsArchivedFilter,
    });
  }
  const pendingSettingsPatches = hostOverrides.pendingSettingsPatches;
  const resolvedSessions = pendingSettingsPatches
    ? createPendingSettingsSessionCapability(sessions, pendingSettingsPatches)
    : sessions;
  const resolvedHost = { ...host, sessions: resolvedSessions } as TestChatHost;
  for (const sessionKey of Object.keys(pendingSettingsPatches ?? {})) {
    void patchChatSessionSettings(resolvedHost, sessionKey, {}).catch(() => undefined);
  }
  onTestFinished(() => {
    disposed = true;
    for (const cancel of pendingEffects) {
      cancel();
    }
  });
  return request ? Object.assign(resolvedHost, { request }) : resolvedHost;
}
