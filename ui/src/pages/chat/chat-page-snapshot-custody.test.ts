/* @vitest-environment jsdom */

import { ContextProvider } from "@lit/context";
import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { applicationContext } from "../../app/context.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../../lib/sessions/route-navigation.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { stubMatchMedia } from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { nativeHistoryMessage, type TestChatPane } from "./chat-pane.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { loadChatRoute } from "./route-loader.ts";
import {
  readChatSessionSnapshot,
  resolveChatSnapshotKey,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  stubMatchMedia(false);
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTranscriptTestDom();
});

it.each([false, true])(
  "admits a real ChatPage's stored global snapshot only for its selected agent (changes: %s)",
  async (changeAgent) => {
    const mainSnapshot: ChatSessionSnapshot = {
      messages: [nativeHistoryMessage(1, "Main agent's stored transcript")],
      pagination: { hasMore: true, nextOffset: 1, totalMessages: 3 },
      sessionId: "main-stored-session",
    };
    const researchSnapshot: ChatSessionSnapshot = {
      messages: [nativeHistoryMessage(1, "Research agent's stored transcript")],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "research-stored-session",
    };
    const writer = new SessionSnapshotStore();
    writer.write("agent:main:main", mainSnapshot);
    writer.write("agent:research:main", researchSnapshot);
    await writer.flush();
    const h = createMountedPanes([]);
    const context = h.context;
    const client = expectDefined(context.gateway.snapshot.client, "fixture client");
    const originalRequest = client.request.bind(client);
    const routedClient = createTestGatewayClient(async (method, params, options) => {
      if (method === "agents.list") {
        return {
          defaultId: "main",
          mainKey: "main",
          scope: "global",
          agents: [{ id: "main" }, { id: "research" }],
        };
      }
      if (method === "sessions.resolve") {
        return {
          ok: true,
          key: "global",
          agentId: "main",
          kind: "global",
          boardFace: "chat",
        };
      }
      return originalRequest(method, params, options);
    });
    vi.spyOn(client, "request").mockImplementation(routedClient.request.bind(routedClient));
    const router = createRouter({ routes: [] });
    const lifecycle = new AbortController();
    Object.assign(context, {
      basePath: "",
      router,
      lifecycleAbortSignal: lifecycle.signal,
      navigate: vi.fn(),
      replace: vi.fn(),
    });
    h.pane.applyGatewaySnapshot({
      ...context.gateway.snapshot,
      hello: {
        ...expectDefined(context.gateway.snapshot.hello, "fixture hello"),
        snapshot: {
          sessionDefaults: { defaultAgentId: "main", mainKey: "main", mainSessionKey: "global" },
        },
      },
    });
    await context.agents.refreshList();
    const route = await loadChatRoute(
      context,
      {
        pathname: "/chat/main",
        search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
        hash: "",
      },
      "chat",
      lifecycle.signal,
    );
    expect(route).toMatchObject({ kind: "session", sessionKey: "global" });
    if (!("kind" in route) || route.kind !== "session") {
      throw new Error("Expected the supported global chat route");
    }
    h.pane.applyGatewaySnapshot({ ...context.gateway.snapshot, phase: "stopped", client: null });
    const entered = createDeferred();
    const release = createDeferred();
    // oxlint-disable-next-line typescript/unbound-method -- Rebound to the original page-store receiver below.
    const originalRead = SessionSnapshotStore.prototype.read;
    vi.spyOn(SessionSnapshotStore.prototype, "read").mockImplementation(async function (
      this: SessionSnapshotStore,
      key,
      onPrewarm,
    ) {
      const snapshot = await originalRead.call(this, key, onPrewarm);
      if (key === "agent:main:main") {
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    });
    const page = new ChatPage();
    Object.assign(page, { context });
    const provider = new ContextProvider(page, { context: applicationContext });
    provider.setValue(context);
    page.data = route;
    let pane: TestChatPane | undefined;
    try {
      document.body.append(page);
      await page.updateComplete;
      pane = expectDefined(page.querySelector<TestChatPane>("openclaw-chat-pane"), "rendered pane");
      expect(pane.state).toBeDefined();
      expect(chatHistoryRequests(pane.state).initialSnapshotHydration).toBeDefined();
      await entered.promise;
      expect((pane as TestChatPane & { agentId?: string }).agentId).toBeUndefined();
      const state = pane.state;
      expect(state.sessionKey).toBe("global");
      expect(state.assistantAgentId).toBe("main");
      const hydration = expectDefined(
        chatHistoryRequests(state).initialSnapshotHydration,
        "stored hydration",
      );
      if (changeAgent) {
        context.agentSelection.set("research");
      }
      expect(page.querySelector("openclaw-chat-pane")).toBe(pane);
      expect(pane.state).toBe(state);
      expect(state.assistantAgentId).toBe(changeAgent ? "research" : "main");
      expect(resolveChatSnapshotKey(state, { sessionKey: "global" })).toBe(
        changeAgent ? "agent:research:main" : "agent:main:main",
      );
      const sessionBefore = state.currentSessionId;
      const paginationBefore = state.chatHistoryPagination;
      release.resolve();
      await hydration.promise;
      expect.soft(state.chatMessages).toEqual(changeAgent ? [] : mainSnapshot.messages);
      expect
        .soft(state.currentSessionId)
        .toBe(changeAgent ? sessionBefore : mainSnapshot.sessionId);
      expect
        .soft(state.chatHistoryPagination)
        .toEqual(changeAgent ? paginationBefore : mainSnapshot.pagination);
      expect
        .soft(readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey: "global" }))
        .toEqual(changeAgent ? null : mainSnapshot);
      await pane.sessionSnapshotStore?.flush();
      expect(await originalRead.call(writer, "agent:research:main")).toEqual(researchSnapshot);
    } finally {
      release.resolve();
      page.remove();
      await pane?.sessionSnapshotStore?.whenIdle();
      lifecycle.abort();
      router.stop();
      routedClient.stop();
      await clearStoredChatSnapshots();
    }
  },
);
