/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-typing.test/"} */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { renderChatTypingIndicator } from "./components/chat-typing-indicator.ts";
import { scheduleCommittedChatScroll } from "./scroll.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createTypingPane() {
  const request = vi.fn().mockResolvedValue({ ok: true, broadcast: true });
  const fixture = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture(),
  });
  const { pane, state } = fixture;
  pane.presencePayload = { presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }] };
  state.sessionKey = "agent:work:main";
  state.assistantAgentId = "work";
  state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
  state.sessionsResultAgentId = "work";
  const row: GatewaySessionRow = {
    key: "global",
    kind: "global",
    sessionId: "session-a",
    updatedAt: 1,
    visibility: "shared",
    sharingRole: "owner",
  };
  state.sessionsResult = {
    ts: 1,
    count: 1,
    path: "",
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [row],
  };
  return { ...fixture, request, row };
}

describe("chat pane typing presence", () => {
  it.each(["auto", "manual"] as const)(
    "remote typing preserves the viewport with a pending %s scroll",
    (source) => {
      vi.useFakeTimers();
      const { pane, state } = createTestChatPane({
        client: { request: vi.fn() } as unknown as GatewayBrowserClient,
        sessions: {} as SessionCapability,
      });
      state.sessionKey = "agent:main:main";
      state.sessionsResult = {
        count: 1,
        path: "",
        sessions: [
          { key: state.sessionKey, kind: "direct", sessionId: "typing-scroll", updatedAt: 1 },
        ],
      } as never;
      pane.presencePayload = {
        presence: [{ user: { id: "owner" } }, { user: { id: "writer" } }],
      };
      const scrollport = document.createElement("div");
      let extent = 2000;
      Object.defineProperties(scrollport, {
        scrollHeight: { get: () => extent },
        clientHeight: { value: 500 },
      });
      scrollport.scrollTop = 1500;
      state.chatScrollElement = () => scrollport;
      state.chatScrollToEnd = () => {
        scrollport.scrollTop = scrollport.scrollHeight - scrollport.clientHeight;
        return true;
      };
      state.chatHasAutoScrolled = true;
      state.chatUserNearBottom = true;
      scheduleCommittedChatScroll(state, false, true, { source });
      const typing = {
        sessionKey: state.sessionKey,
        sessionId: "typing-scroll",
        agentId: "main",
        actor: { type: "human", id: "writer", label: "Writer" },
        typing: true,
        preview: "A draft that has not been submitted",
        ts: 1,
      } as const;
      pane.handleSessionTypingEvent(typing);
      expect(pane.typingActorViews()).toHaveLength(1);
      extent += 83;
      vi.advanceTimersToNextFrame();
      expect(scrollport.scrollTop).toBe(source === "manual" ? 1583 : 1500);
      scheduleCommittedChatScroll(state, false, false, { source: "manual" });
      vi.advanceTimersToNextFrame();
      expect(scrollport.scrollTop).toBe(1583);
      pane.handleSessionTypingEvent({ ...typing, preview: "Updated draft" });
      scheduleCommittedChatScroll(state, false, false);
      extent += 83;
      vi.advanceTimersToNextFrame();
      expect(scrollport.scrollTop).toBe(1666);
    },
  );

  it("sender provenance clears only the exact profile sender and expires remaining actors", () => {
    vi.useFakeTimers();
    const { pane, state } = createTestChatPane({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    state.sessionKey = "agent:work:main";
    state.assistantAgentId = "work";
    state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
    state.sessionsResultAgentId = "work";
    const aliceId = "0d9f4c35-d221-49da-9a3f-b8c73921066b";
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: aliceId } }, { user: { id: "bob" } }],
    };
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [
        {
          key: "global",
          kind: "global",
          sessionId: "session-a",
          updatedAt: 1,
        } as GatewaySessionRow,
      ],
    } as never;
    for (const actor of [
      { id: aliceId, label: "Alice", preview: "Alice's ephemeral draft" },
      { id: "bob", label: "Bob" },
    ]) {
      pane.handleSessionTypingEvent({
        sessionKey: state.sessionKey,
        sessionId: "session-a",
        agentId: "work",
        actor: { type: "human", ...actor },
        typing: true,
        ...(actor.preview ? { preview: actor.preview } : {}),
        ts: 1,
      });
    }
    expect(pane.typingActorViews()).toEqual([
      { id: aliceId, label: "Alice", preview: "Alice's ephemeral draft" },
      { id: "bob", label: "Bob" },
    ]);

    const event = (message: unknown, sessionKey = state.sessionKey) => ({
      sessionKey,
      agentId: "work",
      message,
    });
    pane.clearTypingActorForSessionMessage(
      event({ role: "user", senderLabel: `Alice (${aliceId})` }),
    );
    pane.clearTypingActorForSessionMessage(
      event({ role: "assistant", __openclaw: { senderId: aliceId } }),
    );
    pane.clearTypingActorForSessionMessage(
      event({ role: "user", __openclaw: { senderId: aliceId } }, "agent:work:other"),
    );
    expect([...pane.typingActors.keys()]).toEqual([aliceId, "bob"]);

    pane.clearTypingActorForSessionMessage(
      event({ role: "user", __openclaw: { senderId: aliceId } }),
    );
    pane.clearTypingActorForSessionMessage(
      event({
        role: "user",
        __openclaw: {
          senderId: aliceId,
          senderIdentity: {
            type: "observation",
            id: aliceId,
            pluginId: "channel",
            accountId: null,
            senderKind: "unknown",
          },
        },
      }),
    );
    expect([...pane.typingActors.keys()]).toEqual([aliceId, "bob"]);
    pane.clearTypingActorForSessionMessage(
      event({
        role: "user",
        __openclaw: { senderId: aliceId, senderIdentity: { type: "profile", id: aliceId } },
      }),
    );
    expect([...pane.typingActors.keys()]).toEqual(["bob"]);

    vi.advanceTimersByTime(2_500);
    expect(pane.typingActors.size).toBe(0);
  });

  it("keeps a paused draft in place until it resumes or explicitly stops", () => {
    vi.useFakeTimers();
    const { pane, state } = createTestChatPane({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    state.sessionKey = "agent:main:main";
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [{ key: state.sessionKey, kind: "direct", sessionId: "pause", updatedAt: 1 }],
    } as never;
    pane.presencePayload = { presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }] };
    const typing = {
      sessionKey: state.sessionKey,
      sessionId: "pause",
      agentId: "main",
      actor: { type: "human", id: "alice", label: "Alice" },
      typing: true,
      preview: "Let me think about this",
      ts: 1,
    } as const;
    const container = document.createElement("div");
    pane.handleSessionTypingEvent(typing);
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    const bubble = container.querySelector(".chat-bubble");
    vi.advanceTimersByTime(2_500);
    expect(pane.typingActorViews()).toEqual([
      { id: "alice", label: "Alice", preview: typing.preview, paused: true },
    ]);
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    expect(container.querySelector(".chat-bubble")).toBe(bubble);
    expect(container.querySelector(".agent-chat__typing-state")?.textContent).toBe(
      "Paused · not sent",
    );
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
    vi.advanceTimersByTime(60_000);
    expect(pane.typingActors.size).toBe(1);
    pane.handleSessionTypingEvent({ ...typing, preview: "Here is my answer" });
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    expect(container.querySelector(".chat-bubble")).toBe(bubble);
    expect(container.querySelector("[role=status]")?.textContent).toBe("Alice is typing…");
    pane.handleSessionTypingEvent({ ...typing, typing: false });
    expect(pane.typingActors.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // A surviving tab can keep a departed writer's profile online. Retained
    // previews must still be bounded when its explicit stop never arrives.
    pane.handleSessionTypingEvent(typing);
    vi.advanceTimersByTime(119_999);
    expect(pane.typingActors.size).toBe(1);
    pane.handleSessionTypingEvent({ ...typing, preview: "Still here" });
    vi.advanceTimersByTime(1);
    expect(pane.typingActors.size).toBe(1);
    vi.advanceTimersByTime(119_999);
    expect(pane.typingActors.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    pane.handleSessionTypingEvent(typing);
    vi.setSystemTime(Date.now() + 120_000);
    vi.advanceTimersByTime(2_500);
    expect(pane.typingActors.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["disconnect", "leave", "unqualified"] as const)(
    "retires a paused draft on %s without removing another viewer's draft",
    (departure) => {
      vi.useFakeTimers();
      const { pane, state } = createTestChatPane({
        client: { request: vi.fn() } as unknown as GatewayBrowserClient,
        sessions: {} as SessionCapability,
      });
      state.sessionKey = "agent:work:main";
      state.assistantAgentId = "work";
      state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
      state.sessionsResultAgentId = "work";
      state.sessionsResult = {
        count: 1,
        path: "",
        sessions: [{ key: "global", kind: "global", sessionId: "pause", updatedAt: 1 }],
      } as never;
      const viewer = (id: string) => ({
        user: { id, identity: { type: "profile", id } },
        watchedSessions: ["agent:work:global"],
      });
      pane.presencePayload = { presence: [viewer("alice"), viewer("bob")] };
      for (const id of ["alice", "bob"]) {
        pane.handleSessionTypingEvent({
          sessionKey: state.sessionKey,
          sessionId: "pause",
          agentId: "work",
          actor: { type: "human", id, label: id },
          typing: true,
          preview: id + " draft",
          ts: 1,
        });
      }
      vi.advanceTimersByTime(2_500);
      pane.pruneTypingActors();
      expect(pane.typingActors.size).toBe(2);
      pane.presencePayload = {
        presence: [
          viewer("bob"),
          {
            ...viewer("alice"),
            ...(departure === "disconnect" ? { reason: "disconnect" } : {}),
            ...(departure === "leave" ? { watchedSessions: ["agent:main:global"] } : {}),
            ...(departure === "unqualified" ? { user: { id: "alice" } } : {}),
          },
        ],
      };
      pane.pruneTypingActors();
      expect([...pane.typingActors.keys()]).toEqual(["bob"]);
      pane.clearTypingActorForSessionMessage({
        sessionKey: state.sessionKey,
        agentId: "work",
        message: { role: "user", __openclaw: { senderIdentity: { type: "profile", id: "bob" } } },
      });
      expect(pane.typingActors.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("renders draft bubbles separately from boolean-only dots and live status", () => {
    const container = document.createElement("div");
    render(
      renderChatTypingIndicator([
        { id: "alice", label: "Alice", preview: "Hello **world**" },
        { id: "bob", label: "Bob" },
        { id: "carol", label: "Carol", preview: "Paused draft", paused: true },
      ]),
      container,
    );

    expect(container.querySelector(".agent-chat__typing-preview-bubble")?.textContent).toContain(
      "Hello **world**",
    );
    expect(container.querySelector(".agent-chat__typing-preview-label")?.textContent?.trim()).toBe(
      "Alice",
    );
    expect(
      container.querySelector(".chat-group--typing .chat-group-footer")?.textContent,
    ).toContain("Typing · not sent");
    expect(container.querySelectorAll(".chat-group.user.chat-group--peer")).toHaveLength(3);
    expect(
      container.querySelector(".chat-group--typing .chat-bubble .chat-text")?.textContent,
    ).toContain("Hello **world**");
    expect(
      container
        .querySelector(".agent-chat__typing-preview-bubble")
        ?.closest("[aria-live]")
        ?.getAttribute("aria-live"),
    ).toBe("off");
    expect(container.querySelectorAll(".agent-chat__typing-bubble > span")).toHaveLength(3);
    expect(container.querySelector(".sr-only")?.textContent).toBe("Alice, Bob are typing…");
  });

  it("keeps each actor’s bubble stable across draft, dots, and peer updates without interpreting markup", () => {
    const container = document.createElement("div");
    const alice = {
      id: "alice",
      label: "Alice",
      preview: "<img src=x onerror=alert(1)> **draft**",
    };
    const bob = { id: "bob", label: "Bob", preview: "Hello" };
    render(renderChatTypingIndicator([alice, bob]), container);
    const aliceGroup = container.querySelector(".chat-group--typing");
    const aliceBubble = aliceGroup?.querySelector(".chat-bubble");
    expect(aliceGroup?.querySelector(".chat-text")?.textContent).toBe(alice.preview);
    expect(aliceGroup?.querySelectorAll(".chat-text img, .chat-text strong")).toHaveLength(0);
    render(renderChatTypingIndicator([bob, { ...alice, preview: "   " }]), container);
    expect(container.querySelectorAll(".chat-group--typing")[1]).toBe(aliceGroup);
    expect(aliceGroup?.querySelector(".chat-bubble")).toBe(aliceBubble);
    expect(aliceGroup?.querySelectorAll(".agent-chat__typing-bubble > span")).toHaveLength(3);
    render(renderChatTypingIndicator([{ ...alice, preview: "Edited draft" }]), container);
    expect(container.querySelector(".chat-group--typing")).toBe(aliceGroup);
    expect(aliceGroup?.querySelector(".chat-bubble")).toBe(aliceBubble);
    expect(aliceGroup?.querySelector(".chat-text")?.textContent).toBe("Edited draft");
    expect(container.querySelector("[role=status]")?.textContent).toBe("Alice is typing…");
    render(renderChatTypingIndicator([]), container);
    expect(container.querySelector(".agent-chat__typing-indicator")).toBeNull();
  });

  it.each(["gutter", "footer", "none"] as const)(
    "uses the transcript’s %s avatar placement",
    (placement) => {
      const container = document.createElement("div");
      render(
        renderChatTypingIndicator([{ id: "alice", label: "Alice", preview: "A draft" }], placement),
        container,
      );
      expect(
        container.querySelectorAll(
          ".chat-message-avatar-anchor > :is(.chat-avatar, .chat-avatar-slot)",
        ),
      ).toHaveLength(placement === "gutter" ? 1 : 0);
      expect(container.querySelectorAll(".chat-group-footer .chat-author-avatar")).toHaveLength(
        placement === "footer" ? 1 : 0,
      );
      expect(container.querySelector(".chat-sender-name")?.textContent).toBe("Alice");
    },
  );

  it("sends only the last 300 draft code points and omits previews when typing stops", () => {
    const { pane, request } = createTypingPane();

    pane.sendTypingState(true, `  prefix${"😀".repeat(300)}  `);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "session.typing",
      expect.objectContaining({
        sessionKey: "agent:work:main",
        sessionId: "session-a",
        agentId: "work",
        typing: true,
        preview: "😀".repeat(300),
      }),
    );

    pane.sendTypingState(false, "must not leak");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ typing: false });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("preview");

    pane.sendTypingState(true, "   ");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("preview");
  });

  it("paces a continuous draft at 250 ms and delivers the latest trailing preview", () => {
    vi.useFakeTimers();
    const { pane, request } = createTypingPane();
    for (let index = 0; index < 10; index += 1) {
      pane.sendTypingState(true, `draft ${index}`);
      vi.advanceTimersByTime(100);
    }
    expect(request.mock.calls.map(([, params]) => params.preview)).toEqual([
      "draft 0",
      "draft 2",
      "draft 4",
      "draft 7",
      "draft 9",
    ]);
    vi.advanceTimersByTime(250);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("stops immediately and cancels the queued draft before a new typing burst", () => {
    vi.useFakeTimers();
    const { pane, request } = createTypingPane();
    pane.sendTypingState(true, "first");
    vi.advanceTimersByTime(100);
    pane.sendTypingState(true, "pending");
    pane.sendTypingState(false);
    expect(request.mock.calls.map(([, params]) => params.typing)).toEqual([true, false]);
    vi.advanceTimersByTime(250);
    expect(request).toHaveBeenCalledTimes(2);
    pane.sendTypingState(true, "new draft");
    expect(request.mock.calls[2]?.[1]).toMatchObject({ typing: true, preview: "new draft" });
  });

  it.each([
    "disconnect",
    "reconnect",
    "client",
    "session",
    "generation",
    "role",
    "visibility",
    "solo",
  ])("discards a queued preview after %s changes its target", (change) => {
    vi.useFakeTimers();
    const { pane, state, request, row } = createTypingPane();
    pane.sendTypingState(true, "first");
    pane.sendTypingState(true, "pending");
    switch (change) {
      case "disconnect":
        state.connected = false;
        break;
      case "reconnect":
        pane.connectionGeneration += 1;
        break;
      case "client":
        state.client = createGatewayBrowserClientFixture();
        break;
      case "session":
        state.sessionKey = "agent:work:other";
        break;
      case "generation":
        row.sessionId = "session-b";
        break;
      case "role":
        row.sharingRole = "viewer";
        break;
      case "visibility":
        row.visibility = "draft";
        break;
      case "solo":
        pane.presencePayload = { presence: [{ user: { id: "owner" } }] };
        break;
    }
    vi.advanceTimersByTime(250);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
