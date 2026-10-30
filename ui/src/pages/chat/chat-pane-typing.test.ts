/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-typing.test/"} */

import { createEffect, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionTypingEvent } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { PresencePayload } from "../../app/user-profile.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";
import { renderTypingIndicator } from "./components/chat-status.test-support.ts";
import { scheduleCommittedChatScroll } from "./scroll.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setGlobalSession(
  state: ReturnType<typeof createTestChatPane>["state"],
  sessionId: string,
) {
  state.sessionKey = "agent:work:main";
  state.assistantAgentId = "work";
  state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
  state.sessionsResultAgentId = "work";
  const row: GatewaySessionRow = { key: "global", kind: "global", sessionId, updatedAt: 1 };
  state.sessionsResult = { count: 1, path: "", sessions: [row] } as never;
  return row;
}

function typingDom() {
  const container = document.createElement("div");
  return {
    container,
    query: (selector: string) => container.querySelector(selector),
    all: (selector: string) => container.querySelectorAll(selector),
    text: (selector: string) => container.querySelector(selector)?.textContent,
    render: (
      actors: Parameters<typeof renderTypingIndicator>[0],
      placement?: Parameters<typeof renderTypingIndicator>[2],
      overflow?: Parameters<typeof renderTypingIndicator>[3],
    ) => renderTypingIndicator(actors, container, placement, overflow),
  };
}

function globalTypingPane(sessionId = "session-a") {
  const fixture = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: {} as SessionCapability,
  });
  setGlobalSession(fixture.state, sessionId);
  return fixture;
}

function peerEvent(sessionKey: string, index: number, typing = true) {
  return typingEvent(sessionKey, {
    actor: { type: "human", id: "peer-" + index, label: "Peer " + index },
    typing,
    preview: "Draft " + index,
  });
}

function typingEvent(
  sessionKey: string,
  extra: Partial<SessionTypingEvent> = {},
): SessionTypingEvent {
  return {
    sessionKey,
    sessionId: "session-a",
    agentId: "work",
    actor: { type: "human", id: "alice", label: "Alice" },
    typing: true,
    ts: 1,
    ...extra,
  };
}

function createTypingPane() {
  const request = vi.fn().mockResolvedValue({ ok: true, broadcast: true });
  const fixture = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: createSessionCapabilityFixture(),
  });
  const { pane, state } = fixture;
  pane.presence.update({
    presence: [
      { ts: 1, user: { id: "owner" } },
      { ts: 1, user: { id: "alice" } },
    ],
  });
  const row = setGlobalSession(state, "session-a");
  Object.assign(row, { visibility: "shared", sharingRole: "owner" });
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
  it("remote typing preserves a pending manual follow command", () => {
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
    pane.presence.update({
      presence: [
        { ts: 1, user: { id: "owner" } },
        { ts: 1, user: { id: "writer" } },
      ],
    });
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
    scheduleCommittedChatScroll(state, false, true, { source: "manual" });
    const typing = typingEvent(state.sessionKey, {
      sessionId: "typing-scroll",
      agentId: "main",
      actor: { type: "human", id: "writer", label: "Writer" },
      preview: "A draft that has not been submitted",
    });
    pane.handleSessionTypingEvent(typing);
    expect(pane.collaboration.typingViews).toHaveLength(1);
    extent += 83;
    vi.advanceTimersToNextFrame();
    expect(scrollport.scrollTop).toBe(1500);
    // Smooth sends wait through layout measurement; a peer update during
    // that frame must not cancel the reader’s pending manual command.
    pane.handleSessionTypingEvent({
      ...typing,
      actor: { type: "human", id: "second-writer", label: "Second writer" },
      preview: "Draft after measurement",
    });
    expect(pane.collaboration.typingViews).toHaveLength(2);
    vi.advanceTimersToNextFrame();
    expect(scrollport.scrollTop).toBe(1583);
    scheduleCommittedChatScroll(state, false, false, { source: "manual" });
    vi.advanceTimersToNextFrame();
    expect(scrollport.scrollTop).toBe(1583);
    pane.handleSessionTypingEvent({ ...typing, preview: "Updated draft" });
    scheduleCommittedChatScroll(state, false, false);
    extent += 83;
    vi.advanceTimersToNextFrame();
    expect(scrollport.scrollTop).toBe(1666);
  });

  it("sender provenance clears only the exact profile sender and expires remaining actors", () => {
    vi.useFakeTimers();
    const { pane, state } = globalTypingPane();
    const aliceId = "0d9f4c35-d221-49da-9a3f-b8c73921066b";
    pane.presence.update({
      presence: [
        { ts: 1, user: { id: "owner" } },
        { ts: 1, user: { id: aliceId } },
        { ts: 1, user: { id: "bob" } },
      ],
    });
    for (const actor of [
      { id: aliceId, label: "Alice", preview: "Alice's ephemeral draft" },
      { id: "bob", label: "Bob" },
    ]) {
      pane.handleSessionTypingEvent(
        typingEvent(state.sessionKey, {
          actor: { type: "human", ...actor },
          ...(actor.preview ? { preview: actor.preview } : {}),
        }),
      );
    }
    expect(pane.collaboration.typingViews).toEqual([
      { id: aliceId, label: "Alice", preview: "Alice's ephemeral draft" },
      { id: "bob", label: "Bob" },
    ]);

    const clear = (message: unknown, sessionKey = state.sessionKey) =>
      pane.clearTypingActorForSessionMessage({ sessionKey, agentId: "work", message });
    const sender = { senderId: aliceId };
    clear({ role: "user", senderLabel: `Alice (${aliceId})` });
    clear({ role: "assistant", __openclaw: sender });
    clear({ role: "user", __openclaw: sender }, "agent:work:other");
    expect([...pane.typingActors.keys()]).toEqual([aliceId, "bob"]);

    clear({ role: "user", __openclaw: sender });
    clear({
      role: "user",
      __openclaw: {
        ...sender,
        senderIdentity: {
          type: "observation",
          id: aliceId,
          pluginId: "channel",
          accountId: null,
          senderKind: "unknown",
        },
      },
    });
    expect([...pane.typingActors.keys()]).toEqual([aliceId, "bob"]);
    clear({
      role: "user",
      __openclaw: { ...sender, senderIdentity: { type: "profile", id: aliceId } },
    });
    expect([...pane.typingActors.keys()]).toEqual(["bob"]);

    vi.advanceTimersByTime(2_500);
    expect(pane.typingActors.size).toBe(0);
  });

  it.each([false, true])("bounds draft exit deadlines (delayed callback: %s)", (delayed) => {
    vi.useFakeTimers();
    const { pane, state } = createTypingPane();
    const typing = typingEvent(state.sessionKey, { preview: "A draft" });
    pane.handleSessionTypingEvent(typing);
    if (delayed) {
      vi.setSystemTime(Date.now() + 19_800);
      vi.advanceTimersByTime(10_000);
      expect(pane.collaboration.typingViews[0]?.exitDurationMs).toBe(200);
      vi.advanceTimersByTime(200);
      expect(pane.typingActors.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      return;
    }
    pane.handleSessionTypingEvent({ ...typing, actor: { type: "human", id: "bob", label: "Bob" } });
    const container = document.createElement("div");
    renderTypingIndicator(pane.collaboration.typingViews, container);
    const row = container.querySelector(".agent-chat__typing-row");
    const bubble = row?.querySelector(".chat-bubble");
    vi.advanceTimersByTime(29_699);
    expect(
      pane.collaboration.typingViews.every((actor) => actor.exitDurationMs === undefined),
    ).toBe(true);
    vi.advanceTimersByTime(1);
    expect(pane.collaboration.typingViews.map((actor) => actor.exitDurationMs)).toEqual([300, 300]);
    renderTypingIndicator(pane.collaboration.typingViews, container);
    expect(container.querySelectorAll("[data-exiting]")).toHaveLength(2);
    expect(row?.getAttribute("style")).toContain("--chat-typing-exit-duration: 300ms");
    expect(row?.querySelector(".chat-bubble")).toBe(bubble);
    vi.advanceTimersByTime(100);
    pane.handleSessionTypingEvent({ ...typing, preview: "Still writing" });
    renderTypingIndicator(pane.collaboration.typingViews, container);
    expect(row?.hasAttribute("data-exiting")).toBe(false);
    expect(row?.getAttribute("style")).toBeNull();
    expect(row?.querySelector(".chat-bubble")).toBe(bubble);
    expect(row?.textContent).toContain("Still writing");
    vi.advanceTimersByTime(200);
    expect([...pane.typingActors.keys()]).toEqual(["alice"]);
    vi.advanceTimersByTime(29_500);
    expect(pane.collaboration.typingViews[0]?.exitDurationMs).toBe(300);
    pane.handleSessionTypingEvent({ ...typing, typing: false });
    expect(pane.typingActors.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a paused draft on unqualified presence without removing another viewer's draft", () => {
    vi.useFakeTimers();
    const { pane, state } = globalTypingPane("pause");
    const viewer = (id: string): PresencePayload["presence"][number] => ({
      ts: 1,
      user: { id, identity: { type: "profile", id } },
      watchedSessions: ["agent:work:global"],
    });
    pane.presence.update({ presence: [viewer("alice"), viewer("bob")] });
    for (const id of ["alice", "bob"]) {
      pane.handleSessionTypingEvent(
        typingEvent(state.sessionKey, {
          sessionId: "pause",
          actor: { type: "human", id, label: id },
          preview: id + " draft",
        }),
      );
    }
    vi.advanceTimersByTime(10_000);
    pane.pruneTypingActors();
    expect(pane.typingActors.size).toBe(2);
    pane.presence.update({
      presence: [
        viewer("bob"),
        {
          ...viewer("alice"),
          user: { id: "alice" },
        },
      ],
    });
    pane.pruneTypingActors();
    expect([...pane.typingActors.keys()]).toEqual(["bob"]);
    pane.clearTypingActorForSessionMessage({
      sessionKey: state.sessionKey,
      agentId: "work",
      message: { role: "user", __openclaw: { senderIdentity: { type: "profile", id: "bob" } } },
    });
    expect(pane.typingActors.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps each actor’s bubble stable across draft, dots, and peer updates without interpreting markup", () => {
    const { render, query, all, text } = typingDom();
    const alice = {
      id: "alice",
      label: "Alice",
      preview: "<img src=x onerror=alert(1)> **draft**",
    };
    const bob = { id: "bob", label: "Bob" };
    render([alice, bob]);
    expect(text(".agent-chat__typing-preview-label")?.trim()).toBe("Alice");
    expect(text(".chat-group--typing .chat-group-footer")).toContain("is typing...");
    expect(all(".chat-group.user.chat-group--peer")).toHaveLength(2);
    expect(query(".agent-chat__typing-group")).toBeNull();
    expect(
      query(".agent-chat__typing-preview-bubble")
        ?.closest("[aria-live]")
        ?.getAttribute("aria-live"),
    ).toBe("off");
    expect(all(".agent-chat__typing-bubble > span")).toHaveLength(3);
    expect(text(".sr-only")).toBe("Alice, Bob are typing…");

    const aliceGroup = query(".chat-group--typing");
    const aliceBubble = aliceGroup?.querySelector(".chat-bubble");
    expect(aliceGroup?.querySelector(".chat-text")?.textContent).toBe(alice.preview);
    expect(aliceGroup?.querySelectorAll(".chat-text img, .chat-text strong")).toHaveLength(0);
    render([bob, { ...alice, preview: "   " }]);
    expect(all(".chat-group--typing")[1]).toBe(aliceGroup);
    expect(aliceGroup?.querySelector(".chat-bubble")).toBe(aliceBubble);
    expect(aliceGroup?.querySelectorAll(".agent-chat__typing-bubble > span")).toHaveLength(3);
    render([{ ...alice, preview: "Edited draft" }]);
    expect(query(".chat-group--typing")).toBe(aliceGroup);
    expect(aliceGroup?.querySelector(".chat-bubble")).toBe(aliceBubble);
    expect(aliceGroup?.querySelector(".chat-text")?.textContent).toBe("Edited draft");
    expect(text("[role=status]")).toBe("Alice is typing…");
    render([]);
    expect(query(".agent-chat__typing-indicator")).toBeNull();
  });

  it("uses the transcript’s footer avatar placement", () => {
    const { render, all, text } = typingDom();
    render([{ id: "alice", label: "Alice", preview: "A draft" }], "footer");
    expect(all(".chat-message-avatar-anchor > :is(.chat-avatar, .chat-avatar-slot)")).toHaveLength(
      0,
    );
    expect(all(".chat-group-footer .chat-author-avatar")).toHaveLength(1);
    expect(text(".chat-sender-name")).toBe("Alice");
  });

  it("keeps two preview drafts while only active overflow people own the shared row", () => {
    vi.useFakeTimers();
    const { pane, state } = createTypingPane();
    const event = (index: number, typing = true) => peerEvent(state.sessionKey, index, typing);
    const { render, query, all, text } = typingDom();
    const summaries = [
      "Peer 3 is typing…",
      "Peer 3 and Peer 4 are typing…",
      "Peer 3, Peer 4, and Peer 5 are typing…",
      "Peer 3, Peer 4, and 2 others are typing…",
      "Peer 3, Peer 4, and 3 others are typing…",
    ];
    for (let count = 1; count <= 8; count += 1) {
      pane.handleSessionTypingEvent(event(count));
      render(pane.collaboration.typingViews, "gutter", pane.collaboration.typingOverflow);
      expect(all(".chat-bubble")).toHaveLength(Math.min(2, count));
      expect(all(".agent-chat__typing-person")).toHaveLength(Math.min(5, Math.max(0, count - 2)));
      expect(pane.collaboration.typingViews.filter((actor) => actor.preview)).toHaveLength(
        Math.min(2, count),
      );
      if (count >= 3 && count <= 7) {
        expect(text(".agent-chat__typing-summary")).toBe(summaries[count - 3]);
      }
    }
    expect(text(".agent-chat__typing-summary")).toBe("Several people are typing…");
    expect(text("[role=status]")).toBe("Several people are typing…");
    expect(pane.collaboration.typingOverflow).toEqual({ several: true });
    const stable = pane.collaboration.typingViews;
    for (let index = 0; index < 100; index += 1) {
      pane.handleSessionTypingEvent({ ...event(9), preview: "Unprojected " + index });
    }
    expect(pane.collaboration.typingViews).toBe(stable);
    pane.handleSessionTypingEvent(event(9, false));
    pane.handleSessionTypingEvent(event(8, false));
    expect(pane.collaboration.typingOverflow).toBeUndefined();
    render(pane.collaboration.typingViews);
    expect(text(".agent-chat__typing-summary")).toBe("Peer 3, Peer 4, and 3 others are typing…");
    vi.advanceTimersByTime(10_000);
    render(pane.collaboration.typingViews);
    expect(pane.collaboration.typingViews).toEqual([
      { id: "peer-1", label: "Peer 1", preview: "Draft 1", paused: true },
      { id: "peer-2", label: "Peer 2", preview: "Draft 2", paused: true },
    ]);
    expect(pane.collaboration.typingOverflow).toBeUndefined();
    expect(all(".chat-bubble")).toHaveLength(2);
    expect(query(".agent-chat__typing-group")).toBeNull();
    expect(all(".agent-chat__typing-state")[0]?.textContent).toBe("Draft");
    expect(text("[role=status]")).toBe("");
    pane.handleSessionTypingEvent(event(7));
    render(pane.collaboration.typingViews);
    expect(text(".agent-chat__typing-summary")).toBe("Peer 7 is typing…");
    expect(all(".agent-chat__typing-person")).toHaveLength(1);
    render(pane.collaboration.typingViews, "none", pane.collaboration.typingOverflow);
    expect(query(".agent-chat__typing-overflow")?.getAttribute("title")).toBe(
      "Peer 7 — is typing...",
    );
    expect(all("[role=img]")).toHaveLength(0);
    pane.handleSessionTypingEvent(event(7, false));
    render(pane.collaboration.typingViews);
    expect(query(".agent-chat__typing-group")).toBeNull();
    expect(all(".chat-bubble")).toHaveLength(2);
    pane.clearTypingActors();
    expect(pane.collaboration.typingViews).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires simultaneous expirations together without promoting expired peers or removing a renewed draft", () => {
    vi.useFakeTimers();
    const { pane, state } = createTypingPane();
    const event = (index: number) => peerEvent(state.sessionKey, index);
    for (let index = 0; index < 1000; index += 1) {
      pane.handleSessionTypingEvent(event(index));
    }
    const render = vi.fn();
    mountSolid(() => {
      projectChatFields(pane.collaboration);
      createEffect(
        () => [pane.collaboration.typingViews, pane.collaboration.typingOverflow],
        render,
      );
      return null;
    });
    flush();
    render.mockClear();
    vi.advanceTimersByTime(10_000);
    flush();
    // The active-only overflow vanishes in bounded updates even though the
    // first two preview drafts remain retained for their own idle deadline.
    expect(render.mock.calls.length).toBeLessThan(12);
    expect(pane.collaboration.typingViews).toHaveLength(2);
    expect(pane.collaboration.typingOverflow).toBeUndefined();
    vi.advanceTimersByTime(19_800);
    pane.handleSessionTypingEvent({ ...event(999), preview: "Renewed during exit" });
    flush();
    render.mockClear();
    vi.advanceTimersByTime(200);
    flush();
    expect(render).toHaveBeenCalledTimes(1);
    expect(pane.typingActors.size).toBe(1);
    expect(pane.collaboration.typingViews).toEqual([
      { id: "peer-999", label: "Peer 999", preview: "Renewed during exit" },
    ]);
    expect(pane.collaboration.typingOverflow).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    // A boolean-only actor has its own 2.5s deadline, not the draft deadline.
    pane.handleSessionTypingEvent({ ...event(1000), preview: undefined });
    vi.advanceTimersByTime(2_500);
    expect([...pane.typingActors.keys()]).toEqual(["peer-999"]);
    pane.clearTypingActors();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains overflow avatars, shimmers live text, and renders unsafe names as text", () => {
    const { render, query, all } = typingDom();
    const actors = ["Alice", "Ben", "Camila", "Dev", "Emilia", "Farid", "Grace"].map(
      (label, index) => ({ id: "peer-" + index, label, preview: "Draft" }),
    );
    render(actors);
    const group = query(".agent-chat__typing-group");
    const summary = query(".agent-chat__typing-summary");
    const stack = query(".agent-chat__typing-identities");
    const avatars = [...all(".agent-chat__typing-person")];
    render(actors, "gutter", { several: true });
    expect(summary?.textContent).toBe("Several people are typing…");
    expect(query(".agent-chat__typing-group")).toBe(group);
    expect(query(".agent-chat__typing-identities")).toBe(stack);
    expect(
      [...all(".agent-chat__typing-person")].every((node, index) => node === avatars[index]),
    ).toBe(true);
    expect(summary?.querySelector(".agent-chat__typing-text")?.hasAttribute("data-typing")).toBe(
      true,
    );
    const longName = "<script>not markup</script> " + "LongName".repeat(30);
    render([actors[0]!, actors[1]!, { id: "new", label: longName }]);
    expect(summary?.textContent).toBe(longName + " is typing…");
    expect(query(".agent-chat__typing-name")?.getAttribute("title")).toBe(longName);
    expect(all("script")).toHaveLength(0);
  });

  it("sends the last 300 draft code points including whitespace and omits previews when typing stops", () => {
    const { pane, request } = createTypingPane();
    pane.sendTypingState(true, `  prefix${"😀".repeat(300)}  `);
    expect(request.mock.calls[0]).toEqual([
      "session.typing",
      expect.objectContaining({
        sessionKey: "agent:work:main",
        sessionId: "session-a",
        agentId: "work",
        typing: true,
        preview: "😀".repeat(298) + "  ",
        cursor: 598,
      }),
    ]);

    pane.sendTypingState(false, "must not leak");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ typing: false });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("preview");
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("cursor");

    pane.sendTypingState(true, "   ");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("preview");
  });

  it.each([
    { stop: false, edits: Array.from({ length: 10 }, (_, index) => `draft ${index}`) },
    { stop: true, edits: ["first", "pending"] },
  ])("paces previews and settles the trailing draft (stop: $stop)", ({ stop, edits }) => {
    vi.useFakeTimers();
    const { pane, request } = createTypingPane();
    edits.forEach((draft, index) => {
      pane.sendTypingState(true, draft);
      if (!stop || index < edits.length - 1) {
        vi.advanceTimersByTime(100);
      }
    });
    if (stop) {
      pane.sendTypingState(false);
      expect(request.mock.calls.map(([, params]) => params.typing)).toEqual([true, false]);
    } else {
      expect(request.mock.calls.map(([, params]) => params.preview)).toEqual([
        "draft 0",
        "draft 2",
        "draft 4",
        "draft 7",
        "draft 9",
      ]);
    }
    vi.advanceTimersByTime(250);
    expect(request).toHaveBeenCalledTimes(stop ? 2 : 5);
    if (stop) {
      pane.sendTypingState(true, "new draft");
      expect(request.mock.calls[2]?.[1]).toMatchObject({ typing: true, preview: "new draft" });
    }
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
        pane.presence.update({ presence: [{ ts: 1, user: { id: "owner" } }] });
        break;
    }
    vi.advanceTimersByTime(250);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
