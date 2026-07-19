// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildSessionsCsv } from "./query.ts";
import type { UsageSessionEntry } from "./types.ts";

describe("usage query CSV export", () => {
  it("omits invalid session updated timestamps instead of throwing", () => {
    const csv = buildSessionsCsv([
      {
        key: "session-1",
        label: "Session 1",
        updatedAt: Number.POSITIVE_INFINITY,
        usage: null,
      } satisfies UsageSessionEntry,
    ]);

    expect(csv).toContain("session-1,Session 1,,,,,,,,,,,,,,,");
  });

  it.each([
    ['=HYPERLINK("https://evil.example","click")', "'=HYPERLINK"],
    ["+1+1", "'+1+1"],
    ["-10", "'-10"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\t=1+1", "'\t=1+1"],
    ["  =1+1", "'  =1+1"],
    ["\uFF1D1+1", "'\uFF1D1+1"],
    ["\n=1+1", '"\'\n=1+1"'],
  ])("neutralizes spreadsheet formula prefix in session label %j", (label, prefix) => {
    const csv = buildSessionsCsv([
      {
        key: "session-1",
        label,
        updatedAt: 0,
        usage: null,
      } satisfies UsageSessionEntry,
    ]);

    expect(csv).toContain(prefix);
  });

  it.each([
    ["\tnotes", "\tnotes"],
    ["  plain text", "  plain text"],
  ])("preserves whitespace-prefixed plain label %j byte-for-byte", (label, expected) => {
    const csv = buildSessionsCsv([
      {
        key: "session-1",
        label,
        updatedAt: 0,
        usage: null,
      } satisfies UsageSessionEntry,
    ]);

    expect(csv.split("\n")[1]).toContain(`,${expected},`);
  });

  it("quotes but does not neutralize a CR-prefixed plain label", () => {
    const csv = buildSessionsCsv([
      {
        key: "session-1",
        label: "\rnotes",
        updatedAt: 0,
        usage: null,
      } satisfies UsageSessionEntry,
    ]);

    expect(csv.split("\n")[1]).toContain(',"\rnotes",');
  });

  it("quotes carriage returns so a bare CR cannot split a row", () => {
    const csv = buildSessionsCsv([
      {
        key: "session-1",
        label: "line1\rline2",
        updatedAt: 0,
        usage: null,
      } satisfies UsageSessionEntry,
    ]);

    expect(csv.split("\n")[1]).toContain('"line1\rline2"');
  });
});
