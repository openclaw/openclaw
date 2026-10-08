/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { messageRecoveryKey } from "../chat-message-recovery.ts";
import * as chatThreadBuild from "../chat-thread-build.ts";
import { setExpansionState } from "../chat-thread.ts";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { getTranscriptState } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

beforeEach(() => {
  stubAnimationFrames();
  vi.useFakeTimers({ toNotFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.setSystemTime(10_000);
  installTranscriptDomMocks();
});

afterEach(() => {
  resetTranscriptTestDom();
  vi.useRealTimers();
});

it("projects unchanged renders and streaming deltas without rereading 3,000 retained messages", () => {
  let reads = 0;
  const messages = Array.from(
    { length: 3_000 },
    (_, index) =>
      new Proxy(
        {
          role: index % 2 ? "assistant" : "user",
          content: `Message ${index}`,
          timestamp: index + 1,
          __openclaw: { id: `message-${index}`, runId: `finished-${index >> 1}` },
        },
        {
          get(target, property, receiver) {
            reads += 1;
            return Reflect.get(target, property, receiver);
          },
        },
      ),
  );
  const props = {
    ...threadProps("projection-scale", "agent:main:projection-scale", messages),
    runId: "active",
    runActive: true,
    stream: "Reply",
    streamStartedAt: 4_000,
  };
  const transcript = createTestTranscript(props.paneId);
  const build = vi.spyOn(chatThreadBuild, "buildChatItems");
  const project = () =>
    transcript.renderSession(props.sessionKey, (session) => {
      projectChatTranscript(props, session);
      return html``;
    });
  try {
    project();
    expect(reads).toBeGreaterThan(0);
    transcript.renderSession(props.sessionKey, (session) => {
      setExpansionState(
        session.expandedAssistantMessages,
        messageRecoveryKey(undefined, "message-1"),
        { status: "loaded", markdown: "Full answer", revision: 1 },
      );
      return html``;
    });
    project();
    build.mockClear();
    for (const stream of ["Reply", "Reply continues", "Reply continues again"]) {
      props.stream = stream;
      reads = 0;
      project();
      expect(build).not.toHaveBeenCalled();
      expect(reads, stream).toBe(0);
    }
  } finally {
    transcript.hostDisconnected();
  }
});

function personMessage(id: string, name: string, timestamp: number) {
  return {
    role: "user",
    content: `Message from ${name}`,
    timestamp,
    __openclaw: {
      id: `message-${timestamp}`,
      senderId: id,
      senderName: name,
      senderIdentity: { type: "profile" as const, id },
    },
  };
}

function drawThread(props: ReturnType<typeof threadProps>) {
  const transcript = createTestTranscript(props.paneId);
  const container = document.body.appendChild(document.createElement("div"));
  return {
    container,
    draw: () => render(renderChatThread(props, transcript), container),
    dispose: () => {
      render(nothing, container);
      transcript.hostDisconnected();
    },
  };
}

it("refreshes sender names for a replaced sender and a changed signed-in viewer", () => {
  const own = personMessage("alex", "Alex", 1);
  const props = threadProps("projection-sender", "agent:main:main", [own]);
  props.userId = "alex";
  props.userName = "Alex";
  const view = drawThread(props);
  const names = () =>
    [...view.container.querySelectorAll(".chat-sender-name")].map((node) => node.textContent);
  try {
    view.draw();
    expect(names()).toEqual([]);
    props.messages = [own, personMessage("riley", "Riley", 2)];
    view.draw();
    expect(names()).toEqual(["Alex", "Riley"]);
    props.messages = [own, personMessage("alex", "Alex", 2)];
    view.draw();
    expect(names()).toEqual([]);
    props.userId = "riley";
    props.userName = "Riley";
    view.draw();
    expect(names()).toContain("Alex");
    props.userId = "alex";
    props.userName = "Alex";
    view.draw();
    expect(names()).toEqual([]);
  } finally {
    view.dispose();
  }
});

it("updates automatic reply attribution when only the session owner changes", () => {
  const own = personMessage("alex", "Alex", 1);
  const props = threadProps("projection-owner", "agent:main:main", [
    own,
    { role: "assistant", content: "Answer", timestamp: 2 },
  ]);
  props.userId = "alex";
  props.selectedSession = { key: props.sessionKey, kind: "direct", updatedAt: 1 };
  const view = drawThread(props);
  try {
    for (const id of ["alex", "riley", "alex"]) {
      props.selectedSession = {
        ...props.selectedSession,
        owner: { actor: { type: "human", id, identity: { type: "profile", id } } },
      };
      view.draw();
      expect(view.container.querySelector(".chat-reply-attribution__name")?.textContent).toBe(
        id === "riley" ? "You" : undefined,
      );
    }
  } finally {
    view.dispose();
  }
});

function activityMessage(id: string, timestamp: number) {
  const activity: AgentActivityItem[] = ["prior", "current"].map((part) => ({
    itemId: `${id}-${part}`,
    toolCallId: `${id}-${part}`,
    kind: "tool",
    name: "read",
    title: id,
    status: "running",
    phase: "start",
  }));
  return {
    role: "assistant",
    runId: "active",
    timestamp,
    __openclaw: { id },
    content: activity.map(({ toolCallId }) => ({
      type: "toolCall",
      id: toolCallId,
      name: "read",
      arguments: {},
    })),
    activity,
  };
}

it("moves live activity to the current eligible group after replacement and run changes", () => {
  const first = activityMessage("Earlier operation", 2);
  const latest = activityMessage("Latest operation", 4);
  const props = threadProps("projection-activity", "agent:main:main", [
    { role: "user", content: "Inspect the workspace", timestamp: 1 },
    first,
    { role: "assistant", content: "Next file", timestamp: 3, phase: "commentary" },
    latest,
  ]);
  Object.assign(props, { runId: "active", runActive: true, showToolCalls: true });
  const view = drawThread(props);
  const liveLabels = () =>
    [...view.container.querySelectorAll(".chat-activity-group__label--live")].map(
      (node) => node.textContent,
    );
  try {
    view.draw();
    expect(liveLabels()).toEqual(["Latest operation…"]);
    props.messages = props.messages.map((message) =>
      message === latest ? { ...latest, runId: "peer" } : message,
    );
    view.draw();
    expect(liveLabels()).toEqual(["Earlier operation…"]);
    props.runId = "peer";
    view.draw();
    expect(liveLabels()).toEqual(["Latest operation…"]);
    props.runActive = false;
    view.draw();
    expect(liveLabels()).toEqual([]);
  } finally {
    view.dispose();
  }
});

it("keeps search and gallery caches warm while refreshing streamed and replaced messages", () => {
  const hidden = {
    role: "assistant",
    content: "MEDIA:https://example.com/hidden.mp4",
    timestamp: 1,
    __openclaw: { id: "hidden" },
  };
  const hit = {
    role: "assistant",
    content: "needle MEDIA:https://example.com/visible.mp4",
    timestamp: 2,
    __openclaw: { id: "visible" },
  };
  const props = {
    ...threadProps("projection-search-video", "agent:main:main", [hidden, hit]),
    stream: "MEDIA:https://example.com/live.mp4",
    streamStartedAt: 3,
  };
  const state = getTranscriptState(props.paneId);
  Object.assign(state, { searchOpen: true, searchQuery: "needle" });
  const transcript = createTestTranscript(props.paneId);
  const build = vi.spyOn(chatThreadBuild, "buildChatItems");
  const project = () => {
    transcript.renderSession(props.sessionKey, (session) => {
      projectChatTranscript(props, session);
      return html``;
    });
    return state.transcriptRenderContext.turnVideoMessages
      ?.values()
      .next()
      .value?.map(({ message }) => message);
  };
  const liveMessage = () => ({
    role: "assistant",
    content: [{ type: "text", text: props.stream }],
  });
  try {
    expect(project()).toEqual([hidden, hit, liveMessage()]);
    build.mockClear();
    for (const stream of [props.stream, "MEDIA:https://example.com/updated.mp4"]) {
      props.stream = stream;
      expect(project()).toEqual([hidden, hit, liveMessage()]);
      expect(build).not.toHaveBeenCalled();
    }
    const replacement = {
      ...hidden,
      content: "MEDIA:https://example.com/replacement.mp4",
      __openclaw: { id: "replacement" },
    };
    props.messages = [replacement, hit];
    expect(project()).toEqual([replacement, hit, liveMessage()]);
  } finally {
    transcript.hostDisconnected();
  }
});

it("opens the visible forwarded disclosure when replying across search after a prepend", () => {
  const forwarded = (id: string, content: string, timestamp: number) => ({
    role: "assistant",
    provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    senderSession: { sessionKey: "agent:other:main", agentId: "other", label: "Other" },
    content,
    timestamp,
    __openclaw: { id },
  });
  const later = forwarded("later", "needle", 2);
  const answer = { role: "assistant", content: "needle answer", timestamp: 3 };
  const props = threadProps("projection-reply-owner", "agent:main:main", [later, answer]);
  const state = getTranscriptState(props.paneId);
  const view = drawThread(props);
  props.onRequestUpdate = view.draw;
  try {
    view.draw();
    props.messages = [forwarded("earlier", "Hidden original", 1), later, answer];
    view.draw();
    Object.assign(state, { searchOpen: true, searchQuery: "needle" });
    view.draw();
    expect(view.container.textContent).not.toContain("Hidden original");

    state.transcriptRenderContext.onOpenReply?.("earlier");

    expect(state.searchOpen).toBe(false);
    expect(view.container.querySelector<HTMLDetailsElement>(".chat-session-activity")?.open).toBe(
      true,
    );
    expect(view.container.textContent).toContain("Hidden original");
  } finally {
    view.dispose();
  }
});
