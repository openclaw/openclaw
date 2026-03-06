import { describe, expect, it } from "vitest";
import { parseReplyDirectives } from "./reply-directives.js";

describe("parseReplyDirectives", () => {
  it("treats structured NO_REPLY action payload as silent", () => {
    const parsed = parseReplyDirectives('{"action":"NO_REPLY"}');
    expect(parsed.isSilent).toBe(true);
    expect(parsed.text).toBe("");
  });
});
