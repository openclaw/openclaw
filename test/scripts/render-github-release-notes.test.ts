import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { splitChangelog } from "../../scripts/lib/release-changelog.mjs";
import {
  GITHUB_RELEASE_BODY_MAX_BYTES,
  GITHUB_RELEASE_BODY_MAX_CHARACTERS,
  formatContributionRecordProvenance,
  formatShippedBaselineExclusions,
  parseContributionRecordProvenance,
  parseShippedBaselineExclusions,
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
    `## ${version}`,
    "### Highlights\n\n- A grouped user-facing highlight.",
    "### Fixes\n\n- A grouped user-facing fix.",
    `### Complete contribution record\n\n${record}`,
    "## 2026.6.11\n\n- Previous release.\n",
  ].join("\n\n");
}

function renderNotes(
  changelog: string,
  options: Partial<Parameters<typeof renderGithubReleaseNotes>[0]> = {},
) {
  return renderGithubReleaseNotes({ version, tag, repository, changelog, ...options });
}

function verifyNotes(
  body: string,
  options: Pick<Parameters<typeof verifyGithubReleaseNotes>[0], "changelog"> &
    Partial<Parameters<typeof verifyGithubReleaseNotes>[0]>,
) {
  return verifyGithubReleaseNotes({ version, tag, repository, ...options, body });
}

function releaseRepo() {
  const rootDir = tempDirs.make("openclaw-release-render-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Release Fixture");
  git("config", "user.email", "release-fixture@openclaw.invalid");
  git("config", "commit.gpgsign", "false");
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "release fixture");
    return git("rev-parse", "HEAD");
  };
  const render = (ref: string, releaseTag = tag, extra: string[] = []) =>
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
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  return { rootDir, commit, render };
}

describe("GitHub release-note rendering", () => {
  it("refuses docs-mirror source in the initial renderer", () => {
    expect(() =>
      renderNotes(
        `## ${version}\n\n<!-- openclaw-docs-mirror-v1 {} -->\n\nPublished reader prose.\n`,
      ),
    ).toThrow("docs-publication renderer");
  });

  it("renders pinned legacy and split compact sources through the CLI", () => {
    const { rootDir, commit, render } = releaseRepo();
    const changelog = changelogFor(`- **PR #123** ${"record ".repeat(20_000)}`);
    writeFileSync(join(rootDir, "CHANGELOG.md"), changelog);
    const legacy = commit();
    splitChangelog({ rootDir });
    const split = commit();
    writeFileSync(
      join(rootDir, `CHANGELOG/${version}.md`),
      `## ${version}\n\nUncommitted drift.\n`,
    );
    const legacyBody = render(legacy);
    const splitBody = render(split);
    const bodyPath = join(rootDir, "release-body.md");
    writeFileSync(bodyPath, splitBody);
    const verify = () => render(split, tag, ["--verify-body", bodyPath]);
    expect(verify()).toBe("");
    writeFileSync(bodyPath, `${splitBody}\nUnapproved appended prose.\n`);
    expect(verify).toThrow("Release body does not match canonical release notes.");
    expect(legacyBody).not.toContain("Uncommitted drift");
    expect(splitBody).not.toContain("Uncommitted drift");
    expect(legacyBody).toContain(`/blob/${tag}/CHANGELOG.md#complete-contribution-record`);
    expect(splitBody).toContain(
      `/blob/${tag}/CHANGELOG/records/${version}.md#complete-contribution-record`,
    );
    expect(splitBody).toBe(
      legacyBody.replace("/CHANGELOG.md#", `/CHANGELOG/records/${version}.md#`),
    );
  });

  it("renders and verifies a pinned beta delta instead of cumulative stable notes", () => {
    const { rootDir, commit, render } = releaseRepo();
    const delta = `## ${tag.slice(1)}\n\n### Fixes\n\n- New beta-only fix.`;
    writeFileSync(
      join(rootDir, "CHANGELOG.md"),
      `${delta}\n\n## ${version}\n\n- Cumulative stable feature.\n`,
    );
    splitChangelog({ rootDir });
    const ref = commit();
    writeFileSync(join(rootDir, `CHANGELOG/${tag.slice(1)}.md`), `${delta}\nUncommitted drift.\n`);
    expect(render(ref)).toBe(delta);
    expect(render(ref, `v${version}`)).toBe(`## ${version}\n\n- Cumulative stable feature.`);
    const bodyPath = join(rootDir, "body.md");
    writeFileSync(bodyPath, delta);
    expect(render(ref, tag, ["--version", tag.slice(1), "--verify-body", bodyPath])).toBe("");
  });

  it("round-trips canonical contribution provenance and accepts published legacy lines", () => {
    const target = "a".repeat(40);
    const canonical = {
      base: "v2026.7.2-beta.7",
      target,
      inRangePullRequests: 1,
      retainedSeedOnlyPullRequests: 0,
      uniquePullRequests: 1,
    };
    const singular = formatContributionRecordProvenance(canonical);
    const commaSeparated = formatContributionRecordProvenance({
      ...canonical,
      inRangePullRequests: 1_234,
      retainedSeedOnlyPullRequests: 56,
      uniquePullRequests: 1_290,
    });

    expect(singular).toContain("1 in-range PR + 0 retained seed-only PRs = 1 unique PR.");
    expect(commaSeparated).toContain(
      "1,234 in-range PRs + 56 retained seed-only PRs = 1,290 unique PRs.",
    );
    expect(
      parseContributionRecordProvenance(`${singular}\n\n#### Pull requests\n\n- **PR #123** fix.`),
    ).toEqual(canonical);
    const legacy = parseContributionRecordProvenance(
      `This audited record covers the complete v2026.7.2-beta.6..${target} history: 1 merged PR.\n\n#### Pull requests\n\n- **PR #123** fix.`,
    );
    expect(legacy).toMatchObject({ uniquePullRequests: 1 });
    expect(() => formatContributionRecordProvenance(legacy!)).toThrow("requires split PR counts");
    for (const [line, error] of [
      [
        commaSeparated.replace("= 1,290 unique PRs", "= 1,291 unique PRs"),
        "provenance arithmetic is invalid",
      ],
      [commaSeparated.replace("1,234", "1234"), "provenance is malformed"],
    ] as const) {
      expect(() => parseContributionRecordProvenance(line)).toThrow(error);
    }
    expect(() => parseContributionRecordProvenance(singular)).toThrow(
      "positive contribution record requires a Pull requests section",
    );
  });

  it("prefixes extended-stable notes with immutable regular-stable context", () => {
    const changelog = "## 2026.8.35\n\n- Fix.";
    const options = { version: "2026.8.35", tag: "v2026.8.35" };
    const rendered = renderNotes(changelog, { ...options, regularStableVersion: "2026.9.5" });

    expect(rendered.body).toMatch(/^This is a gateway-only `extended-stable` release/);
    expect(rendered.body).toContain("end of August 2026");
    expect(rendered.body).toContain(
      "[2026.9.5](https://github.com/openclaw/openclaw/releases#release-v2026.9.5)\n\n## 2026.8.35",
    );
    expect(() => renderNotes(changelog, options)).toThrow(
      "regular stable version must be a string",
    );
  });

  it("uses the full form at exactly 125,000 bytes and compacts at 125,001", () => {
    const seed = renderNotes(changelogFor("x"));
    const exactRecordLength =
      GITHUB_RELEASE_BODY_MAX_BYTES - seed.size.bytes + Buffer.byteLength("x");
    const exact = renderNotes(changelogFor("x".repeat(exactRecordLength)));
    const over = renderNotes(changelogFor("x".repeat(exactRecordLength + 1)));

    expect(exact.mode).toBe("full");
    expect(exact.size).toEqual({
      characters: GITHUB_RELEASE_BODY_MAX_CHARACTERS,
      bytes: GITHUB_RELEASE_BODY_MAX_BYTES,
    });
    expect(over.mode).toBe("compact");
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
      renderNotes(changelogFor("- **PR #123** fix: example."), {
        tag: "v2026.7.2-beta.1",
      }),
    ).toThrow("requires CHANGELOG.md version 2026.7.2");

    expect(() =>
      renderNotes(
        changelogFor(`### Complete contribution ledger\n\n${"legacy ".repeat(20_000)}`).replace(
          "### Complete contribution record\n\n",
          "",
        ),
      ),
    ).toThrow("cannot be compacted without a complete contribution record");
  });

  it.each([
    ["v2026.7.1-2", "2026.7.1", "2026.7.1"],
    ["v2026.7.1-alpha.2", "2026.7.1-alpha.2", "2026.7.1-alpha.2"],
    ["v2026.7.1-alpha.1", "Unreleased", "2026.7.1"],
  ])("selects the canonical section for %s", (releaseTag, heading, selected) => {
    const changelog = `## ${heading}\n\n- Fix.\n\n## 2026.6.11\n\n- Old.`;
    expect(renderNotes(changelog, { tag: releaseTag }).body).toBe(`## ${selected}\n\n- Fix.`);
  });

  it("rejects the Unreleased fallback for non-alpha and malformed tags", () => {
    const changelog = "## Unreleased\n\n- Fix.";
    expect(() => renderNotes(changelog)).toThrow("CHANGELOG.md does not contain ## 2026.7.1");
    expect(() =>
      renderNotes(changelog, {
        version: "foo",
        tag: "vfoo-alpha.1",
      }),
    ).toThrow("invalid release tag");
  });

  it("compacts at the real contribution record instead of a fenced pseudo-heading", () => {
    const changelog = changelogFor(`- **PR #123** ${"record-only-detail ".repeat(9_000)}`).replace(
      "### Fixes",
      ["```md", "### Complete contribution record", "```", "", "### Fixes"].join("\n"),
    );
    const rendered = renderNotes(changelog);

    expect(rendered.mode).toBe("compact");
    expect(rendered.body).toContain("```md\n### Complete contribution record\n```");
    expect(rendered.body).toContain("- A grouped user-facing fix.");
    expect(rendered.body).not.toContain("record-only-detail");
  });

  it("verifies the exact generated compact body and optional proof tail", () => {
    const changelog = changelogFor(`- **PR #123** ${"z".repeat(130_000)}`);
    const verification = "### Release verification\n\n- release SHA: `abc123`";
    const rendered = renderNotes(changelog, { verification });

    expect(verifyNotes(rendered.body, { changelog })).toMatchObject({
      matches: true,
      mode: "compact",
    });
    expect(verifyNotes(rendered.body.replace("tag-pinned", "mutable"), { changelog }).matches).toBe(
      false,
    );
    expect(verifyNotes(rendered.body, { changelog, tag: "v2026.7.1-beta.2" }).matches).toBe(false);
  });
});
