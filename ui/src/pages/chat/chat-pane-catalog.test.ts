/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { buildCatalogSessionKey, type CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { catalogList } from "./chat-pane-catalog.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { consumePaneSessionHandoff } from "./chat-pane-shared.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionContext,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import * as chatThreadBuild from "./chat-thread-build.ts";
import { renderChatPropsInto } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const catalogKey = {
  catalogId: "codex",
  hostId: "gateway:local",
  threadId: "thread-101",
} satisfies CatalogSessionKey;
const catalogSession: SessionCatalogSession = {
  threadId: catalogKey.threadId,
  status: "idle",
  archived: false,
  canContinue: true,
  canArchive: true,
};

function createCatalogPane(request: ReturnType<typeof vi.fn>, key = catalogKey) {
  const client = { request } as unknown as GatewayBrowserClient;
  const sessions = {} as SessionCapability;
  const fixture = createTestChatPane({ client, sessions });
  const { pane } = fixture;
  Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
  pane.sessionKey = buildCatalogSessionKey(key, "main");
  return { ...fixture, client, key, sessions };
}

function createCatalogContinuationPane(request: ReturnType<typeof vi.fn>) {
  const fixture = createCatalogPane(request);
  const { pane, state } = fixture;
  state.sessionKey = pane.sessionKey;
  state.chatMessage = "Continue the original catalog conversation";
  state.handleChatDraftChange = vi.fn((draft: string) => {
    state.chatMessage = draft;
  });
  state.handleSendChat = vi.fn(async () => undefined);
  pane.history.catalogSession = { ...catalogSession };
  pane.onPaneSessionChange = vi.fn();
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  return fixture;
}

function startContinuation() {
  const continued = createDeferred<{ sessionKey: string }>();
  const request = vi.fn(() => continued.promise);
  const fixture = createCatalogContinuationPane(request);
  return {
    ...fixture,
    request,
    continued,
    pending: fixture.pane.continueCatalogSession(fixture.key),
  };
}

function expectNoContinuation({ pane, state }: ReturnType<typeof createCatalogContinuationPane>) {
  expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
  expect(state.handleChatDraftChange).not.toHaveBeenCalled();
  expect(state.handleSendChat).not.toHaveBeenCalled();
  expect(state.chatSending).toBe(false);
}

describe("chat pane catalog", () => {
  it("reuses unchanged catalog history while admitting an older page", () => {
    installTranscriptDomMocks();
    onTestFinished(resetTranscriptTestDom);
    const { pane, state, context } = createRefreshChatPane(createGatewayBrowserClientFixture());
    const sessionKey = buildCatalogSessionKey(
      { catalogId: "fixture", hostId: "gateway:local", threadId: "history" },
      "main",
    );
    Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
    pane.sessionKey = state.sessionKey = sessionKey;
    Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
    const now = Date.now();
    pane.receiveQuestionEvent({
      event: "question.requested",
      payload: {
        id: "catalog-question",
        sessionKey,
        agentId: "main",
        createdAtMs: now,
        expiresAtMs: now + 60_000,
        status: "pending",
        questions: [
          {
            questionId: "confirm",
            header: "Confirm",
            question: "Unrelated live question",
            options: [],
          },
        ],
      },
    });
    state.chatSessionApprovalQueue = [
      {
        id: "catalog-approval",
        kind: "exec",
        request: { command: "Unrelated live approval", sessionKey },
        createdAtMs: now,
        expiresAtMs: now + 60_000,
      },
    ];
    Object.assign(context, {
      overlays: {
        snapshot: { approvalQueue: state.chatSessionApprovalQueue },
        decideApproval: vi.fn(),
      },
    });
    const messages = [
      { role: "user", content: "Saved catalog question", timestamp: 2, messageId: "user" },
      { role: "assistant", content: "Saved catalog answer", timestamp: 3, messageId: "answer" },
    ];
    Object.assign(pane.history, { catalogMessages: messages, catalogLoading: false });
    state.settings = { ...state.settings, chatShowToolCalls: true };
    state.chatVerboseLevel = "full";
    state.chatToolMessages = [
      { role: "toolResult", toolName: "read", content: "Unrelated live tool", toolCallId: "live" },
    ];
    const container = document.body.appendChild(createApplicationContextProvider(context));
    const build = vi.spyOn(chatThreadBuild, "buildChatItems");
    const draw = () => {
      pane.render();
      renderChatPropsInto(
        container,
        expectDefined(pane.chatProps, "rendered catalog props"),
        context,
      );
    };

    draw();
    expect(container.textContent).toContain("Saved catalog answer");
    expect(container.textContent).not.toContain("Unrelated live tool");
    expect(container.querySelector(".chat-question-panel, .chat-inline-approval")).toBeNull();
    draw();
    expect(build).toHaveBeenCalledOnce();

    Object.assign(pane.history, {
      catalogMessages: [
        { role: "assistant", content: "Older catalog answer", timestamp: 1, messageId: "older" },
        ...messages,
      ],
    });
    draw();
    expect(build).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Older catalog answer");
    expect(container.textContent).toContain("Saved catalog answer");
    expect(container.textContent).not.toContain("Unrelated live tool");
  });
  it("finds continuation metadata on a later catalog page", async () => {
    const key = catalogKey;
    const selectedSession: SessionCatalogSession = {
      ...catalogSession,
      sourceHomeId: "source-home-a",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(catalogList(key, [], { nextCursor: "page-2" }))
      .mockResolvedValueOnce(catalogList(key, [selectedSession], { nextCursor: "page-2" }))
      .mockResolvedValueOnce({ hostId: key.hostId, threadId: key.threadId, items: [] });
    const { pane } = createCatalogPane(request);
    Object.defineProperty(pane, "isConnected", { configurable: true, value: true });

    await pane.loadCatalogSession(key, false);

    expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
      agentId: "main",
      catalogId: key.catalogId,
      hostIds: [key.hostId],
      limitPerHost: 100,
      cursors: { [key.hostId]: "page-2" },
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.read", {
      agentId: "main",
      catalogId: key.catalogId,
      hostId: key.hostId,
      threadId: key.threadId,
      sourceHomeId: "source-home-a",
      limit: 50,
    });
    expect(pane.history.catalogSession).toEqual(selectedSession);
  });

  it("discards a catalog read when the pane owner changes", async () => {
    const key = catalogKey;
    const read = createDeferred<SessionsCatalogReadResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        catalogList(key, [{ ...catalogSession }], {
          capabilities: { continueSession: false, archive: false },
        }),
      )
      .mockImplementationOnce(() => read.promise);
    const { pane, state } = createCatalogPane(request);
    state.sessionKey = pane.sessionKey;
    state.assistantAgentId = "main";
    Object.defineProperty(pane, "isConnected", { configurable: true, value: true });

    const pending = pane.loadCatalogSession(key, false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    state.sessionKey = buildCatalogSessionKey(key, "other");
    pane.sessionKey = state.sessionKey;
    read.resolve({
      hostId: key.hostId,
      threadId: key.threadId,
      items: [{ id: "u1", type: "userMessage", text: "stale" }],
    });

    await expect(pending).resolves.toBe(false);
    expect(pane.history.catalogMessages).toEqual([]);
  });

  it.each<[string, SessionCatalogTranscriptItem, string]>([
    [
      "raw tool command",
      { type: "toolCall", raw: { command: "git status --short" } },
      "Tool call\n\ngit status --short",
    ],
    ["empty reasoning", { type: "reasoning" }, "Thinking"],
  ])("renders %s", (_name, item, expected) => {
    const { pane } = createCatalogContinuationPane(vi.fn());

    expect(pane.catalogItemMessage(item)).toMatchObject({
      content: [{ type: "text", text: expected }],
    });
  });

  it("bounds the visible preview from raw structured results without changing source data", () => {
    const output = "x".repeat(750);
    const item: SessionCatalogTranscriptItem = { type: "toolResult", raw: { result: { output } } };
    const preview = `${JSON.stringify({ output }).slice(0, 499)}…`;
    const { pane } = createCatalogContinuationPane(vi.fn());
    const original = structuredClone(item);

    expect(pane.catalogItemMessage(item)).toMatchObject({
      content: [{ type: "text", text: `Tool result\n\n${preview}\n\n[Output truncated]` }],
    });
    expect(item).toEqual(original);
  });

  it("keeps paging when an advancing older page renders nothing new", async () => {
    const readPage: SessionsCatalogReadResult = {
      hostId: "gateway:local",
      threadId: "thread-1",
      items: [{ id: "x1", type: "other" }],
      nextCursor: "cursor-2",
    };
    const key = { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" };
    const { pane, state } = createCatalogPane(
      vi.fn(async () => readPage),
      key,
    );
    state.sessionKey = pane.sessionKey;
    pane.history.catalogCursor = "cursor-1";
    Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
    expect(await pane.loadCatalogSession(key, true)).toBe(true);
    expect(pane.history.catalogCursor).toBe("cursor-2");
    expect(pane.history.catalogMessages).toHaveLength(0);
  });
  it.each(["draft", "attachment"])(
    "hands a continued catalog %s to the retained pane",
    async (kind) => {
      const attachmentOnly = kind === "attachment";
      const destination = attachmentOnly ? "agent:main:attachment-only" : "agent:main:continued";
      const request = vi.fn().mockResolvedValue({ sessionKey: destination });
      const { key, pane, state } = createCatalogContinuationPane(request);
      const attachment = {
        mimeType: "image/png",
        fileName: "only.png",
        dataUrl: "data:image/png;base64,BBBB",
      };
      if (attachmentOnly) {
        state.chatMessage = "";
        state.chatAttachments = [{ id: "att-2", ...attachment }];
      } else {
        pane.history.catalogSession = {
          ...pane.history.catalogSession!,
          sourceHomeId: "source-home-a",
        };
      }
      await pane.continueCatalogSession(key);
      expect(request).toHaveBeenCalledWith("sessions.catalog.continue", {
        ...key,
        agentId: "main",
        ...(!attachmentOnly ? { sourceHomeId: "source-home-a" } : {}),
      });
      expect(consumePaneSessionHandoff(pane.context, pane.paneId, destination)).toEqual({
        attachments: attachmentOnly ? [expect.objectContaining(attachment)] : [],
        draft: attachmentOnly ? expect.any(String) : "Continue the original catalog conversation",
        send: true,
      });
      expect(pane.onPaneSessionChange).toHaveBeenCalledWith("single", destination);
      expect(state.sessionKey).not.toBe(destination);
      expect(state.handleSendChat).not.toHaveBeenCalled();
    },
  );

  it("still ignores a continuation with no draft and no attachments", async () => {
    const request = vi.fn();
    const { key, pane, state } = createCatalogContinuationPane(request);
    state.chatMessage = "   ";
    state.chatAttachments = [];

    await pane.continueCatalogSession(key);

    expect(request).not.toHaveBeenCalled();
  });

  it("does not stage or send a continuation rejected by its logical pane", async () => {
    const request = vi.fn().mockResolvedValue({ sessionKey: "agent:main:rejected-continuation" });
    const { key, pane, state } = createCatalogContinuationPane(request);
    pane.onPaneSessionChange = vi.fn(() => false);

    await pane.continueCatalogSession(key);

    expect(
      consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:rejected-continuation"),
    ).toBeNull();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatSending).toBe(false);
  });

  it.each(["conversation", "pane owner", "connection epoch", "Gateway client"])(
    "does not adopt or send a catalog continuation after changing the %s",
    async (changed) => {
      const continued = createDeferred<{ sessionKey: string }>();
      const request = vi.fn(() => continued.promise);
      const fixture = createCatalogContinuationPane(request);
      const { key, pane, state, sessions } = fixture;
      state.assistantAgentId = "main";
      const pending = pane.continueCatalogSession(key);
      const replacement = { request: vi.fn() } as unknown as GatewayBrowserClient;
      if (changed === "conversation" || changed === "pane owner") {
        state.sessionKey =
          changed === "conversation"
            ? "agent:main:different-conversation"
            : buildCatalogSessionKey(key, "other");
        pane.sessionKey = state.sessionKey;
        if (changed === "conversation") {
          pane.catalogLoadGeneration += 1;
        }
      } else {
        if (changed === "Gateway client") {
          state.client = replacement;
          pane.connectedClient = replacement;
          pane.context = createSessionContext(replacement, sessions);
        }
        pane.connectionGeneration += 1;
        state.connectionEpoch = pane.connectionGeneration;
      }
      const draft = `Draft after changing the ${changed}`;
      state.chatMessage = draft;
      continued.resolve({ sessionKey: "agent:main:stale-continuation" });
      await pending;
      expectNoContinuation(fixture);
      expect(state.chatMessage).toBe(draft);
      if (changed === "pane owner") {
        expect(request).toHaveBeenCalledWith("sessions.catalog.continue", {
          ...key,
          agentId: "main",
        });
      } else if (changed === "conversation") {
        expect(state.sessionKey).toBe("agent:main:different-conversation");
      } else if (changed === "Gateway client") {
        expect(state.client).toBe(replacement);
      }
    },
  );

  it("does not clear a newer scoped send when a stale catalog continuation resolves", async () => {
    const { pane, state, continued, pending } = startContinuation();
    state.sessionKey = "agent:main:different-conversation";
    pane.sessionKey = state.sessionKey;
    pane.catalogLoadGeneration += 1;
    state.chatSendingScopeKey = "newer-conversation-send";
    state.chatSending = true;
    continued.resolve({ sessionKey: "agent:main:stale-continuation" });
    await pending;

    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatSendingScopeKey).toBe("newer-conversation-send");
    expect(state.chatSending).toBe(true);
  });

  it("allows only the latest overlapping catalog continuation to adopt and send", async () => {
    const first = createDeferred<{ sessionKey: string }>();
    const second = createDeferred<{ sessionKey: string }>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { key, pane, state } = createCatalogContinuationPane(request);

    const staleContinuation = pane.continueCatalogSession(key);
    state.chatMessage = "Only send the latest catalog draft";
    const currentContinuation = pane.continueCatalogSession(key);
    first.resolve({ sessionKey: "agent:main:stale-continuation" });
    await staleContinuation;

    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatSending).toBe(true);

    second.resolve({ sessionKey: "agent:main:latest-continuation" });
    await currentContinuation;

    expect(pane.onPaneSessionChange).toHaveBeenCalledOnce();
    expect(
      consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:latest-continuation"),
    ).toEqual({
      attachments: [],
      draft: "Only send the latest catalog draft",
      send: true,
    });
    expect(state.handleSendChat).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "scopes catalog continuation failure to its conversation (stale=%s)",
    async (stale) => {
      const { pane, state, continued, pending } = startContinuation();
      if (stale) {
        state.sessionKey = "agent:main:different-conversation";
        pane.sessionKey = state.sessionKey;
        pane.catalogLoadGeneration += 1;
        state.lastError = "Current conversation error";
        state.chatMessage = "Draft belonging to the selected conversation";
      }
      continued.reject(new Error("Catalog continuation failed"));
      await pending;
      expect(state).toMatchObject({
        lastError: stale ? "Current conversation error" : "Catalog continuation failed",
        chatSending: false,
      });
      expect(state.handleSendChat).not.toHaveBeenCalled();
    },
  );
});
