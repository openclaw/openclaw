// The non-isolated runner resets modules between files but preserves customElements.
// A dedicated jsdom context keeps the registered pane class on this file's module graph.
import { afterEach, expect, it, vi } from "vitest";
/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-lifecycle.test/"} */
import type {
  SessionSuggestion,
  SessionSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { QUEUED_EDIT_RETENTION_CHANGE_EVENT } from "./chat-page-retained-sessions.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createPaneTestHost,
  getPaneTestRuntime,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { enqueueChatMessage } from "./chat-queue.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  dismissConfirmedActionPopovers,
  openChatRewindConfirmation,
} from "./components/chat-message-confirmation.ts";
import * as chatThread from "./components/chat-thread-interactions.ts";
import { handleChatDraftChange } from "./input-history.ts";
import { beginQueuedMessageEdit, cancelQueuedMessageEdit } from "./queued-message-edit.ts";
import { isSidebarSlotVisible, openSlot, setSidebarOpen } from "./sidebar-layout.ts";
import { buildInitialChatSubmission } from "./user-message-content.ts";

function pendingSuggestion(
  state: ChatPageHost,
  id: string,
  text = id,
  author: SessionSuggestion["author"] = { type: "human", id: "alice", label: "Alice" },
): SessionSuggestion {
  return {
    id,
    sessionKey: state.sessionKey,
    agentId: "main",
    author,
    text,
    createdAt: 1,
    state: "pending",
  };
}

function barePane(request?: ReturnType<typeof vi.fn>) {
  return createTestChatPane({
    client: (request ? { request } : {}) as unknown as GatewayBrowserClient,
    sessions: {} as SessionCapability,
  });
}

function runtimePane(sessionKey: string, context = createInitializationContext()) {
  // The shared host forwards the controller surface declared by TestChatPane.
  const pane = createPaneTestHost(
    "openclaw-chat-runtime-test",
    ChatPaneRuntime,
  ) as unknown as TestChatPane;
  pane.sessionKey = sessionKey;
  pane.chatMessagesBySession = new Map();
  pane.context = context;
  return pane;
}

function stopAtAttach(pane: TestChatPane) {
  const error = new Error("stop after attach");
  const attach = vi.spyOn(pane.chatState, "attach").mockImplementation(() => {
    throw error;
  });
  return () => {
    expect(() => getPaneTestRuntime(pane).connectedCallback()).toThrow(error);
    return attach.mock.calls[0]?.[0];
  };
}

function editablePane(request: ReturnType<typeof vi.fn>) {
  const fixture = barePane(request);
  fixture.state.handleChatDraftChange = (next) => {
    fixture.state.chatMessage = next;
  };
  return fixture;
}

function rejectedSuggestion(message: string) {
  return new GatewayRequestError({ code: "INVALID_REQUEST", message });
}

const suggestionOwner = { type: "human", id: "owner", label: "Owner" } as const;

function deferredPair<T>() {
  const first = createDeferred<T>();
  const second = createDeferred<T>();
  const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  return { first, second, request };
}

function suggestionRow(state: ChatPageHost, sessionId?: string): GatewaySessionRow {
  return {
    key: state.sessionKey,
    kind: "direct",
    sessionId,
    updatedAt: 1,
    visibility: "suggest",
    sharingRole: "owner",
  };
}

function selectSuggestionRows(state: ChatPageHost, ...sessions: GatewaySessionRow[]) {
  state.sessionsResult = { count: sessions.length, path: "", sessions } as never;
}

const SKIP_REWIND_CONFIRM_PREFERENCE = "openclaw:skip-rewind-confirm";
const confirmationOwners = new Set<HTMLElement>();

it("publishes queued-edit retention changes while its pane is parked", async () => {
  vi.useFakeTimers();
  const key = "agent:main:parked-edit";
  const fixture = createMountedPanes([{ key, kind: "direct", updatedAt: 1 }]);
  const pane = fixture.mount(key);
  const updates = vi.spyOn(pane, "render");
  await pane.updateComplete;
  for (let pass = 0; pass < 2; pass++) {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(160);
  }
  expect(pane.querySelector(".agent-chat__composer-combobox textarea")).not.toBeNull();
  expect(pane.state.chatLoading).toBe(false);

  pane.presented = false;
  const retained = vi.fn();
  pane.addEventListener(QUEUED_EDIT_RETENTION_CHANGE_EVENT, retained);
  updates.mockClear();
  const state = pane.state;
  state.connected = false;
  const queued = enqueueChatMessage(state, "queued original");
  expect(queued).not.toBeNull();
  expect(beginQueuedMessageEdit(state, queued!.id)).toBe("started");
  state.requestUpdate();
  expect(retained).toHaveBeenCalledTimes(1);
  expect(cancelQueuedMessageEdit(state)).toBe(true);
  state.requestUpdate();
  expect(retained).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  expect(updates).not.toHaveBeenCalled();
  pane.presented = true;
  await pane.updateComplete;
});

it("renews the attention cue for repeated draft prefill", () => {
  vi.useFakeTimers();
  const { pane } = barePane();
  const input = document.body.appendChild(document.createElement("div"));
  input.className = "agent-chat__input";
  const textarea = input.appendChild(document.createElement("textarea"));
  vi.spyOn(pane, "querySelector").mockReturnValue(textarea);
  const lifecycle = pane as TestChatPane & {
    draft?: string;
    focusComposer: boolean;
    updated: (changedProperties?: Map<PropertyKey, unknown>) => void;
  };
  lifecycle.focusComposer = true;
  lifecycle.draft = "Prefilled prompt";
  const attentionClass = "agent-chat__input--prefill-attention";
  lifecycle.updated(new Map([["focusComposer", false]]));
  expect(document.activeElement).toBe(textarea);
  expect(input.classList.contains(attentionClass)).toBe(true);
  vi.advanceTimersByTime(300);
  lifecycle.updated(new Map([["focusComposer", false]]));
  vi.advanceTimersByTime(599);
  expect(input.classList.contains(attentionClass)).toBe(true);
  vi.advanceTimersByTime(1);
  expect(input.classList.contains(attentionClass)).toBe(false);
  input.remove();
});

it("claims the connected client's first message before attaching the pane", () => {
  const targetSessionKey = "agent:main:created-session";
  const client = {
    addEventListener: vi.fn(() => vi.fn()),
    request: vi.fn(),
  } as unknown as GatewayBrowserClient;
  const context = createInitializationContext();
  context.gateway.snapshot.client = client;
  context.chatSubmissions.retain(
    buildInitialChatSubmission(
      targetSessionKey,
      { createdAt: 1, text: "keep the first prompt visible" },
      client,
      "initial-run",
    ),
  );
  const pane = runtimePane(targetSessionKey, context);
  const connect = stopAtAttach(pane);

  try {
    const attachedState = connect();
    expect(attachedState?.client).toBe(client);
    expect(attachedState?.chatMessages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "keep the first prompt visible" }] },
    ]);
  } finally {
    pane.disconnectedCallback();
  }
});

it.each(["absent", "open"] as const)(
  "restores its own %s layout instead of another split pane's layout",
  (preference) => {
    vi.stubGlobal("localStorage", createStorageMock());
    const left = "agent:main:left";
    const right = "agent:main:right";
    const rightLayout = openSlot({ columns: [] }, "workspace");
    const leftLayout = setSidebarOpen(openSlot({ columns: [] }, "detail"), preference === "open");
    const client = createGatewayBrowserClientFixture();
    const context = createInitializationContext(client);
    const pane = runtimePane(left, context);
    patchSettings({
      sessionKey: right,
      sidebarSessionLayouts: {
        [right]: rightLayout,
        ...(preference !== "absent" ? { [left]: leftLayout } : {}),
      },
      sidebarSessionActivePanels: {
        [right]: "workspace",
        ...(preference !== "absent" ? { [left]: "detail" } : {}),
      },
    });
    const connect = stopAtAttach(pane);
    const expectOwnLayout = () => {
      expect(pane.state.sessionKey).toBe(left);
      expect(isSidebarSlotVisible(pane.state.sidebarLayout, "workspace")).toBe(false);
      expect(isSidebarSlotVisible(pane.state.sidebarLayout, "detail")).toBe(preference === "open");
      expect(pane.state.sidebarFocusPanelId).toBe(preference === "absent" ? "" : "detail");
    };
    try {
      connect();
      expectOwnLayout();
      pane.applyGatewaySnapshot({ ...context.gateway.snapshot, phase: "reconnecting" });
      expectOwnLayout();
      expect(loadSettings().sidebarSessionLayouts?.[right]).toMatchObject(rightLayout);
      expect(loadSettings().sessionKey).toBe(right);
    } finally {
      pane.disconnectedCallback();
    }
  },
);

function createSuggestionPane(request = vi.fn()) {
  const fixture = barePane(request);
  fixture.pane.presencePayload = {
    presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
  };
  return fixture;
}

it("does not let a stale add completion clear a newer session operation", async () => {
  const { first, second, request } = deferredPair<{ suggestion: SessionSuggestion }>();
  const { pane, state } = createSuggestionPane(request);
  state.chatAttachments = [];

  state.chatMessage = "first";
  const firstPending = pane.addCurrentSessionSuggestion();
  pane.resetSessionSuggestions();
  state.chatMessage = "second";
  const secondPending = pane.addCurrentSessionSuggestion();

  first.resolve({ suggestion: pendingSuggestion(state, "first") });
  await firstPending;
  expect(pane.sessionSuggestionAddOperation).toBeDefined();
  expect(pane.sessionSuggestions.some((suggestion) => suggestion.id === "first")).toBe(false);
  second.resolve({ suggestion: pendingSuggestion(state, "second") });
  await secondPending;
  expect(pane.sessionSuggestionAddOperation).toBeUndefined();
});

it.each(["attachments", "mentions"] as const)(
  "rejects suggestion submission while %s remain",
  async (content) => {
    const request = vi.fn();
    const { pane, state } = createSuggestionPane(request);
    state.chatMessage = "@Alex text only";
    state.chatAttachments =
      content === "attachments"
        ? [{ id: "attachment", mimeType: "image/png", dataUrl: "data:image/png;base64,AAA" }]
        : [];
    state.chatMentions =
      content === "mentions" ? [{ profileId: "alex-profile", start: 0, end: 5 }] : [];

    await pane.addCurrentSessionSuggestion();
    expect(request).not.toHaveBeenCalled();
    expect(state.chatError).toBe(
      t(
        content === "mentions"
          ? "chat.mentions.unsupported"
          : "chat.sessionSuggestions.attachmentsUnsupported",
      ),
    );
    expect(state.chatMessage).toBe("@Alex text only");
  },
);

it("coalesces overlapping refreshes and applies the event-invalidated follow-up", async () => {
  const { first, second, request } = deferredPair<SessionSuggestionsListResult>();
  const { pane, state } = createSuggestionPane(request);
  selectSuggestionRows(state, { ...suggestionRow(state), sharingRole: "viewer" });
  const eventSuggestion = pendingSuggestion(state, "event");
  const existingSuggestion: SessionSuggestion = {
    ...eventSuggestion,
    id: "existing",
    createdAt: 0,
  };

  const pending = pane.refreshSessionSuggestions();
  const overlapping = pane.refreshSessionSuggestions();
  expect(request).toHaveBeenCalledTimes(1);
  pane.handleSessionSuggestionEvent({ action: "added", suggestion: eventSuggestion });
  first.resolve({ suggestions: [existingSuggestion], role: "viewer" });
  await Promise.all([pending, overlapping]);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  second.resolve({ suggestions: [existingSuggestion, eventSuggestion], role: "viewer" });
  await vi.waitFor(() =>
    expect(pane.sessionSuggestions).toEqual([existingSuggestion, eventSuggestion]),
  );
  expect(pane.sessionSuggestionRole).toBe("viewer");
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
});

it("clears cached suggestions until a rotated session instance list resolves", async () => {
  const listed = createDeferred<SessionSuggestionsListResult>();
  const request = vi.fn(() => listed.promise);
  const { pane, state } = createSuggestionPane(request);
  const row = (sessionId: string) => suggestionRow(state, sessionId);
  const stale = pendingSuggestion(state, "stale");
  const fresh = pendingSuggestion(state, "fresh");

  pane.syncSessionSuggestionTarget("main", row("session-a"));
  await pane.refreshSessionSuggestions();
  pane.sessionSuggestions = [stale];
  state.sessionsResultAgentId = "main";
  selectSuggestionRows(state, row("session-b"));

  pane.syncSessionSuggestionTarget("main", row("session-b"));

  expect(pane.sessionSuggestions).toEqual([]);
  expect(request).toHaveBeenCalledTimes(1);
  listed.resolve({ suggestions: [fresh], role: "owner" });
  await vi.waitFor(() => expect(pane.sessionSuggestions).toEqual([fresh]));
});

it("clears displayed typing actors when the session instance rotates", () => {
  const { pane, state } = createSuggestionPane();
  const row = (sessionId: string) => suggestionRow(state, sessionId);
  const sessionA = row("session-a");
  selectSuggestionRows(state, sessionA);
  pane.syncSessionSuggestionTarget("main", sessionA);
  pane.handleSessionTypingEvent({
    sessionKey: state.sessionKey,
    sessionId: "session-a",
    agentId: "main",
    actor: { type: "human", id: "alice", label: "Alice" },
    typing: true,
    ts: 1,
  });
  expect(pane.typingActors.size).toBe(1);

  const sessionB = row("session-b");
  selectSuggestionRows(state, sessionB);
  pane.syncSessionSuggestionTarget("main", sessionB);

  expect(pane.typingActors.size).toBe(0);
});

it("keeps an owner's self-authored resolved suggestion through the following list", async () => {
  const listed = createDeferred<SessionSuggestionsListResult>();
  const resolvedResponse = createDeferred<{ suggestion: SessionSuggestion }>();
  const request = vi.fn((method: string) => {
    if (method === "session.suggestions.resolve") {
      return resolvedResponse.promise;
    }
    if (method === "session.suggestions.list") {
      return listed.promise;
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const { pane, state } = createSuggestionPane(request);
  pane.context.gateway.snapshot.selfUser = { id: "owner" } as never;
  selectSuggestionRows(state, suggestionRow(state));
  const pending = pendingSuggestion(state, "owner", "resolved suggestion", suggestionOwner);
  const resolved = { ...pending, state: "accepted" as const };
  pane.sessionSuggestionRole = "owner";
  pane.sessionSuggestions = [pending];

  const resolving = pane.resolveCurrentSessionSuggestion(pending, "queue");
  expect(request).toHaveBeenCalledTimes(1);
  pane.handleSessionSuggestionEvent({ action: "resolved", suggestion: resolved });
  expect(pane.sessionSuggestions).toEqual([resolved]);
  expect(request).toHaveBeenCalledTimes(2);

  listed.resolve({ suggestions: [resolved], role: "owner" });
  await vi.waitFor(() => expect(pane.sessionSuggestions).toEqual([resolved]));
  resolvedResponse.resolve({ suggestion: resolved });
  await resolving;

  expect(pane.sessionSuggestions).toEqual([resolved]);
  expect(pane.sessionSuggestionRole).toBe("owner");
});

it("drops a resolve completion after the same session key rotates instances", async () => {
  const response = createDeferred<{ suggestion: SessionSuggestion }>();
  const { pane, state } = barePane(vi.fn(() => response.promise));
  const session = (sessionId: string) => suggestionRow(state, sessionId);
  const suggestion = pendingSuggestion(state, "old", "old suggestion", suggestionOwner);
  pane.context.gateway.snapshot.selfUser = { id: "owner" } as never;
  pane.syncSessionSuggestionTarget("main", session("session-a"));
  pane.sessionSuggestions = [suggestion];

  const resolving = pane.resolveCurrentSessionSuggestion(suggestion, "queue");
  pane.syncSessionSuggestionTarget("main", session("session-b"));
  response.resolve({ suggestion: { ...suggestion, state: "accepted" } });
  await resolving;

  expect(pane.sessionSuggestions).toEqual([]);
  expect(state.chatError).toBeNull();
});

it("does not apply an edit failure after the same session key rotates instances", async () => {
  const deferred = createDeferred<never>();
  const { pane, state } = editablePane(vi.fn(() => deferred.promise));
  const suggestion = pendingSuggestion(state, "edit", "suggested text");
  pane.sessionSuggestionTargetSignature = "main\0agent:main:current\0session-a";
  state.chatMessage = "original";
  const pending = pane.resolveCurrentSessionSuggestion(suggestion, "edit");
  pane.sessionSuggestionTargetSignature = "main\0agent:main:current\0session-b";
  pane.resetSessionSuggestions();
  state.chatMessage = "new session draft";
  deferred.reject(new Error("old request failed"));

  await pending;
  expect(state.chatMessage).toBe("new session draft");
  expect(state.chatError).not.toBe("old request failed");
});

it.each([false, true])(
  "restores only an untouched owner draft after an edit rejection (reselected=%s)",
  async (reselected) => {
    const deferred = createDeferred<never>();
    const { pane, state } = barePane(vi.fn(() => deferred.promise));
    const suggestion = pendingSuggestion(state, "edit-rejected", "@Alex rejected suggestion");
    state.handleChatDraftChange = (next, mentions) => handleChatDraftChange(state, next, mentions);
    state.chatMessage = "@Alex owner draft";
    state.chatMentions = [{ profileId: "original-profile", start: 0, end: 5 }];

    const resolving = pane.resolveCurrentSessionSuggestion(suggestion, "edit");
    expect(state.chatMentions).toEqual([]);
    if (reselected) {
      state.handleChatDraftChange(suggestion.text, [
        { profileId: "replacement-profile", start: 0, end: 5 },
      ]);
    }
    deferred.reject(rejectedSuggestion("suggestion already resolved"));
    await resolving;

    expect(state.chatMessage).toBe(reselected ? suggestion.text : "@Alex owner draft");
    expect(state.chatMentions).toEqual([
      { profileId: reselected ? "replacement-profile" : "original-profile", start: 0, end: 5 },
    ]);
    expect(state.chatError).toBe("suggestion already resolved");
  },
);

it("serializes edit resolutions so rejected suggestions cannot snapshot each other", async () => {
  const { first, second, request } = deferredPair<never>();
  const { pane, state } = editablePane(request);
  const suggestion = (id: string) => pendingSuggestion(state, id);
  state.chatMessage = "owner draft";

  const firstPending = pane.resolveCurrentSessionSuggestion(suggestion("first"), "edit");
  await pane.resolveCurrentSessionSuggestion(suggestion("second"), "edit");
  expect(request).toHaveBeenCalledTimes(1);
  expect(state.chatMessage).toBe("first");

  first.reject(rejectedSuggestion("first was rejected"));
  await firstPending;
  expect(state.chatMessage).toBe("owner draft");

  const secondPending = pane.resolveCurrentSessionSuggestion(suggestion("second"), "edit");
  second.reject(rejectedSuggestion("second was rejected"));
  await secondPending;
  expect(request).toHaveBeenCalledTimes(2);
  expect(state.chatMessage).toBe("owner draft");
});
function createConfirmationOwner() {
  const owner = document.createElement("span");
  owner.className = "chat-confirm-wrap";
  const trigger = document.createElement("button");
  owner.appendChild(trigger);
  document.body.appendChild(owner);
  confirmationOwners.add(owner);
  openChatRewindConfirmation(trigger, vi.fn());
  const popover = [...document.querySelectorAll<HTMLElement>(".chat-confirm-popover")].at(-1);
  expect(popover).toBeInstanceOf(HTMLElement);
  return { owner, popover: popover! };
}

function watchCapture(target: Document | Window, type: "click" | "keydown") {
  const add = vi.spyOn(target, "addEventListener");
  const remove = vi.spyOn(target, "removeEventListener");
  return () => {
    const captured = add.mock.calls.flatMap(([event, listener, options]) =>
      event === type && options === true && listener ? [listener] : [],
    );
    expect(captured).toHaveLength(2);
    return () => {
      expect(remove).toHaveBeenCalledWith(type, captured[0], true);
      expect(remove).not.toHaveBeenCalledWith(type, captured[1], true);
    };
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const owner of confirmationOwners) {
    dismissConfirmedActionPopovers(owner);
    owner.remove();
  }
  confirmationOwners.clear();
  chatThread.resetThreadPresentation();
  window.localStorage.removeItem(SKIP_REWIND_CONFIRM_PREFERENCE);
  vi.unstubAllGlobals();
});

it("dismisses only confirmations owned by the disconnected pane", () => {
  const frameCallbacks: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }),
  );
  const listeners = [watchCapture(document, "click"), watchCapture(window, "keydown")];
  const { pane } = barePane();
  window.localStorage.removeItem(SKIP_REWIND_CONFIRM_PREFERENCE);
  const paneConfirmation = createConfirmationOwner();
  const siblingConfirmation = createConfirmationOwner();

  for (const callback of frameCallbacks.splice(0)) {
    callback(0);
  }
  const checkRemovals = listeners.map((capture) => capture());
  pane.appendChild(paneConfirmation.owner);
  pane.disconnectedCallback();

  expect(paneConfirmation.popover.isConnected).toBe(false);
  expect(siblingConfirmation.popover.isConnected).toBe(true);
  for (const check of checkRemovals) {
    check();
  }
});
