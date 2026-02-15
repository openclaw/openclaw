import { describe, expect, it } from "vitest";
import { wrapNoteMessage } from "./note.js";

describe("wrapNoteMessage", () => {
  it("preserves long filesystem paths without inserting spaces/newlines", () => {
    const input =
      "/Users/user/Documents/Github/impact-signals-pipeline/with/really/long/segments/file.txt";
    const wrapped = wrapNoteMessage(input, { maxWidth: 22, columns: 80 });

    expect(wrapped).toBe(input);
  });

  it("preserves long urls without inserting spaces/newlines", () => {
    const input =
      "https://example.com/this/is/a/very/long/url/segment/that/should/not/be/split/for-copy";
    const wrapped = wrapNoteMessage(input, { maxWidth: 24, columns: 80 });

    expect(wrapped).toBe(input);
  });

  it("preserves long file-like underscore tokens for copy safety", () => {
    const input = "administrators_authorized_keys_with_extra_suffix";
    const wrapped = wrapNoteMessage(input, { maxWidth: 14, columns: 80 });

    expect(wrapped).toBe(input);
  });

  it("still chunks generic long opaque tokens to avoid pathological line width", () => {
    const input = "x".repeat(70);
    const wrapped = wrapNoteMessage(input, { maxWidth: 20, columns: 80 });

    expect(wrapped).toContain("\n");
    expect(wrapped.replace(/\n/g, "")).toBe(input);
  });
});
