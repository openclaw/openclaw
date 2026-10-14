import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { splitChangelog } from "../../scripts/lib/release-changelog.mjs";
import {
  GITHUB_RELEASE_BODY_MAX_BYTES,
  GITHUB_RELEASE_BODY_MAX_CHARACTERS,
  extractChangelogSection,
  formatContributionRecordProvenance,
  formatShippedBaselineExclusions,
  parseContributionRecordProvenance,
  parseShippedBaselineExclusions,
  releaseNotesVersionForTag,
  renderGithubReleaseNotes,
  verifyGithubReleaseNotes,
} from "../../scripts/render-github-release-notes.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repository = "openclaw/openclaw";
const tag = "v2026.7.1-beta.3";
const version = "2026.7.1";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function changelogFor(record: string): string {
  return [
    "# Changelog",
    "",
    `## ${version}`,
    "",
    "### Highlights",
    "",
    "- A grouped user-facing highlight.",
    "",
    "### Fixes",
    "",
    "- A grouped user-facing fix.",
    "",
    "### Complete contribution record",
    "",
    record,
    "",
    "## 2026.6.11",
    "",
    "- Previous release.",
    "",
  ].join("\n");
}

describe("GitHub release-note rendering", () => {
  it("refuses docs-mirror source in the initial renderer", () => {
    expect(() =>
      renderGithubReleaseNotes({
        changelog: `## ${version}\n\n<!-- openclaw-docs-mirror-v1 {} -->\n\nPublished reader prose.\n`,
        version,
        tag,
        repository,
      }),
    ).toThrow("docs-publication renderer");
  });

  it.each([false, true])(
    "renders pinned legacy and split sources through the CLI (compact=%s)",
    (compact) => {
      const rootDir = tempDirs.make("openclaw-release-render-");
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
      git("init", "-q");
      git("config", "user.name", "Release Fixture");
      git("config", "user.email", "release-fixture@openclaw.invalid");
      git("config", "commit.gpgsign", "false");
      const changelog = changelogFor(
        `- **PR #123** ${compact ? "record ".repeat(20_000) : "fix: example."}`,
      );
      writeFileSync(join(rootDir, "CHANGELOG.md"), changelog);
      git("add", ".");
      git("commit", "-qm", "legacy release");
      const legacy = git("rev-parse", "HEAD");
      splitChangelog({ rootDir });
      git("add", ".");
      git("commit", "-qm", "split release");
      const split = git("rev-parse", "HEAD");
      writeFileSync(
        join(rootDir, `CHANGELOG/${version}.md`),
        `## ${version}\n\nUncommitted drift.\n`,
      );
      const render = (ref: string) =>
        execFileSync(
          process.execPath,
          [
            resolve("scripts/render-github-release-notes.mts"),
            "--root",
            rootDir,
            "--ref",
            ref,
            "--tag",
            tag,
            "--repository",
            repository,
          ],
          { encoding: "utf8" },
        );
      const legacyBody = render(legacy);
      const splitBody = render(split);
      const bodyPath = join(rootDir, "release-body.md");
      writeFileSync(bodyPath, splitBody);
      const verify = () =>
        execFileSync(
          process.execPath,
          [
            resolve("scripts/render-github-release-notes.mts"),
            "--root",
            rootDir,
            "--ref",
            split,
            "--tag",
            tag,
            "--repository",
            repository,
            "--verify-body",
            bodyPath,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
      expect(verify()).toBe("");
      writeFileSync(bodyPath, `${splitBody}\nUnapproved appended prose.\n`);
      expect(verify).toThrow("Release body does not match canonical release notes.");
      expect(legacyBody).not.toContain("Uncommitted drift");
      expect(splitBody).not.toContain("Uncommitted drift");
      if (compact) {
        expect(legacyBody).toContain(`/blob/${tag}/CHANGELOG.md#complete-contribution-record`);
        expect(splitBody).toContain(
          `/blob/${tag}/CHANGELOG/records/${version}.md#complete-contribution-record`,
        );
        expect(splitBody).toBe(
          legacyBody.replace("/CHANGELOG.md#", `/CHANGELOG/records/${version}.md#`),
        );
      } else {
        expect(splitBody).toBe(legacyBody);
        expect(splitBody).toBe(extractChangelogSection(changelog, version));
      }
    },
  );

  it("renders and verifies a pinned beta delta instead of cumulative stable notes", () => {
    const rootDir = tempDirs.make("openclaw-beta-render-");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Release Fixture");
    git("config", "user.email", "release-fixture@openclaw.invalid");
    git("config", "commit.gpgsign", "false");
    const delta = `## ${tag.slice(1)}\n\n### Fixes\n\n- New beta-only fix.`;
    writeFileSync(
      join(rootDir, "CHANGELOG.md"),
      `${delta}\n\n## ${version}\n\n- Cumulative stable feature.\n`,
    );
    splitChangelog({ rootDir });
    git("add", ".");
    git("commit", "-qm", "beta delta");
    const ref = git("rev-parse", "HEAD");
    writeFileSync(join(rootDir, `CHANGELOG/${tag.slice(1)}.md`), `${delta}\nUncommitted drift.\n`);
    const render = (releaseTag: string, extra: string[] = []) =>
      execFileSync(
        process.execPath,
        [
          resolve("scripts/render-github-release-notes.mts"),
          "--root",
          rootDir,
          "--ref",
          ref,
          "--tag",
          releaseTag,
          "--repository",
          repository,
          ...extra,
        ],
        { encoding: "utf8" },
      );
    expect(render(tag)).toBe(delta);
    expect(render(`v${version}`)).toBe(`## ${version}\n\n- Cumulative stable feature.`);
    const bodyPath = join(rootDir, "body.md");
    writeFileSync(bodyPath, delta);
    expect(render(tag, ["--version", tag.slice(1), "--verify-body", bodyPath])).toBe("");
  });

  it("round-trips canonical contribution provenance and accepts published legacy lines", () => {
    const target = "a".repeat(40);
    const singular = formatContributionRecordProvenance({
      base: "v2026.7.2-beta.7",
      target,
      inRangePullRequests: 1,
      retainedSeedOnlyPullRequests: 0,
      uniquePullRequests: 1,
    });
    const commaSeparated = formatContributionRecordProvenance({
      base: "v2026.7.2-beta.7",
      target,
      inRangePullRequests: 1_234,
      retainedSeedOnlyPullRequests: 56,
      uniquePullRequests: 1_290,
    });

    expect(singular).toContain("1 in-range PR + 0 retained seed-only PRs = 1 unique PR.");
    expect(commaSeparated).toContain(
      "1,234 in-range PRs + 56 retained seed-only PRs = 1,290 unique PRs.",
    );
    expect(
      parseContributionRecordProvenance(
        [singular, "", "#### Pull requests", "", "- **PR #123** fix: canonical example."].join(
          "\n",
        ),
      ),
    ).toEqual({
      base: "v2026.7.2-beta.7",
      target,
      inRangePullRequests: 1,
      retainedSeedOnlyPullRequests: 0,
      uniquePullRequests: 1,
    });
    const legacy = parseContributionRecordProvenance(
      [
        `This audited record covers the complete v2026.7.2-beta.6..02d06caeb0febe7ec3c0df1454b85c38f3fb27d1 history: 1 merged PR. The generation manifest also supplies direct commits as editorial input; the grouped notes above prioritize user impact.`,
        "",
        "#### Pull requests",
        "",
        "- **PR #123** fix: legacy example.",
      ].join("\n"),
    );
    expect(legacy).toMatchObject({ uniquePullRequests: 1 });
    expect(() => formatContributionRecordProvenance(legacy!)).toThrow("requires split PR counts");
    expect(() =>
      parseContributionRecordProvenance(
        commaSeparated.replace("= 1,290 unique PRs", "= 1,291 unique PRs"),
      ),
    ).toThrow("provenance arithmetic is invalid");
    expect(() =>
      parseContributionRecordProvenance(commaSeparated.replace("1,234", "1234")),
    ).toThrow("provenance is malformed");
    expect(() =>
      parseContributionRecordProvenance(singular.replace("1 in-range", "001 in-range")),
    ).toThrow("provenance is malformed");
    expect(() => parseContributionRecordProvenance(singular)).toThrow(
      "positive contribution record requires a Pull requests section",
    );
  });

  it("prefixes extended-stable notes with immutable regular-stable context", () => {
    const extendedVersion = "2026.8.35";
    const extendedTag = `v${extendedVersion}`;
    const regularStableVersion = "2026.9.5";
    const changelog = changelogFor("- **PR #123** fix: example.").replaceAll(
      version,
      extendedVersion,
    );
    const rendered = renderGithubReleaseNotes({
      changelog,
      version: extendedVersion,
      tag: extendedTag,
      repository,
      regularStableVersion,
    });

    expect(
      rendered.body.startsWith(
        "This is a gateway-only `extended-stable` release, which is our current equivalent to LTS. " +
          "This release is OpenClaw from the end of August 2026, plus critical security updates, " +
          "reliability and performance fixes, and features like new model support. " +
          "The latest version of OpenClaw at the time of this release is " +
          "[2026.9.5](https://github.com/openclaw/openclaw/releases#release-v2026.9.5)\n\n" +
          "## 2026.8.35",
      ),
    ).toBe(true);
    expect(
      verifyGithubReleaseNotes({
        body: rendered.body,
        changelog,
        version: extendedVersion,
        tag: extendedTag,
        repository,
        regularStableVersion,
      }).matches,
    ).toBe(true);
    expect(() =>
      renderGithubReleaseNotes({
        changelog,
        version: extendedVersion,
        tag: extendedTag,
        repository,
      }),
    ).toThrow("regular stable version must be a string");
  });

  it("uses the full form at exactly 125,000 bytes and compacts at 125,001", () => {
    const seed = renderGithubReleaseNotes({
      changelog: changelogFor("x"),
      version,
      tag,
      repository,
    });
    const exactRecordLength =
      GITHUB_RELEASE_BODY_MAX_BYTES - seed.size.bytes + Buffer.byteLength("x");
    const exact = renderGithubReleaseNotes({
      changelog: changelogFor("x".repeat(exactRecordLength)),
      version,
      tag,
      repository,
    });
    const over = renderGithubReleaseNotes({
      changelog: changelogFor("x".repeat(exactRecordLength + 1)),
      version,
      tag,
      repository,
    });

    expect(exact.mode).toBe("full");
    expect(exact.size).toEqual({
      characters: GITHUB_RELEASE_BODY_MAX_CHARACTERS,
      bytes: GITHUB_RELEASE_BODY_MAX_BYTES,
    });
    expect(over.mode).toBe("compact");
  });

  it("normalizes correction tags to the stable changelog section", () => {
    expect(releaseNotesVersionForTag("v2026.7.1-2")).toBe("2026.7.1");
    const rendered = renderGithubReleaseNotes({
      changelog: changelogFor("- **PR #123** fix: correction."),
      version,
      tag: "v2026.7.1-2",
      repository,
    });

    expect(rendered.body).toContain("## 2026.7.1");
  });

  it("round-trips canonical shipped baseline exclusions and rejects malformed metadata", () => {
    const line = formatShippedBaselineExclusions([
      { ref: "v2026.6.11", count: 2, pullRequests: [108, 101] },
      { ref: "v2026.6.10-beta.2", count: 0, pullRequests: [] },
    ]);

    expect(line).toBe(
      "Shipped baseline exclusions: v2026.6.10-beta.2 (0 PRs); v2026.6.11 (2 PRs: #101, #108).",
    );
    expect(parseShippedBaselineExclusions(line)).toEqual([
      { ref: "v2026.6.10-beta.2", count: 0, pullRequests: [] },
      { ref: "v2026.6.11", count: 2, pullRequests: [101, 108] },
    ]);
    expect(() =>
      parseShippedBaselineExclusions("Shipped baseline exclusion: v2026.6.11 (8 PRs)."),
    ).toThrow("malformed shipped baseline exclusion");
    expect(() =>
      parseShippedBaselineExclusions("Shipped baseline exclusions: v2026.6.11 (2 PRs: #101)."),
    ).toThrow("invalid shipped baseline exclusion count");
  });

  it("rejects tag/version drift and legacy oversized ledger anchors", () => {
    expect(() =>
      renderGithubReleaseNotes({
        changelog: changelogFor("- **PR #123** fix: example."),
        version,
        tag: "v2026.7.2-beta.1",
        repository,
      }),
    ).toThrow("requires CHANGELOG.md version 2026.7.2");

    expect(() =>
      renderGithubReleaseNotes({
        changelog: changelogFor(
          `### Complete contribution ledger\n\n${"legacy ".repeat(20_000)}`,
        ).replace("### Complete contribution record\n\n", ""),
        version,
        tag,
        repository,
      }),
    ).toThrow("cannot be compacted without a complete contribution record");
  });

  it("prefers an alpha tag's exact changelog heading over the Unreleased fallback", () => {
    // Shipped alpha tags carry their own heading with no base section,
    // matching the tagged CHANGELOG.md shape of v2026.6.20-alpha.1.
    const changelog = [
      "# Changelog",
      "",
      "## 2026.7.1-alpha.2",
      "",
      "- Alpha-only fix.",
      "",
      "## 2026.6.11",
      "",
      "- Previous release.",
      "",
    ].join("\n");
    const rendered = renderGithubReleaseNotes({
      changelog,
      version,
      tag: "v2026.7.1-alpha.2",
      repository,
    });

    expect(rendered.body).toContain("## 2026.7.1-alpha.2");
    expect(rendered.body).toContain("Alpha-only fix.");
    expect(rendered.body).not.toContain("Previous release.");
  });

  it("permits the Unreleased fallback only for alpha tags", () => {
    const changelog = changelogFor("- **PR #123** fix: example.").replace(
      "## 2026.7.1",
      "## Unreleased",
    );
    const rendered = renderGithubReleaseNotes({
      changelog,
      version,
      tag: "v2026.7.1-alpha.1",
      repository,
    });

    expect(rendered.body).toContain("## 2026.7.1");
    expect(rendered.body).not.toContain("## Unreleased");
    expect(() =>
      renderGithubReleaseNotes({
        changelog,
        version,
        tag,
        repository,
      }),
    ).toThrow("CHANGELOG.md does not contain ## 2026.7.1");
    expect(() =>
      renderGithubReleaseNotes({
        changelog,
        version: "foo",
        tag: "vfoo-alpha.1",
        repository,
      }),
    ).toThrow("invalid release tag");
  });

  it("compacts at the real contribution record instead of a fenced pseudo-heading", () => {
    const changelog = changelogFor(`- **PR #123** ${"record-only-detail ".repeat(9_000)}`).replace(
      "### Fixes",
      ["```md", "### Complete contribution record", "```", "", "### Fixes"].join("\n"),
    );
    const rendered = renderGithubReleaseNotes({ changelog, version, tag, repository });

    expect(rendered.mode).toBe("compact");
    expect(rendered.body).toContain("```md\n### Complete contribution record\n```");
    expect(rendered.body).toContain("- A grouped user-facing fix.");
    expect(rendered.body).not.toContain("record-only-detail");
  });

  it("verifies the exact generated compact body and optional proof tail", () => {
    const changelog = changelogFor(`- **PR #123** ${"z".repeat(130_000)}`);
    const verification = "### Release verification\n\n- release SHA: `abc123`";
    const rendered = renderGithubReleaseNotes({
      changelog,
      version,
      tag,
      repository,
      verification,
    });

    expect(
      verifyGithubReleaseNotes({
        body: rendered.body,
        changelog,
        version,
        tag,
        repository,
      }),
    ).toMatchObject({ matches: true, mode: "compact" });
    expect(
      verifyGithubReleaseNotes({
        body: rendered.body.replace("tag-pinned", "mutable"),
        changelog,
        version,
        tag,
        repository,
      }).matches,
    ).toBe(false);
    expect(
      verifyGithubReleaseNotes({
        body: rendered.body,
        changelog,
        version,
        tag: "v2026.7.1-beta.2",
        repository,
      }).matches,
    ).toBe(false);
  });
});
