import { describe, expect, it } from "vitest";
import { escapeQuotedLogValue } from "./logging.js";

describe("escapeQuotedLogValue", () => {
  it("escapes double quotes for quoted key/value log tokens", () => {
    expect(escapeQuotedLogValue('groupPolicy to "allowlist"')).toBe(
      'groupPolicy to \\"allowlist\\"',
    );
  });

  it("leaves non-quote characters untouched", () => {
    expect(escapeQuotedLogValue("line one\\nline two")).toBe("line one\\nline two");
  });
});
