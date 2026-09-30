import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import {
  formatBuildChipText,
  formatSettingsBuildLabel,
  formatSidebarBuildSubtitle,
} from "./sidebar-build-chip-format.ts";

const COMMIT = "e8cbc62f0123456789abcdef0123456789abcdef";
const BUILT_AT = "2026-07-10T12:00:00.000Z";
const NOW = new Date("2026-07-10T16:00:00.000Z");

function buildInfo(overrides: Partial<ControlUiBuildInfo> = {}): ControlUiBuildInfo {
  return {
    version: "2026.7.10",
    commit: COMMIT,
    commitAt: null,
    builtAt: BUILT_AT,
    branch: "main",
    dirty: false,
    release: false,
    buildId: "test",
    ...overrides,
  };
}

describe("formatBuildChipText", () => {
  const cases: Array<{
    name: string;
    info: ControlUiBuildInfo;
    expected: string | null;
  }> = [
    {
      name: "long branch keeps an emoji that fits exactly at the boundary",
      info: buildInfo({ branch: `${"a".repeat(12)}😀suffix` }),
      expected: "aaaaaaaaaaaa😀…@e8cbc62",
    },
    {
      name: "long branch does not split an emoji across the boundary",
      info: buildInfo({ branch: `${"a".repeat(13)}😀suffix` }),
      expected: "aaaaaaaaaaaaa…@e8cbc62",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(formatBuildChipText(testCase.info)).toBe(testCase.expected);
    });
  }
});

describe("formatSettingsBuildLabel", () => {
  it("keeps official release artifacts version-only", () => {
    expect(formatSettingsBuildLabel(buildInfo({ release: true }), "2026.7.9")).toBe("2026.7.10");
  });

  it("adds branch and dirty provenance for development builds", () => {
    expect(formatSettingsBuildLabel(buildInfo({ branch: "feat/x", dirty: true }), "2026.7.9")).toBe(
      "2026.7.10 · feat/x@e8cbc62*",
    );
  });

  it("falls back to the Gateway version when artifact metadata is unavailable", () => {
    expect(
      formatSettingsBuildLabel(
        buildInfo({ version: null, commit: null, branch: null, dirty: null }),
        "2026.7.9",
      ),
    ).toBe("2026.7.9");
  });

  it("keeps detached clean source builds distinguishable from releases", () => {
    expect(formatSettingsBuildLabel(buildInfo({ branch: null, dirty: false }), "2026.7.9")).toBe(
      "2026.7.10 · git@e8cbc62",
    );
  });
});

describe("formatSidebarBuildSubtitle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats a detached source build with commit age", () => {
    expect(formatSidebarBuildSubtitle(buildInfo({ branch: null, commitAt: BUILT_AT }))).toBe(
      "git@e8cbc62 · 4h ago",
    );
  });

  it("includes branch and dirty state with commit age", () => {
    expect(
      formatSidebarBuildSubtitle(buildInfo({ branch: "feat/x", dirty: true, commitAt: BUILT_AT })),
    ).toBe("feat/x@e8cbc62* · 4h ago");
  });

  it.each([null, "not-a-timestamp"])("keeps the Git identity when commitAt is %s", (commitAt) => {
    expect(formatSidebarBuildSubtitle(buildInfo({ commitAt }))).toBe("git@e8cbc62");
  });

  it("suppresses build identity when the commit is missing", () => {
    expect(formatSidebarBuildSubtitle(buildInfo({ commit: null, commitAt: BUILT_AT }))).toBeNull();
  });
});
