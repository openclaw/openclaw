/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { messageRecoveryKey } from "../chat-message-recovery.ts";
import * as chatThreadBuild from "../chat-thread-build.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { setExpansionState } from "../chat-thread.ts";
import {
  createTestTranscript as createTranscript,
  stubAnimationFrames,
} from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import { getTranscriptState, type ChatThreadProps } from "./chat-thread-interactions.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  transcriptMessage as msg,
  threadProps,
} from "./chat-transcript.test-support.ts";

const cleanups: (() => void)[] = [];
let frame: ReturnType<typeof stubAnimationFrames>;
function createTestTranscript(...args: Parameters<typeof createTranscript>) {
  const transcript = createTranscript(...args);
  cleanups.push(() => transcript.dispose());
  return transcript;
}

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
  cleanups.push(() => render(null, container));
  return {
    container,
    settle: async () => {
      await waitForSolid(() => {
        frame();
        flush();
        expect(transcript.isPositionSettled).toBe(true);
      });
      // The measured viewport paints before ordinary overscan resumes.
      frame();
      flush();
      frame();
      flush();
    },
    draw: () => {
      render(renderChatThread(props, transcript), container);
      flush();
      transcript.start();
      transcript.update();
      flush();
    },
  };
}

describe("transcript projection", () => {
  beforeEach(() => {
    frame = stubAnimationFrames();
    vi.useFakeTimers({ toNotFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    vi.setSystemTime(10_000);
    installTranscriptDomMocks();
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
    resetTranscriptTestDom();
    vi.useRealTimers();
  });

  it.each(["answer", "reasoning"] as const)(
    "projects %s deltas without rereading 3,000 retained messages",
    (kind) => {
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
      const earlierReasoning = { itemId: "earlier", text: "Earlier thought", startedAt: 3_500 };
      const props = {
        ...threadProps("projection-scale", "agent:main:projection-scale", messages),
        runId: "active",
        runActive: true,
        stream: kind === "answer" ? "Reply" : "",
        streamStartedAt: 4_000,
        showThinking: true,
        selectedSession: {
          key: "agent:main:projection-scale",
          kind: "direct" as const,
          updatedAt: 1,
          reasoningLevel: "on",
        },
        reasoning:
          kind === "reasoning"
            ? {
                runId: "active",
                items: [earlierReasoning, { itemId: "thinking", text: "Reply", startedAt: 4_000 }],
              }
            : null,
      };
      const transcript = createTestTranscript(props.paneId);
      const build = vi.spyOn(chatThreadBuild, "buildChatItems");
      const project = () =>
        transcript.renderSession(props.sessionKey, (session) => {
          projectChatTranscript(props, session);
          return null;
        });
      project();
      expect(reads).toBeGreaterThan(0);
      transcript.renderSession(props.sessionKey, (session) => {
        setExpansionState(
          session.expandedAssistantMessages,
          messageRecoveryKey(undefined, "message-1"),
          { status: "loaded", markdown: "Full answer", revision: 1 },
        );
        return null;
      });
      project();
      build.mockClear();
      for (const stream of ["Reply", "Reply continues", "Reply continues again"]) {
        if (kind === "answer") {
          props.stream = stream;
        } else {
          props.reasoning = {
            runId: "active",
            items: [earlierReasoning, { itemId: "thinking", text: stream, startedAt: 4_000 }],
          };
        }
        reads = 0;
        project();
        expect(build).not.toHaveBeenCalled();
        expect(reads, stream).toBe(0);
      }
    },
  );

  it("renders browser previews in their own row outside the work summary", async () => {
    const props = threadProps(
      "projection-browser-preview",
      "agent:main:dashboard:projection-browser-preview",
      [
        msg("user", "Inspect the example page"),
        msg("assistant", "I will inspect the example page.", 2_000, { phase: "final_answer" }),
        msg("toolResult", "Opened", 3_000, {
          toolCallId: "browser-call",
          toolName: "browser",
          details: {
            browserTab: {
              profile: "managed",
              target: "host",
              targetId: "example-tab",
              url: "https://example.com",
              title: "Example page",
            },
          },
        }),
        msg("assistant", "The page is ready.", 4_000),
      ],
    );
    props.showToolCalls = true;
    saveChatSessionScrollPosition(props.paneId, props.sessionKey, {
      scrollTop: 0,
      anchorToEnd: false,
    });
    const view = drawThread(props);
    view.draw();
    await waitForSolid(() =>
      expect(view.container.querySelector("openclaw-browser-tab-card")).not.toBeNull(),
    );
    const card = view.container.querySelector<HTMLElement>("openclaw-browser-tab-card");
    const previews = card?.closest(".chat-group--turn-block");
    expect(card).not.toBeNull();
    expect(previews).not.toBeNull();
    expect(card?.querySelector(".url")?.textContent).toBe("https://example.com");
    expect(card?.querySelector(".title")?.textContent).toBe("Example page");
    expect(previews?.closest(".chat-work-group")).toBeNull();
    expect(view.container.querySelector(".chat-work-group")).not.toBeNull();
    expect(view.container.textContent).toContain("I will inspect the example page.");
    expect(view.container.textContent).toContain("The page is ready.");
    expect(view.container.textContent).not.toContain("[object Object]");
  });

  it("refreshes sender names for a replaced sender and a changed signed-in viewer", async () => {
    const own = personMessage("alex", "Alex", 1);
    const props = threadProps("projection-sender", "agent:main:main", [own]);
    props.userId = "alex";
    props.userName = "Alex";
    const view = drawThread(props);
    const names = () =>
      [...view.container.querySelectorAll(".chat-sender-name")].map((node) => node.textContent);
    view.draw();
    await view.settle();
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
  });

  it("updates automatic reply attribution when only the session owner changes", () => {
    const own = personMessage("alex", "Alex", 1);
    const props = threadProps("projection-owner", "agent:main:main", [
      own,
      msg("assistant", "Answer", 2),
    ]);
    props.userId = "alex";
    props.selectedSession = { key: props.sessionKey, kind: "direct", updatedAt: 1 };
    const view = drawThread(props);
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

  it("moves live activity to the current eligible group after replacement and run changes", async () => {
    const first = activityMessage("Earlier operation", 2);
    const latest = activityMessage("Latest operation", 4);
    const props = threadProps("projection-activity", "agent:main:main", [
      msg("user", "Inspect the workspace", 1),
      first,
      msg("assistant", "Next file", 3, { phase: "commentary" }),
      latest,
    ]);
    Object.assign(props, { runId: "active", runActive: true, showToolCalls: true });
    const view = drawThread(props);
    const liveLabels = () =>
      [...view.container.querySelectorAll(".chat-activity-group__label--live")].map(
        (node) => node.textContent,
      );
    view.draw();
    await view.settle();
    await waitForSolid(() => expect(liveLabels()).toEqual(["Latest operation…"]));
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
  });

  it("keeps search and gallery caches warm while refreshing streamed and replaced messages", () => {
    const hidden = msg("assistant", "MEDIA:https://example.com/hidden.mp4", 1, {
      __openclaw: { id: "hidden" },
    });
    const hit = msg("assistant", "needle MEDIA:https://example.com/visible.mp4", 2, {
      __openclaw: { id: "visible" },
    });
    const props = {
      ...threadProps("projection-search-video", "agent:main:main", [hidden, hit]),
      stream: "MEDIA:https://example.com/live.mp4",
      streamStartedAt: 3,
    };
    const state = getTranscriptState(props.paneId);
    state.search.toggle();
    state.search.setQuery("needle");
    const transcript = createTestTranscript(props.paneId);
    const build = vi.spyOn(chatThreadBuild, "buildChatItems");
    const project = () => {
      transcript.renderSession(props.sessionKey, (session) => {
        projectChatTranscript(props, session);
        return null;
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
  });

  it("opens the visible forwarded disclosure when replying across search after a prepend", async () => {
    const forwarded = (id: string, content: string, timestamp: number) => ({
      role: "assistant",
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      senderSession: { sessionKey: "agent:other:main", agentId: "other", label: "Other" },
      content,
      timestamp,
      __openclaw: { id },
    });
    const later = forwarded("later", "needle", 2);
    const answer = msg("assistant", "needle answer", 3);
    const props = threadProps("projection-reply-owner", "agent:main:main", [later, answer]);
    const state = getTranscriptState(props.paneId);
    const view = drawThread(props);
    view.draw();
    await view.settle();
    props.messages = [forwarded("earlier", "Hidden original", 1), later, answer];
    view.draw();
    state.search.toggle();
    state.search.setQuery("needle");
    view.draw();
    expect(view.container.textContent).not.toContain("Hidden original");

    state.transcriptRenderContext.onOpenReply?.("earlier");
    await view.settle();

    expect(state.search.snapshot.open).toBe(false);
    expect(view.container.querySelector<HTMLDetailsElement>(".chat-session-activity")?.open).toBe(
      true,
    );
    expect(view.container.textContent).toContain("Hidden original");
  });
});

describe("voice reconciliation", () => {
  const savedMessage = (content: string, id: string, extra: object = {}) => ({
    role: "user",
    content,
    __openclaw: { id, ...extra },
  });
  const caption = (id: string, text: string, transcriptId: string) => ({
    id,
    role: "user" as const,
    text,
    isStreaming: false,
    transcriptId,
  });
  const membershipScans = (calls: readonly (readonly unknown[])[]) =>
    calls.filter(([callback]) => callback === persistedMessageEntryId);

  function voiceProjection(props: ChatThreadProps) {
    const controller = createTestTranscript(props.paneId);
    const container = document.body.appendChild(document.createElement("div"));
    cleanups.push(() => render(null, container));
    return () => {
      controller.renderSession(props.sessionKey, (session) => {
        const renderRows = vi.spyOn(session, "render");
        render(renderChatThread(props, controller), container);
        controller.start();
        controller.update();
        flush();
        expect(renderRows).toHaveBeenCalledOnce();
        renderRows.mockRestore();
        return null;
      });
      return [...container.querySelectorAll(".agent-chat__voice-turn-text")].map(
        (turn) => turn.textContent,
      );
    };
  }

  beforeEach(installTranscriptDomMocks);
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
    resetTranscriptTestDom();
  });

  it.each(["absent", "empty", "ID-less"] as const)(
    "skips the voice membership scan for %s captions",
    (kind) => {
      const messages = [savedMessage("Saved message", "voice:saved")];
      const map = vi.spyOn(messages, "map");
      const props = threadProps(`voice-${kind}`, undefined, messages);
      props.realtimeTalkConversation =
        kind === "absent"
          ? undefined
          : kind === "empty"
            ? []
            : [{ id: "live", role: "user", text: "Still speaking", isStreaming: true }];

      expect(voiceProjection(props)()).toEqual(kind === "ID-less" ? ["Still speaking"] : []);
      expect(membershipScans(map.mock.calls)).toEqual([]);
    },
  );

  it("uses one raw-history scan, preserving pending captions and refreshing replaced history", () => {
    const messages = [
      savedMessage("Hidden saved words", "voice:saved"),
      savedMessage("Pending input", "pending:input"),
      savedMessage("Pending send", "send:pending", {
        kind: "pending-send",
        state: "waiting-reconnect",
      }),
    ];
    const map = vi.spyOn(messages, "map");
    const props = threadProps("voice-membership", undefined, messages);
    props.realtimeTalkConversation = [
      caption("saved", "Saved caption", "voice:saved"),
      caption("unsaved", "Unsaved caption", "voice:unsaved"),
      { id: "live", role: "assistant", text: "Live caption", isStreaming: true },
      caption("input", "Pending input caption", "pending:input"),
      caption("send", "Pending send caption", "send:pending"),
    ];
    const state = getTranscriptState(props.paneId);
    state.search.toggle();
    state.search.setQuery("unmatched search");
    const project = voiceProjection(props);
    const pendingCaptions = ["Live caption", "Pending input caption", "Pending send caption"];

    expect(project()).toEqual(["Unsaved caption", ...pendingCaptions]);
    expect(membershipScans(map.mock.calls)).toHaveLength(1);

    props.messages = [savedMessage("New saved words", "voice:unsaved"), ...messages.slice(1)];
    const replacementMap = vi.spyOn(props.messages, "map");
    expect(project()).toEqual(["Saved caption", ...pendingCaptions]);
    expect(membershipScans(replacementMap.mock.calls)).toHaveLength(1);
  });
});
