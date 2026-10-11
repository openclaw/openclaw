import { describe, expect, it } from "vitest";
import { extractEditorText, extractSessionBranchHeadline } from "./session-message-cut-content.js";

function headline(text: string) {
  return extractSessionBranchHeadline({
    type: "message",
    message: { role: "assistant", content: text },
  });
}

describe("session branch headline previews", () => {
  it.each([
    ["**Make verification the agent's job**", "Make verification the agent's job"],
    [
      "## Focused checks\n\n- Read the [guide](https://example.com) and use `pnpm test`.",
      "Focused checks Read the guide and use pnpm test.",
    ],
    ["Keep foo_bar_baz and ~/.openclaw", "Keep foo_bar_baz and ~/.openclaw"],
  ])("flattens display formatting in %s", (text, expected) => {
    expect(headline(text)).toBe(expected);
  });

  it("removes Markdown before truncation cuts off the closing delimiter", () => {
    expect(headline("**" + "a".repeat(121) + "**")).toBe("a".repeat(119) + "…");
    expect(headline("**" + "🦞".repeat(120) + "**")).toBe("🦞".repeat(120));
  });

  it("leaves the original editor text intact", () => {
    const content = [{ type: "text", text: "**Original** [guide](https://example.com)" }];
    expect(
      extractSessionBranchHeadline({ type: "message", message: { role: "user", content } }),
    ).toBe("Original guide");
    expect(extractEditorText(content)).toBe("**Original** [guide](https://example.com)");
  });
});
