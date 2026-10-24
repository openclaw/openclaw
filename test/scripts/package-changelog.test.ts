import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderReleaseDocsMirror } from "../../scripts/lib/release-docs-mirror.mjs";
import {
  extractCurrentPackageChangelog as extract,
  preparePackageChangelog as prepare,
  readCurrentPackageChangelog as readCurrent,
  restorePackageChangelog as restore,
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
const version = "2026.5.28";
const entryPath = `CHANGELOG/${version}.md`;
const recordPath = `CHANGELOG/records/${version}.md`;
const index = `# Changelog\n\n- [${version}](${entryPath})\n`;

function makeChangelog(source = oversizedChangelog, packageVersion = "2026.5.28-beta.1") {
  const root = tempDirs.make("openclaw-package-changelog-");
  const write = (file: string, content: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const read = (file = "CHANGELOG.md") => readFileSync(path.join(root, file), "utf8");
  write("package.json", JSON.stringify({ version: packageVersion }));
  write("CHANGELOG.md", source);
  return { root, write, read };
}

describe("package-changelog", () => {
  it("packages an oversized docs mirror and restores its index", async () => {
    const docsPath = `docs/releases/${version}.md`;
    const docs = `# Release notes\n\n${"Complete release documentation.\n\n".repeat(20_000)}`;
    const { root, write, read } = makeChangelog(index, version);
    write(docsPath, docs);
    const mirror = renderReleaseDocsMirror({ rootDir: root, version, sources: [docsPath] });
    write(entryPath, mirror);
    write(recordPath, notes(version, "### Complete contribution record\n\n- PR #123."));
    await expect(prepare(root)).resolves.toBe(true);
    const packaged = read();
    const links = [...packaged.matchAll(/https:\/\/[^)\s]+/gu)].map(([url]) => url);
    expect(links).toEqual([
      `https://github.com/openclaw/openclaw/blob/main/${entryPath}`,
      `https://github.com/openclaw/openclaw/raw/refs/heads/main/${entryPath}`,
      `https://docs.openclaw.ai/releases/${version}`,
      `https://github.com/openclaw/openclaw/blob/main/${recordPath}#complete-contribution-record`,
    ]);
    expect(Buffer.byteLength(packaged)).toBeLessThanOrEqual(500 * 1024);

    await expect(restore(root)).resolves.toBe(true);
    expect(read()).toBe(index);
  });

  it("packages only a split release, pins its record, and restores the index after source edits", async () => {
    const section = `## 2026.5.28\n\n- Complete editorial notes and credit. Thanks @contributor.\n\n${largeRecord}\n`;
    const { root, write, read } = makeChangelog(index);
    write(entryPath, section);
    write(recordPath, notes(version, largeRecord));
    write("CHANGELOG/2026.5.27.md", "## 2026.5.27\n\n- Old history.\n");

    await expect(prepare(root)).resolves.toBe(true);
    const packaged = read();
    expect(packaged).toContain("Complete editorial notes and credit.");
    expect(packaged).toContain("/blob/v2026.5.28-beta.1/CHANGELOG/records/2026.5.28.md");
    expect(packaged).not.toContain("Old history");
    expect(Buffer.byteLength(packaged)).toBeLessThanOrEqual(500 * 1024);

    write(entryPath, `${section}\n- Later source edit.\n`);
    await expect(restore(root)).resolves.toBe(true);
    expect(read()).toBe(index);
    expect(read(entryPath)).toContain("Later source edit");
  });

  it("keeps split prerelease fallback and rejects unsafe exact notes", () => {
    const { root, write } = makeChangelog("# Changelog\n");
    write(
      "CHANGELOG/2026.5.30.md",
      notes("2026.5.30 (Unreleased)", "- Pending release notes with sufficient detail."),
    );
    expect(readCurrent(root, "2026.5.28-beta.1")).toContain("Pending release notes");
    expect(() => readCurrent(root, version)).toThrow("does not contain a release section");
    write(entryPath, notes(version, "- Tiny."));
    expect(() => readCurrent(root, "2026.5.28-beta.1")).toThrow("only 7 body bytes");
  });

  it.each(["2026.5.28-beta.2", "2026.5.28-1"])("prefers exact %s notes", (release) => {
    const selected = notes(release, "- Package notes with enough release detail.");
    const source = `# Changelog\n${selected}${notes("2026.5.28", "- Stable.")}`;
    expect(extract(source, release)).toBe(`# Changelog\n\n${selected}`);
  });

  it("rejects a missing release below draft notes", () => {
    expect(() => extract(cumulativeChangelog, "2026.5.29")).toThrow(
      "CHANGELOG.md does not contain a release section for 2026.5.29.",
    );
  });

  it("rejects unsafe exact notes instead of falling back to drafts", () => {
    const source = `# Changelog\n${notes("2026.5.30 (Unreleased)", "- Pending development package notes with enough release detail.")}${notes("2026.5.29", "- Tiny.")}${current}`;
    expect(() => extract(source, "2026.5.29", { allowUnreleased: true })).toThrow(
      "Packaged changelog section for 2026.5.29 is only 7 body bytes",
    );
  });

  it("excludes the generated record link from the editorial minimum", () => {
    const source = `# Changelog\n\n## 2026.5.28\n\n### Fixes\n\n${largeRecord}\n`;
    expect(() => extract(source, version)).toThrow("below the 32 byte safety minimum");
  });

  it.each(["", largeRecord])(
    "bounds oversized editorial notes locally and in CI (%#)",
    (record) => {
      const source = `# Changelog\n${notes(version, `${"é".repeat(260_000)}\n${record}`)}`;

      const output = vi.spyOn(console, "error").mockImplementation(() => {});
      withEnv({ GITHUB_ACTIONS: undefined, GITHUB_STEP_SUMMARY: undefined }, () => {
        expect(() => extract(source, version)).toThrow("exceeds the 512000 byte size limit");
      });
      output.mockClear();
      withEnv({ GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: undefined }, () => {
        expect(extract(source, version)).toContain("é".repeat(260_000));
      });
      expect(output).toHaveBeenCalledWith(expect.stringContaining("::warning file=CHANGELOG.md,"));
    },
  );

  it("refuses to overwrite edited package notes and preserves the backup", async () => {
    const { root, read, write } = makeChangelog();

    await expect(prepare(root)).resolves.toBe(true);
    const packaged = read();
    expect(packaged.match(/^## .+$/gm)).toEqual([`## ${version}`]);
    expect(packaged).toContain(
      "https://github.com/openclaw/openclaw/blob/v2026.5.28-beta.1/CHANGELOG.md#complete-contribution-record",
    );

    const editedChangelog = packaged.replace("- Current fix.", "- Current fix edited.");
    write("CHANGELOG.md", editedChangelog);
    await expect(restore(root)).rejects.toThrow("Refusing to restore packaged changelog backup");
    expect(read()).toBe(editedChangelog);
    expect(
      existsSync(path.join(root, ".artifacts/package-changelog/CHANGELOG.md.prepack-backup")),
    ).toBe(true);
  });

  it("restores interrupted QA packaging", async () => {
    const source = cumulativeChangelog
      .replace("## Unreleased", "## 2026.5.30 (Unreleased)")
      .replace("- Pending note.", "- Pending release note with enough detail.");
    const { root, read } = makeChangelog(source, "2026.5.29");
    await expect(prepare(root, { allowUnreleased: true })).resolves.toBe(true);
    // Older published packers retained only the source backup.
    rmSync(path.join(root, ".artifacts", "package-changelog", "CHANGELOG.md.packaged"));
    await expect(restore(root)).resolves.toBe(true);
    expect(read()).toBe(source);
  });
});
