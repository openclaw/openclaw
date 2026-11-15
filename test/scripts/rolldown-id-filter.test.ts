import { describe, expect, it } from "vitest";
import { directoryIdFilter, exactIdFilter } from "../../scripts/lib/rolldown-id-filter.mts";

describe("rolldown id filters", () => {
  it("matches the forward-slash ids Rolldown reports for Windows paths", () => {
    const exact = exactIdFilter("C:\\openclaw\\src\\state\\schema.ts").id;
    expect(exact.test("C:/openclaw/src/state/schema.ts")).toBe(true);
    expect(exact.test("C:/openclaw/src/state/schema.tsx")).toBe(false);

    const directory = directoryIdFilter("C:\\openclaw\\src\\assets", /[^/]+\.png/u).id;
    expect(directory.test("C:/openclaw/src/assets/icon.png")).toBe(true);
    expect(directory.test("C:/openclaw/src/assets/nested/icon.png")).toBe(false);
  });

  it("matches POSIX ids exactly and escapes regex characters", () => {
    const exact = exactIdFilter("/repo/a+b.ts", "/repo/c.ts").id;
    expect(exact.test("/repo/a+b.ts")).toBe(true);
    expect(exact.test("/repo/aab.ts")).toBe(false);
    expect(exact.test("/repo/c.ts")).toBe(true);
  });
});
