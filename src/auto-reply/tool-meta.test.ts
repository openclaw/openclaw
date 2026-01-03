import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createToolDebouncer,
  formatToolAggregate,
  formatToolPrefix,
  shortenMeta,
  shortenPath,
} from "./tool-meta.js";

describe("tool meta formatting", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("shortens paths under HOME", () => {
    vi.stubEnv("HOME", "/Users/test");
    expect(shortenPath("/Users/test")).toBe("~");
    expect(shortenPath("/Users/test/a/b.txt")).toBe("~/a/b.txt");
    expect(shortenPath("/opt/x")).toBe("/opt/x");
  });

  it("shortens meta strings with optional colon suffix", () => {
    vi.stubEnv("HOME", "/Users/test");
    expect(shortenMeta("/Users/test/a.txt")).toBe("~/a.txt");
    expect(shortenMeta("/Users/test/a.txt:12")).toBe("~/a.txt:12");
    expect(shortenMeta("")).toBe("");
  });

  it("formats aggregates with grouping and brace-collapse", () => {
    vi.stubEnv("HOME", "/Users/test");
    const out = formatToolAggregate("  fs  ", [
      "/Users/test/dir/a.txt",
      "/Users/test/dir/b.txt",
      "note",
      "a→b",
    ]);
    expect(out).toMatch(/^🛠️ fs/);
    expect(out).toContain("~/dir/{a.txt, b.txt}");
    expect(out).toContain("note");
    expect(out).toContain("a→b");
  });

  it("formats prefixes with default labels", () => {
    vi.stubEnv("HOME", "/Users/test");
    expect(formatToolPrefix(undefined, undefined)).toBe("🛠️ tool");
    expect(formatToolPrefix("x", "/Users/test/a.txt")).toBe("🛠️ x: ~/a.txt");
  });
});

describe("tool meta debouncer", () => {
  it("flushes on timer and when tool changes", () => {
    vi.useFakeTimers();
    try {
      const calls: Array<{ tool: string | undefined; metas: string[] }> = [];
      const d = createToolDebouncer((tool, metas) => {
        calls.push({ tool, metas });
      }, 50);

      d.push("a", "/tmp/1");
      d.push("a", "/tmp/2");
      expect(calls).toHaveLength(0);

      vi.advanceTimersByTime(60);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        tool: "a",
        metas: ["/tmp/1", "/tmp/2"],
      });

      d.push("a", "x");
      d.push("b", "y"); // tool change flushes immediately
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ tool: "a", metas: ["x"] });

      vi.advanceTimersByTime(60);
      expect(calls).toHaveLength(3);
      expect(calls[2]).toMatchObject({ tool: "b", metas: ["y"] });
    } finally {
      vi.useRealTimers();
    }
  });
});
