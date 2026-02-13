import { describe, expect, it } from "vitest";
import {
  buildBehaviorDiff,
  getPreviousBehaviorHint,
  normalizeVersionArg,
  parseChangelogReleases,
} from "./behavior-diff.js";

const CHANGELOG_SAMPLE = `# Changelog

## 2026.2.12

### Changes

- CLI: add local-time log output.

### Fixes

- Gateway: prevent dropped turns on restart.

## 2026.2.9

### Added

- IRC channel support.

### Fixes

- Telegram: harden quote parsing.
`;

describe("behavior-diff", () => {
  it("normalizes version args", () => {
    expect(normalizeVersionArg("v2026.2.12")).toBe("2026.2.12");
    expect(normalizeVersionArg("2026.2.12")).toBe("2026.2.12");
    expect(normalizeVersionArg("bad")).toBeNull();
  });

  it("parses releases and sections from changelog", () => {
    const releases = parseChangelogReleases(CHANGELOG_SAMPLE);
    expect(releases).toHaveLength(2);
    expect(releases[0]?.version).toBe("2026.2.12");
    expect(releases[0]?.sections[0]?.title).toBe("Changes");
    expect(releases[0]?.sections[0]?.items[0]).toContain("local-time");
    expect(releases[0]?.sections[1]?.title).toBe("Fixes");
  });

  it("builds an upgrade diff range", () => {
    const diff = buildBehaviorDiff({
      changelog: CHANGELOG_SAMPLE,
      fromVersion: "2026.2.9",
      toVersion: "2026.2.12",
    });
    expect(diff.direction).toBe("upgrade");
    expect(diff.releases.map((entry) => entry.version)).toEqual(["2026.2.12"]);
  });

  it("returns section-specific previous behavior hints", () => {
    expect(getPreviousBehaviorHint("Fixes")).toContain("bug");
    expect(getPreviousBehaviorHint("Added")).toContain("missing");
    expect(getPreviousBehaviorHint("Breaking")).toContain("Legacy");
    expect(getPreviousBehaviorHint("Changes")).toContain("differently");
  });
});
