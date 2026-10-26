/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { rememberLiveTerminalRun } from "../terminal-message-identity.ts";
import { createChatThreadHarness } from "./chat-message-native.test-support.tsx";
import { toggleTranscriptSearch } from "./chat-thread-interactions.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  requireElement as required,
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

function saved(
  role: string,
  content: string,
  timestamp: number,
  __openclaw: Record<string, unknown>,
) {
  return { role, content, timestamp, __openclaw };
}

async function setupEntryTranscript(messages: unknown[] = []) {
  const transcript = createTestTranscript();
  const props = threadProps("pane-entry", "agent:main:entry", messages, {
    runId: null,
    runWorking: false,
  });
  let container = document.body.appendChild(document.createElement("div"));
  let view = createChatThreadHarness(container, transcript);
  onTestFinished(() => {
    transcript.dispose();
    view.unmount();
  });
  const update = () => {
    view.render(props);
    flush();
    transcript.update();
    flush();
  };
  update();
  transcript.start();
  update();
  await flushDeferredRowPrune();
  return {
    props,
    transcript,
    update,
    set(patch: Partial<typeof props>) {
      Object.assign(props, patch);
      update();
    },
    startReply(runId: string, stream: string, streamSegments = props.streamSegments) {
      Object.assign(props, {
        runId,
        runWorking: true,
        runActive: true,
        streamStartedAt: 3_000,
        stream,
        streamSegments,
      });
      update();
    },
    get container() {
      return container;
    },
    remount() {
      view.unmount();
      container = document.body.appendChild(document.createElement("div"));
      view = createChatThreadHarness(container, transcript);
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

  it.each(["animationend", "animationcancel", "disconnect"])(
    "retires a new prompt on %s without disturbing existing bubbles",
    async (eventType) => {
      const view = await setupEntryTranscript([
        { role: "user", content: "existing prompt", timestamp: 1_000 },
      ]);
      const existing = bubbles(view.container)[0];
      view.set({ queue: [pendingSend("new-prompt")] });
      const submitted = expectDefined(bubbles(view.container)[1], "submitted prompt");
      expect(bubbles(view.container)[0]).toBe(existing);
      expect(entering(view.container)).toEqual([submitted]);

      if (eventType === "disconnect") {
        view.transcript.dispose();
        expect(entering(view.container)).toHaveLength(0);
        return;
      }
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
        ...view.props.messages,
        saved("user", "new-prompt", Date.now(), {
          id: "persisted-prompt",
          idempotencyKey: "new-prompt",
          seq: 1,
        }),
      ];
      view.props.queue = [];
      view.update();
      expect(bubbles(view.container)[1]).toBe(submitted);
      expect(entering(view.container)).toHaveLength(0);
      view.remount();
      expect(bubbles(view.container)).toHaveLength(2);
      expect(entering(view.container)).toHaveLength(0);
      view.transcript.dispose();
    },
  );

  it("keeps consecutive pending steers in place through their history handoff", async () => {
    const view = await setupEntryTranscript();
    const first = { ...pendingSend("First input"), createdAt: 10, queueMode: "steer" as const };
    const second = { ...pendingSend("Second input"), createdAt: 20, queueMode: "steer" as const };
    view.set({ queue: [first] });
    const firstBubble = expectDefined(bubbles(view.container)[0], "first prompt");
    view.set({ queue: [first, second] });
    const pendingBubbles = bubbles(view.container).filter((bubble) => bubble.dataset.messageText);
    expect(pendingBubbles.map((bubble) => bubble.dataset.messageText)).toEqual([
      "First input",
      "Second input",
    ]);
    expect(pendingBubbles[0]).toBe(firstBubble);

    view.props.messages = [first, second].map((input, index) => ({
      role: "user",
      content: input.text,
      timestamp: input.createdAt,
      __openclaw: { id: input.id, seq: index + 1, idempotencyKey: input.sendRunId },
    }));
    view.set({ queue: [] });
    const settledBubbles = bubbles(view.container).filter((bubble) => bubble.dataset.messageText);
    expect(settledBubbles).toHaveLength(2);
    settledBubbles.forEach((bubble, index) => expect(bubble).toBe(pendingBubbles[index]));
  });

  it("does not leave a dormant arrival when reduced motion disables animation", async () => {
    const media = (matches: boolean) => () => ({
      matches,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("matchMedia", media(true));
    const view = await setupEntryTranscript();
    view.set({ queue: [pendingSend("reduced-motion-prompt")] });
    expect(entering(view.container)).toHaveLength(0);
    vi.stubGlobal("matchMedia", media(false));
    view.set({ queue: [...view.props.queue, pendingSend("later-prompt")] });
    expect(entering(view.container).map((bubble) => bubble.dataset.messageText)).toEqual([
      "later-prompt",
    ]);
  });

  it("keeps asynchronous reply text out of entry animation through terminal and history handoff", async () => {
    const runId = "reply-run";
    const prefix = "The first paragraph stays visible.\n\n";
    const completedText = prefix + "A new reply with more tokens";
    const history = [
      saved("user", "Earlier question", 1_000, {
        id: "earlier-question",
        idempotencyKey: "earlier-run:user",
        seq: 1,
      }),
      saved("assistant", completedText, 1_500, {
        id: "earlier-answer",
        runId: "earlier-run",
        seq: 2,
      }),
      saved("user", "Current question", 2_000, {
        id: "question",
        idempotencyKey: `${runId}:user`,
        seq: 3,
      }),
    ];
    const view = await setupEntryTranscript(history);
    const earlierReply = required(view.container, '[data-entry-id="earlier-answer"]');
    view.startReply(runId, "");
    expect(entering(view.container)).toHaveLength(0);
    view.set({ stream: prefix + "A new reply" });
    const reply = required(view.container, ".chat-bubble.streaming");
    const paragraph = required(reply, ".chat-text p");
    const row = expectDefined(reply.closest(".chat-virtual-row"), "causal run frame");
    expect(reply).not.toBe(earlierReply);
    expect(entering(view.container)).toHaveLength(0);
    view.set({ stream: completedText });
    expect(view.container.querySelector(".chat-bubble.streaming")).toBe(reply);
    expect(reply.querySelector(".chat-text p")).toBe(paragraph);

    const terminal = {
      role: "assistant",
      content: completedText,
      timestamp: 4_000,
      stopReason: "stop",
    };
    Object.assign(view.props, {
      stream: null,
      streamStartedAt: null,
      runWorking: false,
      runActive: false,
      runId: null,
    });
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
      expect(entering(view.container), stage + ": no reply entry animation").toHaveLength(0);
    }
    expect(view.container.querySelector('[data-entry-id="answer"]')).toBe(
      bubbles(view.container).at(-1),
    );
    view.remount();
    expect(entering(view.container)).toHaveLength(0);
  });

  it("retains the later live body and code choice when preceding commentary persists", async () => {
    const runId = "commentary-run";
    const prompt = saved("user", "Show the code", 1_000, {
      id: "code-question",
      idempotencyKey: `${runId}:user`,
      seq: 1,
    });
    const view = await setupEntryTranscript([prompt]);
    const commentary = "Checking the existing implementation.";
    const code = Array.from({ length: 10 }, (_, index) => `const value${index} = ${index};`).join(
      "\n",
    );
    const answer = "The retained answer.\n\n```ts\n" + code + "\n```\n\nMore is arriving.";
    view.startReply(runId, answer, [
      { text: commentary, ts: 2_000, runId, itemId: "commentary-1" },
    ]);
    await Promise.resolve();
    const reply = required(view.container, ".chat-bubble.streaming");
    const paragraph = required(reply, ".chat-text p");
    const expand = required(reply, ".code-block-expand");
    expand.click();
    expect(expand.getAttribute("aria-expanded")).toBe("true");
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
    view.set({ streamSegments: [] });
    await Promise.resolve();
    const retained = required(view.container, ".chat-bubble.streaming");
    for (const text of [commentary, answer]) {
      expect(
        bubbles(view.container).filter((bubble) => bubble.dataset.messageText === text),
      ).toHaveLength(1);
    }
    expect.soft(retained, "retained body").toBe(reply);
    expect.soft(retained.querySelector(".chat-text p"), "retained paragraph").toBe(paragraph);
    expect.soft(retained.querySelector(".code-block-expand"), "retained control").toBe(expand);
    expect
      .soft(retained.querySelector(".code-block-expand")?.getAttribute("aria-expanded"))
      .toBe("true");
  });

  it("does not animate initial history, prepends, search restoration, or session restoration", async () => {
    const view = await setupEntryTranscript([
      { role: "assistant", content: "existing", timestamp: 2_000 },
    ]);
    expect(entering(view.container)).toHaveLength(0);
    view.props.messages = [
      { role: "user", content: "older", timestamp: 1_000 },
      ...view.props.messages,
    ];
    view.update();
    expect(entering(view.container)).toHaveLength(0);
    toggleTranscriptSearch(view.props.paneId);
    view.props.messages = [
      ...view.props.messages,
      { role: "user", content: "while searching", timestamp: 3_000 },
    ];
    view.update();
    toggleTranscriptSearch(view.props.paneId);
    view.update();
    expect(entering(view.container)).toHaveLength(0);
    view.set({ sessionKey: "agent:main:other", queue: [pendingSend("restored-prompt")] });
    expect(entering(view.container)).toHaveLength(0);
    // The retired pending-only animation must not bypass session initialization.
    expect(view.container.querySelector(".chat-bubble--user-turn-enter")).toBeNull();
  });
});
