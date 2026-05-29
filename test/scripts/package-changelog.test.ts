import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractCurrentPackageChangelog,
  preparePackageChangelog,
  resolvePackageChangelogVersions,
  restorePackageChangelog,
} from "../../scripts/package-changelog.mjs";

function changelog(strings: TemplateStringsArray, ...values: string[]) {
  const text = String.raw({ raw: strings }, ...values).replace(/^\n/u, "");
  const indents = Array.from(text.matchAll(/^( +)\S/gmu), (match) => match[1].length);
  const indent = indents.length ? Math.min(...indents) : 0;
  const lines = text
    .split("\n")
    .map((line) => line.slice(indent))
    .filter((line) => line.trim());
  return `${lines.join("\n\n")}\n`;
}

const cumulativeChangelog = changelog`
  # Changelog
  Docs: https://docs.openclaw.ai
  ## Unreleased
  ### Fixes
  - Pending note.
  ## 2026.5.28
  ### Highlights
  - Current highlight.
  ### Changes
  - Current change.
  ### Fixes
  - Current fix.
  ## 2026.5.27
  ### Highlights
  - Older highlight.
`;

describe("package-changelog", () => {
  it("maps release-channel package versions to package changelog candidate headings", () => {
    expect(resolvePackageChangelogVersions("2026.5.28")).toEqual(["2026.5.28"]);
    expect(resolvePackageChangelogVersions("2026.5.28-1")).toEqual(["2026.5.28-1"]);
    expect(resolvePackageChangelogVersions("2026.5.28-beta.1")).toEqual([
      "2026.5.28-beta.1",
      "2026.5.28",
      "Unreleased",
    ]);
    expect(resolvePackageChangelogVersions("2026.5.28-alpha.2")).toEqual([
      "2026.5.28-alpha.2",
      "2026.5.28",
      "Unreleased",
    ]);
  });

  it("extracts only the package version stable release section", () => {
    expect(extractCurrentPackageChangelog(cumulativeChangelog, "2026.5.28-beta.1")).toBe(
      changelog`
        # Changelog
        Docs: https://docs.openclaw.ai
        ## 2026.5.28
        ### Highlights
        - Current highlight.
        ### Changes
        - Current change.
        ### Fixes
        - Current fix.
      `,
    );
  });

  it("prefers an exact prerelease section when it exists", () => {
    const source = changelog`
      # Changelog
      ## 2026.5.28-beta.2
      - Beta 2.
      ## 2026.5.28
      - Stable.
    `;

    expect(extractCurrentPackageChangelog(source, "2026.5.28-beta.2")).toBe(changelog`
      # Changelog
      ## 2026.5.28-beta.2
      - Beta 2.
    `);
  });

  it("uses Unreleased only as a prerelease fallback when no release heading exists", () => {
    const source = changelog`
      # Changelog
      ## Unreleased
      - Pending beta.
      ## 2026.5.27
      - Older stable.
    `;

    expect(extractCurrentPackageChangelog(source, "2026.5.28-beta.1")).toBe(changelog`
      # Changelog
      ## Unreleased
      - Pending beta.
    `);
  });

  it("extracts exact correction release sections", () => {
    const source = changelog`
      # Changelog
      ## 2026.5.28-1
      - Correction.
      ## 2026.5.28
      - Stable.
    `;

    expect(extractCurrentPackageChangelog(source, "2026.5.28-1")).toBe(changelog`
      # Changelog
      ## 2026.5.28-1
      - Correction.
    `);
  });

  it("fails closed when package version has no matching release section", () => {
    expect(() => extractCurrentPackageChangelog(cumulativeChangelog, "2026.5.29")).toThrow(
      "CHANGELOG.md does not contain a release section for 2026.5.29.",
    );
  });

  it("fails closed when the packaged changelog is unexpectedly large", () => {
    const source = changelog`
      # Changelog
      ## 2026.5.28
      ${"é".repeat(260_000)}
    `;

    expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
      "exceeds the 512000 byte safety limit",
    );
  });

  it("prepares and restores the packaged changelog without changing the source permanently", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-package-changelog-"));
    try {
      writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.28-beta.1"}\n', "utf8");
      writeFileSync(path.join(root, "CHANGELOG.md"), cumulativeChangelog, "utf8");

      await expect(preparePackageChangelog(root)).resolves.toBe(true);
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toContain("## Unreleased");
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toContain("## 2026.5.27");
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain("## 2026.5.28");

      await expect(restorePackageChangelog(root)).resolves.toBe(true);
      expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(cumulativeChangelog);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
