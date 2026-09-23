import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, test } from "vitest";
import {
  checkChangelogLayout,
  findChangelogSection,
  findReleaseChangelog,
  isReleaseChangelogPath,
  loadChangelogCollection,
  loadReleaseChangelog,
  splitChangelog,
  writeReleaseChangelog,
} from "../../scripts/lib/release-changelog.mjs";
import {
  checkReleaseDocsMirrors,
  flattenReleaseDocs,
  parseReleaseDocsMirror,
  renderReleaseDocsMirror,
} from "../../scripts/lib/release-docs-mirror.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cli = fileURLToPath(new URL("../../scripts/release-changelog.mjs", import.meta.url));
const current =
  "## 2026.9.4\n\n### Highlights\n\nText.\n\n```md\n## 2099.1.1\n```\n\n### Complete contribution record\n\nAudited range abc..def.\n- **PR #12** Thanks @human.\n\n";
const old = "## 2026.8.1\n\nOld notes without a contribution record.\n";
function fixture(content = `# Changelog\n\n${current}${old}`) {
  const rootDir = tempDirs.make("release-changelog-test-");
  fs.writeFileSync(path.join(rootDir, "CHANGELOG.md"), content);
  return rootDir;
}
function git(rootDir: string, ...args: string[]) {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("mechanical split preserves every section and authentic record, including CRLF", () => {
  for (const section of [current, current.replaceAll("\n", "\r\n")]) {
    const rootDir = fixture(`# Changelog\n\n${section}${old}`);
    const before = fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
    assert.deepEqual(splitChangelog({ rootDir, check: true }), {
      sections: 2,
      releases: 2,
      records: 1,
      duplicates: 0,
    });
    assert.equal(fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8"), before);
    splitChangelog({ rootDir });
    const release = loadReleaseChangelog({ rootDir, version: "v2026.9.4" });
    assert.equal(release.section, section);
    assert.equal(
      release.record?.slice(release.record.indexOf("### Complete")),
      section.slice(section.indexOf("### Complete")),
    );
    assert.equal(loadReleaseChangelog({ rootDir, version: "2026.8.1" }).record, null);
    assert.deepEqual(checkChangelogLayout({ rootDir }), { releases: 2, records: 1 });
  }
});

test("legacy and split immutable Git reads are independent of working-tree changes", () => {
  const rootDir = fixture();
  git(rootDir, "init", "-q");
  git(rootDir, "add", "CHANGELOG.md");
  git(
    rootDir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "legacy",
  );
  const legacy = git(rootDir, "rev-parse", "HEAD");
  splitChangelog({ rootDir });
  git(rootDir, "add", "CHANGELOG.md", "CHANGELOG");
  git(
    rootDir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "split",
  );
  const split = git(rootDir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(rootDir, "CHANGELOG/2026.9.4.md"), "broken");
  assert.equal(
    loadReleaseChangelog({ rootDir, ref: legacy, version: "2026.9.4" }).layout,
    "legacy",
  );
  assert.equal(loadReleaseChangelog({ rootDir, ref: split, version: "2026.9.4" }).section, current);
  assert.throws(() => loadReleaseChangelog({ rootDir, version: "2026.9.4" }), /mismatched/u);
});

test("duplicate historical sections are retained together but never silently selected", () => {
  const rootDir = fixture(`# Changelog\n\n${old}${old}`);
  assert.throws(() => loadReleaseChangelog({ rootDir, version: "2026.8.1" }), /Ambiguous/u);
  assert.equal(splitChangelog({ rootDir }).duplicates, 1);
  assert.equal(fs.readFileSync(path.join(rootDir, "CHANGELOG/2026.8.1.md"), "utf8"), old + old);
  assert.equal((loadChangelogCollection({ rootDir }).match(/^## /gmu) ?? []).length, 2);
  assert.throws(() => findReleaseChangelog({ rootDir, version: "2026.8.1" }), /Ambiguous/u);
  assert.throws(
    () => writeReleaseChangelog({ rootDir, version: "2026.8.1", section: old }),
    /Ambiguous/u,
  );
  checkChangelogLayout({ rootDir });
});

test("initial generation updates its record, protects mirrors and refuses legacy writes", () => {
  const rootDir = fixture();
  assert.throws(
    () => writeReleaseChangelog({ rootDir, version: "2026.9.4", section: current }),
    /require split/u,
  );
  splitChangelog({ rootDir });
  const updated = current.replace("PR #12", "PR #13");
  writeReleaseChangelog({ rootDir, version: "2026.9.4", section: updated });
  assert.match(loadReleaseChangelog({ rootDir, version: "2026.9.4" }).record ?? "", /PR #13/u);
  assert.equal(fs.readFileSync(path.join(rootDir, "CHANGELOG/2026.8.1.md"), "utf8"), old);
  const frozenRecord = fs.readFileSync(path.join(rootDir, "CHANGELOG/records/2026.9.4.md"), "utf8");
  fs.writeFileSync(
    path.join(rootDir, "CHANGELOG/2026.9.4.md"),
    '<!-- openclaw-docs-mirror-v1 {"version":"2026.9.4"} -->\n## 2026.9.4\n\nDocs prose.\n',
  );
  assert.equal(loadReleaseChangelog({ rootDir, version: "2026.9.4" }).format, "docs-mirror");
  checkChangelogLayout({ rootDir });
  assert.throws(
    () => writeReleaseChangelog({ rootDir, version: "2026.9.4", section: current }),
    /cannot overwrite/u,
  );
  assert.equal(
    fs.readFileSync(path.join(rootDir, "CHANGELOG/records/2026.9.4.md"), "utf8"),
    frozenRecord,
  );
});

test("missing entries, conflicts, path traversal and symlinks fail at the owner", () => {
  for (const damage of ["missing", "changed", "mislabeled", "orphan", "mirror-missing"]) {
    const damagedRoot = fixture();
    splitChangelog({ rootDir: damagedRoot });
    const recordPath = path.join(damagedRoot, "CHANGELOG/records/2026.9.4.md");
    const record = fs.readFileSync(recordPath, "utf8");
    if (damage === "missing" || damage === "mirror-missing") {
      fs.unlinkSync(recordPath);
      if (damage === "mirror-missing") {
        fs.writeFileSync(
          path.join(damagedRoot, "CHANGELOG/2026.9.4.md"),
          "<!-- openclaw-docs-mirror-v1 {} -->\n## 2026.9.4\n\nDocs prose.\n",
        );
      }
    } else if (damage === "orphan") {
      fs.writeFileSync(
        path.join(damagedRoot, "CHANGELOG/records/2026.1.1.md"),
        record.replace("2026.9.4", "2026.1.1"),
      );
    } else {
      fs.writeFileSync(
        recordPath,
        damage === "changed"
          ? record.replace("PR #12", "PR #99")
          : record.replace("2026.9.4", "2026.1.1"),
      );
    }
    assert.throws(
      () => loadChangelogCollection({ rootDir: damagedRoot, recordsOnly: true }),
      /contribution record|Contribution record|mismatched/u,
    );
  }
  const rootDir = fixture();
  splitChangelog({ rootDir });
  assert.equal(findReleaseChangelog({ rootDir, version: "2026.1.1" }), null);
  assert.throws(() => loadReleaseChangelog({ rootDir, version: "2026.1.1" }), /Missing/u);
  assert.throws(() => loadReleaseChangelog({ rootDir, version: "../2026.9.4" }), /Invalid/u);
  fs.writeFileSync(path.join(rootDir, "CHANGELOG.md"), current);
  assert.throws(() => loadReleaseChangelog({ rootDir, version: "2026.9.4" }), /Conflicting/u);
  fs.writeFileSync(path.join(rootDir, "CHANGELOG.md"), "# Changelog\n");
  fs.symlinkSync(path.join(rootDir, "CHANGELOG.md"), path.join(rootDir, "CHANGELOG/2026.1.1.md"));
  assert.throws(() => findReleaseChangelog({ rootDir, version: "2026.9.4" }), /symlink/u);
});

test("Unreleased fallback and path classification preserve candidate boundaries", () => {
  const section = "## 2026.9.5 (Unreleased)\n\nUpcoming notes.\n";
  const rootDir = fixture(`# Changelog\n\n${section}${old}`);
  assert.equal(findChangelogSection(section, "Unreleased"), section);
  splitChangelog({ rootDir });
  assert.equal(loadReleaseChangelog({ rootDir, version: "Unreleased" }).version, "2026.9.5");
  assert.equal(
    isReleaseChangelogPath("CHANGELOG/records/2026.9.4.md", { version: "v2026.9.4" }),
    true,
  );
  assert.equal(isReleaseChangelogPath("CHANGELOG/2026.9.3.md", { version: "2026.9.4" }), false);
  assert.equal(isReleaseChangelogPath("CHANGELOG/arbitrary.md"), false);
});

test("CLI reads and checks the same owner without runtime dependencies", () => {
  const rootDir = fixture();
  execFileSync(process.execPath, [cli, "split", "--root", rootDir]);
  const output = execFileSync(
    process.execPath,
    [cli, "read", "--root", rootDir, "--version", "2026.9.4"],
    { encoding: "utf8" },
  );
  assert.equal(output, current);
  const records = execFileSync(
    process.execPath,
    [cli, "collection", "--root", rootDir, "--records-only"],
    { encoding: "utf8" },
  );
  assert.match(records, /PR #12/u);
  assert.doesNotMatch(records, /2026\.8\.1/u);
  execFileSync(process.execPath, [cli, "check", "--root", rootDir]);
});

describe("release docs mirrors", () => {
  const mirrorCli = fileURLToPath(
    new URL("../../scripts/render-release-changelog.mjs", import.meta.url),
  );
  const version = "2026.9.4";
  const source = `docs/releases/${version}.md`;

  function mirrorFixture() {
    const rootDir = tempDirs.make("release-docs-mirror-");
    fs.mkdirSync(path.join(rootDir, "docs/releases"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "CHANGELOG/records"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, source),
      '---\ntitle: "Release title"\n---\n\nExact prose.\n',
    );
    return { rootDir, version, sources: [source] };
  }

  it("retains prose, credits, tables, images and code while flattening wrappers and links", () => {
    const code = '```md\n<Accordion title="example">\n[local](/do-not-change)\n```';
    const input = [
      "# A release",
      "",
      "## Messaging",
      "",
      "<AccordionGroup>",
      '<Accordion title="Keep **this** wording">',
      "",
      "Exact prose: [install](/install/node#help), [relative](../guide.md), [section](#source).",
      "",
      '<details class="release-source-toggle">',
      "<summary>Sources and complete change list</summary>",
      "",
      "- Exact credit [#42](https://github.com/openclaw/openclaw/pull/42). Thanks @alice, @steipete.",
      "",
      "| A | B |",
      "| --- | --- |",
      "| exact | cells |",
      "",
      "![original alt](/images/example.png)",
      "",
      code,
      "",
      "`<Widget> [inline](/unchanged)` and `<Note>\n[split](/unchanged) </Note>`.",
      "",
      "</details>",
      "</Accordion>",
      "</AccordionGroup>",
      "<Warning>",
      "Keep the warning.",
      "</Warning>",
      "",
      '[ref]: /install/node "Keep title"',
    ].join("\n");
    const result = flattenReleaseDocs(input, source);
    expect(result).toContain("##### Keep **this** wording");
    expect(result).toContain("###### Sources and complete change list");
    expect(result).toContain(
      "- Exact credit [#42](https://github.com/openclaw/openclaw/pull/42). Thanks @alice, @steipete.",
    );
    expect(result).toContain("| A | B |\n| --- | --- |\n| exact | cells |");
    expect(result).toContain("![original alt](https://docs.openclaw.ai/images/example.png)");
    expect(result).toContain(code);
    expect(result).toContain(
      "`<Widget> [inline](/unchanged)` and `<Note>\n[split](/unchanged) </Note>`.",
    );
    expect(result).toContain("[install](https://docs.openclaw.ai/install/node#help)");
    expect(result).toContain("[relative](https://docs.openclaw.ai/guide)");
    expect(result).toContain("[section](https://docs.openclaw.ai/releases/2026.9.4#source)");
    expect(result).toContain("> **Warning**\n> \n> Keep the warning.");
    expect(result).toContain('[ref]: https://docs.openclaw.ai/install/node "Keep title"');
  });

  it("binds source bytes and explicit multi-page order, preserving landing navigation", () => {
    const options = mirrorFixture();
    const other = "docs/releases/part.md";
    fs.writeFileSync(
      path.join(options.rootDir, source),
      "---\ntitle: Landing\n---\n\n[Part](./part.md) - Exact navigation.\n",
    );
    fs.writeFileSync(
      path.join(options.rootDir, other),
      "---\ntitle: Part\n---\n\nFinal complete list.\n",
    );
    const result = renderReleaseDocsMirror({ ...options, sources: [source, other] });
    expect(result).toContain("[Part](https://docs.openclaw.ai/releases/part) - Exact navigation.");
    expect(result.indexOf("### Landing")).toBeLessThan(result.indexOf("### Part"));
    expect(result).toContain("Final complete list.");
    const metadata = parseReleaseDocsMirror(result);
    expect(metadata?.sources).toEqual([source, other]);
    const reversed = renderReleaseDocsMirror({ ...options, sources: [other, source] });
    expect(parseReleaseDocsMirror(reversed)?.sourceDigest).not.toEqual(metadata?.sourceDigest);
    fs.appendFileSync(path.join(options.rootDir, source), "\n");
    expect(
      parseReleaseDocsMirror(renderReleaseDocsMirror({ ...options, sources: [source, other] }))
        ?.sourceDigest,
    ).not.toEqual(metadata?.sourceDigest);
  });

  it("checks only marked entries and rejects byte drift, invalid markers and missing sources", () => {
    const options = mirrorFixture();
    const output = path.join(options.rootDir, `CHANGELOG/${version}.md`);
    fs.writeFileSync(output, renderReleaseDocsMirror(options));
    fs.writeFileSync(
      path.join(options.rootDir, "CHANGELOG/2026.8.1.md"),
      "## 2026.8.1\n\nHistorical prose.\n",
    );
    expect(checkReleaseDocsMirrors(options)).toEqual([version]);
    fs.appendFileSync(output, "Edited independently.\n");
    expect(() => checkReleaseDocsMirrors(options)).toThrow(/stale or differs/);
    fs.writeFileSync(output, renderReleaseDocsMirror(options).replace("mirror-v1", "mirror-v2"));
    expect(() => checkReleaseDocsMirrors(options)).toThrow(/Unknown or invalid/);
    fs.writeFileSync(output, renderReleaseDocsMirror(options));
    fs.unlinkSync(path.join(options.rootDir, source));
    expect(() => checkReleaseDocsMirrors(options)).toThrow(/ENOENT/);
  });

  it("rejects unsafe paths, duplicate sources, malformed wrappers and unsupported constructs", () => {
    const options = mirrorFixture();
    expect(() => renderReleaseDocsMirror({ ...options, sources: ["docs/../private.md"] })).toThrow(
      /Invalid docs source/,
    );
    expect(() => renderReleaseDocsMirror({ ...options, sources: [source, source] })).toThrow(
      /without duplicates/,
    );
    for (const body of [
      '<Widget title="do not lose me" />',
      '<Accordion title="Open">',
      "</details>",
      '<Note title="custom text">\nBody\n</Note>',
    ]) {
      expect(() => flattenReleaseDocs(`# Title\n\n${body}`, source)).toThrow();
    }
    fs.symlinkSync(
      path.join(options.rootDir, "../outside.md"),
      path.join(options.rootDir, "docs/escape.md"),
    );
    expect(() => renderReleaseDocsMirror({ ...options, sources: ["docs/escape.md"] })).toThrow();
  });

  it("runs the rendering and checking CLI without touching frozen records or docs", () => {
    const options = mirrorFixture();
    const record = path.join(options.rootDir, `CHANGELOG/records/${version}.md`);
    fs.writeFileSync(record, "Frozen original record.\n");
    const original = fs.readFileSync(path.join(options.rootDir, source));
    const output = path.join(options.rootDir, `CHANGELOG/${version}.md`);
    const args = [
      mirrorCli,
      "--root",
      options.rootDir,
      "--version",
      version,
      "--source",
      source,
      "--output",
    ];
    expect(spawnSync(process.execPath, [...args, output], { encoding: "utf8" }).status).toBe(0);
    const check = spawnSync(process.execPath, [mirrorCli, "--root", options.rootDir, "--check"], {
      encoding: "utf8",
    });
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain("Checked 1 docs mirror(s)");
    expect(spawnSync(process.execPath, [...args, record], { encoding: "utf8" }).status).toBe(1);
    expect(fs.readFileSync(record, "utf8")).toBe("Frozen original record.\n");
    expect(fs.readFileSync(path.join(options.rootDir, source))).toEqual(original);
    fs.appendFileSync(path.join(options.rootDir, source), "Approved docs revision.\n");
    expect(
      spawnSync(process.execPath, [mirrorCli, "--root", options.rootDir, "--check"], {
        encoding: "utf8",
      }).status,
    ).toBe(1);
  });
});
