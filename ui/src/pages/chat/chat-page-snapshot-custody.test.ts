/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../../lib/sessions/route-navigation.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { settleChatPage, stubMatchMedia } from "./chat-page.test-support.ts";
import "./chat-page.tsx";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import { nativeHistoryMessage } from "./chat-pane.test-support.ts";
import type { ChatPaneElement } from "./chat-pane.tsx";
import type { ChatPageHost } from "./chat-state-host.ts";
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
    const h = createMountedPanes([]);
    const context = h.context;
    const client = expectDefined(context.gateway.snapshot.client, "fixture client");
    const snapshotHost = {
      settings: { gatewayUrl: context.gateway.connection.gatewayUrl },
      client,
      assistantAgentId: "main",
      agentsList: null,
      hello: context.gateway.snapshot.hello,
    };
    const mainSnapshotKey = resolveChatSnapshotKey(snapshotHost, { sessionKey: "agent:main:main" });
    const researchSnapshotKey = resolveChatSnapshotKey(snapshotHost, {
      sessionKey: "agent:research:main",
    });
    writer.write(mainSnapshotKey, mainSnapshot);
    writer.write(researchSnapshotKey, researchSnapshot);
    await writer.flush();
    const originalRequest = client.request.bind(client);
    const routedClient = createTestGatewayClient(async (method, params, options) => {
      if (method === "agents.list") {
        return makeBootRoster({ scope: "global", agents: [{ id: "main" }, { id: "research" }] });
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
    if (!("kind" in route) || route.kind !== "session") {
      throw new Error("Expected the supported global chat route");
    }
    Object.defineProperty(client, "offlineRecoveryScope", {
      configurable: true,
      value: client.recoveryScope,
    });
    Object.defineProperty(client, "recoveryScopeReady", { configurable: true, value: false });
    h.pane.applyGatewaySnapshot({ ...context.gateway.snapshot, phase: "reconnecting" });
    const entered = createDeferred();
    const release = createDeferred();
    // oxlint-disable-next-line typescript/unbound-method -- Rebound to the original page-store receiver below.
    const originalRead = SessionSnapshotStore.prototype.read;
    vi.spyOn(SessionSnapshotStore.prototype, "read").mockImplementation(async function (
      this: SessionSnapshotStore,
      key,
      onBoard,
    ) {
      const snapshot = await originalRead.call(this, key, onBoard);
      if (key === mainSnapshotKey) {
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    });
    let pane: ChatPaneRuntime | undefined;
    const connected = vi.spyOn(ChatPaneRuntime.prototype, "start");
    const provider = createSolidApplicationContextProvider(context);
    const container = document.body.appendChild(createApplicationContextProvider(context));
    let view: ReturnType<typeof mountSolid> | undefined;
    const pageState = () => {
      // SAFETY: The real runtime owns this protected state; this test observes hydration without exposing a production accessor.
      const state = (pane as unknown as { state?: ChatPageHost } | undefined)?.state;
      return expectDefined(state, "mounted pane state");
    };
    try {
      view = mountSolid(
        () => Object.assign(document.createElement("openclaw-chat-page"), { data: route }),
        {
          container,
          wrapper: provider.wrapper,
        },
      );
      const page = expectDefined(
        view.container.querySelector("openclaw-chat-page"),
        "mounted page",
      );
      await settleChatPage(page);
      const paneElement = expectDefined(
        page.querySelector<ChatPaneElement>("openclaw-chat-pane"),
        "rendered pane",
      );
      pane = connected.mock.contexts.find(
        (value): value is ChatPaneRuntime =>
          value instanceof ChatPaneRuntime && value.element === paneElement,
      );
      expect(expectDefined(pane, "mounted pane runtime").element).toBe(paneElement);
      expect(chatHistoryRequests(pageState()).initialSnapshotHydration).toBeDefined();
      await entered.promise;
      expect(pane?.agentId).toBeUndefined();
      const state = pageState();
      expect(state.sessionKey).toBe("global");
      expect(state.assistantAgentId).toBe("main");
      const hydration = expectDefined(
        chatHistoryRequests(state).initialSnapshotHydration,
        "stored hydration",
      );
      if (changeAgent) {
        context.agentSelection.set("research");
      }
      expect(page.querySelector("openclaw-chat-pane")).toBe(paneElement);
      expect(pageState()).toBe(state);
      expect(state.assistantAgentId).toBe(changeAgent ? "research" : "main");
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
      await pane?.sessionSnapshotStore?.flush();
      expect(await originalRead.call(writer, researchSnapshotKey)).toEqual(researchSnapshot);
    } finally {
      release.resolve();
      view?.unmount();
      container.remove();
      await pane?.sessionSnapshotStore?.whenIdle();
      lifecycle.abort();
      router.stop();
      routedClient.stop();
      await clearStoredChatSnapshots();
    }
  },
);
