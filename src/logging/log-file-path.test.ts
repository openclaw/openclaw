import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLegacyRollingLogFilePath,
  isSameRollingLogFileFamily,
  resolveConfiguredLogFilePath,
  resolveRollingLogFilePathForDate,
} from "./log-file-path.js";

const date = new Date(2026, 6, 22, 12, 0, 0);

describe("resolveConfiguredLogFilePath", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(date);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const resolveForProfile = (profile?: string) => {
    vi.stubEnv("OPENCLAW_PROFILE", profile);
    return resolveConfiguredLogFilePath();
  };

  it.each([
    [undefined, "openclaw"],
    ["Default", "openclaw"],
    ["dev", "openclaw-dev"],
    ["QA_Profile", "openclaw--1q-1a-0-1profile"],
  ])("uses the %s profile filename", (profile, prefix) => {
    expect(path.basename(resolveForProfile(profile))).toBe(`${prefix}-2026-07-22.log`);
  });

  it.each([
    ["qa-profile", "openclaw-qa--profile-2026-07-22.log"],
    ["-1q-1a-0-1profile", undefined],
  ])("keeps QA_Profile distinct from %s", (profile, expected) => {
    const other = resolveForProfile(profile);
    expect(resolveForProfile("QA_Profile")).not.toBe(other);
    if (expected) {
      expect(path.basename(other)).toBe(expected);
    }
  });

  it("bounds direct environment profiles that exceed the CLI length contract", () => {
    const first = resolveForProfile("A".repeat(80));
    const second = resolveForProfile("B".repeat(80));

    expect(path.basename(first)).toMatch(/^openclaw--3[a-f0-9]{64}-2026-07-22\.log$/u);
    expect(path.basename(first).length).toBeLessThanOrEqual(255);
    expect(first).not.toBe(second);
  });

  it("preserves an explicit logging.file override", () => {
    vi.stubEnv("OPENCLAW_PROFILE", "dev");
    expect(
      resolveConfiguredLogFilePath({ logging: { file: "/var/log/openclaw/custom.log" } }),
    ).toBe("/var/log/openclaw/custom.log");
  });
});

it.each([
  ["openclaw-dev-2026-07-22.log", "openclaw-dev-2026-07-23.log"],
  ["openclaw-YYYY-MM-DD.log", "openclaw-2026-07-23.log"],
])("advances %s while preserving its family", (before, after) => {
  expect(
    resolveRollingLogFilePathForDate(`/tmp/openclaw/${before}`, new Date(2026, 6, 23, 12)),
  ).toBe(`/tmp/openclaw/${after}`);
});

it("keeps default and named profile fallback families separate", () => {
  expect(
    isSameRollingLogFileFamily("openclaw-dev-2026-07-22.log", "openclaw-dev-2026-07-21.log"),
  ).toBe(true);
  expect(isSameRollingLogFileFamily("openclaw-dev-2026-07-22.log", "openclaw-2026-07-22.log")).toBe(
    false,
  );
});

it("keeps legacy explicit dated paths rolling without broadening the override contract", () => {
  expect(isLegacyRollingLogFilePath("openclaw-2026-07-22.log")).toBe(true);
  expect(isLegacyRollingLogFilePath("openclaw-YYYY-MM-DD.log")).toBe(true);
  expect(isLegacyRollingLogFilePath("openclaw-dev-2026-07-22.log")).toBe(false);
  expect(isLegacyRollingLogFilePath("openclaw-configured.log")).toBe(false);
});
