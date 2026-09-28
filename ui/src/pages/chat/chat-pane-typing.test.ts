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

  it("keeps a paused draft stable and expires it 30 seconds after the last edit", () => {
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
    vi.advanceTimersByTime(9_999);
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    expect(container.querySelector(".agent-chat__typing-state")?.textContent).toBe("is typing...");
    expect(container.querySelector(".agent-chat__typing-state")?.hasAttribute("data-typing")).toBe(
      true,
    );
    vi.advanceTimersByTime(1);
    expect(pane.typingActorViews()).toEqual([
      { id: "alice", label: "Alice", preview: typing.preview, paused: true },
    ]);
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    expect(container.querySelector(".chat-bubble")).toBe(bubble);
    expect(container.querySelector(".agent-chat__typing-state")?.textContent).toBe("Draft");
    expect(container.querySelector(".agent-chat__typing-state")?.hasAttribute("data-typing")).toBe(
      false,
    );
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
    vi.advanceTimersByTime(10_000);
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
    vi.advanceTimersByTime(29_999);
    expect(pane.typingActors.size).toBe(1);
    pane.handleSessionTypingEvent({ ...typing, preview: "Still here" });
    vi.advanceTimersByTime(1);
    expect(pane.typingActors.size).toBe(1);
    vi.advanceTimersByTime(29_999);
    expect(pane.typingActors.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    pane.handleSessionTypingEvent(typing);
    vi.setSystemTime(Date.now() + 30_000);
    vi.advanceTimersByTime(10_000);
    expect(pane.typingActors.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an exit on renewed typing without keeping another actor past its deadline", () => {
    vi.useFakeTimers();
    const { pane, state } = createTypingPane();
    const typing = {
      sessionKey: state.sessionKey,
      sessionId: "session-a",
      agentId: "work",
      actor: { type: "human", id: "alice", label: "Alice" },
      typing: true,
      preview: "A draft",
      ts: 1,
    } as const;
    pane.handleSessionTypingEvent(typing);
    pane.handleSessionTypingEvent({ ...typing, actor: { type: "human", id: "bob", label: "Bob" } });
    const container = document.createElement("div");
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    const row = container.querySelector(".agent-chat__typing-row");
    const bubble = row?.querySelector(".chat-bubble");
    vi.advanceTimersByTime(29_699);
    expect(pane.typingActorViews().every((actor) => actor.exitDurationMs === undefined)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(pane.typingActorViews().map((actor) => actor.exitDurationMs)).toEqual([300, 300]);
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    expect(container.querySelectorAll("[data-exiting]")).toHaveLength(2);
    expect(row?.getAttribute("style")).toContain("--chat-typing-exit-duration: 300ms");
    expect(row?.querySelector(".chat-bubble")).toBe(bubble);
    vi.advanceTimersByTime(100);
    pane.handleSessionTypingEvent({ ...typing, preview: "Still writing" });
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    expect(row?.hasAttribute("data-exiting")).toBe(false);
    expect(row?.getAttribute("style")).toBeNull();
    expect(row?.querySelector(".chat-bubble")).toBe(bubble);
    expect(row?.textContent).toContain("Still writing");
    vi.advanceTimersByTime(200);
    expect([...pane.typingActors.keys()]).toEqual(["alice"]);
    vi.advanceTimersByTime(29_500);
    expect(pane.typingActorViews()[0]?.exitDurationMs).toBe(300);
    pane.handleSessionTypingEvent({ ...typing, typing: false });
    expect(pane.typingActors.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shortens a delayed exit to the remaining idle budget", () => {
    vi.useFakeTimers();
    const { pane, state } = createTypingPane();
    pane.handleSessionTypingEvent({
      sessionKey: state.sessionKey,
      sessionId: "session-a",
      agentId: "work",
      actor: { type: "human", id: "alice", label: "Alice" },
      typing: true,
      preview: "A draft",
      ts: 1,
    });
    vi.setSystemTime(Date.now() + 19_800);
    vi.advanceTimersByTime(10_000);
    expect(pane.typingActorViews()[0]?.exitDurationMs).toBe(200);
    vi.advanceTimersByTime(200);
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
      vi.advanceTimersByTime(10_000);
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
    ).toContain("is typing...");
    expect(container.querySelectorAll(".chat-group.user.chat-group--peer")).toHaveLength(2);
    expect(container.querySelector(".agent-chat__typing-group")).toBeNull();
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

  it("keeps two preview drafts while only active overflow people own the shared row", () => {
    vi.useFakeTimers();
    const { pane, state } = createTypingPane();
    const event = (index: number, typing = true) => ({
      sessionKey: state.sessionKey,
      sessionId: "session-a",
      agentId: "work",
      actor: { type: "human" as const, id: "peer-" + index, label: "Peer " + index },
      typing,
      preview: "Draft " + index,
      ts: 1,
    });
    const container = document.createElement("div");
    for (let count = 1; count <= 8; count += 1) {
      pane.handleSessionTypingEvent(event(count));
      render(
        renderChatTypingIndicator(pane.typingActorViews(), "gutter", pane.typingOverflow),
        container,
      );
      expect(container.querySelectorAll(".chat-bubble")).toHaveLength(Math.min(2, count));
      expect(container.querySelectorAll(".agent-chat__typing-person")).toHaveLength(
        Math.min(5, Math.max(0, count - 2)),
      );
      expect(pane.typingActorViews().filter((actor) => actor.preview)).toHaveLength(
        Math.min(2, count),
      );
    }
    expect(container.querySelector(".agent-chat__typing-summary")?.textContent).toBe(
      "Several people are typing…",
    );
    expect(container.querySelector("[role=status]")?.textContent).toBe(
      "Several people are typing…",
    );
    const stable = pane.typingActorViews();
    const requestUpdate = vi.spyOn(pane, "requestUpdate");
    for (let index = 0; index < 100; index += 1) {
      pane.handleSessionTypingEvent({ ...event(9), preview: "Unprojected " + index });
    }
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(pane.typingActorViews()).toBe(stable);
    pane.handleSessionTypingEvent(event(9, false));
    pane.handleSessionTypingEvent(event(8, false));
    expect(pane.typingOverflow).toBeUndefined();
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    expect(container.querySelector(".agent-chat__typing-summary")?.textContent).toBe(
      "Peer 3, Peer 4, and 3 others are typing…",
    );
    vi.advanceTimersByTime(10_000);
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    expect(pane.typingActorViews()).toEqual([
      { id: "peer-1", label: "Peer 1", preview: "Draft 1", paused: true },
      { id: "peer-2", label: "Peer 2", preview: "Draft 2", paused: true },
    ]);
    expect(container.querySelector(".agent-chat__typing-group")).toBeNull();
    expect(container.querySelectorAll(".agent-chat__typing-state")[0]?.textContent).toBe("Draft");
    pane.handleSessionTypingEvent(event(7));
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    expect(container.querySelector(".agent-chat__typing-summary")?.textContent).toBe(
      "Peer 7 is typing…",
    );
    expect(container.querySelectorAll(".agent-chat__typing-person")).toHaveLength(1);
    pane.handleSessionTypingEvent(event(7, false));
    render(renderChatTypingIndicator(pane.typingActorViews()), container);
    expect(container.querySelector(".agent-chat__typing-group")).toBeNull();
    expect(container.querySelectorAll(".chat-bubble")).toHaveLength(2);
    pane.clearTypingActors();
    expect(pane.typingActorViews()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires simultaneous expirations together without promoting expired peers or removing a renewed draft", () => {
    vi.useFakeTimers();
    const { pane, state } = createTypingPane();
    const event = (index: number) => ({
      sessionKey: state.sessionKey,
      sessionId: "session-a",
      agentId: "work",
      actor: { type: "human" as const, id: "peer-" + index, label: "Peer " + index },
      typing: true,
      preview: "Draft " + index,
      ts: 1,
    });
    for (let index = 0; index < 1000; index += 1) {
      pane.handleSessionTypingEvent(event(index));
    }
    const requestUpdate = vi.spyOn(pane, "requestUpdate");
    vi.advanceTimersByTime(10_000);
    // The active-only overflow vanishes in bounded updates even though the
    // first two preview drafts remain retained for their own idle deadline.
    expect(requestUpdate.mock.calls.length).toBeLessThan(12);
    expect(pane.typingActorViews()).toHaveLength(2);
    expect(pane.typingOverflow).toBeUndefined();
    vi.advanceTimersByTime(19_800);
    pane.handleSessionTypingEvent({ ...event(999), preview: "Renewed during exit" });
    requestUpdate.mockClear();
    vi.advanceTimersByTime(200);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    expect(pane.typingActors.size).toBe(1);
    expect(pane.typingActorViews()).toEqual([
      { id: "peer-999", label: "Peer 999", preview: "Renewed during exit" },
    ]);
    expect(pane.typingOverflow).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    // A boolean-only actor has its own 2.5s deadline, not the draft deadline.
    pane.handleSessionTypingEvent({ ...event(1000), preview: undefined });
    vi.advanceTimersByTime(2_500);
    expect([...pane.typingActors.keys()]).toEqual(["peer-999"]);
    pane.clearTypingActors();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the active-only overflow on idle, stop, and reset while preview drafts remain", () => {
    vi.useFakeTimers();
    const { pane, state } = createTypingPane();
    const event = (index: number, typing = true) => ({
      sessionKey: state.sessionKey,
      sessionId: "session-a",
      agentId: "work",
      actor: { type: "human" as const, id: "peer-" + index, label: "Peer " + index },
      typing,
      preview: "Draft " + index,
      ts: 1,
    });
    for (let index = 0; index < 8; index += 1) {
      pane.handleSessionTypingEvent(event(index));
    }
    const container = document.createElement("div");
    render(
      renderChatTypingIndicator(pane.typingActorViews(), "gutter", pane.typingOverflow),
      container,
    );
    expect(pane.typingOverflow).toEqual({ several: true });
    expect(container.querySelector(".agent-chat__typing-summary")?.textContent).toBe(
      "Several people are typing…",
    );
    vi.advanceTimersByTime(10_000);
    render(
      renderChatTypingIndicator(pane.typingActorViews(), "gutter", pane.typingOverflow),
      container,
    );
    expect(pane.typingOverflow).toBeUndefined();
    expect(container.querySelector(".agent-chat__typing-group")).toBeNull();
    expect(container.querySelectorAll(".chat-bubble")).toHaveLength(2);
    expect(container.querySelectorAll(".agent-chat__typing-state")[0]?.textContent).toBe("Draft");
    pane.handleSessionTypingEvent(event(7));
    render(
      renderChatTypingIndicator(pane.typingActorViews(), "none", pane.typingOverflow),
      container,
    );
    expect(container.querySelector(".agent-chat__typing-summary")?.textContent).toBe(
      "Peer 7 is typing…",
    );
    expect(container.querySelector(".agent-chat__typing-overflow")?.getAttribute("title")).toBe(
      "Peer 7 — is typing...",
    );
    expect(container.querySelectorAll("[role=img]")).toHaveLength(0);
    pane.handleSessionTypingEvent(event(7, false));
    render(
      renderChatTypingIndicator(pane.typingActorViews(), "gutter", pane.typingOverflow),
      container,
    );
    expect(container.querySelector(".agent-chat__typing-group")).toBeNull();
    pane.clearTypingActors();
    expect(pane.typingActorViews()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("names one to five active overflow people, bounds avatars, and shimmers only live text", () => {
    const container = document.createElement("div");
    const actors = ["Alice", "Ben", "Camila", "Dev", "Emilia", "Farid", "Grace"].map(
      (label, index) => ({ id: "peer-" + index, label, preview: "Draft" }),
    );
    const expected = [
      "Camila is typing…",
      "Camila and Dev are typing…",
      "Camila, Dev, and Emilia are typing…",
      "Camila, Dev, and 2 others are typing…",
      "Camila, Dev, and 3 others are typing…",
    ];
    for (let count = 3; count <= 7; count += 1) {
      render(renderChatTypingIndicator(actors.slice(0, count)), container);
      expect(container.querySelector(".agent-chat__typing-summary")?.textContent).toBe(
        expected[count - 3],
      );
      expect(container.querySelectorAll(".agent-chat__typing-person")).toHaveLength(count - 2);
    }
    const group = container.querySelector(".agent-chat__typing-group");
    const summary = container.querySelector(".agent-chat__typing-summary");
    const stack = container.querySelector(".agent-chat__typing-identities");
    const avatars = [...container.querySelectorAll(".agent-chat__typing-person")];
    render(renderChatTypingIndicator(actors, "gutter", { several: true }), container);
    expect(summary?.textContent).toBe("Several people are typing…");
    expect(container.querySelector(".agent-chat__typing-group")).toBe(group);
    expect(container.querySelector(".agent-chat__typing-identities")).toBe(stack);
    expect(
      [...container.querySelectorAll(".agent-chat__typing-person")].every(
        (node, index) => node === avatars[index],
      ),
    ).toBe(true);
    expect(summary?.querySelector(".agent-chat__typing-text")?.hasAttribute("data-typing")).toBe(
      true,
    );
    const longName = "<script>not markup</script> " + "LongName".repeat(30);
    render(
      renderChatTypingIndicator([actors[0]!, actors[1]!, { id: "new", label: longName }]),
      container,
    );
    expect(summary?.textContent).toBe(longName + " is typing…");
    expect(container.querySelector(".agent-chat__typing-name")?.getAttribute("title")).toBe(
      longName,
    );
    expect(container.querySelectorAll("script")).toHaveLength(0);
    render(
      renderChatTypingIndicator([
        { ...actors[0]!, paused: true },
        { ...actors[1]!, paused: true },
      ]),
      container,
    );
    expect(container.querySelector(".agent-chat__typing-group")).toBeNull();
    expect(container.querySelectorAll(".agent-chat__typing-state")[0]?.textContent).toBe("Draft");
    expect(container.querySelector("[role=status]")?.textContent).toBe("");
  });

  it("finds sparse active overflow names without scanning retained idle drafts", () => {
    vi.useFakeTimers();
    const { pane, state } = createTypingPane();
    const event = (index: number, typing = true) => ({
      sessionKey: state.sessionKey,
      sessionId: "session-a",
      agentId: "work",
      actor: { type: "human" as const, id: "peer-" + index, label: "Peer " + index },
      typing,
      preview: "Draft",
      ts: 1,
    });
    for (let i = 0; i < 1000; i += 1) {
      pane.handleSessionTypingEvent(event(i));
    }
    vi.advanceTimersByTime(10_000);
    let visits = 0;
    const original = pane.typingActors[Symbol.iterator].bind(pane.typingActors);
    vi.spyOn(pane.typingActors, Symbol.iterator).mockImplementation(() => {
      const iterator = original();
      const next = iterator.next.bind(iterator);
      iterator.next = () => {
        visits += 1;
        return next();
      };
      return iterator;
    });
    pane.handleSessionTypingEvent(event(999));
    expect(visits).toBeLessThan(4);
    expect(pane.typingOverflow).toBeUndefined();
    expect(
      pane
        .typingActorViews()
        .slice(2)
        .map((actor) => actor.label),
    ).toEqual(["Peer 999"]);
    pane.handleSessionTypingEvent({
      ...event(999),
      actor: { ...event(999).actor, label: "Renamed" },
    });
    expect(pane.typingActorViews()[2]?.label).toBe("Renamed");
    const update = vi.spyOn(pane, "requestUpdate");
    pane.handleSessionTypingEvent({
      ...event(999),
      actor: { ...event(999).actor, label: "Renamed" },
      preview: "Hidden edit",
    });
    expect(update).not.toHaveBeenCalled();
    pane.handleSessionTypingEvent(event(998));
    expect(
      pane
        .typingActorViews()
        .slice(2)
        .map((actor) => actor.label),
    ).toEqual(["Renamed", "Peer 998"]);
    pane.handleSessionTypingEvent(event(999, false));
    expect(
      pane
        .typingActorViews()
        .slice(2)
        .map((actor) => actor.label),
    ).toEqual(["Peer 998"]);
    pane.handleSessionTypingEvent(event(998, false));
    expect(pane.typingActorViews()).toHaveLength(2);
    pane.clearTypingActors();
    expect(vi.getTimerCount()).toBe(0);
  });

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
