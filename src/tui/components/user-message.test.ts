import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { MarkdownMessageComponent } from "./markdown-message.js";

describe("user Markdown message", () => {
  it("preserves ordered-list markers and backslash escapes", () => {
    const message = new MarkdownMessageComponent(
      "user",
      String.raw`7. first
9. second

Escaped \*literal\*`,
    );

    const rendered = message.render(80).map(normalizeTestText).join("\n");

    expect(rendered).toContain("7. first");
    expect(rendered).toContain("9. second");
    expect(rendered).toContain(String.raw`\*literal\*`);
  });
});
