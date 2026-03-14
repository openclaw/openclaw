import { describe, expect, it } from "vitest";
import { parseReplyDirectives } from "./reply-directives.js";

describe("parseReplyDirectives", () => {
  it("marks exact NO_REPLY as silent", () => {
    const result = parseReplyDirectives("NO_REPLY");
    expect(result.isSilent).toBe(true);
    expect(result.text).toBe("");
  });

  it("marks own-line NO_REPLY as silent", () => {
    const result = parseReplyDirectives("Checked inbox, nothing new.\n\nNO_REPLY");
    expect(result.isSilent).toBe(true);
    expect(result.text).toBe("");
  });

  it("marks own-line NO_REPLY with single newline as silent", () => {
    const result = parseReplyDirectives("Status update.\nNO_REPLY");
    expect(result.isSilent).toBe(true);
    expect(result.text).toBe("");
  });

  it("marks own-line NO_REPLY with leading whitespace as silent", () => {
    const result = parseReplyDirectives("Nothing to report.\n  NO_REPLY  ");
    expect(result.isSilent).toBe(true);
    expect(result.text).toBe("");
  });

  it("strips inline NO_REPLY but delivers surrounding text", () => {
    const result = parseReplyDirectives("😄 NO_REPLY");
    expect(result.isSilent).toBe(false);
    expect(result.text).not.toContain("NO_REPLY");
  });

  it("delivers normal text without NO_REPLY", () => {
    const result = parseReplyDirectives("Hello, here is your update.");
    expect(result.isSilent).toBe(false);
    expect(result.text).toBe("Hello, here is your update.");
  });
});
