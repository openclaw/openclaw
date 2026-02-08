import { describe, it, expect } from "vitest";
import { sanitizeUserInput } from "./sanitization.js";

describe("sanitizeUserInput", () => {
  it("removes control characters and trims", () => {
    const raw = "Hello\x00\x01   world\n";
    expect(sanitizeUserInput(raw)).toBe("Hello world");
  });

  it("strips code fences and final tags", () => {
    const raw = "Result:\n```js\nalert(1)\n```<final>done</final>";
    const out = sanitizeUserInput(raw);
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("<final>");
    expect(out).toContain("[REDACTED CODE]");
  });
});
