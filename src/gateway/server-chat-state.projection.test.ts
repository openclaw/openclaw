import { describe, expect, it, vi } from "vitest";
import * as codeRegions from "../shared/text/code-regions.js";
import { createChatRunState } from "./server-chat-state.js";

describe("live chat directive projection", () => {
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

  it("retires code ownership when the display cap removes its opening delimiter", () => {
    const state = createChatRunState();
    const prefix = "`[[reply_to_current]]`\n\nNext ";
    state.updateBuffer("reply", { delta: prefix + "x".repeat(500_000 - prefix.length) });
    expect(state.resolveBuffer("reply").text.startsWith(prefix)).toBe(true);
    state.updateBuffer("reply", { delta: "!" });
    const visible = state.resolveBuffer("reply").text;
    expect(visible.startsWith("`\n\nNext ")).toBe(true);
    expect(visible).not.toContain("[[reply_to_current]]");
    expect(visible.endsWith("!")).toBe(true);
  });
});
