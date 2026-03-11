import { describe, expect, it } from "vitest";
import { sanitizeAssistantMessageTextForDisplay } from "./assistant-message.js";

describe("sanitizeAssistantMessageTextForDisplay", () => {
  it("strips relevant-memories scaffolding before rendering", () => {
    const out = sanitizeAssistantMessageTextForDisplay(
      [
        "Visible intro",
        "<relevant-memories>",
        "private memory",
        "</relevant-memories>",
        "Visible outro",
      ].join("\n"),
    );

    expect(out).toContain("Visible intro");
    expect(out).toContain("Visible outro");
    expect(out).not.toContain("relevant-memories");
    expect(out).not.toContain("private memory");
  });
});
