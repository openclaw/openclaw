import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import {
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

describe("formatSidebarBuildSubtitle branch truncation", () => {
  const cases: Array<{
    name: string;
    info: ControlUiBuildInfo;
    expected: string | null;
  }> = [
    {
      name: "long branch does not split an emoji across the boundary",
      info: buildInfo({ branch: `${"a".repeat(13)}😀suffix` }),
      expected: "aaaaaaaaaaaaa…@e8cbc62",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(formatSidebarBuildSubtitle(testCase.info)).toBe(testCase.expected);
    });
  }
});

describe("formatSettingsBuildLabel", () => {
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

  it("suppresses build identity when the commit is missing", () => {
    expect(formatSidebarBuildSubtitle(buildInfo({ commit: null, commitAt: BUILT_AT }))).toBeNull();
  });
});
