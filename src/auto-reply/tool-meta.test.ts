/** Tests compact tool metadata formatting for auto-reply progress output. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
<<<<<<< HEAD
import { formatToolAggregate } from "./tool-meta.js";
=======
import { formatToolAggregate, formatToolPrefix, shortenMeta, shortenPath } from "./tool-meta.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

// Use path.resolve so inputs match the resolved HOME on every platform.
const home = path.resolve("/Users/test");

function withHome<T>(run: () => T): T {
  return withEnv({ HOME: home }, run);
}

describe("tool meta formatting", () => {
<<<<<<< HEAD
  it("shortens home paths with optional colon suffix", () => {
    withHome(() => {
      expect(formatToolAggregate("fs", [`${home}/a.txt`])).toContain("~/a.txt");
      expect(formatToolAggregate("fs", [`${home}/a.txt:12`])).toContain("~/a.txt:12");
      expect(formatToolAggregate("exec", [`cd ${home}/dir && ls`])).toContain(
        "cd ~/dir && ls",
      );
      expect(formatToolAggregate("fs", [""])).toBe("🧩 Fs");
=======
  it("shortens paths under HOME", () => {
    withHome(() => {
      expect(shortenPath(home)).toBe("~");
      expect(shortenPath(`${home}/a/b.txt`)).toBe("~/a/b.txt");
      expect(shortenPath("/opt/x")).toBe("/opt/x");
    });
  });

  it("shortens meta strings with optional colon suffix", () => {
    withHome(() => {
      expect(shortenMeta(`${home}/a.txt`)).toBe("~/a.txt");
      expect(shortenMeta(`${home}/a.txt:12`)).toBe("~/a.txt:12");
      expect(shortenMeta(`cd ${home}/dir && ls`)).toBe("cd ~/dir && ls");
      expect(shortenMeta("")).toBe("");
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    });
  });

  it("formats aggregates with grouping and brace-collapse", () => {
    withHome(() => {
      const out = formatToolAggregate("  fs  ", [
        `${home}/dir/a.txt`,
        `${home}/dir/b.txt`,
        "note",
        "a→b",
      ]);
      expect(out).toMatch(/^🧩 Fs/);
      expect(out).toContain("~/dir/{a.txt, b.txt}");
      expect(out).toContain("note");
      expect(out).toContain("a→b");
    });
  });

  it("wraps aggregate meta in backticks when markdown is enabled", () => {
    withHome(() => {
      const out = formatToolAggregate("fs", [`${home}/dir/a.txt`], { markdown: true });
      expect(out).toContain("`~/dir/a.txt`");
    });
  });

  it("uses a longer inline code delimiter when meta contains backticks", () => {
    const out = formatToolAggregate("fs", ["name `with` ticks"], { markdown: true });
    expect(out).toBe("🧩 Fs: ``name `with` ticks``");
  });

  it("keeps exec flags outside markdown and moves them to the front", () => {
    withHome(() => {
      const out = formatToolAggregate("exec", [`cd ${home}/dir && gemini 2>&1 · elevated`], {
        markdown: true,
      });
      expect(out).toBe("🛠️ elevated · `cd ~/dir && gemini 2>&1`");
    });
  });
<<<<<<< HEAD
=======

  it("formats prefixes with default labels", () => {
    withHome(() => {
      expect(formatToolPrefix(undefined, undefined)).toBe("🧩 Tool");
      expect(formatToolPrefix("x", `${home}/a.txt`)).toBe("🧩 X: ~/a.txt");
    });
  });
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
});
