import { describe, expect, it } from "vitest";
import { truncateLabel } from "./context-treemap.js";

const hasLoneSurrogate = (value: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

describe("truncateLabel", () => {
  it("returns the value unchanged when within the char budget", () => {
    expect(truncateLabel("short", 10)).toBe("short");
  });

  it("returns empty string for a non-positive budget", () => {
    expect(truncateLabel("anything", 0)).toBe("");
  });

  it("does not split a surrogate pair at the truncation boundary", () => {
    // 🦞 (2 UTF-16 code units) straddles the cut; a raw value.slice(0, n)
    // would leave a trailing lone high surrogate (renders as �).
    const label = "x🦞tail";
    const out = truncateLabel(label, 2);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).not.toContain("�");
  });

  it("keeps a multibyte label surrogate-safe under the main truncation path", () => {
    const label = `${"字".repeat(3)}🦞${"y".repeat(20)}`;
    const out = truncateLabel(label, 5);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("preserves an intact surrogate pair that fits within the budget", () => {
    const out = truncateLabel("🦞abc", 10);
    expect(out).toBe("🦞abc");
  });
});
