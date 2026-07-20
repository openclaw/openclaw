import { describe, expect, it } from "vitest";
import { renderStatusFooterLine } from "./status-footer.js";

describe("renderStatusFooterLine", () => {
  it("names the current activity in activity mode", () => {
    expect(
      renderStatusFooterLine({ mode: "activity", activityLabel: "Bash: run tests", elapsedMs: 0 }),
    ).toBe("▸ Bash: run tests · 0s · reply to steer");
  });

  it("ignores the activity label in minimal mode", () => {
    expect(
      renderStatusFooterLine({ mode: "minimal", activityLabel: "Bash: run tests", elapsedMs: 0 }),
    ).toBe("▸ Working · 0s · reply to steer");
  });

  it("falls back to Working when no activity is known", () => {
    expect(renderStatusFooterLine({ mode: "activity", elapsedMs: 0 })).toBe(
      "▸ Working · 0s · reply to steer",
    );
    expect(renderStatusFooterLine({ mode: "activity", activityLabel: "   ", elapsedMs: 0 })).toBe(
      "▸ Working · 0s · reply to steer",
    );
  });

  it("renders elapsed time compactly", () => {
    expect(renderStatusFooterLine({ mode: "minimal", elapsedMs: 125_000 })).toContain("· 2m");
  });

  it("treats a negative elapsed as zero", () => {
    expect(renderStatusFooterLine({ mode: "minimal", elapsedMs: -5_000 })).toBe(
      "▸ Working · 0s · reply to steer",
    );
  });

  it("collapses whitespace in the activity label", () => {
    expect(
      renderStatusFooterLine({ mode: "activity", activityLabel: " run\n  tests ", elapsedMs: 0 }),
    ).toBe("▸ run tests · 0s · reply to steer");
  });

  it("truncates a long label on a word boundary", () => {
    const label = "Running the entire integration suite across every supported channel adapter";
    const line = renderStatusFooterLine({ mode: "activity", activityLabel: label, elapsedMs: 0 });
    expect(line).toContain("…");

    const shown = line.slice("▸ ".length, line.indexOf(" · "));
    expect(shown.endsWith("…")).toBe(true);
    // The kept text is a whole-word prefix of the original: the cut landed on a space,
    // never mid-word.
    const kept = shown.slice(0, -1);
    expect(label.startsWith(kept)).toBe(true);
    expect(label[kept.length]).toBe(" ");
  });

  it("truncates on code points so surrogate pairs never split", () => {
    // One past the truncation limit, so this label must be cut.
    const label = "🙂".repeat(61);
    const line = renderStatusFooterLine({ mode: "activity", activityLabel: label, elapsedMs: 0 });
    expect(line).not.toContain("�");
    // A split surrogate pair would leave a lone high surrogate behind.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(line)).toBe(false);
  });
});
