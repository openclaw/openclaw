import { describe, expect, it } from "vitest";
import { extractReleaseNotesSection } from "../scripts/render-github-release-notes.ts";

describe("extractReleaseNotesSection", () => {
  it("returns the requested changelog section body without the heading", () => {
    const changelog = `# Changelog

## 2026.3.9

### Changes

- Added mac workflow.

## 2026.3.8

### Fixes

- Older item.
`;

    expect(extractReleaseNotesSection(changelog, "2026.3.9")).toBe(`### Changes

- Added mac workflow.
`);
  });

  it("throws when the requested version is missing", () => {
    expect(() => extractReleaseNotesSection("# Changelog\n", "2026.3.9")).toThrow(
      "Version 2026.3.9 not found in CHANGELOG.md.",
    );
  });
});
