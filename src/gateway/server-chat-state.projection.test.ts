import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { AgentAssistantSourceReceipt } from "../infra/agent-events.js";
import * as codeRegions from "../shared/text/code-regions.js";
import { projectInFlightRunSnapshot } from "./chat-inflight-snapshot.js";
import { createChatRunState } from "./server-chat-state.js";

const directive = "`[[reply_to_current]]`";

let state: ReturnType<typeof createChatRunState>;
beforeEach(() => {
  state = createChatRunState();
});
afterEach(() => vi.restoreAllMocks());

function expectUpdate(input: Parameters<typeof state.updateBuffer>[1], text: string | undefined) {
  state.updateBuffer("reply", input);
  expect(state.resolveBuffer("reply").text).toBe(text);
}

it.each([
  ["literal trailing marker", "The token is ", SILENT_REPLY_TOKEN],
  ["punctuated literal suffix", "The token is ", `${SILENT_REPLY_TOKEN}.`],
  ["prepared literal marker", "", SILENT_REPLY_TOKEN],
  ["prepared short reply", SILENT_REPLY_TOKEN.slice(0, 1), SILENT_REPLY_TOKEN.slice(1, 2)],
  [
    "runtime directive",
    `Opening\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nPrivate`,
    ` context\n${INTERNAL_RUNTIME_CONTEXT_END}\nVisible`,
    " context\nVisible",
  ],
  ["media directive", "Opening\nMEDIA", ":./model.png\nVisible"],
  ["code literal", "`", "[[reply_to_current]]`", "`"],
  ["media URL", "Opening\nMEDIA:prose ./model.png ", "https://example.com/a.png\n"],
])("preserves prepared source for %s", (_name, prefix, suffix, expected = suffix) => {
  const runId = "source-classification";
  if (prefix) {
    state.updateBuffer(runId, { itemId: "native", occurrenceId: "a", text: prefix });
  }
  state.updateBuffer(runId, {
    itemId: "native",
    occurrenceId: "b",
    text: prefix + suffix,
    managedMediaUrls: ["./model.png"],
  });
  if (prefix) {
    state.retireBuffer(runId, ["a"]);
  }
  expect.soft(state.resolveBuffer(runId)).toMatchObject({ text: expected, suppress: !expected });
  expect.soft(projectInFlightRunSnapshot({ chatRunState: state, runId }).text).toBe(expected);
  const final = state.resolveBuffer(runId, { final: true });
  expect(final.displayText ?? final.text).toBe(expected);
});

it("matches terminal receipts by identity, not text", () => {
  state.retireBuffer("reply", ["superseded"]);
  state.retireBuffer("reply", ["selected"]);
  expectUpdate({ itemId: "selected", text: "Same.", replace: true, replaceable: true }, "");
  expectUpdate({ itemId: "new", text: "Same.", replace: true, replaceable: true }, "Same.");
});

it.each(["anonymous", "native"])("aligns %s deltas after empty items", (kind) => {
  state.updateBuffer("reply", { itemId: "first", text: "Visible." });
  state.updateBuffer("reply", { itemId: "second", occurrenceId: "saved", text: "Saved" });
  state.retireBuffer("reply", ["saved"]);
  state.updateBuffer("reply", { itemId: "second", occurrenceId: "empty", text: "Saved" });
  expect(state.resolveBuffer("reply").suppress).toBe(false);
  const baseline = state.resolveBuffer("reply").text;
  state.takeBufferDelta("reply", baseline);
  state.updateBuffer("reply", {
    ...(kind === "native" ? { itemId: "second", occurrenceId: "empty" } : {}),
    delta: "X",
  });
  const visible = state.resolveBuffer("reply").text;
  const delta = state.takeBufferDelta("reply", visible);
  const wire = delta?.replace ? delta.deltaText : baseline + (delta?.deltaText ?? "");
  expect([visible, wire]).toEqual(["Visible.\n\nX", "Visible.\n\nX"]);
});

it("retains commits received before text", () => {
  state.retireBuffer("reply", ["saved"]);
  state.updateBuffer("reply", { itemId: "saved", text: "Saved." });
  expectUpdate({ itemId: "tail", text: "Tail." }, "Tail.");
  expect(state.resolveBuffer("reply", { final: true })).toMatchObject({
    text: "Saved.\n\nTail.",
    displayText: "Tail.",
  });
});

it.each(["Saved.", "Saved.\n\n"])("corrects text after committed prefix %j", (prefix) => {
  state.updateBuffer("reply", { itemId: "saved", text: prefix });
  state.retireBuffer("reply", ["saved"]);
  state.takeBufferDelta("reply", "");
  expectUpdate({ itemId: "tail", text: "\n" }, "");
  expectUpdate({ itemId: "tail", delta: "\nDraft" }, "Draft");
  expectUpdate({ itemId: "tail", text: "Corrected", replace: true }, "Corrected");
  expect(state.takeBufferDelta("reply", "Corrected")).toEqual({
    deltaText: "Corrected",
    replace: true,
  });
});

it.each(["visible", "empty"])("retires owned bytes when %s commits first", (firstCommit) => {
  state.updateBuffer("reply", { itemId: "visible", text: "Saved." });
  state.updateBuffer("reply", { itemId: "empty", text: "", delta: "" });
  state.retireBuffer("reply", [firstCommit]);
  expect(state.resolveBuffer("reply").text).toBe(firstCommit === "visible" ? "" : "Saved.");
  state.retireBuffer("reply", [firstCommit === "visible" ? "empty" : "visible"]);
  expect(state.resolveBuffer("reply").text).toBe("");
});

it.each([undefined, "reused-display-id"])("separates occurrences (id=%s)", (itemId) => {
  const first: AgentAssistantSourceReceipt = {};
  const second: AgentAssistantSourceReceipt = {};
  state.updateBuffer("reply", { itemId, text: "Saved." }, first);
  first.committedMessageSeq = 2;
  state.retireSource("reply", first);
  state.updateBuffer("reply", { itemId, text: "Unsaved.", delta: "" }, second);
  expect(state.resolveBuffer("reply").text).toBe("Unsaved.");
  second.committedMessageSeq = 3;
  state.retireSource("reply", second);
  state.updateBuffer("reply", { itemId, text: "Corrected.", replace: true }, second);
  expect(state.resolveBuffer("reply").text).toBe("");
});

it.each([
  [true, false],
  [false, false],
  [true, true],
  [false, true],
])("retains unsaved text (identified=%s, committed=%s)", (identified, committedBeforeAppend) => {
  state.updateBuffer("reply", { ...(identified ? { itemId: "first" } : {}), text: "Unsaved." });
  state.updateBuffer("reply", { itemId: "second", text: "Saved." });
  if (committedBeforeAppend) {
    state.retireBuffer("reply", ["second"]);
  }
  let wire = state.resolveBuffer("reply").text;
  state.takeBufferDelta("reply", wire);
  state.updateBuffer("reply", { delta: "More." });
  if (!committedBeforeAppend) {
    state.retireBuffer("reply", ["second"]);
  }
  const delta = state.takeBufferDelta("reply", state.resolveBuffer("reply").text);
  if (delta) {
    wire = delta.replace ? delta.deltaText : wire + delta.deltaText;
  }
  expect(wire).toBe("Unsaved.\n\nMore.");
  expect(state.resolveBuffer("reply").text).toBe("Unsaved.\n\nMore.");
  if (identified) {
    state.retireBuffer("reply", ["first"]);
    expect(state.resolveBuffer("reply").text).toBe("More.");
  }
});

it.each([true, false])("retires bytes across append (before=%s)", (committedBefore) => {
  state.updateBuffer("reply", { itemId: "saved", text: "Saved." });
  state.takeBufferDelta("reply", "Saved.");
  if (committedBefore) {
    state.retireBuffer("reply", ["saved"]);
    state.takeBufferDelta("reply", "");
  }
  state.updateBuffer("reply", { delta: "More." });
  if (!committedBefore) {
    state.retireBuffer("reply", ["saved"]);
  }
  expect(state.resolveBuffer("reply").text).toBe("More.");
  expect(state.takeBufferDelta("reply", "More.")?.deltaText).toBe("More.");
});

it.each([false, true])("consumes late committed text (snapshot=%s)", (snapshot) => {
  state.updateBuffer("reply", { itemId: "first", text: "First" });
  state.takeBufferDelta("reply", "First");
  state.retireBuffer("reply", ["first"]);
  expect(state.takeBufferDelta("reply", "")).toEqual({ deltaText: "", replace: true });
  expect(state.resolveBuffer("reply", { final: true }).text).toBe("First");
  expectUpdate(
    { itemId: "first", delta: " note", ...(snapshot ? { text: "First note" } : {}) },
    "",
  );
  expect(state.resolveBuffer("reply", { final: true }).text).toBe("First note");
  expect(state.takeBufferDelta("reply", "")).toBeUndefined();
  expectUpdate({ itemId: "second", text: "Tail." }, "Tail.");
});

it("bounds parsing of growing literal directives", () => {
  const regions = vi.spyOn(codeRegions, "findCodeRegions");
  const ownership = vi.spyOn(codeRegions, "findCodeOwnership");
  const run = state.getOrCreate("reply");
  const literal = `The marker is ${directive}.\n\nNext paragraph.\n\n`;
  const block = "```ts\nconst value = 1;\n```\n\n";
  expectUpdate({ delta: literal }, literal);
  for (let index = 1; index <= 100; index++) {
    expectUpdate({ delta: block }, literal + block.repeat(index));
  }
  const calls = [...regions.mock.calls, ...ownership.mock.calls];
  const parsedChars = calls.reduce((total, [text]) => total + text.length, 0);
  expect(parsedChars).toBeLessThan((run.rawBuffer?.length ?? 0) * 4);
});

it.each([1, 4])("bounds code-point reads across %i messages", (messages) => {
  const codePointAt = vi.spyOn(String.prototype, "codePointAt");
  const chunks = 32;
  const delta = "word";
  for (let message = 0; message < messages; message++) {
    for (let chunk = 1; chunk <= chunks; chunk++) {
      state.updateBuffer("reply", {
        itemId: `message-${message}`,
        text: delta.repeat(chunk),
        delta,
      });
    }
  }
  expect(codePointAt.mock.calls.length).toBeLessThanOrEqual(messages * chunks * 2);
  codePointAt.mockRestore();
  expect(state.resolveBuffer("reply", { final: true }).text).toBe(
    Array.from({ length: messages }, () => delta.repeat(chunks)).join("\n\n"),
  );
});

it.each<[string, string, { deltaText: string; replace?: boolean }]>([
  ["Launch ", "🚀", { deltaText: "🚀" }],
  ["Launch \uD83D", "\uDE80", { deltaText: "Launch 🚀", replace: true }],
])("preserves code points after %j + %j", (first, delta, frame) => {
  state.updateBuffer("reply", { itemId: "answer", text: first, delta: first });
  state.takeBufferDelta("reply", state.resolveBuffer("reply").text);
  state.updateBuffer("reply", { itemId: "answer", text: "Launch 🚀", delta });
  expect(state.takeBufferDelta("reply", state.resolveBuffer("reply").text)).toEqual(frame);
});

it.each([
  {
    name: "closing backtick",
    frames: ["before `[[reply_to_current]]", `before ${directive} after`],
    visible: ["before `", `before ${directive} after`],
  },
  {
    name: "image reference",
    frames: [`![${directive}][x]\n\nnext`, `![${directive}][x]\n\nnext\n\n[x]: /image.png`],
    visible: [`![${directive}][x]\n\nnext`, "![``][x]\n\nnext\n\n[x]: /image.png"],
  },
  {
    name: "directive across append boundary",
    frames: [`${directive}\n\nNext [`, `${directive}\n\nNext [[reply_to_current]] after`],
    visible: [`${directive}\n\nNext`, `${directive}\n\nNext  after`],
  },
  {
    name: "replacement",
    frames: [`${directive}\n\nNext`, "[[reply_to_current]] visible"],
    visible: [`${directive}\n\nNext`, " visible"],
  },
])("reprojects Markdown after $name", ({ frames, visible }) => {
  let previous = "";
  frames.forEach((text, index) => {
    expectUpdate(
      {
        itemId: "answer",
        ...(text.startsWith(previous) ? { delta: text.slice(previous.length) } : { text }),
      },
      visible[index],
    );
    previous = text;
  });
});

it("isolates terminal tail release and clears retired projection", () => {
  const run = state.getOrCreate("reply");
  expectUpdate({ delta: `${directive}\n\nNext [` }, `${directive}\n\nNext`);
  expect(state.resolveBuffer("reply", { final: true }).text).toBe(run.rawBuffer);
  expect(state.resolveBuffer("reply").text).toBe(`${directive}\n\nNext`);
  state.clearRun("reply");
  expect(state.runs.has("reply")).toBe(false);
  expectUpdate({ delta: "[[reply_to_current]] visible" }, " visible");
});

it("retains pending deltas and reconciles terminal whitespace", () => {
  state.updateBuffer("reply", { delta: "N" });
  expect(state.resolveBuffer("reply").suppress).toBe(false);
  expect(state.takeBufferDelta("reply", "N")).toEqual({ deltaText: "N" });
  expectUpdate({ delta: "ice" }, "Nice");
  expectUpdate({ delta: " work " }, "Nice work ");
  expect(state.takeBufferDelta("reply", "Nice work ")).toEqual({ deltaText: "ice work " });
  expect(state.takeBufferDelta("reply", "Nice work ")).toBeUndefined();
  expect(state.takeBufferDelta("reply", "Nice work")).toEqual({
    deltaText: "Nice work",
    replace: true,
  });
  state.updateBuffer("reply", { delta: "again" });
  expect(state.takeBufferDelta("reply", "Nice work again")).toEqual({ deltaText: " again" });
});

it("reprojects managed media without leaking terminal tails", () => {
  const text = `${directive}\n\nPicture\nMEDIA:./plot.png\nDone`;
  expectUpdate({ delta: text }, text);
  expect(state.takeBufferDelta("reply", text)).toEqual({ deltaText: text });
  state.updateBuffer("reply", { managedMediaUrls: ["./plot.png"] });
  const visible = `${directive}\n\nPicture\nDone`;
  expect(state.resolveBuffer("reply").text).toBe(visible);
  expect(state.takeBufferDelta("reply", visible)).toEqual({ deltaText: visible, replace: true });
});
