// UTF-16-safe truncation test for `task.slice(0, 2000)` in
// buildResumeMessage (src/agents/subagent-orphan-recovery.ts:75).
// Subagent orphan recovery truncates the task description in the resume
// message at 2000 code units, which can split a surrogate pair.
import { describe, expect, it } from "vitest";
import { truncateUtf16Safe } from "../utils.js";

describe("task resume truncation", () => {
  it("drops the incomplete emoji pair instead of producing a lone surrogate (maxChars=2000)", () => {
    // task = 1999 't' + emoji = 2001 code units. emoji high surrogate at
    // index 1999 (within the 2000-char limit), low surrogate at index 2000
    // (outside). slice(0, 2000) → lone high surrogate → U+FFFD.
    // truncateUtf16Safe(2000) backs out to 1999 pure 't'.
    const task = "t".repeat(1999) + "🚀";
    expect(task.slice(0, 2000).charCodeAt(1999)).toBe(0xd83d); // lone high surrogate
    expect(truncateUtf16Safe(task, 2000)).toBe("t".repeat(1999)); // pair dropped cleanly
  });

  it("preserves the complete emoji when it fits fully within the boundary", () => {
    // task = 1998 't' + emoji = 2000 code units. Both surrogate halves
    // are within the limit — no truncation needed.
    const task = "t".repeat(1998) + "🚀";
    expect(task.length).toBe(2000);
    expect(truncateUtf16Safe(task, 2000)).toBe(task);
  });

  it("preserves task strings shorter than the limit unchanged", () => {
    expect(truncateUtf16Safe("deploy database migration", 2000)).toBe("deploy database migration");
    expect(truncateUtf16Safe("", 2000)).toBe("");
  });
});
