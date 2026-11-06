// @vitest-environment node
import { describe, expect, it } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import type { ChatItemsFacts } from "./chat-thread-facts.ts";
import { buildItems, createProps, makeMessage } from "./chat-thread.test-support.ts";
import {
  buildCachedChatItems,
  getExpandedToolCards,
  retireChatThreadSources,
  resetChatThreadState,
  syncToolCardExpansionState,
} from "./chat-thread.ts";

function hasLiveTarget(reference: WeakRef<object>): boolean {
  // Keep JSC's dereferenced temporary out of the suspended async test frame.
  return reference.deref() !== undefined;
}

function replyPrompt(id: string, index: 0 | 1) {
  return makeMessage(id, index + 1, {
    role: "user",
    __openclaw: {
      id,
      seq: index + 1,
      runId: index === 0 ? "first" : "follow",
      senderId: index === 0 ? "alice" : "bob",
      senderName: index === 0 ? "Alice" : "Bob",
    },
  });
}

describe("tool expansion state", () => {
  it("releases a closed pane's messages while retaining its disclosure choices", async () => {
    resetChatThreadState();
    class TranscriptMessage {
      role = "assistant";
      content = [{ type: "toolcall", id: "released-call", name: "read" }];
    }
    const paneId = "released-pane";
    const sessionKey = "released-session";
    const populatePane = () => {
      const message = new TranscriptMessage();
      const items = buildItems({ paneId, sessionKey, messages: [message] });
      syncToolCardExpansionState(sessionKey, items, true);
      return {
        messageReference: new WeakRef(message),
        collectionControl: new WeakRef({ unowned: true }),
      };
    };
    try {
      const { messageReference, collectionControl } = populatePane();
      await collectGarbageForTest();
      expect(collectionControl.deref()).toBeUndefined();
      expect(hasLiveTarget(messageReference)).toBe(true);

      resetChatThreadState(paneId);
      await collectGarbageForTest();
      expect(messageReference.deref()).toBeUndefined();
      expect([...getExpandedToolCards(sessionKey).values()]).toEqual([true]);
    } finally {
      resetChatThreadState();
    }
  });
});

it("releases repeated hidden retirements without losing independent raw survivor rows", async () => {
  const paneId = "hidden-retirement";
  const populate = () => {
    const messages = Array.from({ length: 6 }, (_, index) =>
      makeMessage(`hidden-${index}`, index + 1, {
        role: index % 2 ? "assistant" : "user",
        runId: `hidden-turn-${Math.floor(index / 2)}`,
      }),
    );
    const props = createProps({ paneId, messages });
    const survivors = new Set<unknown>(messages.slice(2, 4));
    const prior = ["visible", "unfiltered"].map((view) =>
      buildCachedChatItems(props, view === "visible" ? "visible" : "unfiltered").filter(
        (item) =>
          item.kind === "group" && item.messages.every((entry) => survivors.has(entry.message)),
      ),
    );
    expect(prior.map((rows) => rows.length)).toEqual([2, 2]);
    const retired = [messages[0]!, messages[1]!, messages[4]!, messages[5]!];
    const references = retired.map((source) => new WeakRef(source));
    retireChatThreadSources(paneId, retired.slice(0, 2));
    // No intervening build: the second retirement must use weak provenance,
    // release its bodies now, and leave the middle complete turn reusable.
    retireChatThreadSources(paneId, retired.slice(2));
    return {
      references,
      prior,
      retained: messages.slice(2, 4),
      control: new WeakRef({ unowned: true }),
    };
  };
  try {
    const { references, prior, retained, control } = populate();
    await collectGarbageForTest();
    expect(control.deref()).toBeUndefined();
    expect(references.map(hasLiveTarget)).toEqual([false, false, false, false]);
    for (const [index, view] of ["visible", "unfiltered"].entries()) {
      const next = buildCachedChatItems(
        createProps({ paneId, messages: retained }),
        view === "visible" ? "visible" : "unfiltered",
      ).filter((item) => item.kind === "group");
      expect(next).toHaveLength(2);
      const boundary = prior[index]![0]!;
      expect(boundary).toMatchObject({ replyPreviousMessageId: "hidden-1" });
      expect(next[0]).not.toBe(boundary);
      expect(next[0]).toMatchObject({ key: boundary.key, replyPreviousMessageId: undefined });
      expect(next[0]!.messages[0]!.message).toBe(retained[0]);
      expect(next[1]).toBe(prior[index]![1]);
    }
  } finally {
    resetChatThreadState(paneId);
  }
});

it.each(["current", "turn"] as const)(
  "releases a retired %s reply dependency before the next render",
  async (dependency) => {
    const paneId = `reply-retirement-${dependency}`;
    const populate = () => {
      const prompt = replyPrompt("first-prompt", 0);
      const follow = replyPrompt("follow-prompt", 1);
      const answer = makeMessage("answer", 3, {
        runId: "first",
        openclawDelivery: { replyToCurrent: true },
      });
      const messages = [prompt, follow, answer];
      const props = createProps({ paneId, messages });
      const rows = ["visible", "unfiltered"].map((view) => {
        const reply = buildCachedChatItems(
          props,
          view === "visible" ? "visible" : "unfiltered",
        ).findLast((item) => item.kind === "group" && item.role === "assistant");
        expect(reply).toMatchObject({
          replyCurrentSource: { message: prompt },
          replyTurnSource: { message: follow },
          replyToMessage: { message: follow },
        });
        if (!reply) {
          throw new Error("Expected reply row");
        }
        return new WeakRef(reply);
      });
      const retired = dependency === "current" ? prompt : follow;
      const reference = new WeakRef(retired);
      retireChatThreadSources(paneId, [retired]);
      return { reference, rows, remaining: messages.filter((source) => source !== retired) };
    };
    try {
      const { reference, rows, remaining } = populate();
      await collectGarbageForTest();
      expect(reference.deref()).toBeUndefined();
      expect(rows.map(hasLiveTarget)).toEqual([false, false]);
      expect(remaining.at(-1)?.content).toBe("answer");
    } finally {
      resetChatThreadState(paneId);
    }
  },
);

it.each(["current", "turn"] as const)(
  "releases a retired %s reply from its unseen first-text seed before the next render",
  async (dependency) => {
    const paneId = `onset-retirement-${dependency}`;
    const populate = () => {
      const messages = [replyPrompt("onset-first", 0), replyPrompt("onset-follow", 1)];
      const retired = messages[dependency === "current" ? 0 : 1]!;
      const props = createProps({
        paneId,
        sessionKey: paneId,
        messages,
        runId: dependency === "current" ? "first" : "follow",
        runActive: true,
        runWorking: true,
        stream: null,
        streamStartedAt: 30,
      });
      const facts: ChatItemsFacts = { firsts: new Map(), indexedDividers: [] };
      const coldWaiting = buildChatItems(props, undefined, "transcript", facts);
      expect(facts.streamOnset).toMatchObject({ kind: "stream", text: "", isStreaming: true });
      expect(facts.streamOnset?.replyToMessage?.message).toBe(retired);
      const rows = (["visible", "unfiltered"] as const).map((view) => {
        const items = buildCachedChatItems(props, view);
        expect(items).toEqual(coldWaiting);
        expect(items.some((item) => item.kind === "stream")).toBe(false);
        expect(items.some((item) => item.kind === "reading-indicator")).toBe(true);
        const row = items.find(
          (item) =>
            item.kind === "group" && item.messages.some((entry) => entry.message === retired),
        );
        if (!row) {
          throw new Error("Expected source row");
        }
        return new WeakRef(row);
      });
      const reference = new WeakRef(retired);
      retireChatThreadSources(paneId, [retired]);
      return {
        reference,
        rows,
        remaining: messages.filter((source) => source !== retired),
        runId: props.runId,
        control: new WeakRef({ unowned: true }),
      };
    };
    try {
      const { reference, rows, remaining, runId, control } = populate();
      await collectGarbageForTest();
      expect(control.deref()).toBeUndefined();
      expect(reference.deref()).toBeUndefined();
      expect(rows.map(hasLiveTarget)).toEqual([false, false]);
      const next = createProps({
        paneId,
        sessionKey: paneId,
        messages: remaining,
        runId,
        runActive: true,
        runWorking: true,
        stream: "First text after retirement",
        streamStartedAt: 30,
      });
      const expected = buildChatItems(structuredClone(next));
      for (const view of ["visible", "unfiltered"] as const) {
        expect(buildCachedChatItems(next, view)).toEqual(expected);
      }
    } finally {
      resetChatThreadState(paneId);
    }
  },
);

it("releases hidden-tool Canvas memos held by a surviving raw neighbor without another render", async () => {
  const paneId = "hidden-canvas-retirement";
  const populate = () => {
    const prompt = makeMessage("canvas-prompt", 1, { role: "user" });
    const canvas = makeMessage("canvas-result", 2, {
      role: "toolResult",
      toolCallId: "canvas-call",
      toolName: "canvas_render",
      content: JSON.stringify({
        kind: "canvas",
        view: {
          backend: "canvas",
          id: "cv_retired",
          url: "/__openclaw__/canvas/documents/cv_retired/index.html",
          title: "Retired view",
        },
        presentation: { target: "assistant_message" },
      }),
    });
    const neighbor = makeMessage("canvas-neighbor", 3);
    const messages = [prompt, canvas, neighbor];
    const props = createProps({ paneId, messages, showToolCalls: false });
    const projections = ["visible", "unfiltered"].map((view) =>
      buildCachedChatItems(props, view === "visible" ? "visible" : "unfiltered"),
    );
    const projected = projections.flatMap((items) =>
      items.flatMap((item) =>
        item.kind === "group" ? item.messages.map((entry) => entry.message) : [],
      ),
    );
    expect(projected).not.toContain(canvas);
    const raw = new Set<unknown>(messages);
    const derived = projected.filter((source) => !raw.has(source));
    expect(derived).toHaveLength(2);
    const references = derived.map((source) => {
      if (!source || typeof source !== "object") {
        throw new Error("Expected Canvas projection");
      }
      return new WeakRef(source);
    });
    const rawReference = new WeakRef(canvas);
    retireChatThreadSources(paneId, [canvas]);
    return {
      references,
      rawReference,
      retained: [prompt, neighbor],
      control: new WeakRef({ unowned: true }),
    };
  };
  try {
    const { references, rawReference, retained, control } = populate();
    await collectGarbageForTest();
    expect(control.deref()).toBeUndefined();
    expect(rawReference.deref()).toBeUndefined();
    expect(references.map(hasLiveTarget)).toEqual([false, false]);
    expect(retained.map((source) => source.content)).toEqual(["canvas-prompt", "canvas-neighbor"]);
  } finally {
    resetChatThreadState(paneId);
  }
});
