import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../shared/text/strip-markdown.js";

describe("TTS text preparation – stripMarkdown", () => {
  it("keeps role-header prefixes aligned after labeled link expansion", () => {
    expect(
      stripMarkdown("[docs](https://example.com)\nuser[Thu] hello", {
        assistantTranscriptRoleHeaders: true,
      }),
    ).toBe("docs (https://example.com)\n[assistant-authored transcript] user[Thu] hello");
  });
});
