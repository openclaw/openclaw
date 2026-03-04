import { afterEach, describe, expect, it } from "vitest";
import { __test__ } from "./logger.js";

const { defaultRollingPathForToday, isRollingPath } = __test__;

describe("defaultRollingPathForToday", () => {
  const origProfile = process.env.OPENCLAW_PROFILE;
  afterEach(() => {
    if (origProfile === undefined) {
      delete process.env.OPENCLAW_PROFILE;
    } else {
      process.env.OPENCLAW_PROFILE = origProfile;
    }
  });

  it("produces default path when no profile is set", () => {
    delete process.env.OPENCLAW_PROFILE;
    const p = defaultRollingPathForToday();
    expect(p).toMatch(/openclaw-\d{4}-\d{2}-\d{2}\.log$/);
    expect(p).not.toContain("openclaw-xv-");
  });

  it("produces default path when profile is 'default'", () => {
    process.env.OPENCLAW_PROFILE = "default";
    const p = defaultRollingPathForToday();
    expect(p).toMatch(/openclaw-\d{4}-\d{2}-\d{2}\.log$/);
    expect(p).not.toContain("openclaw-default-");
  });

  it("includes profile tag when OPENCLAW_PROFILE is set", () => {
    process.env.OPENCLAW_PROFILE = "xv";
    const p = defaultRollingPathForToday();
    expect(p).toMatch(/openclaw-xv-\d{4}-\d{2}-\d{2}\.log$/);
  });
});

describe("isRollingPath", () => {
  it("matches default rolling path", () => {
    expect(isRollingPath("/tmp/openclaw/openclaw-2026-03-04.log")).toBe(true);
  });

  it("matches profile-specific rolling path", () => {
    expect(isRollingPath("/tmp/openclaw/openclaw-xv-2026-03-04.log")).toBe(true);
    expect(isRollingPath("/tmp/openclaw/openclaw-my-profile-2026-03-04.log")).toBe(true);
  });

  it("rejects non-rolling paths", () => {
    expect(isRollingPath("/tmp/openclaw/openclaw.log")).toBe(false);
    expect(isRollingPath("/tmp/openclaw/other-2026-03-04.log")).toBe(false);
  });
});
