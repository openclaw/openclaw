// Package Changelog tests cover package changelog script behavior.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderReleaseDocsMirror } from "../../scripts/lib/release-docs-mirror.mjs";
import {
  extractCurrentPackageChangelog,
  preparePackageChangelog,
  readCurrentPackageChangelog,
  resolvePackageChangelogVersions,
  restorePackageChangelog,
} from "../../scripts/package-changelog.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function changelog(strings: TemplateStringsArray, ...values: string[]) {
  return `${String.raw({ raw: strings }, ...values)
    .replace(/^\n/u, "")
    .trimEnd()}\n`;
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

const oversizedContributionRecord = `### Complete contribution record

${"- **PR #123** Thanks @contributor.\n".repeat(20_000)}`;
const oversizedChangelog = cumulativeChangelog.replace(
  "## 2026.5.27",
  `${oversizedContributionRecord}\n## 2026.5.27`,
);

describe("package-changelog", () => {
  it.each([1, 20_000])(
    "packages a %i-paragraph docs mirror and restores every source artifact",
    async (paragraphs) => {
      const root = tempDirs.make("openclaw-package-changelog-mirror-");
      const version = "2026.5.28";
      const docsPath = `docs/releases/${version}.md`;
      const entryPath = `CHANGELOG/${version}.md`;
      const recordPath = `CHANGELOG/records/${version}.md`;
      const index = `# Changelog\n\n- [${version}](${entryPath})\n`;
      const docs = `# Release notes\n\n${"Complete release documentation.\n\n".repeat(paragraphs)}Final release detail.\n`;
      const record = `## ${version}\n\n### Complete contribution record\n\n- **PR #123** Thanks @contributor.\n`;
      mkdirSync(path.join(root, "docs", "releases"), { recursive: true });
      mkdirSync(path.join(root, "CHANGELOG", "records"), { recursive: true });
      writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ version })}\n`);
      writeFileSync(path.join(root, docsPath), docs);
      const mirror = renderReleaseDocsMirror({ rootDir: root, version, sources: [docsPath] });
      const sources = new Map([
        ["CHANGELOG.md", index],
        [docsPath, docs],
        [entryPath, mirror],
        [recordPath, record],
      ]);
      for (const [file, content] of sources) {
        writeFileSync(path.join(root, file), content);
      }
      await expect(preparePackageChangelog(root)).resolves.toBe(true);
      const packaged = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
      expect(packaged).toContain(`## ${version}`);
      if (paragraphs === 1) {
        expect(packaged).toBe(`# Changelog\n\n${mirror.trimEnd()}\n`);
      } else {
        expect(Buffer.byteLength(mirror)).toBeGreaterThan(500 * 1024);
        expect(packaged).toContain(`https://github.com/openclaw/openclaw/blob/main/${entryPath}`);
        expect(packaged).toContain(
          `https://github.com/openclaw/openclaw/raw/refs/heads/main/${entryPath}`,
        );
        expect(packaged).toContain(`https://github.com/openclaw/openclaw/blob/main/${recordPath}`);
        expect(packaged).toContain(`https://docs.openclaw.ai/releases/${version}`);
        expect(packaged).not.toContain(`/v${version}/`);
      }
      expect(Buffer.byteLength(packaged)).toBeLessThanOrEqual(500 * 1024);

      await expect(restorePackageChangelog(root)).resolves.toBe(true);
      for (const [file, content] of sources) {
        expect(readFileSync(path.join(root, file), "utf8")).toBe(content);
      }
    },
  );

  it("packages only a split release, pins its record, and restores the index after source edits", async () => {
    const root = tempDirs.make("openclaw-package-changelog-split-");
    const index = "# Changelog\n\n- [2026.5.28](CHANGELOG/2026.5.28.md)\n";
    const section = `## 2026.5.28\n\n- Complete editorial notes and credit. Thanks @contributor.\n\n${oversizedContributionRecord}\n`;
    mkdirSync(path.join(root, "CHANGELOG", "records"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.28-beta.1"}\n');
    writeFileSync(path.join(root, "CHANGELOG.md"), index);
    writeFileSync(path.join(root, "CHANGELOG", "2026.5.28.md"), section);
    writeFileSync(
      path.join(root, "CHANGELOG", "records", "2026.5.28.md"),
      `## 2026.5.28\n\n${oversizedContributionRecord}\n`,
    );
    writeFileSync(path.join(root, "CHANGELOG", "2026.5.27.md"), "## 2026.5.27\n\n- Old history.\n");

    await expect(preparePackageChangelog(root)).resolves.toBe(true);
    const packaged = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(packaged).toContain("Complete editorial notes and credit.");
    expect(packaged).toContain("/blob/v2026.5.28-beta.1/CHANGELOG/records/2026.5.28.md");
    expect(packaged).not.toContain("Old history");
    expect(Buffer.byteLength(packaged)).toBeLessThanOrEqual(500 * 1024);

    writeFileSync(
      path.join(root, "CHANGELOG", "2026.5.28.md"),
      `${section}\n- Later source edit.\n`,
    );
    await expect(restorePackageChangelog(root)).resolves.toBe(true);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(index);
    expect(readFileSync(path.join(root, "CHANGELOG", "2026.5.28.md"), "utf8")).toContain(
      "Later source edit",
    );
  });

  it("keeps split prerelease fallback and rejects unsafe exact notes", () => {
    const root = tempDirs.make("openclaw-package-changelog-split-");
    mkdirSync(path.join(root, "CHANGELOG"));
    writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n");
    writeFileSync(
      path.join(root, "CHANGELOG", "2026.5.30.md"),
      "## 2026.5.30 (Unreleased)\n\n- Pending release notes with sufficient detail.\n",
    );
    expect(readCurrentPackageChangelog(root, "2026.5.28-beta.1")).toContain(
      "Pending release notes",
    );
    expect(() => readCurrentPackageChangelog(root, "2026.5.28")).toThrow(
      "does not contain a release section",
    );
    writeFileSync(path.join(root, "CHANGELOG", "2026.5.28.md"), "## 2026.5.28\n- Tiny.\n");
    expect(() => readCurrentPackageChangelog(root, "2026.5.28-beta.1")).toThrow(
      "only 7 body bytes",
    );
  });

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
    expect(resolvePackageChangelogVersions("2026.5.29", { allowUnreleased: true })).toEqual([
      "2026.5.29",
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
- Beta 2 package notes with enough release detail.
## 2026.5.28
- Stable.
`;

    expect(extractCurrentPackageChangelog(source, "2026.5.28-beta.2")).toBe(changelog`
# Changelog

## 2026.5.28-beta.2
- Beta 2 package notes with enough release detail.
`);
  });

  it.each(["Unreleased", "2026.5.30 (Unreleased)"])(
    "uses %s only as a prerelease fallback when no release heading exists",
    (heading) => {
      const source = changelog`
# Changelog
## ${heading}
- Pending beta package notes with enough release detail.
## 2026.5.27
- Older stable.
`;

      expect(extractCurrentPackageChangelog(source, "2026.5.28-beta.1")).toBe(changelog`
# Changelog

## ${heading}
- Pending beta package notes with enough release detail.
`);
    },
  );

  it("extracts exact correction release sections", () => {
    const source = changelog`
# Changelog
## 2026.5.28-1
- Correction release notes with enough detail.
## 2026.5.28
- Stable.
`;

    expect(extractCurrentPackageChangelog(source, "2026.5.28-1")).toBe(changelog`
# Changelog

## 2026.5.28-1
- Correction release notes with enough detail.
`);
  });

  it.each(["Unreleased", "2026.5.30 (Unreleased)", "2026.5.30 (Release notes)"])(
    "fails closed without a matching release section even with %s notes",
    (heading) => {
      const source = cumulativeChangelog.replace("## Unreleased", `## ${heading}`);
      expect(() => extractCurrentPackageChangelog(source, "2026.5.29")).toThrow(
        "CHANGELOG.md does not contain a release section for 2026.5.29.",
      );
    },
  );

  it.each(["Unreleased", "2026.5.30 (Unreleased)"])(
    "allows %s notes for explicitly non-publish stable artifacts",
    (heading) => {
      const unreleasedChangelog = cumulativeChangelog
        .replace("## Unreleased", `## ${heading}`)
        .replace("- Pending note.", "- Pending release note with enough detail.");
      expect(
        extractCurrentPackageChangelog(unreleasedChangelog, "2026.5.29", {
          allowUnreleased: true,
        }),
      ).toBe(changelog`
# Changelog
Docs: https://docs.openclaw.ai

## ${heading}
### Fixes
- Pending release note with enough detail.
`);
    },
  );

  it.each(["Unreleased", "2026.5.30 (Unreleased)"])(
    "does not fall back to %s when exact non-publish notes fail safety checks",
    (heading) => {
      const source = changelog`
# Changelog
## ${heading}
- Pending development package notes with enough release detail.
## 2026.5.29
- Tiny.
## 2026.5.28
- Older stable release notes with enough detail.
`;

      expect(() =>
        extractCurrentPackageChangelog(source, "2026.5.29", { allowUnreleased: true }),
      ).toThrow("Packaged changelog section for 2026.5.29 is only 7 body bytes");
    },
  );

  it.each(["", oversizedContributionRecord])(
    "refuses oversized editorial notes even with a contribution record (%#)",
    (record) => {
      const source = changelog`
# Changelog
## 2026.5.28
${"é".repeat(260_000)}
${record}
`;

      expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
        "exceeds the 512000 byte safety limit",
      );
    },
  );

  it.each(["2026.5.28", "2026.5.28-beta.1", "2026.5.28-alpha.2", "2026.5.28-1"])(
    "compacts only an oversized contribution record and pins the exact %s tag",
    (version) => {
      const editorial = `## ${version}\n\n### Fixes\n\n- Preserve this complete user-facing note and credit. Thanks @contributor.`;
      const source = `# Changelog\n\n${editorial}\n\n${oversizedContributionRecord}\n`;
      const packaged = extractCurrentPackageChangelog(source, version);
      expect(packaged).toBe(
        `# Changelog\n\n${editorial}\n\n### Complete contribution record\n\nThe full contribution record is available in the tag-pinned [CHANGELOG.md](https://github.com/openclaw/openclaw/blob/v${version}/CHANGELOG.md#complete-contribution-record).\n`,
      );
    },
  );

  it("does not use the generated contribution link to satisfy the release-note minimum", () => {
    const source = `# Changelog\n\n## 2026.5.28\n\n### Fixes\n\n${oversizedContributionRecord}\n`;
    expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
      "below the 32 byte safety minimum",
    );
  });

  it("fails closed when the extracted release section is effectively empty", () => {
    const source = changelog`
# Changelog
Docs: https://docs.openclaw.ai
## 2026.5.28
### Fixes
## 2026.5.27
- Older stable release notes with enough detail.
`;

    expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
      "below the 32 byte safety minimum",
    );
  });

  it.each([cumulativeChangelog, oversizedChangelog])(
    "prepares and restores all source notes and credits (%#)",
    async (sourceChangelog) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-package-changelog-"));
      try {
        writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.28-beta.1"}\n', "utf8");
        writeFileSync(path.join(root, "CHANGELOG.md"), sourceChangelog, "utf8");

        await expect(preparePackageChangelog(root)).resolves.toBe(true);
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toContain(
          "## Unreleased",
        );
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toContain("## 2026.5.27");
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain("## 2026.5.28");

        await expect(restorePackageChangelog(root)).resolves.toBe(true);
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(sourceChangelog);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["Unreleased", "2026.5.30 (Unreleased)"])(
    "recovers interrupted %s QA packaging with the default restore path",
    async (heading) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-package-changelog-"));
      const unreleasedChangelog = cumulativeChangelog
        .replace("## Unreleased", `## ${heading}`)
        .replace("- Pending note.", "- Pending release note with enough detail.");
      try {
        writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.29"}\n', "utf8");
        writeFileSync(path.join(root, "CHANGELOG.md"), unreleasedChangelog, "utf8");

        await expect(preparePackageChangelog(root, { allowUnreleased: true })).resolves.toBe(true);
        // Older published packers retained only the source backup.
        rmSync(path.join(root, ".artifacts", "package-changelog", "CHANGELOG.md.packaged"));
        await expect(restorePackageChangelog(root)).resolves.toBe(true);
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(unreleasedChangelog);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([cumulativeChangelog, oversizedChangelog])(
    "refuses to restore over edits after package preparation (%#)",
    async (sourceChangelog) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-package-changelog-"));
      const backupPath = path.join(
        root,
        ".artifacts",
        "package-changelog",
        "CHANGELOG.md.prepack-backup",
      );

      try {
        writeFileSync(path.join(root, "package.json"), '{"version":"2026.5.28-beta.1"}\n', "utf8");
        writeFileSync(path.join(root, "CHANGELOG.md"), sourceChangelog, "utf8");
        await preparePackageChangelog(root);
        const editedChangelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8").replace(
          "- Current fix.",
          "- Current fix edited.",
        );
        writeFileSync(path.join(root, "CHANGELOG.md"), editedChangelog, "utf8");

        await expect(restorePackageChangelog(root)).rejects.toThrow(
          "Refusing to restore packaged changelog backup",
        );
        expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(editedChangelog);
        expect(existsSync(backupPath)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
