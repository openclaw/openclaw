import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { AgentAssistantSourceReceipt } from "../infra/agent-events.js";
import * as codeRegions from "../shared/text/code-regions.js";
import { sanitizeChatHistoryMessage } from "./chat-display-projection.sanitize.js";
import { projectInFlightRunSnapshot } from "./chat-inflight-snapshot.js";
import { SUPPRESSED_CONTROL_REPLY_TOKENS } from "./control-reply-text.js";
import { capLiveAssistantText } from "./live-chat-projector.js";
import { createChatRunState } from "./server-chat-state.js";
import {
  appendCharacterRuns,
  assistantTextDifference,
  joinOccurrences as join,
  paragraphSeparator,
  preservesAvailableText,
  projectAvailableParts,
  type AvailableAssistantPart as AvailablePart,
  type CharacterRun,
  type ModelOccurrence as Occurrence,
} from "./server-chat-state.model.test-support.js";

describe("live chat directive projection", () => {
  it.each([
    {
      name: "bare trailing policy",
      prefix: "The token is ",
      suffix: SILENT_REPLY_TOKEN,
      expected: SILENT_REPLY_TOKEN,
    },
    {
      name: "punctuated literal suffix",
      prefix: "The token is ",
      suffix: `${SILENT_REPLY_TOKEN}.`,
      expected: `${SILENT_REPLY_TOKEN}.`,
    },
    { name: "standalone silent reply", prefix: "", suffix: SILENT_REPLY_TOKEN, expected: "" },
    {
      name: "terminal control lead fragment",
      prefix: SILENT_REPLY_TOKEN.slice(0, 1),
      suffix: SILENT_REPLY_TOKEN.slice(1, 2),
      expected: "",
      finalExpected: SILENT_REPLY_TOKEN.slice(1, 2),
    },
    {
      name: "runtime directive crossing occurrences",
      prefix: `Opening\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nPrivate`,
      suffix: ` context\n${INTERNAL_RUNTIME_CONTEXT_END}\nVisible`,
      expected: " context\nVisible",
    },
    {
      name: "media directive crossing occurrences",
      prefix: "Opening\nMEDIA",
      suffix: ":./model.png\nVisible",
      expected: ":./model.png\nVisible",
    },
    {
      name: "code literal crossing occurrences",
      prefix: "`",
      suffix: "[[reply_to_current]]`",
      expected: "`",
    },
    {
      name: "media URL retained after its directive prefix commits",
      prefix: "Opening\nMEDIA:prose ./model.png ",
      suffix: "https://example.com/a.png\n",
      expected: "https://example.com/a.png\n",
    },
  ])(
    "decides suppression from full source for $name",
    ({ prefix, suffix, expected, finalExpected }) => {
      const state = createChatRunState();
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
      if (prefix && suffix === SILENT_REPLY_TOKEN) {
        // Full live/history policy strips a bare trailing token. Once its context
        // commits, the raw tail stays visible instead of being classified alone.
        expect(state.resolveBuffer(runId).text).toBe(prefix.trimEnd());
        expect(
          sanitizeChatHistoryMessage({
            role: "assistant",
            content: [{ type: "text", text: prefix + suffix }],
          }).message,
        ).toMatchObject({ content: [{ type: "text", text: prefix.trimEnd() }] });
      }
      if (prefix) {
        state.retireBuffer(runId, ["a"]);
      }
      expect
        .soft(state.resolveBuffer(runId))
        .toMatchObject({ text: expected, suppress: !expected });
      expect.soft(projectInFlightRunSnapshot({ chatRunState: state, runId }).text).toBe(expected);
      const final = state.resolveBuffer(runId, { final: true });
      expect(final.displayText ?? final.text).toBe(finalExpected ?? expected);
    },
  );

  it("retires a keyed source after repeated capped complete snapshots", () => {
    const state = createChatRunState();
    const text = `${"a".repeat(100_000)}${"b".repeat(500_000)}`;
    state.updateBuffer("reply", { itemId: "native", text });
    state.updateBuffer("reply", { itemId: "native", text: `${text}!` });
    expect(state.retireBuffer("reply", ["native"])).toBe(true);
    expect(state.resolveBuffer("reply").text).toBe("");
  });

  it("matches a terminal-only native receipt by identity before accepting an identical new item", () => {
    const state = createChatRunState();
    state.retireBuffer("reply", ["superseded"]);
    state.retireBuffer("reply", ["selected"]);
    state.updateBuffer("reply", {
      itemId: "selected",
      text: "Same.",
      replace: true,
      replaceable: true,
    });
    expect(state.resolveBuffer("reply").text).toBe("");
    state.updateBuffer("reply", { itemId: "new", text: "Same.", replace: true, replaceable: true });
    expect(state.resolveBuffer("reply").text).toBe("Same.");
  });

  it("keeps a later item live when the previous paragraph commits after it starts", () => {
    const state = createChatRunState();
    state.updateBuffer("reply", { itemId: "first", text: "Saved." });
    state.updateBuffer("reply", { itemId: "second", text: "Tail." });
    expect(state.retireBuffer("reply", ["first"])).toBe(true);
    expect(state.resolveBuffer("reply").text).toBe("Tail.");
    state.updateBuffer("reply", { itemId: "second", text: "Tail. More." });
    expect(state.resolveBuffer("reply").text).toBe("Tail. More.");
  });

  it.each([
    { sameNative: false, texts: ["First", "Middle", "Again"], visible: "First\n\nAgain" },
    { sameNative: true, texts: ["A", "AB", "ABC"], visible: "AC" },
  ])(
    "keeps returning occurrences disjoint (sameNative=$sameNative)",
    ({ sameNative, texts, visible }) => {
      const state = createChatRunState();
      ["first", "middle", "first"].forEach((occurrenceId, index) => {
        state.updateBuffer("reply", {
          itemId: sameNative ? "native" : occurrenceId,
          occurrenceId,
          text: texts[index],
        });
      });
      state.retireBuffer("reply", ["middle"]);
      expect(state.resolveBuffer("reply").text).toBe(visible);
      state.retireBuffer("reply", ["first"]);
      expect(state.resolveBuffer("reply").text).toBe("");
    },
  );

  it("keeps an invalidated occurrence disjoint when its identity returns", () => {
    const state = createChatRunState();
    const runId = "reused-occurrence";
    state.updateBuffer(runId, { itemId: "n", occurrenceId: "a", text: "A" });
    state.updateBuffer(runId, {
      itemId: "m",
      occurrenceId: "m",
      text: "X",
      replace: true,
      replaceable: true,
    });
    state.updateBuffer(runId, { itemId: "n", occurrenceId: "b", text: "B" });
    state.updateBuffer(runId, { itemId: "n", occurrenceId: "a", text: "BC" });
    state.retireBuffer(runId, ["m"]);
    expect.soft(state.resolveBuffer(runId).text).toBe("BC");
    expect.soft(projectInFlightRunSnapshot({ chatRunState: state, runId }).text).toBe("BC");
    const final = state.resolveBuffer(runId, { final: true });
    expect(final.displayText ?? final.text).toBe("BC");
  });

  it("retires an earlier unscoped cumulative occurrence without replaying its prefix", () => {
    const state = createChatRunState();
    state.updateBuffer("reply", { occurrenceId: "first", text: "A" });
    state.updateBuffer("reply", { occurrenceId: "second", text: "AB" });
    state.retireBuffer("reply", ["first"]);
    expect(state.resolveBuffer("reply").text).toBe("B");
    state.retireBuffer("reply", ["second"]);
    expect(state.resolveBuffer("reply").text).toBe("");
  });

  it.each(["", "\n", "\n\n"])(
    "keeps unscoped correction boundary %j after retirement",
    (separator) => {
      const state = createChatRunState();
      state.updateBuffer("reply", { itemId: "first", text: "A" });
      state.updateBuffer("reply", { itemId: "discarded", text: "B" });
      state.updateBuffer("reply", { occurrenceId: "corrected", text: `A${separator}X` });
      state.updateBuffer("reply", { itemId: "last", text: "Last" });
      state.retireBuffer("reply", ["last"]);
      expect(state.resolveBuffer("reply").text).toBe(`A${separator}X`);
      state.retireBuffer("reply", ["first"]);
      expect(state.resolveBuffer("reply").text).toBe("X");
      state.retireBuffer("reply", ["corrected"]);
      expect(state.resolveBuffer("reply").text).toBe("");
    },
  );

  it.each(["anonymous", "native"])(
    "keeps %s deltas aligned after an empty active occurrence",
    (kind) => {
      const state = createChatRunState();
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
      expect(visible).toBe("Visible.\n\nX");
      expect(wire).toBe(visible);
    },
  );

  it("retains an identified commit before its first ordinary text callback", () => {
    const state = createChatRunState();
    state.retireBuffer("reply", ["saved"]);
    state.updateBuffer("reply", { itemId: "saved", text: "Saved." });
    state.updateBuffer("reply", { itemId: "tail", text: "Tail." });
    expect(state.resolveBuffer("reply").text).toBe("Tail.");
    expect(state.resolveBuffer("reply", { final: true }).text).toBe("Saved.\n\nTail.");
  });

  it("retires an identified commit before a correction of the same occurrence", () => {
    const state = createChatRunState();
    state.updateBuffer("reply", { itemId: "answer", text: "Draft" });
    state.retireBuffer("reply", ["answer"]);
    state.updateBuffer("reply", { itemId: "answer", text: "Corrected", replace: true });
    expect(state.resolveBuffer("reply").text).toBe("");
    expect(state.resolveBuffer("reply", { final: true }).text).toBe("Corrected");
  });

  it.each(["Saved.", "Saved.\n\n"])(
    "keeps corrected text after a committed prefix %j and changing leading newlines",
    (prefix) => {
      const state = createChatRunState();
      state.updateBuffer("reply", { itemId: "saved", text: prefix });
      state.retireBuffer("reply", ["saved"]);
      state.takeBufferDelta("reply", "");
      state.updateBuffer("reply", { itemId: "tail", text: "\n" });
      expect(state.resolveBuffer("reply").text).toBe("");
      state.updateBuffer("reply", { itemId: "tail", delta: "\nDraft" });
      expect(state.resolveBuffer("reply").text).toBe("Draft");
      state.updateBuffer("reply", { itemId: "tail", text: "Corrected", replace: true });
      expect(state.resolveBuffer("reply").text).toBe("Corrected");
      expect(state.takeBufferDelta("reply", "Corrected")).toEqual({
        deltaText: "Corrected",
        replace: true,
      });
    },
  );

  it.each(["visible", "empty"])(
    "retires only owned bytes when %s commits before the other occurrence",
    (firstCommit) => {
      const state = createChatRunState();
      state.updateBuffer("reply", { itemId: "visible", text: "Saved." });
      state.updateBuffer("reply", { itemId: "empty", text: "", delta: "" });
      state.retireBuffer("reply", [firstCommit]);
      expect(state.resolveBuffer("reply").text).toBe(firstCommit === "visible" ? "" : "Saved.");
      state.retireBuffer("reply", [firstCommit === "visible" ? "empty" : "visible"]);
      expect(state.resolveBuffer("reply").text).toBe("");
    },
  );

  it.each([
    { kind: "item", observed: true },
    { kind: "item", observed: false },
    { kind: "source", observed: true },
    { kind: "source", observed: false },
  ])(
    "keeps a newer tail when committed $kind callbacks arrive late (observed=$observed)",
    ({ kind, observed }) => {
      const state = createChatRunState();
      const first: AgentAssistantSourceReceipt = {};
      const second: AgentAssistantSourceReceipt = {};
      if (observed) {
        state.updateBuffer(
          "reply",
          { itemId: "first", text: "Saved." },
          kind === "source" ? first : undefined,
        );
      }
      if (kind === "source") {
        first.committedMessageSeq = 2;
        state.retireSource("reply", first);
      } else {
        state.retireBuffer("reply", ["first"]);
      }
      state.updateBuffer(
        "reply",
        { itemId: "second", text: "Unsaved." },
        kind === "source" ? second : undefined,
      );
      state.updateBuffer(
        "reply",
        { itemId: "first", text: "Saved. corrected.", replace: true },
        kind === "source" ? first : undefined,
      );
      expect(state.resolveBuffer("reply").text).toBe("Unsaved.");
      state.updateBuffer(
        "reply",
        { itemId: "second", text: "Unsaved. More.", delta: " More." },
        kind === "source" ? second : undefined,
      );
      expect(state.resolveBuffer("reply").text).toBe("Unsaved. More.");
      if (kind === "source") {
        second.committedMessageSeq = 3;
        state.retireSource("reply", second);
      } else {
        state.retireBuffer("reply", ["second"]);
      }
      state.updateBuffer(
        "reply",
        { itemId: "first", text: "Saved. corrected again.", replace: true },
        kind === "source" ? first : undefined,
      );
      expect(state.resolveBuffer("reply").text).toBe("");
      expect(state.resolveBuffer("reply", { final: true }).text).toBe(
        `${observed ? "Saved.\n\n" : ""}Unsaved. More.`,
      );
    },
  );

  it.each([false, true])(
    "retires all source intervals when only its late callback sees the commit (returning=%s)",
    (returning) => {
      const state = createChatRunState();
      const first: AgentAssistantSourceReceipt = {};
      const second: AgentAssistantSourceReceipt = {};
      state.updateBuffer("reply", { itemId: "first", text: "Saved." }, first);
      state.updateBuffer("reply", { itemId: "second", text: "Unsaved." }, second);
      if (returning) {
        state.updateBuffer("reply", { itemId: "first", text: "Saved again." }, first);
        state.updateBuffer("reply", { itemId: "tail", text: "Tail." }, {});
      }
      first.committedMessageSeq = 2;
      state.updateBuffer("reply", { itemId: "first", text: "Corrected.", replace: true }, first);
      expect(state.resolveBuffer("reply").text).toBe(returning ? "Unsaved.\n\nTail." : "Unsaved.");
    },
  );

  it.each([undefined, "reused-display-id"])(
    "keeps private occurrences in separate buffer scopes (displayItemId=%s)",
    (itemId) => {
      const state = createChatRunState();
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
    },
  );

  it.each([
    { identified: true, committedBeforeAppend: false },
    { identified: false, committedBeforeAppend: false },
    { identified: true, committedBeforeAppend: true },
    { identified: false, committedBeforeAppend: true },
  ])(
    "keeps earlier unsaved text when a later item commits ($identified, $committedBeforeAppend)",
    ({ identified, committedBeforeAppend }) => {
      const state = createChatRunState();
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
    },
  );

  it.each([true, false])(
    "keeps unidentified text outside an earlier occurrence's frontier (committedBefore=%s)",
    (committedBefore) => {
      const state = createChatRunState();
      state.updateBuffer("reply", { itemId: "old", text: "Saved." });
      if (committedBefore) {
        state.retireBuffer("reply", ["old"]);
      }
      state.updateBuffer("reply", { text: "Saved.\n\nUnsaved.", replace: true });
      if (!committedBefore) {
        state.retireBuffer("reply", ["old"]);
      }
      expect(state.resolveBuffer("reply").text).toBe("Saved.\n\nUnsaved.");
    },
  );

  it.each([true, false])(
    "preserves exact retirement across an unidentified append (committedBefore=%s)",
    (committedBefore) => {
      const state = createChatRunState();
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
    },
  );

  it.each([false, true])(
    "consumes genuinely late committed text without manufacturing source bytes (snapshot=%s)",
    (snapshot) => {
      const state = createChatRunState();
      state.updateBuffer("reply", { itemId: "first", text: "First" });
      state.takeBufferDelta("reply", "First");
      state.retireBuffer("reply", ["first"]);
      expect(state.takeBufferDelta("reply", "")).toEqual({ deltaText: "", replace: true });
      expect(state.resolveBuffer("reply", { final: true }).text).toBe("First");
      state.updateBuffer("reply", {
        itemId: "first",
        delta: " note",
        ...(snapshot ? { text: "First note" } : {}),
      });
      expect(state.resolveBuffer("reply").text).toBe("");
      expect(state.resolveBuffer("reply", { final: true }).text).toBe("First note");
      expect(state.takeBufferDelta("reply", "")).toBeUndefined();
      state.updateBuffer("reply", { itemId: "second", text: "Tail." });
      expect(state.resolveBuffer("reply").text).toBe("Tail.");
    },
  );

  it("replaces a trimmed identical tail when its earlier occurrence commits", () => {
    const state = createChatRunState();
    state.updateBuffer("reply", { itemId: "first", text: "Same." });
    state.takeBufferDelta("reply", "Same.");
    state.updateBuffer("reply", { itemId: "second", text: "Same." });
    state.retireBuffer("reply", ["first"]);
    expect(state.takeBufferDelta("reply", state.resolveBuffer("reply").text.trim())).toEqual({
      deltaText: "Same.",
      replace: true,
    });
  });

  it("retires identical messages only by their committed item identities", () => {
    const state = createChatRunState();
    state.updateBuffer("reply", { itemId: "first", text: "Same." });
    state.takeBufferDelta("reply", "Same.");
    state.retireBuffer("reply", ["first"]);
    expect(state.takeBufferDelta("reply", "")).toEqual({ deltaText: "", replace: true });
    state.updateBuffer("reply", { itemId: "second", text: "Same." });
    expect(state.resolveBuffer("reply").text).toBe("Same.");
    expect(state.retireBuffer("reply", ["first"])).toBe(false);
    expect(state.resolveBuffer("reply").text).toBe("Same.");
    expect(state.retireBuffer("reply", ["second"])).toBe(true);
    expect(state.resolveBuffer("reply").text).toBe("");
    state.updateBuffer("reply", { itemId: "third", text: "Same." });
    expect(state.resolveBuffer("reply").text).toBe("Same.");
  });

  it("keeps the retirement frontier across capped cumulative snapshots", () => {
    const state = createChatRunState();
    const committed = `${"x".repeat(500_020)}Saved.`;
    state.updateBuffer("reply", { itemId: "first", text: committed });
    expect(state.retireBuffer("reply", ["first"])).toBe(true);
    state.updateBuffer("reply", { itemId: "second", text: "Tail." });
    expect(state.resolveBuffer("reply").text).toBe("Tail.");
    state.updateBuffer("reply", { itemId: "second", delta: " More." });
    expect(state.resolveBuffer("reply").text).toBe("Tail. More.");
  });

  it("keeps settled literal directives without repeatedly parsing the growing reply", () => {
    const regions = vi.spyOn(codeRegions, "findCodeRegions");
    const ownership = vi.spyOn(codeRegions, "findCodeOwnership");
    const state = createChatRunState();
    const run = state.getOrCreate("reply");
    const literal = "The marker is `[[reply_to_current]]`.\n\nNext paragraph.\n\n";
    const block = "```ts\nconst value = 1;\n```\n\n";
    try {
      state.updateBuffer("reply", { delta: literal });
      expect(state.resolveBuffer("reply").text).toBe(literal);
      for (let index = 1; index <= 100; index++) {
        state.updateBuffer("reply", { delta: block });
        expect(state.resolveBuffer("reply").text).toBe(literal + block.repeat(index));
      }
      const parsedChars = [...regions.mock.calls, ...ownership.mock.calls].reduce(
        (total, [text]) => total + text.length,
        0,
      );
      expect(parsedChars).toBeLessThan((run.rawBuffer?.length ?? 0) * 4);
    } finally {
      regions.mockRestore();
      ownership.mockRestore();
    }
  });

  it.each([
    {
      name: "a closing backtick restores a previously stripped marker",
      frames: ["before `[[reply_to_current]]", "before `[[reply_to_current]]` after"],
      visible: ["before `", "before `[[reply_to_current]]` after"],
    },
    {
      name: "a later image reference changes earlier code ownership",
      frames: [
        "![`[[reply_to_current]]`][x]\n\nnext",
        "![`[[reply_to_current]]`][x]\n\nnext\n\n[x]: /image.png",
      ],
      visible: ["![`[[reply_to_current]]`][x]\n\nnext", "![``][x]\n\nnext\n\n[x]: /image.png"],
    },
    {
      name: "a new directive crosses the append boundary after settled code",
      frames: [
        "`[[reply_to_current]]`\n\nNext [",
        "`[[reply_to_current]]`\n\nNext [[reply_to_current]] after",
      ],
      visible: ["`[[reply_to_current]]`\n\nNext", "`[[reply_to_current]]`\n\nNext  after"],
    },
    {
      name: "a replacement retires the old literal prefix",
      frames: ["`[[reply_to_current]]`\n\nNext", "[[reply_to_current]] visible"],
      visible: ["`[[reply_to_current]]`\n\nNext", " visible"],
    },
  ])("preserves changing Markdown meaning when $name", ({ frames, visible }) => {
    const state = createChatRunState();
    let previous = "";
    frames.forEach((text, index) => {
      state.updateBuffer("reply", {
        itemId: "answer",
        ...(text.startsWith(previous) ? { delta: text.slice(previous.length) } : { text }),
      });
      expect(state.resolveBuffer("reply").text).toBe(visible[index]);
      previous = text;
    });
  });

  it("keeps terminal tail release separate from live state and clears projection on retirement", () => {
    const state = createChatRunState();
    const run = state.getOrCreate("reply");
    state.updateBuffer("reply", { delta: "`[[reply_to_current]]`\n\nNext [" });
    expect(state.resolveBuffer("reply").text).toBe("`[[reply_to_current]]`\n\nNext");
    expect(state.resolveBuffer("reply", { final: true }).text).toBe(run.rawBuffer);
    expect(state.resolveBuffer("reply").text).toBe("`[[reply_to_current]]`\n\nNext");
    state.clearRun("reply");
    expect(state.runs.has("reply")).toBe(false);
    state.updateBuffer("reply", { delta: "[[reply_to_current]] visible" });
    expect(state.resolveBuffer("reply").text).toBe(" visible");
  });

  it("retains pending display deltas across reads and reconciles terminal whitespace", () => {
    const state = createChatRunState();
    state.updateBuffer("reply", { delta: "N" });
    expect(state.resolveBuffer("reply").suppress).toBe(true);
    expect(state.takeBufferDelta("reply", "")).toBeUndefined();
    state.updateBuffer("reply", { delta: "ice" });
    expect(state.resolveBuffer("reply").text).toBe("Nice");
    state.updateBuffer("reply", { delta: " work " });
    expect(state.resolveBuffer("reply").text).toBe("Nice work ");
    expect(state.takeBufferDelta("reply", "Nice work ")).toEqual({ deltaText: "Nice work " });
    expect(state.takeBufferDelta("reply", "Nice work ")).toBeUndefined();
    expect(state.takeBufferDelta("reply", "Nice work")).toEqual({
      deltaText: "Nice work",
      replace: true,
    });
    state.updateBuffer("reply", { delta: "again" });
    expect(state.takeBufferDelta("reply", "Nice work again")).toEqual({ deltaText: " again" });
  });

  it("reprojects managed media facts without leaking a terminal tail into live reads", () => {
    const state = createChatRunState();
    const text = "`[[reply_to_current]]`\n\nPicture\nMEDIA:./plot.png\nDone";
    state.updateBuffer("reply", { delta: text });
    expect(state.resolveBuffer("reply").text).toBe(text);
    expect(state.takeBufferDelta("reply", text)).toEqual({ deltaText: text });
    state.updateBuffer("reply", { managedMediaUrls: ["./plot.png"] });
    const visible = "`[[reply_to_current]]`\n\nPicture\nDone";
    expect(state.resolveBuffer("reply").text).toBe(visible);
    expect(state.takeBufferDelta("reply", visible)).toEqual({ deltaText: visible, replace: true });
  });

  it("keeps text visible when the cap evicts its classification context", () => {
    const state = createChatRunState();
    const prefix = "`[[reply_to_current]]`\n\nNext ";
    state.updateBuffer("reply", { delta: prefix + "x".repeat(500_000 - prefix.length) });
    expect(state.resolveBuffer("reply").text.startsWith(prefix)).toBe(true);
    state.updateBuffer("reply", { delta: "!" });
    const visible = state.resolveBuffer("reply").text;
    expect(visible.startsWith(prefix.slice(1))).toBe(true);
    expect(visible).toContain("[[reply_to_current]]");
    expect(visible.endsWith("!")).toBe(true);
  });
});

it("matches a seeded occurrence model across real caps and native replacements", () => {
  const failures: string[] = [];
  const managedMediaUrls = ["./model.png"];
  const block = (marker: string, size: number, tag: string) => {
    const suffix = `#${tag};`;
    return marker.repeat(Math.max(0, size - suffix.length)) + suffix;
  };
  // Use the production cap policy directly; its limit is private to that module.
  const capped = (text: string) => capLiveAssistantText({ text });
  const seeds = [0x51a7, 0xbadc0de, 0xc0ffee];
  for (const seed of seeds) {
    const prefixVariant = (seed >>> 5) & 3;
    const state = createChatRunState();
    const runId = "occurrence-model";
    const retired = new Set<string>();
    let entries: Occurrence[] = [];
    let available: AvailablePart[] = [];
    let currentNative: string | undefined;
    let currentGroup: string | undefined;
    let scopeSerial = 0;
    const occurrenceIds = new Set<string>();
    const nativeIds = new Set<string>();
    const evictedGroups = new Set<string>();
    let serial = 0;
    let step = 0;
    let wire = "";
    let randomState = seed;
    let firstMismatch: string | undefined;
    let mismatchCount = 0;
    let crossedCap = false;
    let contextEvicted = false;
    const random = () => {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return randomState >>> 0;
    };
    const textBlock = () => {
      const size = random() % 3 ? 1 + (random() % 20) : 100_000 + (random() % 200_001);
      const token =
        SUPPRESSED_CONTROL_REPLY_TOKENS[random() % SUPPRESSED_CONTROL_REPLY_TOKENS.length]!;
      const alphabet = [
        token,
        `${token}.`,
        `The token is ${token}`,
        `The token is ${token}.`,
        `${token}\nVisible`,
        `Before ${token} after`,
        token.slice(0, 3),
        `\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nPrivate`,
        `\n${INTERNAL_RUNTIME_CONTEXT_END}\nVisible`,
        "\nMEDIA:./model.png\nVisible",
        "\nMEDIA",
      ];
      return size < 100 && random() % 3 === 0
        ? alphabet[random() % alphabet.length]!
        : block(String.fromCharCode(97 + (random() % 8)), size, `o${++serial}`);
    };
    const capAvailability = () => {
      const supplied = available.map((part) => part.text).join("");
      let removed = supplied.length - capped(supplied).length;
      crossedCap ||= removed > 0;
      contextEvicted ||= removed > 0;
      available = available.flatMap((part) => {
        if (removed === 0) {
          return [part];
        }
        if (part.owner) {
          part.owner.evicted = true;
          if (part.owner.group) {
            evictedGroups.add(part.owner.group);
          }
        }
        const count = Math.min(removed, part.text.length);
        removed -= count;
        return count === part.text.length
          ? []
          : [{ ...part, text: part.text.slice(count), evicted: true }];
      });
    };
    const verify = (op: string) => {
      const context = `seed=0x${seed.toString(16)} step=${step} op=${op}`;
      const ranges = [...(state.runs.get(runId)?.assistantItems?.values() ?? [])]
        .flatMap((item) => {
          if (item.end === null && item.start !== undefined) {
            throw new Error(`${context} invalidated range retains start=${item.start}`);
          }
          if (typeof item.end !== "number") {
            return [];
          }
          if (typeof item.start !== "number" || item.start > item.end) {
            throw new Error(`${context} invalid bounds ${JSON.stringify(item)}`);
          }
          return item.start < item.end
            ? [{ id: item.itemId, start: item.start, end: item.end }]
            : [];
        })
        .toSorted((left, right) => left.start - right.start || left.end - right.end);
      for (let index = 1; index < ranges.length; index++) {
        const left = ranges[index - 1];
        const right = ranges[index];
        if (left && right && left.end > right.start) {
          throw new Error(`${context} overlapping ranges ${JSON.stringify([left, right])}`);
        }
      }
      const visible = (parts: AvailablePart[]) => {
        const text = join(
          parts.flatMap((part) =>
            part.owner && !part.owner.retired ? [{ ...part.owner, text: part.text }] : [],
          ),
        );
        return available.some((part) => part.owner?.retired) &&
          available.findIndex((part) => part.owner && !part.owner.retired && part.text) > 0
          ? text.replace(/^\n{1,2}/, "")
          : text;
      };
      const tail = visible(available);
      const projected = projectAvailableParts(
        available,
        tail,
        false,
        managedMediaUrls,
        contextEvicted,
      );
      const terminal = projectAvailableParts(
        available,
        tail,
        true,
        managedMediaUrls,
        contextEvicted,
      );
      const expected = projected.displayText;
      const expectedFinal = terminal.displayText;
      const ambiguous = available.some(
        (part) =>
          part.evicted ||
          part.owner?.evicted ||
          (part.owner?.group && evictedGroups.has(part.owner.group)),
      );
      const allowed: CharacterRun[] = [];
      if (ambiguous) {
        for (const part of available) {
          appendCharacterRuns(allowed, part.text, Boolean(part.owner && !part.owner.retired));
        }
      }
      const resolved = state.resolveBuffer(runId);
      const live = resolved.suppress ? "" : resolved.text;
      const delta = state.takeBufferDelta(runId, live);
      if (delta) {
        wire = delta.replace ? delta.deltaText : wire + delta.deltaText;
      }
      const final = state.resolveBuffer(runId, { final: true });
      const views: Array<[string, string, string]> = [
        ["live", live, expected],
        ["delta", wire, expected],
        ["snapshot", projectInFlightRunSnapshot({ chatRunState: state, runId }).text, expected],
        ["display-final", final.displayText ?? (final.suppress ? "" : final.text), expectedFinal],
        ["complete-final", final.text, terminal.text],
      ];
      const safety = new Map<string, boolean>();
      for (const [view, actual, wanted] of views) {
        const exact = !ambiguous || view === "complete-final";
        let matches = actual === wanted;
        if (!exact && !matches) {
          matches = safety.get(actual) ?? preservesAvailableText(allowed, actual);
          safety.set(actual, matches);
        }
        if (!matches) {
          mismatchCount++;
          firstMismatch ??= assistantTextDifference(
            actual,
            wanted,
            `seed=${seed} step=${step} op=${op} view=${view} oracle=${exact ? "exact" : "safety"}`,
          );
        }
      }
      step++;
    };
    const emit = (entry: Occurrence, replace = false, replaceable = false) => {
      const sameNative = currentNative === entry.native;
      const group = sameNative ? currentGroup : `scope-${++scopeSerial}`;
      entry.group = group;
      const supplied = entries.filter((part) => part.group === group);
      if (entry.id) {
        occurrenceIds.add(entry.id);
      }
      if (entry.native) {
        nativeIds.add(entry.native);
      }
      available =
        replace && replaceable && !sameNative
          ? []
          : sameNative
            ? available.filter((part) => !part.owner || part.owner.group !== group)
            : available;
      if (replace && replaceable && !sameNative) {
        contextEvicted = false;
      }
      available = available.filter((part) => part.separatorFor !== group);
      const prefix = available.map((part) => part.text).join("");
      const suppliedText = supplied.map((part) => part.text).join("");
      if (prefix && suppliedText) {
        available.push({ separatorFor: group, text: paragraphSeparator(prefix, suppliedText) });
      }
      available.push(
        ...supplied.filter((part) => part.text).map((owner) => ({ owner, text: owner.text })),
      );
      currentNative = entry.native;
      currentGroup = group;
      capAvailability();
      state.updateBuffer(runId, {
        itemId: entry.native,
        occurrenceId: entry.id,
        text: suppliedText,
        managedMediaUrls,
        ...(replace ? { replace: true } : {}),
        ...(replaceable ? { replaceable: true } : {}),
      });
    };
    const commit = (id: string) => {
      retired.add(id);
      for (const entry of entries) {
        if (entry.id === id) {
          entry.retired = true;
        }
      }
      state.retireBuffer(runId, [id]);
      verify(`commit:${id}`);
    };
    const saved = block("a", 100_000, "A");
    const hidden =
      prefixVariant === 1
        ? saved
        : prefixVariant === 2
          ? block("z", 100_000, "A")
          : "a".repeat(75_000) + block("z", 25_000, "A");
    const a: Occurrence = { id: "A", native: "native", text: hidden, retired: false };
    const b: Occurrence = {
      id: "B",
      native: "native",
      text: block("b", 250_000, "B0"),
      retired: false,
    };
    entries.push(a);
    emit(a);
    verify("item:A:100000");
    entries.push(b);
    emit(b);
    verify("occurrence:B:250000");
    b.text += block("b", 250_000, "B1");
    emit(b);
    verify("append:B:250000");
    commit("A");
    const replacement = saved + b.text.slice(0, 450_000);
    // Three known source edits produce the same replacement after identical
    // retained windows: preserve all A, replace all A, or preserve its first 75k.
    const retained = prefixVariant === 1 ? a.text.length : prefixVariant === 2 ? 0 : 75_000;
    a.text = a.text.slice(0, retained);
    b.text = replacement.slice(retained);
    emit(b, true);
    const shrankAfterEviction = crossedCap;
    verify("same-item:shrink-after-eviction:550000");
    for (const [id, native, text, reset] of [
      ["reuse-a", "reuse-n", "Old", true],
      ["reuse-m", "reuse-m", "Reset", true],
      ["reuse-b", "reuse-n", "Keep", false],
      ["reuse-a", "reuse-n", "New", false],
    ] satisfies Array<[string, string, string, boolean]>) {
      const entry = { id, native, text, retired: false };
      entries = reset ? [entry] : [...entries, entry];
      emit(entry, reset, reset);
      verify(`invalidate-return:${id}:${native}`);
    }
    commit("reuse-m");
    const token = SUPPRESSED_CONTROL_REPLY_TOKENS[seed % SUPPRESSED_CONTROL_REPLY_TOKENS.length]!;
    const semanticParts = [
      ["The token is ", `${token}.`],
      ["The token is ", token],
      ["", token],
      [`${token}\n`, "Visible"],
      ["Before ", `${token} after`],
      ["Prefix ", token.slice(0, 3)],
      [
        `Text\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nPrivate`,
        ` hidden\n${INTERNAL_RUNTIME_CONTEXT_END}\nVisible`,
      ],
      ["Text\nMEDIA", ":./model.png\nVisible"],
    ];
    for (const [index, [prefix, suffix]] of semanticParts.entries()) {
      const native = `semantic-${index}`;
      const before = { id: `${native}-a`, native, text: prefix!, retired: false };
      entries = [before];
      emit(before, true, true);
      verify(`semantic-prefix:${index}`);
      const after = { id: `${native}-b`, native, text: suffix!, retired: false };
      entries.push(after);
      emit(after);
      verify(`semantic-suffix:${index}`);
      commit(before.id);
    }
    let reusedOccurrences = 0;
    let reusedNatives = 0;
    const occurrenceId = () => {
      const pool = [...occurrenceIds].filter((id) => !retired.has(id));
      const reused = pool.length && random() % 2 === 0 ? pool[random() % pool.length] : undefined;
      if (reused !== undefined) {
        reusedOccurrences++;
        return reused;
      }
      return `occurrence-${++serial}`;
    };
    for (let turn = 0; turn < 60; turn++) {
      const choice = random() % 8;
      const current = entries.at(-1);
      if (choice === 7 && current?.id) {
        const candidates = entries.filter((entry) => entry.id !== undefined);
        const target = candidates[random() % candidates.length];
        if (target?.id) {
          commit(target.id);
        }
        continue;
      }
      if (choice === 6) {
        const text = textBlock();
        const previous = available.findLast((part) => part.owner)?.owner;
        const entry = { text, retired: false, group: previous?.group ?? previous?.native };
        entries.push(entry);
        available.push({ owner: entry, text });
        currentNative = undefined;
        capAvailability();
        state.updateBuffer(runId, { delta: text });
        verify(`anonymous-append:${text.length}`);
        continue;
      }
      if (!current?.native || choice === 4 || choice === 5) {
        const id = occurrenceId();
        const pool = [...nativeIds].filter((native) => native !== currentNative);
        const reused = pool.length && random() % 2 === 0 ? pool[random() % pool.length] : undefined;
        const native = reused ?? `item-${++serial}`;
        reusedNatives += Number(reused !== undefined);
        const replacing = choice === 5;
        if (replacing && !occurrenceIds.has(id) && random() % 2 === 0) {
          commit(id);
        }
        const entry = { id, native, text: textBlock(), retired: retired.has(id) };
        entries = replacing ? [entry] : [...entries, entry];
        emit(entry, replacing, replacing);
        verify(`${replacing ? "cross-item-replace" : "item-change"}:${id}:${entry.text.length}`);
        continue;
      }
      if (choice === 3) {
        const entry = {
          id: occurrenceId(),
          native: current.native,
          text: textBlock(),
          retired: false,
        };
        entries.push(entry);
        emit(entry);
        verify(`new-occurrence:${entry.id}:${entry.text.length}`);
        continue;
      }
      if (choice === 0) {
        const text = textBlock();
        current.text += text;
        emit(current);
        verify(`append:${current.id}:${text.length}`);
      } else {
        const kind = random() % 4;
        current.text =
          kind === 0
            ? ""
            : kind === 1
              ? current.text.slice(0, Math.floor(current.text.length / 2))
              : kind === 2
                ? textBlock()
                : current.text + textBlock();
        emit(current, true);
        verify(`same-item-replace:${kind}:${current.id}:${current.text.length}`);
      }
    }
    expect(reusedOccurrences, `seed=${seed} never reused an occurrence`).toBeGreaterThan(0);
    expect(reusedNatives, `seed=${seed} never reused a native item`).toBeGreaterThan(0);
    expect(crossedCap, `seed=${seed} never crossed the real cap`).toBe(true);
    expect(shrankAfterEviction, `seed=${seed} never shrank after eviction`).toBe(true);
    if (firstMismatch) {
      failures.push(`${firstMismatch} (first of ${mismatchCount} mismatches in ${step} steps)`);
    }
  }
  if (failures.length) {
    throw new Error(failures.join("\n"));
  }
});
