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
import { createChatRunState } from "./server-chat-state.js";

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
});
