// The non-isolated runner resets modules between files but preserves customElements.
// A dedicated jsdom context keeps the registered pane class on this file's module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  dismissConfirmedActionPopovers,
  openChatRewindConfirmation,
} from "./components/chat-message.ts";
import * as chatThread from "./components/chat-thread-interactions.ts";
import { handleChatDraftChange } from "./input-history.ts";
import { isSidebarSlotVisible, openSlot, setSidebarOpen } from "./sidebar-layout.ts";
import { buildInitialChatSubmission } from "./user-message-content.ts";

function pendingSuggestion(sessionKey: string, id: string, text: string): SessionSuggestion {
  return {
    id,
    sessionKey,
    agentId: "main",
    author: { type: "human", id: "alice", label: "Alice" },
    text,
    createdAt: 1,
    state: "pending",
  };
}

const SKIP_REWIND_CONFIRM_PREFERENCE = "openclaw:skip-rewind-confirm";
const confirmationOwners = new Set<HTMLElement>();

describe("chat pane composer prefill attention", () => {
  it.each([
    { label: "repeated draft prefill", draft: "Prefilled prompt", repeat: true, attention: true },
    { label: "plain focus", draft: undefined, repeat: false, attention: false },
  ])("focuses with the expected attention cue for $label", ({ draft, repeat, attention }) => {
    vi.useFakeTimers();
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
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
    lifecycle.draft = draft;
    const attentionClass = "agent-chat__input--prefill-attention";
    const mutations = new MutationObserver(() => {});
    mutations.observe(input, { attributeFilter: ["class"], attributeOldValue: true });
    lifecycle.updated(new Map([["focusComposer", false]]));
    expect(document.activeElement).toBe(textarea);
    expect(input.classList.contains(attentionClass)).toBe(attention);
    if (repeat) {
      vi.advanceTimersByTime(300);
      lifecycle.updated(new Map([["focusComposer", false]]));
    }
    vi.advanceTimersByTime(599);
    expect(input.classList.contains(attentionClass)).toBe(attention);
    vi.advanceTimersByTime(1);
    expect(input.classList.contains(attentionClass)).toBe(false);
    if (!attention) {
      expect(
        mutations.takeRecords().some(({ oldValue }) => oldValue?.includes(attentionClass)),
      ).toBe(false);
    }
    mutations.disconnect();
    input.remove();
  });
});

describe("chat pane first-turn attachment lifecycle", () => {
  it("claims the connected client's first message before attaching the pane", () => {
    const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
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
    pane.sessionKey = targetSessionKey;
    pane.chatMessagesBySession = new Map();
    pane.context = context;
    const stopAfterAttach = new Error("stop after attach");
    let attachedState: ChatPageHost | undefined;
    vi.spyOn(pane.chatState, "attach").mockImplementation((state) => {
      attachedState = state;
      throw stopAfterAttach;
    });

    try {
      expect(() => pane.connectedCallback()).toThrow(stopAfterAttach);
      expect(attachedState?.client).toBe(client);
      expect(attachedState?.chatMessages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [
            expect.objectContaining({ type: "text", text: "keep the first prompt visible" }),
          ],
        }),
      ]);
    } finally {
      pane.disconnectedCallback();
    }
  });
});

describe("chat pane initial panel layout", () => {
  it.each(["absent", "closed", "open"] as const)(
    "restores its own %s layout instead of another split pane's layout",
    (preference) => {
      vi.stubGlobal("localStorage", createStorageMock());
      const left = "agent:main:left";
      const right = "agent:main:right";
      const rightLayout = openSlot({ columns: [] }, "workspace");
      const leftLayout = setSidebarOpen(openSlot({ columns: [] }, "tasks"), preference === "open");
      const client = createGatewayBrowserClientFixture();
      const context = createInitializationContext(client);
      const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
      pane.context = context;
      pane.sessionKey = left;
      pane.chatMessagesBySession = new Map();
      patchSettings({
        sessionKey: right,
        sidebarSessionLayouts: {
          [right]: rightLayout,
          ...(preference !== "absent" ? { [left]: leftLayout } : {}),
        },
        sidebarSessionActivePanels: {
          [right]: "workspace",
          ...(preference !== "absent" ? { [left]: "tasks" } : {}),
        },
      });
      const stopAfterAttach = new Error("stop after attach");
      vi.spyOn(pane.chatState, "attach").mockImplementation(() => {
        throw stopAfterAttach;
      });
      const expectOwnLayout = () => {
        expect(pane.state.sessionKey).toBe(left);
        expect(isSidebarSlotVisible(pane.state.sidebarLayout, "workspace")).toBe(false);
        expect(isSidebarSlotVisible(pane.state.sidebarLayout, "tasks")).toBe(preference === "open");
        expect(pane.state.sidebarFocusPanelId).toBe(preference === "absent" ? "" : "tasks");
      };
      try {
        expect(() => pane.connectedCallback()).toThrow(stopAfterAttach);
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
});

describe("chat pane session suggestion lifecycle", () => {
  function createSuggestionPane(client: GatewayBrowserClient) {
    const fixture = createTestChatPane({ client, sessions: {} as SessionCapability });
    fixture.pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    return fixture;
  }

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
    const row = (id: string, text: string) => pendingSuggestion(state.sessionKey, id, text);

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

  it.each(["attachments", "mentions"] as const)(
    "rejects suggestion submission while %s remain",
    async (content) => {
      const request = vi.fn();
      const client = { request } as unknown as GatewayBrowserClient;
      const { pane, state } = createSuggestionPane(client);
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
    const firstList = createDeferred<SessionSuggestionsListResult>();
    const secondList = createDeferred<SessionSuggestionsListResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(firstList.promise)
      .mockReturnValueOnce(secondList.promise);
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createSuggestionPane(client);
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
    const eventSuggestion = pendingSuggestion(state.sessionKey, "event", "new event");
    const existingSuggestion: SessionSuggestion = {
      ...eventSuggestion,
      id: "existing",
      text: "already queued",
      createdAt: 0,
    };

    const pending = pane.refreshSessionSuggestions();
    const overlapping = pane.refreshSessionSuggestions();
    expect(request).toHaveBeenCalledTimes(1);
    pane.handleSessionSuggestionEvent({ action: "added", suggestion: eventSuggestion });
    firstList.resolve({ suggestions: [existingSuggestion], role: "viewer" });
    await Promise.all([pending, overlapping]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    secondList.resolve({ suggestions: [existingSuggestion, eventSuggestion], role: "viewer" });
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
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createSuggestionPane(client);
    const row = (sessionId: string): GatewaySessionRow =>
      ({
        key: state.sessionKey,
        kind: "direct",
        sessionId,
        updatedAt: 1,
        visibility: "suggest",
        sharingRole: "owner",
      }) as GatewaySessionRow;
    const stale = pendingSuggestion(state.sessionKey, "stale-instance", "old instance");
    const fresh: SessionSuggestion = {
      ...stale,
      id: "fresh-instance",
      text: "new instance",
    };

    pane.syncSessionSuggestionTarget("main", row("session-a"));
    await pane.refreshSessionSuggestions();
    pane.sessionSuggestions = [stale];
    state.sessionsResultAgentId = "main";
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [row("session-b")],
    } as never;

    pane.syncSessionSuggestionTarget("main", row("session-b"));

    expect(pane.sessionSuggestions).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    listed.resolve({ suggestions: [fresh], role: "owner" });
    await vi.waitFor(() => expect(pane.sessionSuggestions).toEqual([fresh]));
  });

  it("clears displayed typing actors when the session instance rotates", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createSuggestionPane(client);
    const row = (sessionId: string): GatewaySessionRow =>
      ({
        key: state.sessionKey,
        kind: "direct",
        sessionId,
        updatedAt: 1,
        visibility: "suggest",
        sharingRole: "owner",
      }) as GatewaySessionRow;
    const sessionA = row("session-a");
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [sessionA],
    } as never;
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
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [sessionB],
    } as never;
    pane.syncSessionSuggestionTarget("main", sessionB);

    expect(pane.typingActors.size).toBe(0);
  });

  it("preserves an author's resolved event while its role is still loading", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createSuggestionPane(client);
    pane.context.gateway.snapshot.selfUser = { id: "alice" } as never;
    const pending = pendingSuggestion(state.sessionKey, "mine", "my suggestion");
    pane.sessionSuggestions = [pending];

    pane.handleSessionSuggestionEvent({
      action: "resolved",
      suggestion: { ...pending, state: "accepted" },
    });
    expect(pane.sessionSuggestions).toEqual([{ ...pending, state: "accepted" }]);
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
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createSuggestionPane(client);
    pane.context.gateway.snapshot.selfUser = { id: "owner" } as never;
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: 1,
          visibility: "suggest",
          sharingRole: "owner",
        },
      ],
    } as never;
    const pending: SessionSuggestion = {
      id: "owner-suggestion",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "owner", label: "Owner" },
      text: "my resolved suggestion",
      createdAt: 1,
      state: "pending",
    };
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
    const client = {
      request: vi.fn(() => response.promise),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const session = (sessionId: string): GatewaySessionRow =>
      ({
        key: state.sessionKey,
        kind: "direct",
        sessionId,
        updatedAt: 1,
        visibility: "suggest",
        sharingRole: "owner",
      }) as GatewaySessionRow;
    const suggestion: SessionSuggestion = {
      id: "old-instance-resolution",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "owner", label: "Owner" },
      text: "old instance suggestion",
      createdAt: 1,
      state: "pending",
    };
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

  it("loads an owner's pending suggestions after visibility changes to draft", async () => {
    const visibility = "draft";
    const pending: SessionSuggestion = {
      id: `pending-${visibility}`,
      sessionKey: "agent:main:current",
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "still needs review",
      createdAt: 1,
      state: "pending",
    };
    const request = vi.fn(async () => ({ suggestions: [pending], role: "owner" as const }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createSuggestionPane(client);
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: 1,
          visibility,
          sharingRole: "owner",
        },
      ],
    } as never;

    await pane.refreshSessionSuggestions();

    expect(request).toHaveBeenCalledWith(
      "session.suggestions.list",
      expect.objectContaining({ sessionKey: state.sessionKey }),
    );
    expect(pane.sessionSuggestions).toEqual([pending]);
    expect(pane.sessionSuggestionRole).toBe("owner");
  });

  it("does not apply an edit failure after the same session key rotates instances", async () => {
    const deferred = createDeferred<never>();
    const client = {
      request: vi.fn(() => deferred.promise),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const suggestion = pendingSuggestion(state.sessionKey, "edit", "suggested text");
    state.handleChatDraftChange = (next) => {
      state.chatMessage = next;
    };
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

  it("keeps suggested text after an ambiguous edit failure", async () => {
    const client = {
      request: vi.fn(async () => {
        throw new Error("response lost");
      }),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const suggestion = pendingSuggestion(
      state.sessionKey,
      "edit-ambiguous",
      "@Alex preserve this suggestion",
    );
    state.handleChatDraftChange = (next, mentions) => handleChatDraftChange(state, next, mentions);
    state.chatMessage = "@Alex owner draft";
    state.chatMentions = [{ profileId: "alex-profile", start: 0, end: 5 }];

    await pane.resolveCurrentSessionSuggestion(suggestion, "edit");

    expect(state.chatMessage).toBe("@Alex preserve this suggestion");
    expect(state.chatMentions).toEqual([]);
    expect(state.chatError).toBe("response lost");
  });

  it.each([false, true])(
    "restores only an untouched owner draft after an edit rejection (reselected=%s)",
    async (reselected) => {
      const deferred = createDeferred<never>();
      const client = {
        request: vi.fn(() => deferred.promise),
      } as unknown as GatewayBrowserClient;
      const { pane, state } = createTestChatPane({
        client,
        sessions: {} as SessionCapability,
      });
      const suggestion = pendingSuggestion(
        state.sessionKey,
        "edit-rejected",
        "@Alex rejected suggestion",
      );
      state.handleChatDraftChange = (next, mentions) =>
        handleChatDraftChange(state, next, mentions);
      state.chatMessage = "@Alex owner draft";
      state.chatMentions = [{ profileId: "original-profile", start: 0, end: 5 }];

      const resolving = pane.resolveCurrentSessionSuggestion(suggestion, "edit");
      expect(state.chatMentions).toEqual([]);
      if (reselected) {
        state.handleChatDraftChange(suggestion.text, [
          { profileId: "replacement-profile", start: 0, end: 5 },
        ]);
      }
      deferred.reject(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "suggestion already resolved",
        }),
      );
      await resolving;

      expect(state.chatMessage).toBe(reselected ? suggestion.text : "@Alex owner draft");
      expect(state.chatMentions).toEqual([
        { profileId: reselected ? "replacement-profile" : "original-profile", start: 0, end: 5 },
      ]);
      expect(state.chatError).toBe("suggestion already resolved");
    },
  );

  it("serializes edit resolutions so rejected suggestions cannot snapshot each other", async () => {
    const first = createDeferred<never>();
    const second = createDeferred<never>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const suggestion = (id: string, text: string) => pendingSuggestion(state.sessionKey, id, text);
    state.handleChatDraftChange = (next) => {
      state.chatMessage = next;
    };
    state.chatMessage = "owner draft";

    const firstPending = pane.resolveCurrentSessionSuggestion(suggestion("first", "first"), "edit");
    await pane.resolveCurrentSessionSuggestion(suggestion("second", "second"), "edit");
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatMessage).toBe("first");

    first.reject(
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "first was rejected" }),
    );
    await firstPending;
    expect(state.chatMessage).toBe("owner draft");

    const secondPending = pane.resolveCurrentSessionSuggestion(
      suggestion("second", "second"),
      "edit",
    );
    second.reject(
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "second was rejected" }),
    );
    await secondPending;
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.chatMessage).toBe("owner draft");
  });
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

    pane.appendChild(paneConfirmation.owner);
    pane.disconnectedCallback();

    expect(paneConfirmation.popover.isConnected).toBe(false);
    expect(siblingConfirmation.popover.isConnected).toBe(true);
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
});
