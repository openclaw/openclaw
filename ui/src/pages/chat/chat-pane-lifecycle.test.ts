/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-lifecycle.test/"} */

// The non-isolated runner resets modules between files but preserves customElements.
// A dedicated jsdom context keeps the registered pane class on this file's module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionSuggestion,
  SessionSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import {
  dismissConfirmedActionPopovers,
  openChatRewindConfirmation,
} from "./components/chat-message.ts";
import * as chatThread from "./components/chat-thread.ts";

const SKIP_REWIND_CONFIRM_PREFERENCE = "openclaw:skip-rewind-confirm";
const confirmationOwners = new Set<HTMLElement>();

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe("chat pane session suggestion lifecycle", () => {
  it("does not let a stale add completion clear a newer session operation", async () => {
    const first = createDeferred<{ suggestion: SessionSuggestion }>();
    const second = createDeferred<{ suggestion: SessionSuggestion }>();
    const client = {
      request: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane, state } = createTestChatPane({ client, sessions });
    state.chatAttachments = [];
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    const row = (id: string, text: string): SessionSuggestion => ({
      id,
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text,
      createdAt: 1,
      state: "pending",
    });

    state.chatMessage = "first";
    const firstPending = pane.addCurrentSessionSuggestion();
    pane.resetSessionSuggestions();
    state.chatMessage = "second";
    const secondPending = pane.addCurrentSessionSuggestion();

    first.resolve({ suggestion: row("first", "first") });
    await firstPending;
    expect(pane.sessionSuggestionAddOperation).toBeDefined();
    expect(pane.sessionSuggestions.some((suggestion) => suggestion.id === "first")).toBe(false);
    second.resolve({ suggestion: row("second", "second") });
    await secondPending;
    expect(pane.sessionSuggestionAddOperation).toBeUndefined();
  });

  it("rejects suggestion submission while attachments remain", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    state.chatMessage = "text only";
    state.chatAttachments = [{ id: "attachment" } as never];

    await pane.addCurrentSessionSuggestion();
    expect(request).not.toHaveBeenCalled();
    expect(state.chatError).toContain("Remove attachments");
  });

  it("does not let a stale list response erase a newer suggestion event", async () => {
    const listed = createDeferred<SessionSuggestionsListResult>();
    const client = {
      request: vi.fn(() => listed.promise),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: 1,
          visibility: "suggest",
          sharingRole: "viewer",
        },
      ],
    } as never;
    const eventSuggestion: SessionSuggestion = {
      id: "event",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "new event",
      createdAt: 1,
      state: "pending",
    };

    const pending = pane.refreshSessionSuggestions();
    pane.handleSessionSuggestionEvent({ action: "added", suggestion: eventSuggestion });
    listed.resolve({ suggestions: [], role: "viewer" });
    await pending;
    expect(pane.sessionSuggestions).toEqual([eventSuggestion]);
  });

  it("preserves an author's resolved event while its role is still loading", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    pane.context.gateway.snapshot.selfUser = { id: "alice" } as never;
    const pending: SessionSuggestion = {
      id: "mine",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "my suggestion",
      createdAt: 1,
      state: "pending",
    };
    pane.sessionSuggestions = [pending];

    pane.handleSessionSuggestionEvent({
      action: "resolved",
      suggestion: { ...pending, state: "accepted" },
    });
    expect(pane.sessionSuggestions).toEqual([{ ...pending, state: "accepted" }]);
  });

  it("does not apply an edit failure after switching sessions", async () => {
    const deferred = createDeferred<never>();
    const client = {
      request: vi.fn(() => deferred.promise),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const suggestion: SessionSuggestion = {
      id: "edit",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "suggested text",
      createdAt: 1,
      state: "pending",
    };
    state.handleChatDraftChange = (next) => {
      state.chatMessage = next;
    };
    state.chatMessage = "original";
    const pending = pane.resolveCurrentSessionSuggestion(suggestion, "edit");
    state.sessionKey = "agent:main:next";
    state.chatMessage = "new session draft";
    deferred.reject(new Error("old request failed"));

    await pending;
    expect(state.chatMessage).toBe("new session draft");
    expect(state.chatError).not.toBe("old request failed");
  });
});

function createConfirmationOwner() {
  const owner = document.createElement("span");
  owner.className = "chat-delete-wrap";
  const trigger = document.createElement("button");
  owner.appendChild(trigger);
  document.body.appendChild(owner);
  confirmationOwners.add(owner);
  openChatRewindConfirmation(trigger, vi.fn());
  return owner;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const owner of confirmationOwners) {
    dismissConfirmedActionPopovers(owner);
    owner.remove();
  }
  confirmationOwners.clear();
  chatThread.resetChatThreadPresentationState();
  window.localStorage.removeItem(SKIP_REWIND_CONFIRM_PREFERENCE);
  vi.unstubAllGlobals();
});

describe("chat pane presentation teardown", () => {
  it("dismisses only confirmations owned by the disconnected pane", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    window.localStorage.removeItem(SKIP_REWIND_CONFIRM_PREFERENCE);
    const paneConfirmation = createConfirmationOwner();
    const siblingConfirmation = createConfirmationOwner();

    for (const callback of frameCallbacks.splice(0)) {
      callback(0);
    }
    const captureClickListeners = addDocumentListener.mock.calls.flatMap(
      ([type, listener, options]) =>
        type === "click" && options === true && listener ? [listener] : [],
    );
    const captureKeydownListeners = addWindowListener.mock.calls.flatMap(
      ([type, listener, options]) =>
        type === "keydown" && options === true && listener ? [listener] : [],
    );
    expect(captureClickListeners).toHaveLength(2);
    expect(captureKeydownListeners).toHaveLength(2);

    pane.appendChild(paneConfirmation);
    pane.disconnectedCallback();

    expect(pane.querySelector(".chat-delete-confirm")).toBeNull();
    expect(siblingConfirmation.querySelector(".chat-delete-confirm")).not.toBeNull();
    expect(removeDocumentListener).toHaveBeenCalledWith("click", captureClickListeners[0], true);
    expect(removeDocumentListener).not.toHaveBeenCalledWith(
      "click",
      captureClickListeners[1],
      true,
    );
    expect(removeWindowListener).toHaveBeenCalledWith("keydown", captureKeydownListeners[0], true);
    expect(removeWindowListener).not.toHaveBeenCalledWith(
      "keydown",
      captureKeydownListeners[1],
      true,
    );
  });

  it("dismisses the previous session confirmation before switching in place", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    window.localStorage.removeItem(SKIP_REWIND_CONFIRM_PREFERENCE);
    const owner = createConfirmationOwner();

    try {
      for (const callback of frameCallbacks.splice(0)) {
        callback(0);
      }
      const captureClickListener = addDocumentListener.mock.calls.find(
        ([type, listener, options]) => type === "click" && options === true && listener,
      )?.[1];
      const captureKeydownListener = addWindowListener.mock.calls.find(
        ([type, listener, options]) => type === "keydown" && options === true && listener,
      )?.[1];
      expect(captureClickListener).toBeDefined();
      expect(captureKeydownListener).toBeDefined();
      pane.appendChild(owner);

      const stopAfterReset = new Error("stop after thread presentation reset");
      vi.spyOn(pane, "cancelHeaderRename").mockImplementation(() => {
        throw stopAfterReset;
      });

      expect(() => pane.switchPaneSession("agent:main:next")).toThrow(stopAfterReset);
      expect(owner.querySelector(".chat-delete-confirm")).toBeNull();
      expect(removeDocumentListener).toHaveBeenCalledWith("click", captureClickListener, true);
      expect(removeWindowListener).toHaveBeenCalledWith("keydown", captureKeydownListener, true);
    } finally {
      dismissConfirmedActionPopovers(owner);
      owner.remove();
    }
  });
});
