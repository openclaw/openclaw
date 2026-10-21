import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { renderReleaseDocsMirror } from "../../scripts/lib/release-docs-mirror.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.8.2";
const footer =
  '<p><a href="https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md">View full changelog</a></p>';

function render(section: string, split = false) {
  const root = tempDirs.make("openclaw-changelog-html-");
  const file = path.join(root, "CHANGELOG.md");
  writeFixtureFiles(root, {
    "CHANGELOG.md": split ? `# Changelog\n\n- [Release](CHANGELOG/${version}.md)\n` : section,
    ...(split ? { [`CHANGELOG/${version}.md`]: section } : {}),
  });
  return renderFile(file);
}

function renderFile(file: string) {
  return spawnSync("bash", ["scripts/changelog-to-html.sh", version, file], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function expectHtml(result: ReturnType<typeof renderFile>, content: string) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`<h2>OpenClaw ${version}</h2>\n${content}\n${footer}\n`);
}

it("renders the selected split file through the source index", () => {
  const result = render("## 2026.8.2\n\n### Fixes\n- Current release.\n", true);
  expectHtml(result, "<h3>Fixes</h3>\n<ul>\n<li>Current release.</li>\n</ul>");
});

it.each(["index", "entry"])(
  "renders a docs mirror through its %s with one release heading",
  (route) => {
    const rootDir = tempDirs.make("openclaw-changelog-html-mirror-");
    const source = `docs/releases/${version}.md`;
    writeFixtureFiles(rootDir, {
      [source]: '---\ntitle: "Release notes"\n---\n\n- Current release.\n',
      "CHANGELOG.md": `# Changelog\n\n- [${version}](CHANGELOG/${version}.md)\n`,
      [`CHANGELOG/records/${version}.md`]: `## ${version}\n\n### Complete contribution record\n\nFrozen record.\n`,
    });
    writeFixtureFiles(rootDir, {
      [`CHANGELOG/${version}.md`]: renderReleaseDocsMirror({
        rootDir,
        version,
        sources: [source],
      }),
    });
    const result = renderFile(
      path.join(rootDir, route === "index" ? "CHANGELOG.md" : `CHANGELOG/${version}.md`),
    );
    expectHtml(result, "<h3>Release notes</h3>\n<ul>\n<li>Current release.</li>\n</ul>");
  },
);

it("preserves markup ordering, literal HTML, links, backslashes and list boundaries", () => {
  const fragments = [
    ["### Highlights", "<h3>Highlights</h3>"],
    [
      "- **Fast** & reliable `path\\file`\n- [Guide](https://example.com?a=1&b=2) and **bold**",
      '<ul>\n<li><strong>Fast</strong> & reliable <code>path\\file</code></li>\n<li><a href="https://example.com?a=1&b=2">Guide</a> and <strong>bold</strong></li>\n</ul>',
    ],
    ["\n#### Details\n<p>Existing &amp; HTML</p>", "<h4>Details</h4>\n<p>Existing &amp; HTML</p>"],
    ["##### More\n- Plain <tag>", "<h5>More</h5>\n<ul>\n<li>Plain <tag></li>\n</ul>"],
  ];
  const markdown = fragments.map(([source]) => source).join("\n");
  const result = render(
    `# Changelog\n## 2026.8.2 (Unreleased)\n\n${markdown}\n## 2026.8.1\n- Old release`,
  );
  expectHtml(result, fragments.map(([, html]) => html).join("\n"));
});

it("renders a release-sized appendix within the command budget without losing entries", () => {
  const entries = Array.from(
    { length: 2_000 },
    (_, index) => `- **Fix ${index}**: preserve \`bytes\` & [credit](https://example.com/${index})`,
  );
  const result = render(`## 2026.8.2\n\n### Contributions\n${entries.join("\n")}\n`);
  expect(result.error).toBeUndefined();
  const expected = entries
    .map(
      (_, index) =>
        `<li><strong>Fix ${index}</strong>: preserve <code>bytes</code> & <a href="https://example.com/${index}">credit</a></li>`,
    )
    .join("\n");
  expectHtml(result, `<h3>Contributions</h3>\n<ul>\n${expected}\n</ul>`);
});

it("keeps the missing-version fallback", () => {
  const result = render("## 2026.8.1\n- Previous release\n");
  expectHtml(result, "<p>Latest OpenClaw update.</p>");
});
