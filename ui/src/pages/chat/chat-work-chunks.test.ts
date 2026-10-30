// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import {
  extractToolCardsCached,
  extractToolBlockCardsCached,
  resolveToolCardOutcome,
  resolveToolCardDisplay,
} from "../../lib/chat/tool-cards.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { collapseCompletedTurnWork } from "./chat-turn-presentation.ts";
import { splitMixedWorkGroup } from "./chat-work-chunks.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../test/fixtures/chat-work-chunks.json", import.meta.url), "utf8"),
) as {
  markdownEnvelopes: {
    name: string;
    text: string[];
    textType?: string;
    workBetweenText: boolean;
    expectedParts: number;
  }[];
};
const sessionKey = "agent:main:dashboard:work-chunks";
const message = (id: string, role: string, content: unknown, extra = {}) => ({
  role,
  content,
  timestamp: 1000,
  runId: "run",
  __openclaw: { id, runId: "run" },
  ...extra,
});
function groups(messages: unknown[]) {
  return groupMessages(
    messages.map((entry, index) => ({ kind: "message", key: "source-" + index, message: entry })),
    {},
    undefined,
    true,
  );
}
const tool = (id: string) => ({
  type: "tool_use",
  id,
  name: "read",
  input: { path: "synthetic.txt" },
});
const text = (value: string) => ({ type: "text", text: value });

describe("completed work preserves source order", () => {
  it("keeps unsplit Markdown-context narration visible", () => {
    const source = message(
      "mixed",
      "assistant",
      [text("Finding: first"), tool("read-1"), text("Second finding")],
      { stopReason: "stop" },
    );
    const grouped = groups([
      message("prompt", "user", "Inspect synthetic inputs"),
      source,
      message("final", "assistant", [text("Final answer")], { stopReason: "stop" }),
    ]);
    const items = collapseCompletedTurnWork(grouped, {
      sessionKey,
      runWorking: false,
    });
    expect(items.map((item) => item.kind)).toEqual(["group", "group", "group"]);
    expect(items[1]).toEqual(grouped[1]);
    if (items[1]?.kind !== "group") {
      throw new Error("Missing visible mixed envelope");
    }
    expect(items[1].messages[0]?.message).toEqual(source);
  });

  it("keeps every Anthropic narration in place", () => {
    const messages = [
      message("prompt", "user", "Inspect synthetic inputs"),
      message("first", "assistant", [text("First visible narration"), tool("one")], {
        stopReason: "toolUse",
      }),
      message("one-result", "toolResult", "read one", { toolCallId: "one", toolName: "read" }),
      message("second", "assistant", [text("Second visible narration"), tool("two")], {
        stopReason: "toolUse",
      }),
      message("two-result", "toolResult", "read two", { toolCallId: "two", toolName: "read" }),
      message("final", "assistant", [text("Final visible answer")], { stopReason: "stop" }),
    ];
    const original = structuredClone(messages);
    const items = collapseCompletedTurnWork(groups(messages), {
      sessionKey,
      runWorking: false,
    });
    expect(items.map((item) => item.kind)).toEqual([
      "group",
      "group",
      "work-group",
      "group",
      "work-group",
      "group",
    ]);
    const work = items.filter((item) => item.kind === "work-group");
    expect(work.map((item) => item.groups.flatMap((group) => group.messages).length)).toEqual([
      2, 2,
    ]);
    expect(work.every((item) => item.durationMs === null)).toBe(true);
    expect(messages).toEqual(original);
    const visible = items.filter((item) => item.kind === "group");
    expect(visible[1]?.messages[0]).toMatchObject({
      actionKey: "source-1",
      message: { __openclaw: { id: "first" } },
    });
  });

  it("retains the first visible part's DOM key when work is appended to its envelope", () => {
    const initial = groups([
      message("evolving", "assistant", [text("Already visible")], { stopReason: "toolUse" }),
    ])[0];
    const enriched = groups([
      message("evolving", "assistant", [text("Already visible"), tool("later")], {
        stopReason: "toolUse",
      }),
    ])[0];
    if (initial?.kind !== "group" || enriched?.kind !== "group") {
      throw new Error("Missing source group");
    }
    const first = splitMixedWorkGroup(enriched)[0]!;
    expect(first.key).toBe(initial.key);
    expect(first.messages[0]?.key).toBe(initial.messages[0]?.key);
  });

  it("splits text thinking tool text within one envelope with stable source action IDs", () => {
    const source = message(
      "mixed",
      "assistant",
      [text("Before"), { type: "thinking", thinking: "Reason" }, tool("call"), text("After")],
      { stopReason: "stop" },
    );
    const group = groups([source])[0];
    if (group?.kind !== "group") {
      throw new Error("Missing group");
    }
    const parts = splitMixedWorkGroup(group);
    expect(parts.map((part) => part.visibleContent)).toEqual(["text", "none", "text"]);
    expect(parts.flatMap((part) => part.messages).map((part) => part.actionKey)).toEqual([
      "source-0",
      "source-0",
      "source-0",
    ]);
    expect(parts.map((part) => part.key)).toEqual(
      splitMixedWorkGroup(group).map((part) => part.key),
    );
    expect(
      parts
        .flatMap((part) => part.messages)
        .map((part) => (part.message as typeof source)["__openclaw"].id),
    ).toEqual(["mixed", "mixed", "mixed"]);
  });

  it.each([false, true])(
    "keeps envelope-wide reasoning private when text blocks cross typed work (%s)",
    (separatedByWork) => {
      const thinking = { type: "thinking", thinking: "Typed work" };
      const source = message(
        "private-envelope",
        "assistant",
        [
          text("Before<think>hidden start"),
          ...(separatedByWork ? [thinking] : []),
          text("SECRET</think>Visible"),
          thinking,
          text("After"),
        ],
        { stopReason: "stop" },
      );
      const original = structuredClone(source);
      const group = groups([source])[0];
      if (group?.kind !== "group") {
        throw new Error("Missing source group");
      }
      const parts = splitMixedWorkGroup(group);
      const markdown = parts
        .flatMap((part) => part.messages)
        .map(({ message: partMessage }) =>
          resolveMessageDisplayMarkdown(partMessage, normalizeMessage(partMessage)),
        )
        .join("\n");
      expect(markdown).toBe("BeforeVisible\nAfter");
      expect(markdown).not.toContain("hidden start");
      expect(markdown).not.toContain("SECRET");
      // Context-dependent envelopes retain their source order and action owner.
      expect(parts).toEqual([group]);
      expect(parts[0]?.messages[0]).toBe(group.messages[0]);
      expect(source).toEqual(original);
    },
  );

  it.each([
    ["reasoning", "<think>hidden start", "SECRET</think>Visible"],
    ["memories", "<relevant-memories>hidden start", "SECRET</relevant-memories>Visible"],
    ["tool XML", '<tool_call>{"hidden start":', '"SECRET"}</tool_call>Visible'],
  ])("does not expose cross-block %s scaffolding", (_name, opening, closing) => {
    const source = message("private-leading", "assistant", [
      text(opening),
      text(closing),
      { type: "thinking", thinking: "Typed work" },
    ]);
    const group = groups([source])[0];
    if (group?.kind !== "group") {
      throw new Error("Missing source group");
    }
    const parts = splitMixedWorkGroup(group);
    const markdown = parts
      .flatMap((part) => part.messages)
      .map(({ message: partMessage }) =>
        resolveMessageDisplayMarkdown(partMessage, normalizeMessage(partMessage)),
      )
      .join("\n");
    expect(markdown).toBe("Visible");
    expect(markdown).not.toContain("hidden start");
    expect(markdown).not.toContain("SECRET");
    expect(parts[0]).toBe(group);
  });

  it.each(["toolUse", "error", "aborted"])(
    "does not fold incomplete/failed %s output",
    (stopReason) => {
      const items = groups([
        message("mixed", "assistant", [text("Visible"), tool("call")], { stopReason }),
        message("result", "toolResult", "failed", {
          toolCallId: "call",
          toolName: "read",
          isError: true,
        }),
      ]);
      const output = collapseCompletedTurnWork(items, { sessionKey, runWorking: false });
      expect(output.some((item) => item.kind === "work-group")).toBe(false);
    },
  );

  it("keeps live chunks expanded and preserves their part IDs on completion", () => {
    const input = groups([
      message("mixed", "assistant", [text("Visible"), tool("call")], { stopReason: "toolUse" }),
      message("final", "assistant", "Done", { stopReason: "stop" }),
    ]);
    const live = collapseCompletedTurnWork(input, { sessionKey, runWorking: true });
    const done = collapseCompletedTurnWork(input, { sessionKey, runWorking: false });
    expect(live.some((item) => item.kind === "work-group")).toBe(false);
    const keys = (items: typeof done) =>
      items.flatMap((item) =>
        item.kind === "work-group" ? item.groups.map((group) => group.key) : [item.key],
      );
    expect(keys(live)).toEqual(keys(done));
  });
});

it("does not treat a final-phase toolUse slice as a completed answer", () => {
  const input = groups([
    message(
      "mixed",
      "assistant",
      [
        { type: "thinking", thinking: "Work before text" },
        {
          ...text("Still working"),
          textSignature: JSON.stringify({ v: 1, id: "text", phase: "final_answer" }),
        },
        tool("pending"),
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  const output = collapseCompletedTurnWork(input, { sessionKey, runWorking: false });
  expect(output.some((item) => item.kind === "work-group")).toBe(false);
});

it.each(["final_answer", undefined])(
  "keeps typed thinking-only work with phase %s collapsible",
  (phase) => {
    const output = collapseCompletedTurnWork(
      groups([
        message("thinking", "assistant", [{ type: "thinking", thinking: "Reasoning" }], { phase }),
        message("final", "assistant", "Done", { stopReason: "stop" }),
      ]),
      { sessionKey, runWorking: false },
    );
    expect(output.map((item) => item.kind)).toEqual(["work-group", "group"]);
  },
);

it.each(["", "   ", "<think>filtered private text</think>"])(
  "does not split contiguous work at invisible text %j",
  (hidden) => {
    const output = collapseCompletedTurnWork(
      groups([
        message(
          "mixed",
          "assistant",
          [tool("first"), text(hidden), tool("second"), text("Visible answer")],
          { stopReason: "stop" },
        ),
      ]),
      { sessionKey, runWorking: false },
    );
    expect(output.map((item) => item.kind)).toEqual(["work-group", "group"]);
    const work = output[0];
    expect(
      work?.kind === "work-group" && work.groups.flatMap((group) => group.messages),
    ).toHaveLength(1);
  },
);

describe("Markdown envelope context", () => {
  it.each(fixture.markdownEnvelopes)(
    "$name",
    ({ text: values, textType, workBetweenText, expectedParts }) => {
      const work = { type: "thinking", thinking: "Recorded work" };
      const source = message(
        "markdown",
        "assistant",
        [
          ...values.flatMap((value, index) => [
            ...(workBetweenText && index === 1 ? [work] : []),
            { ...text(value), type: textType ?? "text" },
          ]),
          ...(!workBetweenText ? [work] : []),
        ],
        { stopReason: "stop" },
      );
      const group = groups([source])[0];
      if (group?.kind !== "group") {
        throw new Error("Missing group");
      }
      const parts = splitMixedWorkGroup(group);
      expect(parts).toHaveLength(expectedParts);
      expect(
        parts
          .flatMap((part) => part.messages)
          .map(({ message: value }) =>
            resolveMessageDisplayMarkdown(value, normalizeMessage(value)),
          )
          .filter(Boolean),
      ).toEqual(expectedParts === 3 ? values : [values.join("\n")]);
    },
  );
});

it.each([false, true])(
  "pairs separated call outcomes without duplicating output (failed=%s)",
  (failed) => {
    const source = message(
      "paired",
      "assistant",
      [
        tool("read-1"),
        text("Finding"),
        { type: "tool_result", tool_use_id: "read-1", content: "Recorded output", isError: failed },
        text("Answer"),
      ],
      { stopReason: "stop" },
    );
    const group = groups([source])[0];
    if (group?.kind !== "group") {
      throw new Error("Missing group");
    }
    const parts = splitMixedWorkGroup(group).flatMap((part) => part.messages);
    const cards = parts.flatMap(({ message: value }) => extractToolCardsCached(value));
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => resolveToolCardOutcome(card, false))).toEqual([
      failed ? "failed" : "succeeded",
      failed ? "failed" : "succeeded",
    ]);
    expect(cards.map((card) => card.name)).toEqual(["read", "read"]);
    expect(cards.map((card) => card.args)).toEqual([
      { path: "synthetic.txt" },
      { path: "synthetic.txt" },
    ]);
    expect(cards.map((card) => card.outputText)).toEqual([undefined, "Recorded output"]);
    const blockCards = parts.flatMap(({ message: value }) => {
      const record = value as Record<string, unknown>;
      return (record.content as Record<string, unknown>[]).flatMap((block) =>
        extractToolBlockCardsCached(record, block),
      );
    });
    expect(blockCards.map((card) => card.outputText)).toEqual([undefined, "Recorded output"]);
    expect(blockCards.map((card) => resolveToolCardOutcome(card, false))).toEqual(
      cards.map((card) => resolveToolCardOutcome(card, false)),
    );
    expect(source.content).toHaveLength(4);
  },
);

it("preserves a skipped recorded outcome without duplicating output or details", () => {
  const source = message(
    "skipped",
    "assistant",
    [
      tool("skip"),
      text("Finding"),
      {
        type: "tool_result",
        tool_use_id: "skip",
        content: "Skipped to process an incoming message.",
        details: { status: "skipped", deniedReason: "steering" },
      },
      text("Answer"),
    ],
    { stopReason: "stop" },
  );
  const group = groups([source])[0];
  if (group?.kind !== "group") {
    throw new Error("Missing group");
  }
  const parts = splitMixedWorkGroup(group).flatMap((part) => part.messages);
  const cards = parts.flatMap(({ message: value }) => extractToolCardsCached(value));
  expect(cards.map((card) => resolveToolCardOutcome(card, false))).toEqual(["skipped", "skipped"]);
  expect(cards.map((card) => card.outputText)).toEqual([
    undefined,
    "Skipped to process an incoming message.",
  ]);
  expect(cards[0]?.details).toBeUndefined();
  const dispatched = { ...cards[0]!, name: "tool_call", args: { id: "read", args: {} } };
  const displayed = resolveToolCardDisplay(dispatched);
  expect(displayed).not.toBe(dispatched);
  expect(resolveToolCardOutcome(displayed, false)).toBe("skipped");
  expect(resolveToolCardOutcome({ ...displayed, outputText: undefined }, false)).toBe("skipped");
  expect(
    cards.map((card) => resolveToolCardOutcome({ ...resolveToolCardDisplay(card) }, false)),
  ).toEqual(["skipped", "skipped"]);
  const blockCards = parts.flatMap(({ message: value }) => {
    const record = value as Record<string, unknown>;
    return (record.content as Record<string, unknown>[]).flatMap((block) =>
      extractToolBlockCardsCached(record, block),
    );
  });
  expect(blockCards.map((card) => resolveToolCardOutcome(card, false))).toEqual([
    "skipped",
    "skipped",
  ]);
  expect(blockCards.map((card) => card.outputText)).toEqual(cards.map((card) => card.outputText));
});

it("gives separated same-ID work stretches independent disclosure identities", () => {
  const source = message(
    "same-id",
    "assistant",
    [
      tool("read-1"),
      text("Finding"),
      { type: "tool_result", tool_use_id: "read-1", content: "Output" },
      text("Answer"),
    ],
    { stopReason: "stop" },
  );
  const input = groups([source]);
  const output = collapseCompletedTurnWork(input, { sessionKey, runWorking: false });
  const work = output.filter((item) => item.kind === "work-group");
  expect(work).toHaveLength(2);
  expect(new Set(work.map((item) => item.key)).size).toBe(2);
  const fragments = work.flatMap((item) => item.groups).flatMap((group) => group.messages);
  expect(new Set(fragments.map((item) => item.key)).size).toBe(2);
  expect(fragments.map((item) => item.actionKey)).toEqual(["source-0", "source-0"]);
});

it.each(["call", "result", "both"])("preserves legacy pairing when %s lacks an ID", (missing) => {
  const source = message(
    "legacy",
    "assistant",
    [
      {
        type: "tool_use",
        ...(missing === "result" ? { id: "read-1" } : {}),
        name: "read",
        input: { path: "legacy.txt" },
      },
      text("Finding"),
      {
        type: "tool_result",
        ...(missing === "call" ? { tool_use_id: "read-1" } : {}),
        name: "read",
        content: "Legacy output",
      },
      text("Answer"),
    ],
    { stopReason: "stop" },
  );
  expect(extractToolCardsCached(source)).toHaveLength(1);
  const group = groups([source])[0];
  if (group?.kind !== "group") {
    throw new Error("Missing group");
  }
  const parts = splitMixedWorkGroup(group).flatMap((part) => part.messages);
  const cards = parts.flatMap(({ message: value }) => extractToolCardsCached(value));
  expect(cards.map((card) => resolveToolCardOutcome(card, false))).toEqual([
    "succeeded",
    "succeeded",
  ]);
  expect(cards.map((card) => card.args)).toEqual([{ path: "legacy.txt" }, { path: "legacy.txt" }]);
  expect(cards.map((card) => card.outputText)).toEqual([undefined, "Legacy output"]);
  const blockCards = parts.flatMap(({ message: value }) => {
    const record = value as Record<string, unknown>;
    return (record.content as Record<string, unknown>[]).flatMap((block) =>
      extractToolBlockCardsCached(record, block),
    );
  });
  expect(blockCards.map((card) => resolveToolCardOutcome(card, false))).toEqual([
    "succeeded",
    "succeeded",
  ]);
  expect(blockCards.map((card) => card.args)).toEqual(cards.map((card) => card.args));
  expect(blockCards.map((card) => card.outputText)).toEqual([undefined, "Legacy output"]);
});

it("keeps each legacy result exactly once when calls cross a narration boundary", () => {
  const source = message(
    "legacy-multiple",
    "assistant",
    [
      { type: "tool_use", name: "read", input: { path: "a" } },
      text("Finding"),
      { type: "tool_use", name: "read", input: { path: "b" } },
      { type: "tool_result", name: "read", content: "OUT_A" },
      { type: "tool_result", name: "read", content: "OUT_B" },
      text("Answer"),
    ],
    { stopReason: "stop" },
  );
  const group = groups([source])[0];
  if (group?.kind !== "group") {
    throw new Error("Missing group");
  }
  const cards = splitMixedWorkGroup(group)
    .flatMap((part) => part.messages)
    .flatMap(({ message: value }) => extractToolCardsCached(value));
  const outputs = cards.filter((card) => card.outputText !== undefined);
  expect(outputs).toHaveLength(2);
  expect(outputs.map((card) => [card.args, card.outputText])).toEqual(
    expect.arrayContaining([
      [{ path: "a" }, "OUT_A"],
      [{ path: "b" }, "OUT_B"],
    ]),
  );
  expect(cards.map((card) => resolveToolCardOutcome(card, false))).toEqual([
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
});

it.each(["plain text", 0, true])(
  "does not record primitive tool-card input %j as an envelope",
  (value) => {
    expect(extractToolCardsCached(value)).toEqual([]);
  },
);

it("retains narration around completed work", () => {
  const messages = [
    { role: "user", content: "Inspect the sample", timestamp: 1000 },
    { role: "assistant", content: "First finding", phase: "commentary", timestamp: 2000 },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "read",
      content: "Sample",
      timestamp: 3000,
    },
    { role: "assistant", content: "Final answer", phase: "final_answer", timestamp: 4000 },
  ];
  const items = collapseCompletedTurnWork(
    groupMessages(
      messages.map((entry, index) => ({ kind: "message", key: String(index), message: entry })),
      {},
      undefined,
      true,
    ),
    { sessionKey: "agent:main:dashboard:narration", runWorking: false },
  );
  expect(items.map((item) => item.kind)).toEqual(["group", "group", "work-group", "group"]);
  const narration = items[1];
  expect(narration?.kind === "group" && narration.messages[0]?.message).toBe(messages[1]);
});
