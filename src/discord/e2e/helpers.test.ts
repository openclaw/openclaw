import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SHARED_NAMES_FILE = path.join(os.tmpdir(), "openclaw-e2e-channel-names.txt");
const SHARED_NAMES_LOCK = SHARED_NAMES_FILE + ".lock";

// Each test needs a fresh module to reset the generatedNames Set.
async function freshImport() {
  const mod = await import("./helpers.js");
  return mod.e2eChannelName;
}

function cleanSharedState() {
  try {
    fs.unlinkSync(SHARED_NAMES_FILE);
  } catch {
    // File doesn't exist, that's fine.
  }
  try {
    fs.rmdirSync(SHARED_NAMES_LOCK);
  } catch {
    // Lock doesn't exist, that's fine.
  }
}

describe("e2eChannelName", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    cleanSharedState();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanSharedState();
  });

  it("returns the expected timestamp format", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 14, 5, 9));
    const e2eChannelName = await freshImport();

    expect(e2eChannelName()).toBe("e2e-2026-02-22-t-14-05-09");
  });

  it("returns unchanged name when no clash exists", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-22-t-09-00-00"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-22-t-10-30-00");
  });

  it("increments seconds on a single clash", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-22-t-10-30-00"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-22-t-10-30-01");
  });

  it("skips through multiple consecutive clashes", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();
    const existing = new Set([
      "e2e-2026-02-22-t-10-30-00",
      "e2e-2026-02-22-t-10-30-01",
      "e2e-2026-02-22-t-10-30-02",
    ]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-22-t-10-30-03");
  });

  it("rolls seconds into next minute", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-22-t-10-30-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-22-t-10-31-00");
  });

  it("rolls minutes into next hour", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-22-t-10-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-22-t-11-00-00");
  });

  it("rolls hours into next day", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 23, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-22-t-23-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-23-t-00-00-00");
  });

  it("rolls day across month boundary", async () => {
    // Jan 31 at 23:59:59 → Feb 1
    vi.setSystemTime(new Date(2026, 0, 31, 23, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-01-31-t-23-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-01-t-00-00-00");
  });

  it("rolls day across year boundary", async () => {
    // Dec 31 at 23:59:59 → Jan 1 of next year
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-12-31-t-23-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2027-01-01-t-00-00-00");
  });

  it("handles leap day rollover", async () => {
    // Feb 28 2028 (leap year) at 23:59:59 → Feb 29
    vi.setSystemTime(new Date(2028, 1, 28, 23, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2028-02-28-t-23-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2028-02-29-t-00-00-00");
  });

  it("handles non-leap year Feb 28 rollover", async () => {
    // Feb 28 2026 (not a leap year) at 23:59:59 → Mar 1
    vi.setSystemTime(new Date(2026, 1, 28, 23, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-28-t-23-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-03-01-t-00-00-00");
  });

  it("tracks generated names across consecutive calls", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();

    const first = e2eChannelName();
    const second = e2eChannelName();
    const third = e2eChannelName();

    expect(first).toBe("e2e-2026-02-22-t-10-30-00");
    expect(second).toBe("e2e-2026-02-22-t-10-30-01");
    expect(third).toBe("e2e-2026-02-22-t-10-30-02");
  });

  it("merges existing names with previously generated names", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();

    // First call takes 10:30:00.
    const first = e2eChannelName();
    expect(first).toBe("e2e-2026-02-22-t-10-30-00");

    // Second call with an existing name at 10:30:01 must skip past
    // both the generated 10:30:00 and the existing 10:30:01.
    const second = e2eChannelName(new Set(["e2e-2026-02-22-t-10-30-01"]));
    expect(second).toBe("e2e-2026-02-22-t-10-30-02");
  });

  it("simulates rapid 10-channel creation like multi-tool-feedback", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();
    const names: string[] = [];

    for (let i = 0; i < 10; i++) {
      names.push(e2eChannelName());
    }

    // All names are unique.
    expect(new Set(names).size).toBe(10);

    // They are sequential seconds starting from 10:30:00.
    for (let i = 0; i < 10; i++) {
      const ss = String(i).padStart(2, "0");
      expect(names[i]).toBe(`e2e-2026-02-22-t-10-30-${ss}`);
    }
  });

  it("persists names to shared file for cross-worker visibility", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();

    e2eChannelName();
    e2eChannelName();

    const content = fs.readFileSync(SHARED_NAMES_FILE, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toEqual(["e2e-2026-02-22-t-10-30-00", "e2e-2026-02-22-t-10-30-01"]);
  });

  it("reads shared file to avoid names claimed by other workers", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));

    // Simulate another worker having already claimed 10:30:00.
    fs.writeFileSync(SHARED_NAMES_FILE, "e2e-2026-02-22-t-10-30-00\n");

    const e2eChannelName = await freshImport();

    expect(e2eChannelName()).toBe("e2e-2026-02-22-t-10-30-01");
  });
});
