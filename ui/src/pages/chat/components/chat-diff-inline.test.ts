import { describe, expect, it, vi } from "vitest";
import { renderToolFixture, renderToolCard } from "./chat-tool-render.test-support.ts";

// Covers the tool-result adapter and syntax overlay; pairing is owned by the
// line-presentation tests, and the Review panel owns browser navigation proof.
describe("tool-card inline diff", () => {
  it.each(["example.ts", "example.unknown"])(
    "retains escaped source and inline edits in %s previews",
    async (path) => {
      const before = 'const message = "<img src=x>"; const count = 2;';
      const after = 'const message = "<img src=x>"; const count = 3;';
      const container = document.createElement("div");
      await renderToolFixture(
        renderToolCard(
          { id: "inline", name: "edit", args: { path, oldText: before, newText: after } },
          {
            messageKey: "inline-message",
            expanded: true,
            onToggleExpanded: vi.fn(),
          },
        ),
        container,
      );
      await vi.dynamicImportSettled();
      const text = (selector: string) => container.querySelector(selector)?.textContent;
      await vi.waitFor(() => expect(text(".chat-diff__change--add")).toBe("3"));
      expect(text(".chat-diff__change--del")).toBe("2");
      expect(text(".chat-diff__row--del .chat-diff__text")).toBe(before);
      expect(text(".chat-diff__row--add .chat-diff__text")).toBe(after);
      expect(container.querySelector("img")).toBeNull();
    },
  );
});
