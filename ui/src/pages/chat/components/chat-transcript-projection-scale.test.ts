/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { messageRecoveryKey } from "../chat-message-recovery.ts";
import { createInitialChatRealtimeState } from "../chat-realtime.ts";
import * as chatThreadBuild from "../chat-thread-build.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { setExpansionState } from "../chat-thread.ts";
import { createChatViewFrame } from "../chat-view-frame.ts";
import {
  createChatProps,
  createTestTranscript as createTranscript,
  stubAnimationFrames,
} from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { createRealtimeTalkConversationState } from "../talk/conversation-state.ts";
import { updateRealtimeTalkConversation } from "../talk/conversation.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import { createAsyncQuestionPresentation } from "./chat-async-question.ts";
import { getTranscriptState, type ChatThreadProps } from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import * as transcriptIndex from "./chat-transcript-message-index.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  transcriptMessage as msg,
  threadProps,
} from "./chat-transcript.test-support.ts";

const cleanups: (() => void)[] = [];
const renderedText = (container: ParentNode, selector: string) =>
  [...container.querySelectorAll(selector)].map((node) => node.textContent);
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

function projectSession(props: ChatThreadProps, transcript: ReturnType<typeof createTranscript>) {
  return transcript.renderSession(props.sessionKey, (session) => {
    projectChatTranscript(props, session);
    return null;
  });
}

function cleanupTranscripts() {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  resetTranscriptTestDom();
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
    cleanupTranscripts();
    vi.useRealTimers();
  });

  it("updates live text without projecting rows, but projects visibility and completion", async () => {
    const paneId = "stream-leaf-projection";
    const transcript = createTestTranscript(paneId);
    const projectRows = vi.spyOn(transcriptIndex, "projectTranscriptIndex");
    let updateText!: (text: string | null) => void;
    let updateContext!: (value: boolean) => void;
    const view = mountSolid(() => {
      const [text, setText] = createSignal<string | null>("Initial reply");
      const [context, setContext] = createSignal(false);
      updateText = setText;
      updateContext = setContext;
      const props = {
        ...createChatProps({
          paneId,
          sessionKey: "agent:main:stream-leaf",
          messages: [msg("user", "Prompt", 1_000)],
          transcript,
        }),
        runId: "live",
        runActive: true,
        runWorking: true,
        streamStartedAt: 2_000,
        get stream() {
          return text();
        },
        get assistantName() {
          return context() ? "Updated assistant" : "Assistant";
        },
      };
      const viewFrame = createChatViewFrame(
        props,
        () => undefined,
        createAsyncQuestionPresentation(getTranscriptState(paneId), props),
      );
      return createComponent(ChatThread, { props: viewFrame.threadProps, transcript });
    });
    onTestFinished(view.unmount);
    transcript.start();
    transcript.update();
    await vi.advanceTimersByTimeAsync(0);
    const currentBubble = () => view.container.querySelector<HTMLElement>(".chat-bubble.streaming");
    const bubble = currentBubble()!;
    expect(bubble).not.toBeNull();
    const changeText = (text: string | null, projected = false) => {
      projectRows.mockClear();
      updateText(text);
      flush();
      expect(projectRows).toHaveBeenCalledTimes(projected ? 1 : 0);
    };

    for (const text of ["Reply grows", "Reply grows again", "Reply grows again."]) {
      changeText(text);
      expect(currentBubble()!).toBe(bubble);
      expect(bubble.textContent).toContain(text);
    }

    // A sibling projection update replaces the live resolver's reactive owner.
    updateContext(true);
    flush();
    expect(projectRows).toHaveBeenCalledOnce();
    changeText("Reply after sibling update");
    expect(bubble.textContent).toContain("Reply after sibling update");

    changeText("<thinking>Private planning</thinking>", true);
    expect(view.container.textContent).not.toContain("Private planning");
    changeText("Visible again", true);
    expect(currentBubble()!.textContent).toContain("Visible again");
    changeText(null, true);
    expect(currentBubble()).toBeNull();
  });

  it("updates and parks voice captions without projecting the transcript for each fragment", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const paneId = "voice-leaf-projection";
    const transcript = createTestTranscript(paneId);
    const talk = createInitialChatRealtimeState().realtimeTalk;
    const projectRows = vi.spyOn(transcriptIndex, "projectTranscriptIndex");
    const buildItems = vi.spyOn(chatThreadBuild, "buildChatItems");
    const prompt = msg("user", "Speak the answer", 1_000);
    let setVisible!: (visible: boolean) => void;
    let setMessages!: (messages: unknown[]) => void;
    const publish = (text: string, final = false, transcriptId?: string) =>
      talk.update({
        realtimeTalkConversationState: updateRealtimeTalkConversation(
          talk.snapshot.realtimeTalkConversationState,
          { role: "assistant", itemId: "answer", text, final, transcriptId },
        ),
      });
    const view = mountSolid(() => {
      const captions = projectOwner(
        talk,
        (owner) => owner.snapshot.realtimeTalkConversationState.entries,
        Object.is,
      );
      const [visible, updateVisible] = createSignal(true);
      const [messages, updateMessages] = createSignal<unknown[]>([prompt]);
      setVisible = updateVisible;
      setMessages = updateMessages;
      const props = {
        ...createChatProps({ paneId, sessionKey: "agent:main:voice-leaf", transcript }),
        readRealtimeTalkConversation: () => captions.read(),
        get messages() {
          return messages();
        },
        get transcriptVisible() {
          return visible();
        },
      };
      const viewFrame = createChatViewFrame(
        props,
        () => undefined,
        createAsyncQuestionPresentation(getTranscriptState(paneId), props),
      );
      return createComponent(ChatThread, { props: viewFrame.threadProps, transcript });
    });
    onTestFinished(view.unmount);
    transcript.start();
    transcript.update();
    await vi.advanceTimersByTimeAsync(0);
    projectRows.mockClear();

    publish("First");
    flush();
    expect(projectRows).toHaveBeenCalledOnce();
    const row = view.container.querySelector(".agent-chat__voice-turn")!;
    expect(row).not.toBeNull();
    projectRows.mockClear();
    buildItems.mockClear();
    for (const fragment of [" second", " third", "."]) {
      publish(fragment);
      flush();
      expect(view.container.querySelector(".agent-chat__voice-turn")).toBe(row);
    }
    expect(row.textContent).toContain("First second third.");
    expect(projectRows).not.toHaveBeenCalled();
    expect(buildItems).not.toHaveBeenCalled();

    setVisible(false);
    flush();
    projectRows.mockClear();
    publish(" Hidden continuation.");
    flush();
    expect(row.textContent).not.toContain("Hidden continuation");
    expect(projectRows).not.toHaveBeenCalled();
    setVisible(true);
    flush();
    expect(view.container.querySelector(".agent-chat__voice-turn")?.textContent).toContain(
      "Hidden continuation.",
    );

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    flush();
    projectRows.mockClear();
    publish(" Background continuation.");
    flush();
    expect(talk.snapshot.realtimeTalkConversationState.entries[0]?.text).toContain(
      "Background continuation.",
    );
    expect(row.textContent).not.toContain("Background continuation.");
    expect(projectRows).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    flush();
    expect(view.container.querySelector(".agent-chat__voice-turn")).toBe(row);
    expect(row.textContent).toContain("Background continuation.");

    projectRows.mockClear();
    publish("Final answer.", true, "voice:answer");
    flush();
    expect(view.container.querySelector(".agent-chat__voice-turn-text")?.textContent).toBe(
      "Final answer.",
    );
    expect(view.container.querySelector(".agent-chat__voice-turn-stream")).toBeNull();
    expect(projectRows).not.toHaveBeenCalled();

    setMessages([
      prompt,
      {
        role: "assistant",
        content: "Final answer.",
        __openclaw: { id: "voice:answer" },
      },
    ]);
    flush();
    expect(view.container.querySelector(".agent-chat__voice-turn")).toBeNull();
    expect(
      [...view.container.querySelectorAll(".chat-text")].map((element) =>
        element.textContent?.trim(),
      ),
    ).toEqual(["Speak the answer", "Final answer."]);
    setMessages([prompt]);
    flush();
    expect(view.container.querySelector(".agent-chat__voice-turn-text")?.textContent).toBe(
      "Final answer.",
    );
    projectRows.mockClear();
    talk.update({ realtimeTalkConversationState: createRealtimeTalkConversationState() });
    flush();
    expect(projectRows).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".agent-chat__voice-turn")).toBeNull();
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
      const project = () => projectSession(props, transcript);
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
    const names = () => renderedText(view.container, ".chat-sender-name");
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
    const liveLabels = () => renderedText(view.container, ".chat-activity-group__label--live");
    view.draw();
    await view.settle();
    await vi.dynamicImportSettled();
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

  it("does not adopt conversation footprints for a matching search row", () => {
    const props = threadProps("search-footprint", "agent:main:search-footprint", [
      msg("assistant", "needle", 1_000, { __openclaw: { id: "matching-row" } }),
    ]);
    props.chatBubbleMode = true;
    const read = vi.fn(() => 700);
    props.widgetLayout = {
      read,
      write: vi.fn(),
      writeRows: vi.fn(),
      invalidateRow: vi.fn(),
    };
    const session = new ChatSessionVirtualizerHost(() => {});
    cleanups.push(() => session.dispose());
    session.layout.rowWidth = 768;
    session.layout.paneWidth = 1100;
    session.layout.rowGutter = 166;
    const project = () => projectChatTranscript(props, session).renderRows();
    project();
    const row = session.layout.rows[0];
    expect(session.layout.rowMinimum(0)).toBe(700);
    const search = getTranscriptState(props.paneId).search;
    search.toggle();
    search.setQuery("needle");
    read.mockClear();
    project();
    expect(session.layout.rows[0]).toMatchObject({ key: row?.key, revision: row?.revision });
    expect(session.layout.rowMinimum(0)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    search.close();
    project();
    expect(session.layout.rowMinimum(0)).toBe(700);
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
      projectSession(props, transcript);
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
      return renderedText(container, ".agent-chat__voice-turn-text");
    };
  }

  beforeEach(installTranscriptDomMocks);
  afterEach(cleanupTranscripts);

  it.each(["absent", "empty", "ID-less"] as const)(
    "skips the voice membership scan for %s captions",
    (kind) => {
      const messages = [savedMessage("Saved message", "voice:saved")];
      const map = vi.spyOn(messages, "map");
      const props = threadProps(`voice-${kind}`, undefined, messages);
      props.readRealtimeTalkConversation =
        kind === "absent"
          ? undefined
          : kind === "empty"
            ? () => []
            : () => [{ id: "live", role: "user", text: "Still speaking", isStreaming: true }];

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
    props.readRealtimeTalkConversation = () => [
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
