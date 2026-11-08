import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderReleaseDocsMirror } from "../../scripts/lib/release-docs-mirror.mjs";
import {
  extractCurrentPackageChangelog,
  preparePackageChangelog,
  readCurrentPackageChangelog,
  restorePackageChangelog,
} from "../../scripts/package-changelog.mjs";
import { withEnv } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const notes = (version: string, body: string) => `## ${version}\n${body}\n`;
const current = notes("2026.5.28", "- Current fix.\n- Complete editorial release notes.");
const cumulativeChangelog = `# Changelog\nDocs: https://docs.openclaw.ai\n${notes("Unreleased", "- Pending note.")}${current}${notes("2026.5.27", "- Older highlight.")}`;
const largeRecord = `### Complete contribution record\n\n${"- **PR #123** Thanks @contributor.\n".repeat(20_000)}`;
const oversizedChangelog = cumulativeChangelog.replace(current, `${current}${largeRecord}\n`);

function makeChangelog(source = oversizedChangelog, version = "2026.5.28-beta.1") {
  const root = tempDirs.make("openclaw-package-changelog-");
  const write = (file: string, content: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const read = (file = "CHANGELOG.md") => readFileSync(path.join(root, file), "utf8");
  write("package.json", `${JSON.stringify({ version })}\n`);
  write("CHANGELOG.md", source);
  return { root, write, read };
}

describe("package-changelog", () => {
  it.each([1, 20_000])("packages and restores a %i-paragraph docs mirror", async (paragraphs) => {
    const version = "2026.5.28";
    const docsPath = `docs/releases/${version}.md`;
    const entryPath = `CHANGELOG/${version}.md`;
    const recordPath = `CHANGELOG/records/${version}.md`;
    const index = `# Changelog\n\n- [${version}](${entryPath})\n`;
    const docs = `# Release notes\n\n${"Complete release documentation.\n\n".repeat(paragraphs)}Final release detail.\n`;
    const record = `## ${version}\n\n### Complete contribution record\n\n- **PR #123** Thanks @contributor.\n`;
    const { root, write, read } = makeChangelog(index, version);
    write(docsPath, docs);
    const mirror = renderReleaseDocsMirror({ rootDir: root, version, sources: [docsPath] });
    const sources = new Map([
      ["CHANGELOG.md", index],
      [docsPath, docs],
      [entryPath, mirror],
      [recordPath, record],
    ]);
    for (const [file, content] of sources) {
      write(file, content);
    }
    await expect(preparePackageChangelog(root)).resolves.toBe(true);
    const packaged = read();
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
      expect(read(file)).toBe(content);
    }
  });

  it("packages only a split release, pins its record, and restores the index after source edits", async () => {
    const index = "# Changelog\n\n- [2026.5.28](CHANGELOG/2026.5.28.md)\n";
    const section = `## 2026.5.28\n\n- Complete editorial notes and credit. Thanks @contributor.\n\n${largeRecord}\n`;
    const { root, write, read } = makeChangelog(index);
    write("CHANGELOG/2026.5.28.md", section);
    write("CHANGELOG/records/2026.5.28.md", `## 2026.5.28\n\n${largeRecord}\n`);
    write("CHANGELOG/2026.5.27.md", "## 2026.5.27\n\n- Old history.\n");

    await expect(preparePackageChangelog(root)).resolves.toBe(true);
    const packaged = read();
    expect(packaged).toContain("Complete editorial notes and credit.");
    expect(packaged).toContain("/blob/v2026.5.28-beta.1/CHANGELOG/records/2026.5.28.md");
    expect(packaged).not.toContain("Old history");
    expect(Buffer.byteLength(packaged)).toBeLessThanOrEqual(500 * 1024);

    write("CHANGELOG/2026.5.28.md", `${section}\n- Later source edit.\n`);
    await expect(restorePackageChangelog(root)).resolves.toBe(true);
    expect(read()).toBe(index);
    expect(read("CHANGELOG/2026.5.28.md")).toContain("Later source edit");
  });

  it("keeps split prerelease fallback and rejects unsafe exact notes", () => {
    const { root, write } = makeChangelog("# Changelog\n");
    write(
      "CHANGELOG/2026.5.30.md",
      "## 2026.5.30 (Unreleased)\n\n- Pending release notes with sufficient detail.\n",
    );
    expect(readCurrentPackageChangelog(root, "2026.5.28-beta.1")).toContain(
      "Pending release notes",
    );
    expect(() => readCurrentPackageChangelog(root, "2026.5.28")).toThrow(
      "does not contain a release section",
    );
    write("CHANGELOG/2026.5.28.md", "## 2026.5.28\n- Tiny.\n");
    expect(() => readCurrentPackageChangelog(root, "2026.5.28-beta.1")).toThrow(
      "only 7 body bytes",
    );
  });

  it.each(["2026.5.28-beta.2", "2026.5.28-1"])("prefers exact %s notes", (version) => {
    const selected = notes(version, "- Package notes with enough release detail.");
    const source = `# Changelog\n${selected}${notes("2026.5.28", "- Stable.")}`;
    expect(extractCurrentPackageChangelog(source, version)).toBe(`# Changelog\n\n${selected}`);
  });

  it.each(["Unreleased", "2026.5.30 (Unreleased)", "2026.5.30 (Release notes)"])(
    "rejects a missing release below %s notes",
    (heading) => {
      const source = cumulativeChangelog.replace("## Unreleased", `## ${heading}`);
      expect(() => extractCurrentPackageChangelog(source, "2026.5.29")).toThrow(
        "CHANGELOG.md does not contain a release section for 2026.5.29.",
      );
    },
  );

  it("rejects unsafe exact notes instead of falling back to drafts", () => {
    const source = `# Changelog\n${notes("2026.5.30 (Unreleased)", "- Pending development package notes with enough release detail.")}${notes("2026.5.29", "- Tiny.")}${current}`;
    expect(() =>
      extractCurrentPackageChangelog(source, "2026.5.29", { allowUnreleased: true }),
    ).toThrow("Packaged changelog section for 2026.5.29 is only 7 body bytes");
  });

  it("excludes the generated record link from the editorial minimum", () => {
    const source = `# Changelog\n\n## 2026.5.28\n\n### Fixes\n\n${largeRecord}\n`;
    expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
      "below the 32 byte safety minimum",
    );
  });

  it.each(["", largeRecord])(
    "bounds oversized editorial notes locally and in CI (%#)",
    (record) => {
      const source = `# Changelog\n${notes("2026.5.28", `${"é".repeat(260_000)}\n${record}`)}`;

      const output = vi.spyOn(console, "error").mockImplementation(() => {});
      withEnv({ GITHUB_ACTIONS: undefined, GITHUB_STEP_SUMMARY: undefined }, () => {
        expect(() => extractCurrentPackageChangelog(source, "2026.5.28")).toThrow(
          "exceeds the 512000 byte size limit",
        );
      });
      output.mockClear();
      withEnv({ GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: undefined }, () => {
        expect(extractCurrentPackageChangelog(source, "2026.5.28")).toContain("é".repeat(260_000));
      });
      expect(output).toHaveBeenCalledWith(expect.stringContaining("::warning file=CHANGELOG.md,"));
    },
  );

  it.each([false, true])("restores unchanged notes and rejects edits (%s)", async (edited) => {
    const { root, read, write } = makeChangelog();

    await expect(preparePackageChangelog(root)).resolves.toBe(true);
    const packaged = read();
    expect(packaged).not.toContain("## Unreleased");
    expect(packaged).not.toContain("## 2026.5.27");
    expect(packaged).toContain("## 2026.5.28");
    expect(packaged).toContain(
      "https://github.com/openclaw/openclaw/blob/v2026.5.28-beta.1/CHANGELOG.md#complete-contribution-record",
    );

    if (edited) {
      const editedChangelog = packaged.replace("- Current fix.", "- Current fix edited.");
      write("CHANGELOG.md", editedChangelog);
      await expect(restorePackageChangelog(root)).rejects.toThrow(
        "Refusing to restore packaged changelog backup",
      );
      expect(read()).toBe(editedChangelog);
      expect(
        existsSync(path.join(root, ".artifacts/package-changelog/CHANGELOG.md.prepack-backup")),
      ).toBe(true);
    } else {
      await expect(restorePackageChangelog(root)).resolves.toBe(true);
      expect(read()).toBe(oversizedChangelog);
    }
  });

  it.each(["Unreleased", "2026.5.30 (Unreleased)"])(
    "restores interrupted %s QA packaging",
    async (heading) => {
      const unreleasedChangelog = cumulativeChangelog
        .replace("## Unreleased", `## ${heading}`)
        .replace("- Pending note.", "- Pending release note with enough detail.");
      const { root, read } = makeChangelog(unreleasedChangelog, "2026.5.29");

      await expect(preparePackageChangelog(root, { allowUnreleased: true })).resolves.toBe(true);
      // Older published packers retained only the source backup.
      rmSync(path.join(root, ".artifacts", "package-changelog", "CHANGELOG.md.packaged"));
      await expect(restorePackageChangelog(root)).resolves.toBe(true);
      expect(read()).toBe(unreleasedChangelog);
    },
  );
});
