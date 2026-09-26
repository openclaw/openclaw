/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { rememberLiveTerminalRun } from "../terminal-message-identity.ts";
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

  it.each(["animationend", "animationcancel"])(
    "retires a prompt after its own %s without replaying on acknowledgement or remount",
    (eventType) => {
      const view = setupEntryTranscript();
      view.props.queue = [pendingSend("new-prompt")];
      view.update();
      const submitted = expectDefined(bubbles(view.container)[0], "submitted prompt");
      expect(entering(view.container)).toEqual([submitted]);

      const finish = (target: Element, animationName: string) =>
        target.dispatchEvent(
          Object.assign(new Event(eventType, { bubbles: true }), { animationName }),
        );
      finish(expectDefined(submitted.firstElementChild, "prompt child"), "chat-message-enter");
      finish(submitted, "unrelated-animation");
      expect(entering(view.container)).toEqual([submitted]);
      finish(submitted, "chat-message-enter");
      expect(entering(view.container)).toHaveLength(0);

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
      expect(entering(view.container)).toHaveLength(0);
      view.remount();
      expect(bubbles(view.container)).toHaveLength(1);
      expect(entering(view.container)).toHaveLength(0);
      view.transcript.hostDisconnected();
    },
  );

  it("retires an unfinished prompt animation when the transcript disconnects", () => {
    const view = setupEntryTranscript();
    view.props.queue = [pendingSend("pending-disconnect")];
    view.update();
    expect(entering(view.container)).toHaveLength(1);
    view.transcript.hostDisconnected();
    expect(entering(view.container)).toHaveLength(0);
  });

  it("does not leave a dormant arrival when reduced motion disables animation", () => {
    const media = (matches: boolean) => () => ({
      matches,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("matchMedia", media(true));
    const view = setupEntryTranscript();
    view.props.queue = [pendingSend("reduced-motion-prompt")];
    view.update();
    expect(entering(view.container)).toHaveLength(0);
    vi.stubGlobal("matchMedia", media(false));
    view.props.queue = [...view.props.queue, pendingSend("later-prompt")];
    view.update();
    expect(entering(view.container).map((bubble) => bubble.dataset.messageText)).toEqual([
      "later-prompt",
    ]);
    view.transcript.hostDisconnected();
  });

  it("keeps asynchronous reply text out of entry animation through terminal and history handoff", () => {
    const runId = "reply-run";
    const prefix = "The first paragraph stays visible.\n\n";
    const completedText = prefix + "A new reply with more tokens";
    const history = [
      {
        role: "user",
        content: "Earlier question",
        timestamp: 1_000,
        __openclaw: { id: "earlier-question", idempotencyKey: "earlier-run:user", seq: 1 },
      },
      {
        role: "assistant",
        content: completedText,
        timestamp: 1_500,
        __openclaw: { id: "earlier-answer", runId: "earlier-run", seq: 2 },
      },
      {
        role: "user",
        content: "Current question",
        timestamp: 2_000,
        __openclaw: { id: "question", idempotencyKey: `${runId}:user`, seq: 3 },
      },
    ];
    const view = setupEntryTranscript(history);
    const earlierReply = expectDefined(
      view.container.querySelector<HTMLElement>('[data-entry-id="earlier-answer"]'),
      "unrelated earlier answer with identical text",
    );
    try {
      view.props.runId = runId;
      view.props.runWorking = true;
      view.props.runActive = true;
      view.props.streamStartedAt = 3_000;
      view.props.stream = "";
      view.update();
      expect(entering(view.container)).toHaveLength(0);
      view.props.stream = prefix + "A new reply";
      view.update();
      const reply = expectDefined(
        view.container.querySelector<HTMLElement>(".chat-bubble.streaming"),
        "live answer",
      );
      const paragraph = expectDefined(reply.querySelector(".chat-text p"), "stable paragraph");
      const row = expectDefined(reply.closest(".chat-virtual-row"), "causal run frame");
      expect(reply).not.toBe(earlierReply);
      expect(entering(view.container)).toHaveLength(0);
      view.props.stream = completedText;
      view.update();
      expect(view.container.querySelector(".chat-bubble.streaming")).toBe(reply);
      expect(reply.querySelector(".chat-text p")).toBe(paragraph);

      const terminal = {
        role: "assistant",
        content: completedText,
        timestamp: 4_000,
        stopReason: "stop",
      };
      view.props.stream = null;
      view.props.streamStartedAt = null;
      view.props.runWorking = false;
      view.props.runActive = false;
      view.props.runId = null;
      // Real terminal publication replaces the stream atomically, before its receipt.
      for (const [stage, message] of [
        ["live terminal", rememberLiveTerminalRun(terminal, runId)],
        ["canonical history", { ...terminal, __openclaw: { id: "answer", runId, seq: 4 } }],
      ] as const) {
        view.props.messages = [...history, message];
        view.update();
        const matches = bubbles(view.container).filter(
          (bubble) => bubble.dataset.messageText === completedText,
        );
        expect(matches, stage + ": distinct causal occurrences").toHaveLength(2);
        expect(matches[0], stage + ": unrelated reply is untouched").toBe(earlierReply);
        const current = expectDefined(matches[1], stage + ": current answer");
        expect.soft(current.closest(".chat-virtual-row"), stage + ": run frame").toBe(row);
        expect(current.textContent, stage + ": visible response").toContain(
          "A new reply with more tokens",
        );
        // Terminal/canonical identity may change; neither representation may restart
        // or interrupt an entry fade. Browser probes check opacity at every frame.
        expect(entering(view.container), stage + ": no reply entry animation").toHaveLength(0);
      }
      expect(view.container.querySelector('[data-entry-id="answer"]')).toBe(
        bubbles(view.container).at(-1),
      );
      view.remount();
      expect(entering(view.container)).toHaveLength(0);
    } finally {
      view.transcript.hostDisconnected();
    }
  });

  it("retains the later live body and code choice when preceding commentary persists", async () => {
    const runId = "commentary-run";
    const prompt = {
      role: "user",
      content: "Show the code",
      timestamp: 1_000,
      __openclaw: { id: "code-question", idempotencyKey: `${runId}:user`, seq: 1 },
    };
    const view = setupEntryTranscript([prompt]);
    const commentary = "Checking the existing implementation.";
    const code = Array.from({ length: 10 }, (_, index) => `const value${index} = ${index};`).join(
      "\n",
    );
    const answer = "The retained answer.\n\n```ts\n" + code + "\n```\n\nMore is arriving.";
    try {
      view.props.runId = runId;
      view.props.runWorking = true;
      view.props.runActive = true;
      view.props.streamStartedAt = 3_000;
      view.props.streamSegments = [{ text: commentary, ts: 2_000, runId, itemId: "commentary-1" }];
      view.props.stream = answer;
      view.update();
      await Promise.resolve();
      const reply = expectDefined(
        view.container.querySelector<HTMLElement>(".chat-bubble.streaming"),
        "later live answer",
      );
      const paragraph = expectDefined(reply.querySelector(".chat-text p"), "answer paragraph");
      const expand = expectDefined(
        reply.querySelector<HTMLButtonElement>(".code-block-expand"),
        "code disclosure",
      );
      expand.click();
      expect(expand.getAttribute("aria-expanded")).toBe("true");
      // The matching durable commentary retires only its keyed segment. The
      // later cumulative live answer keeps its run, content, and stream identity.
      view.props.messages = [
        prompt,
        {
          role: "assistant",
          content: commentary,
          timestamp: 2_000,
          phase: "commentary",
          openclawStreamFallback: { source: "segment", itemId: "commentary-1", runId },
          __openclaw: { id: "saved-commentary", runId, seq: 2 },
        },
      ];
      view.props.streamSegments = [];
      view.update();
      await Promise.resolve();
      const retained = expectDefined(
        view.container.querySelector<HTMLElement>(".chat-bubble.streaming"),
        "later answer after commentary handoff",
      );
      expect(
        bubbles(view.container).filter((bubble) => bubble.dataset.messageText === commentary),
      ).toHaveLength(1);
      expect(
        bubbles(view.container).filter((bubble) => bubble.dataset.messageText === answer),
      ).toHaveLength(1);
      expect
        .soft(retained, "preceding frame-part adoption must not replace the later body")
        .toBe(reply);
      expect
        .soft(retained.querySelector(".chat-text p"), "retained answer paragraph")
        .toBe(paragraph);
      expect
        .soft(retained.querySelector(".code-block-expand"), "retained reader control")
        .toBe(expand);
      expect
        .soft(
          retained.querySelector(".code-block-expand")?.getAttribute("aria-expanded"),
          "reader choice survives",
        )
        .toBe("true");
    } finally {
      view.transcript.hostDisconnected();
    }
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
