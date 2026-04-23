import { describe, expect, it } from "vitest";
import { appendUnreleasedChangelogEntry } from "./changelog-unreleased.js";

const baseChangelog = `# Changelog

## Unreleased

### Breaking

- Existing breaking entry.

### Changes

- Existing change.

### Fixes

- Existing fix.

## 2026.4.5
`;

describe("appendUnreleasedChangelogEntry", () => {
  it("appends to the end of the requested unreleased section", () => {
    const next = appendUnreleasedChangelogEntry(baseChangelog, {
      section: "Fixes",
      entry: "New fix entry.",
    });

    expect(next).toContain(`### Fixes

- Existing fix.
- New fix entry.`);
    expect(next).toContain("## 2026.4.5");
  });

  it("avoids duplicating an existing entry", () => {
    const next = appendUnreleasedChangelogEntry(baseChangelog, {
      section: "Changes",
      entry: "- Existing change.",
    });

    expect(next).toBe(baseChangelog);
  });

  it("throws when the unreleased section is missing", () => {
    expect(() =>
      appendUnreleasedChangelogEntry("# Changelog\n", {
        section: "Fixes",
        entry: "New fix entry.",
      }),
    ).toThrow("## Unreleased");
  });
});
