import { describe, expect, it } from "vitest";
import { insertUnreleasedChangelogEntry } from "../../scripts/changelog-add.ts";

const SAMPLE = `# Changelog

## 2026.2.24 (Unreleased)

### Changes

- Existing change.

### Fixes

- Existing fix.

## 2026.2.23

### Changes

- Older entry.
`;

describe("changelog-add", () => {
  it("inserts a new unreleased fixes entry before the next version section", () => {
    const next = insertUnreleasedChangelogEntry(
      SAMPLE,
      "fixes",
      "New fix entry. (#123) Thanks @someone.",
    );
    expect(next).toContain(
      "- Existing fix.\n- New fix entry. (#123) Thanks @someone.\n\n## 2026.2.23",
    );
  });

  it("normalizes missing bullet prefix", () => {
    const next = insertUnreleasedChangelogEntry(SAMPLE, "changes", "New change.");
    expect(next).toContain("- Existing change.\n- New change.\n\n### Fixes");
  });

  it("does not duplicate identical entry", () => {
    const once = insertUnreleasedChangelogEntry(SAMPLE, "fixes", "New fix.");
    const twice = insertUnreleasedChangelogEntry(once, "fixes", "New fix.");
    expect(twice).toBe(once);
  });
});
