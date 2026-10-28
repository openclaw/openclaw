import { describe, expect, it } from "vitest";
import { MarkdownMessageComponent } from "./markdown-message.js";

describe("MarkdownMessageComponent plain mode", () => {
  it("strips terminal control sequences from assistant text", () => {
    const message = new MarkdownMessageComponent(
      "assistant",
      "before\u001b[2J\u001b]52;c;ZXZpbA==\u0007after",
      undefined,
      { streaming: false },
    );
    const rendered = message.render(80).join("\n");
    expect(rendered).toContain("Assistant: beforeafter");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u0007");
  });
});
