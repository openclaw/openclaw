/** Tests compact tool metadata formatting for auto-reply progress output. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { formatToolAggregate } from "./tool-meta.js";

// Use path.resolve so inputs match the resolved HOME on every platform.
const home = path.resolve("/Users/test");

function withHome<T>(run: () => T): T {
  return withEnv({ HOME: home }, run);
}

describe("tool meta formatting", () => {
  it("shortens home paths with optional colon suffix", () => {
    withHome(() => {
      expect(formatToolAggregate("fs", [`${home}/a.txt`])).toContain("~/a.txt");
      expect(formatToolAggregate("fs", [`${home}/a.txt:12`])).toContain("~/a.txt:12");
      expect(formatToolAggregate("exec", [`cd ${home}/dir && ls`])).toContain("cd ~/dir && ls");
      expect(formatToolAggregate("fs", [""])).toBe("Fs");
    });
  });

  it("wraps aggregate meta in backticks when markdown is enabled", () => {
    withHome(() => {
      const out = formatToolAggregate("fs", [`${home}/dir/a.txt`], { markdown: true });
      expect(out).toContain("`~/dir/a.txt`");
    });
  });

  it("preserves path spelling and group order after raw metadata", () => {
    withHome(() => {
      expect(
        formatToolAggregate("fs", [
          "/z/a",
          "/2/a",
          "/z/b",
          "relative/file",
          "/a→b",
          "/1/a",
          "/root",
          "/leaf",
          "/double//file",
          "/trailing/",
        ]),
      ).toBe(
        "Fs: relative/file; /a→b; /z/{a, b}; /2/a; /1/a; /{root, leaf}; /double//file; /trailing/",
      );
    });
  });

  it("keeps exec flags outside markdown and moves them to the front", () => {
    withHome(() => {
      const out = formatToolAggregate("exec", [`cd ${home}/dir && gemini 2>&1 · elevated`], {
        markdown: true,
      });
      expect(out).toBe("elevated · `cd ~/dir && gemini 2>&1`");
    });
  });
});
