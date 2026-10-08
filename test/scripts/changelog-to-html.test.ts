import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderReleaseDocsMirror } from "../../scripts/lib/release-docs-mirror.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const footer =
  '<p><a href="https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md">View full changelog</a></p>';

function render(section: string, version = "2026.8.2", split = false) {
  const root = tempDirs.make("openclaw-changelog-html-");
  const file = path.join(root, "CHANGELOG.md");
  writeFileSync(file, split ? "# Changelog\n\n- [Release](CHANGELOG/2026.8.2.md)\n" : section);
  if (split) {
    mkdirSync(path.join(root, "CHANGELOG"));
    writeFileSync(path.join(root, "CHANGELOG", `${version}.md`), section);
  }
  return renderFile(file, version);
}

function renderFile(file: string, version: string) {
  return spawnSync("bash", ["scripts/changelog-to-html.sh", version, file], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

describe("changelog release HTML", () => {
  it("renders the selected split file through the source index", () => {
    const result = render("## 2026.8.2\n\n### Fixes\n- Current release.\n", "2026.8.2", true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `<h2>OpenClaw 2026.8.2</h2>\n<h3>Fixes</h3>\n<ul>\n<li>Current release.</li>\n</ul>\n${footer}\n`,
    );
  });

  it.each(["index", "entry"])(
    "renders a docs mirror through its %s with one release heading",
    (route) => {
      const rootDir = tempDirs.make("openclaw-changelog-html-mirror-");
      const version = "2026.8.2";
      const source = `docs/releases/${version}.md`;
      const indexPath = path.join(rootDir, "CHANGELOG.md");
      const entryPath = path.join(rootDir, "CHANGELOG", `${version}.md`);
      mkdirSync(path.join(rootDir, "docs/releases"), { recursive: true });
      mkdirSync(path.join(rootDir, "CHANGELOG/records"), { recursive: true });
      writeFileSync(
        path.join(rootDir, source),
        '---\ntitle: "Release notes"\n---\n\n- Current release.\n',
      );
      writeFileSync(indexPath, `# Changelog\n\n- [${version}](CHANGELOG/${version}.md)\n`);
      writeFileSync(
        path.join(rootDir, "CHANGELOG/records", `${version}.md`),
        `## ${version}\n\n### Complete contribution record\n\nFrozen record.\n`,
      );
      writeFileSync(entryPath, renderReleaseDocsMirror({ rootDir, version, sources: [source] }));

      const result = renderFile(route === "index" ? indexPath : entryPath, version);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        `<h2>OpenClaw ${version}</h2>\n<h3>Release notes</h3>\n<ul>\n<li>Current release.</li>\n</ul>\n${footer}\n`,
      );
    },
  );

  it("preserves markup ordering, literal HTML, links, backslashes and list boundaries", () => {
    const result = render(
      [
        "# Changelog",
        "## 2026.8.2 (Unreleased)",
        "",
        "### Highlights",
        "- **Fast** & reliable `path\\file`",
        "- [Guide](https://example.com?a=1&b=2) and **bold**",
        "",
        "#### Details",
        "<p>Existing &amp; HTML</p>",
        "##### More",
        "- Plain <tag>",
        "## 2026.8.1",
        "- Old release",
      ].join("\n"),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      [
        "<h2>OpenClaw 2026.8.2</h2>",
        "<h3>Highlights</h3>",
        "<ul>",
        "<li><strong>Fast</strong> & reliable <code>path\\file</code></li>",
        '<li><a href="https://example.com?a=1&b=2">Guide</a> and <strong>bold</strong></li>',
        "</ul>",
        "<h4>Details</h4>",
        "<p>Existing &amp; HTML</p>",
        "<h5>More</h5>",
        "<ul>",
        "<li>Plain <tag></li>",
        "</ul>",
        footer,
        "",
      ].join("\n"),
    );
  });

  it("renders a release-sized appendix within the command budget without losing entries", () => {
    const entries = Array.from(
      { length: 2_000 },
      (_, index) =>
        `- **Fix ${index}**: preserve \`bytes\` & [credit](https://example.com/${index})`,
    );
    const result = render(`## 2026.8.2\n\n### Contributions\n${entries.join("\n")}\n`);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      [
        "<h2>OpenClaw 2026.8.2</h2>",
        "<h3>Contributions</h3>",
        "<ul>",
        ...entries.map(
          (_, index) =>
            `<li><strong>Fix ${index}</strong>: preserve <code>bytes</code> & <a href="https://example.com/${index}">credit</a></li>`,
        ),
        "</ul>",
        footer,
        "",
      ].join("\n"),
    );
  });

  it("keeps the missing-version fallback", () => {
    const result = render("## 2026.8.1\n- Previous release\n");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `<h2>OpenClaw 2026.8.2</h2>\n<p>Latest OpenClaw update.</p>\n${footer}\n`,
    );
  });
});
