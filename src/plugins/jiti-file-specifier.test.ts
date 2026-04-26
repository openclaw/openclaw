import { describe, expect, it } from "vitest";
import { normalizeJitiFileSpecifier } from "./jiti-file-specifier.js";

describe("normalizeJitiFileSpecifier", () => {
  it("leaves specifiers unchanged on non-Windows platforms", () => {
    const abs = "C:/openclaw/extensions/telegram/index.ts";
    expect(normalizeJitiFileSpecifier(abs, "linux")).toBe(abs);
  });

  it("converts a Windows drive-letter path to a file: URL (native import() safe)", () => {
    const p = "C:/openclaw/dist/extensions/telegram/api.js";
    const out = normalizeJitiFileSpecifier(p, "win32");
    expect(out).toBe("file:///C:/openclaw/dist/extensions/telegram/api.js");
  });

  it("preserves an existing file: URL on Windows", () => {
    const f = "file:///C:/openclaw/entry.mjs";
    expect(normalizeJitiFileSpecifier(f, "win32")).toBe(f);
  });
});
