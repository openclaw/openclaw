/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { toggleTranscriptSearch } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function pendingSend(id: string): ChatQueueItem {
  const createdAt = Date.now();
  return {
    id,
    text: id,
    createdAt,
    sendRunId: id,
    sendState: "sending",
    sendSubmittedAtMs: createdAt,
  };
}

function setupEntryTranscript(messages: unknown[] = []) {
  const transcript = createTestTranscript();
  const props = {
    ...threadProps("pane-entry", "agent:main:entry", messages),
    queue: [] as ChatQueueItem[],
    stream: null as string | null,
    streamStartedAt: null as number | null,
    runId: null as string | null,
    runWorking: false,
  };
  let container = document.body.appendChild(document.createElement("div"));
  const update = () => {
    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();
  };
  update();
  transcript.hostConnected();
  update();
  return {
    props,
    transcript,
    update,
    get container() {
      return container;
    },
    remount() {
      render(null, container);
      container = document.body.appendChild(document.createElement("div"));
      update();
    },
  };
}

function entering(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(".chat-bubble--enter")];
}

function bubbles(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(".chat-bubble")];
}

describe("chat transcript entry lifecycle", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("animates a new send once, not its acknowledgement or a remounted row", () => {
    const view = setupEntryTranscript();
    view.props.queue = [pendingSend("new-prompt")];
    view.update();
    const submitted = bubbles(view.container)[0];
    expect(entering(view.container)).toEqual([submitted]);

    view.props.messages = [
      {
        role: "user",
        content: "new-prompt",
        timestamp: Date.now(),
        __openclaw: { id: "persisted-prompt", idempotencyKey: "new-prompt", seq: 1 },
      },
    ];
    view.props.queue = [];
    view.update();
    expect(bubbles(view.container)[0]).toBe(submitted);
    view.remount();
    expect(bubbles(view.container)).toHaveLength(1);
    expect(entering(view.container)).toHaveLength(0);
    view.transcript.hostDisconnected();
  });

  it("animates the first reply text, not token patches or stream-to-history handoff", () => {
    const view = setupEntryTranscript([
      {
        role: "user",
        content: "question",
        timestamp: 1_000,
        __openclaw: { id: "question", idempotencyKey: "reply-run", seq: 1 },
      },
    ]);
    view.props.runId = "reply-run";
    view.props.runWorking = true;
    view.props.streamStartedAt = Date.now();
    view.props.stream = "";
    view.update();
    expect(entering(view.container)).toHaveLength(0);
    view.props.stream = "A new reply";
    view.update();
    const reply = view.container.querySelector<HTMLElement>('[data-message-text="A new reply"]');
    expect(entering(view.container)).toEqual([reply]);
    view.props.stream = "A new reply with more tokens";
    view.update();
    expect(view.container.querySelector('[data-message-text="A new reply with more tokens"]')).toBe(
      reply,
    );
    expect(entering(view.container)).toEqual([reply]);

    const completedText = view.props.stream;
    view.props.stream = null;
    view.update();
    view.props.messages = [
      ...view.props.messages,
      {
        role: "assistant",
        content: completedText,
        timestamp: Date.now(),
        __openclaw: { id: "answer", seq: 2 },
      },
    ];
    view.props.stream = null;
    view.props.runWorking = false;
    view.update();
    expect(bubbles(view.container).at(-1)?.textContent).toContain("more tokens");
    expect(entering(view.container)).toHaveLength(0);
    view.remount();
    expect(entering(view.container)).toHaveLength(0);
    view.transcript.hostDisconnected();
  });

  it("does not animate initial history, prepends, search restoration, or session restoration", () => {
    const view = setupEntryTranscript([
      { role: "assistant", content: "existing", timestamp: 2_000 },
    ]);
    expect(entering(view.container)).toHaveLength(0);
    view.props.messages = [
      { role: "user", content: "older", timestamp: 1_000 },
      ...view.props.messages,
    ];
    view.update();
    expect(entering(view.container)).toHaveLength(0);
    toggleTranscriptSearch(view.props.paneId, () => {});
    view.props.messages = [
      ...view.props.messages,
      { role: "user", content: "while searching", timestamp: 3_000 },
    ];
    view.update();
    toggleTranscriptSearch(view.props.paneId, () => {});
    view.update();
    expect(entering(view.container)).toHaveLength(0);
    view.props.sessionKey = "agent:main:other";
    view.props.queue = [pendingSend("restored-prompt")];
    view.update();
    expect(entering(view.container)).toHaveLength(0);
    // The retired pending-only animation must not bypass session initialization.
    expect(view.container.querySelector(".chat-bubble--user-turn-enter")).toBeNull();
    view.transcript.hostDisconnected();
  });

  it("animates appended same-role bubbles without replaying existing ones", () => {
    const view = setupEntryTranscript([
      { role: "user", content: "existing prompt", timestamp: 1_000 },
    ]);
    const existing = bubbles(view.container)[0];
    view.props.queue = [pendingSend("second-prompt")];
    view.update();
    expect(bubbles(view.container)[0]).toBe(existing);
    expect(entering(view.container)).toEqual([bubbles(view.container)[1]]);
    view.transcript.hostDisconnected();
  });
});
