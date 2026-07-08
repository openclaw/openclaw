import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// UTF-16-safe truncation tests covering 3 private formatTaskBlocker helpers that
// truncate task.title.slice(0, 80) in diagnostic/restart/log output:
//   gateway/server-reload-handlers.ts:270
//   infra/restart-coordinator.ts:73
//   cli/gateway-cli/run-loop.ts:569
//
// All three are identical copies of the same pattern; the boundary is 80 chars.
import { describe, expect, it } from "vitest";

describe("task title truncation", () => {
  it("drops the incomplete emoji pair instead of producing a lone surrogate (maxChars=80)", () => {
    // title = 79 't' + emoji = 81 code units. emoji high surrogate at index 79
    // (within the 80-char limit), low surrogate at index 80 (beyond).
    // slice(0, 80) includes the lone high surrogate → broken char (U+FFFD).
    // truncateUtf16Safe(80) detects incomplete pair and backs out to 79 pure 't'.
    const title = "t".repeat(79) + "🚀";
    expect(title.slice(0, 80).charCodeAt(79)).toBe(0xd83d); // lone high surrogate
    expect(truncateUtf16Safe(title, 80)).toBe("t".repeat(79)); // pair dropped cleanly
  });

  it("preserves the complete emoji when it fits fully within the boundary", () => {
    // title = 78 't' + emoji = 80 code units. Both halves of the surrogate
    // pair are within the limit — no truncation needed.
    const title = "t".repeat(78) + "🚀";
    expect(title.length).toBe(80);
    expect(truncateUtf16Safe(title, 80)).toBe(title);
  });

  it("preserves task titles shorter than the limit unchanged", () => {
    expect(truncateUtf16Safe("deploy-cron", 80)).toBe("deploy-cron");
    expect(truncateUtf16Safe("", 80)).toBe("");
  });
});
