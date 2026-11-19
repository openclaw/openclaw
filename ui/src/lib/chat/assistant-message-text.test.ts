import { expect, it, onTestFinished, vi } from "vitest";
import * as thinking from "../strip-thinking-tags.ts";
import { stripAssistantMessageText } from "./assistant-message-text.ts";

it.each(["narration", "display"] as const)(
  "shares one stripping pass when %s reads the same message first",
  (first) => {
    const strip = vi.spyOn(thinking, "stripThinkingTags");
    onTestFinished(() => strip.mockRestore());
    const message = {};
    const source = "<think>reasoning</think>\n\n<final>Visible</final>";
    expect(stripAssistantMessageText(message, source, first)).toBe("Visible");
    expect(
      stripAssistantMessageText(message, source, first === "narration" ? "display" : "narration"),
    ).toBe("Visible");
    expect(strip).toHaveBeenCalledOnce();
  },
);

it("retains each consumer's input while sources interleave and change", () => {
  const strip = vi.spyOn(thinking, "stripThinkingTags");
  onTestFinished(() => strip.mockRestore());
  const message = {};
  const raw = "<think>reasoning</think>\n\n<final>Visible</final>";
  const display = "<final>Visible</final>";
  for (let index = 0; index < 2; index++) {
    expect(stripAssistantMessageText(message, raw, "narration")).toBe("Visible");
    expect(stripAssistantMessageText(message, display, "display")).toBe("Visible");
  }
  expect(strip).toHaveBeenCalledTimes(2);

  const changed = "<final>Changed</final>";
  expect(stripAssistantMessageText(message, changed, "narration")).toBe("Changed");
  expect(stripAssistantMessageText(message, display, "display")).toBe("Visible");
  expect(strip).toHaveBeenCalledTimes(3);
  expect(stripAssistantMessageText(message, changed, "display")).toBe("Changed");
  expect(strip).toHaveBeenCalledTimes(3);
  expect(stripAssistantMessageText({}, changed, "display")).toBe("Changed");
  expect(strip).toHaveBeenCalledTimes(4);
});
