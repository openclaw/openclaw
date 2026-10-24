import { beforeEach, expect, it } from "vitest";
import {
  internDiffBaselineFile,
  internSessionEntryDiffBaseline,
  internedDiffBaselineFileCount,
  resetInternedDiffBaselineFiles,
} from "./session-diff-baseline-intern.js";

beforeEach(() => {
  resetInternedDiffBaselineFiles();
});

it("hands every caller the same record for one path and fingerprint", () => {
  const first = internDiffBaselineFile("src/index.ts", "abc123");
  for (let i = 0; i < 10_000; i++) {
    expect(internDiffBaselineFile("src/index.ts", "abc123")).toBe(first);
  }
  expect(internedDiffBaselineFileCount()).toBe(1);
});

it("adopts a new record when a path's fingerprint changes", () => {
  const before = internDiffBaselineFile("src/index.ts", "abc123");
  const after = internDiffBaselineFile("src/index.ts", "def456");
  expect(after).not.toBe(before);
  expect(before.fingerprint).toBe("abc123");
  expect(internDiffBaselineFile("src/index.ts", "def456")).toBe(after);
  expect(internedDiffBaselineFileCount()).toBe(1);
});

it("bounds the table so a rename wave cannot grow it without limit", () => {
  for (let i = 0; i < 6000; i++) {
    internDiffBaselineFile(`src/file-${i}.ts`, "abc123");
  }
  expect(internedDiffBaselineFileCount()).toBeLessThanOrEqual(4096);
  // The most recent path survives eviction.
  const last = internDiffBaselineFile("src/file-5999.ts", "abc123");
  expect(internDiffBaselineFile("src/file-5999.ts", "abc123")).toBe(last);
});

it("shares one record across entries parsed separately", () => {
  const baseline = () => ({
    sessionDiffBaseline: {
      files: [
        { fingerprint: "aaa", path: "src/a.ts" },
        { fingerprint: "bbb", path: "src/b.ts" },
      ],
      root: "/repo",
      sessionId: "s1",
      version: 1 as const,
    },
  });
  const first = baseline();
  const second = baseline();
  internSessionEntryDiffBaseline(first);
  internSessionEntryDiffBaseline(second);

  expect(first.sessionDiffBaseline.files[0]).toBe(second.sessionDiffBaseline.files[0]);
  expect(first.sessionDiffBaseline.files[1]).toBe(second.sessionDiffBaseline.files[1]);
  expect(first.sessionDiffBaseline.files).toEqual(baseline().sessionDiffBaseline.files);
  expect(internedDiffBaselineFileCount()).toBe(2);
});

it("freezes shared records so a stray write cannot leak across entries", () => {
  const entry = {
    sessionDiffBaseline: { files: [{ fingerprint: "aaa", path: "src/a.ts" }] },
  };
  internSessionEntryDiffBaseline(entry);
  expect(() => {
    (entry.sessionDiffBaseline.files[0] as { fingerprint: string }).fingerprint = "zzz";
  }).toThrow(TypeError);
});

it("leaves entries without a usable baseline untouched", () => {
  const withoutBaseline: { sessionDiffBaseline?: { files?: unknown } } = {};
  const withoutFiles = { sessionDiffBaseline: { files: undefined } };
  const notAnArray = { sessionDiffBaseline: { files: "src/a.ts" } };
  const ragged = {
    sessionDiffBaseline: {
      files: [
        null,
        "src/a.ts",
        { path: "src/b.ts" },
        { fingerprint: "ccc" },
        { fingerprint: 1, path: 2 },
      ],
    },
  };
  internSessionEntryDiffBaseline(withoutBaseline);
  internSessionEntryDiffBaseline(withoutFiles);
  internSessionEntryDiffBaseline(notAnArray);
  internSessionEntryDiffBaseline(ragged);
  expect(internedDiffBaselineFileCount()).toBe(0);
  expect(ragged.sessionDiffBaseline.files[2]).toEqual({ path: "src/b.ts" });
});
