import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalMainCommitMatches,
  canonicalPullRequests,
  classifyUnavailableContextualReferences,
  collectReleaseProvenanceOverrides,
  contaminatingPullRequestReferences,
  contributionRecordTarget,
  countTopLevelSectionBullets,
  createGithubSnapshotState,
  cumulativeShippedPullRequests,
  defaultGithubSnapshotPath,
  githubApiWithSnapshot,
  githubNotFoundReferences,
  highlightCountError,
  isEligibleHandle,
  ledgerChecks,
  parseArgs,
  persistGithubSnapshot,
  pullRequestTitleFromCommitSubject,
  releaseNoteReferences,
  releasePullRequestReferencesToSuppress,
  releaseProvenanceMarkers,
  recoverUnavailablePullRequests,
  renderedContributionRecordReferences,
  resolvedReleasePullRequests,
  standardRevertedHash,
  subtractShippedPullRequests,
  validateReleaseProvenanceOverrides,
  withoutExcludedContributionRecords,
} from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";
import { splitChangelog, writeReleaseChangelog } from "../../scripts/lib/release-changelog.mjs";
import { renderGithubReleaseNotes } from "../../scripts/render-github-release-notes.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createReleaseNotesFixtureLines(): string[] {
  return [
    "# Changelog",
    "",
    "## 2026.7.1",
    "",
    "### Highlights",
    "",
    ...["One", "Two", "Three", "Four", "Five"].map((word) => `- ${word}.`),
    "",
    "### Changes",
    "",
    "### Fixes",
    "",
  ];
}

function contributionRecord(
  base: string,
  target: string,
  rows: string[],
  partition = `${rows.length} in-range PRs + 0 retained seed-only PRs = ${rows.length} unique PRs.`,
) {
  return `### Complete contribution record\n\nThis audited record covers the complete ${base}..${target} history: ${partition}\n\n#### Pull requests\n\n${rows.join("\n")}\n`;
}

function commitAll(cwd: string, message: string, extraEnv: Record<string, string> = {}) {
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "--allow-empty", "-qm", message], extraEnv);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function seedRepository(
  prefix: string,
  branch?: string,
  changelog = createReleaseNotesFixtureLines().join("\n"),
) {
  const cwd = tempDirs.make(prefix);
  git(cwd, ["init", "-q", ...(branch ? ["-b", branch] : [])]);
  writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
  return { cwd, base: commitAll(cwd, "chore: baseline"), changelog };
}

const verifier = resolve(
  ".agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs",
);

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "test@openclaw.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "test@openclaw.invalid",
      ...extraEnv,
    },
  }).trim();
}

function runVerifier(
  cwd: string,
  {
    base = "HEAD",
    version = "2026.7.1",
    target = "HEAD",
    mainRef = target,
    manifest,
    extraArgs = [],
    write = true,
    json = true,
    preload,
    env = {},
  }: {
    base?: string | null;
    version?: string;
    target?: string;
    mainRef?: string | null;
    manifest?: string;
    extraArgs?: string[];
    write?: boolean;
    json?: boolean;
    preload?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return spawnSync(
    process.execPath,
    [
      ...(preload ? ["--import", preload] : []),
      verifier,
      ...(base === null ? [] : ["--base", base]),
      "--target",
      target,
      ...(mainRef === null ? [] : ["--main-ref", mainRef]),
      "--version",
      version,
      ...(manifest ? ["--manifest", manifest] : []),
      ...(write ? ["--write-ledger"] : []),
      ...(json ? ["--json"] : []),
      ...extraArgs,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

describe("release-note verification", () => {
  it("rejects an off-branch generation target before release-note discovery", () => {
    const cwd = tempDirs.make("openclaw-off-branch-notes-");
    git(cwd, ["init", "-q", "-b", "main"]);
    git(cwd, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(cwd, "CHANGELOG.md"), createReleaseNotesFixtureLines().join("\n"));
    splitChangelog({ rootDir: cwd });
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-qm", "docs: seed changelog"]);
    const base = git(cwd, ["rev-parse", "HEAD"]);
    git(cwd, ["branch", "release/2026.7.1", base]);
    writeFileSync(join(cwd, "off-branch.txt"), "wrong worktree\n");
    git(cwd, ["add", "off-branch.txt"]);
    git(cwd, ["commit", "-qm", "docs: prepare notes elsewhere"]);

    const result = runVerifier(cwd, {
      base,
      target: "HEAD",
      extraArgs: ["--release-branch", "release/2026.7.1"],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "is not reachable from canonical release branch release/2026.7.1",
    );
    expect(readdirSync(join(cwd, ".git"))).not.toContain("openclaw-release-cache");
  });

  it("initializes a missing target section before writing its contribution record", () => {
    const cwd = tempDirs.make("openclaw-initial-release-notes-");
    git(cwd, ["init", "-q"]);
    git(cwd, ["config", "commit.gpgsign", "false"]);
    writeFileSync(
      join(cwd, "CHANGELOG.md"),
      createReleaseNotesFixtureLines().join("\n").replace("2026.7.1", "2026.6.11"),
    );
    splitChangelog({ rootDir: cwd });
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-qm", "docs: seed changelog"]);
    const target = git(cwd, ["rev-parse", "HEAD"]);
    const version = "2026.7.1-beta.1";

    const result = runVerifier(cwd, { base: target, target, version });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(join(cwd, `CHANGELOG/${version}.md`), "utf8")).toContain(
      [`## ${version}`, "", "### Highlights", "", "### Changes", "", "### Fixes"].join("\n"),
    );
    expect(readFileSync(join(cwd, `CHANGELOG/records/${version}.md`), "utf8")).toContain(
      "0 in-range PRs + 0 retained seed-only PRs = 0 unique PRs",
    );
  });

  it("verifies extended-stable GitHub notes with their regular-stable context", () => {
    const cwd = tempDirs.make("openclaw-extended-stable-notes-");
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    git(cwd, ["init", "-q", "-b", "main"]);
    const version = "2026.8.35";
    const tag = `v${version}`;
    const regularStableVersion = "2026.9.5";
    const changelog = createReleaseNotesFixtureLines().join("\n").replace("2026.7.1", version);
    writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
    git(cwd, ["add", "CHANGELOG.md"]);
    git(cwd, ["commit", "-qm", "initial"]);
    const target = git(cwd, ["rev-parse", "HEAD"]);
    const verifiedChangelog = `${changelog}\n${contributionRecord("HEAD", target, [], "0 in-range PRs + 0 retained seed-only PRs = 0 unique PRs.")}`;
    writeFileSync(join(cwd, "CHANGELOG.md"), verifiedChangelog);
    const body = renderGithubReleaseNotes({
      changelog: verifiedChangelog,
      version,
      tag,
      repository: "openclaw/openclaw",
      regularStableVersion,
    }).body;
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ id: 1, body }))});\n`,
    );
    chmodSync(gh, 0o755);

    const result = runVerifier(cwd, {
      version,
      write: false,
      extraArgs: [
        "--release-tag",
        tag,
        "--check-github",
        "--regular-stable-version",
        regularStableVersion,
      ],
      env: { PATH: `${bin}:${process.env.PATH}` },
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(JSON.parse(result.stdout).github).toMatchObject([{ tag, matches: true }]);
  });

  it.each([
    { previous: "2026.6.11", divergent: false },
    { previous: "2026.7.1-beta.2", divergent: false },
    { previous: "2026.6.11", divergent: true },
    { previous: "2026.7.1-beta.2", divergent: true },
  ])(
    "freezes npm beta $previous (divergent=$divergent) and reuses it after publication",
    ({ previous, divergent }) => {
      const cwd = tempDirs.make("openclaw-npm-beta-notes-");
      git(cwd, ["init", "-q"]);
      git(cwd, ["config", "commit.gpgsign", "false"]);
      const version = "2026.7.1-beta.3";
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        `## ${version}\n\n### Highlights\n\n### Changes\n\n### Fixes\n`,
      );
      splitChangelog({ rootDir: cwd });
      git(cwd, ["add", "."]);
      git(cwd, ["commit", "-qm", "docs: prepare delta"]);
      const target = git(cwd, ["rev-parse", "HEAD"]);
      if (divergent) {
        git(cwd, ["checkout", "-qb", "shipped"]);
        writeReleaseChangelog({
          rootDir: cwd,
          version: previous,
          section: `## ${previous}\n\n### Complete contribution record\n\nThis audited record covers the complete ${target}..${target} history: 0 in-range PRs + 0 retained seed-only PRs = 0 unique PRs.\n`,
        });
        git(cwd, ["add", "."]);
        git(cwd, ["commit", "-qm", "docs: shipped record"]);
        git(cwd, ["tag", `v${previous}`]);
        git(cwd, ["checkout", "-q", "--detach", target]);
      } else {
        git(cwd, ["tag", `v${previous}`]);
      }
      const npm = join(cwd, "npm");
      writeFileSync(
        npm,
        `#!${process.execPath}\nconsole.log(JSON.stringify(process.env.TEST_NPM_BETA));\n`,
      );
      chmodSync(npm, 0o755);
      const manifest = join(cwd, "manifest.json");
      const env = { PATH: `${cwd}:${process.env.PATH}`, TEST_NPM_BETA: previous };
      const result = runVerifier(cwd, { base: null, version, target, manifest, env });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const capturedBase = divergent ? target : `v${previous}`;
      expect(JSON.parse(readFileSync(manifest, "utf8"))).toMatchObject({
        base: capturedBase,
        target,
        version,
      });
      const record = readFileSync(join(cwd, `CHANGELOG/records/${version}.md`), "utf8");
      expect(record).toContain(`${capturedBase}..${target}`);
      if (divergent) {
        expect(record).toContain(`Shipped baseline exclusions: v${previous} (0 PRs).`);
      }
      const publishedEnv = { ...env, TEST_NPM_BETA: version };
      const refused = runVerifier(cwd, { base: "npm-beta", version, target, env: publishedEnv });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("reuse the previously captured --base tag");
      const recovery = runVerifier(cwd, {
        base: `v${previous}`,
        version,
        target,
        write: false,
        env: publishedEnv,
      });
      expect(recovery.status, recovery.stderr || recovery.stdout).toBe(0);
    },
  );

  it("refuses docs mirrors before source or GitHub work and preserves frozen records", () => {
    const cwd = tempDirs.make("openclaw-mirror-generation-");
    writeFileSync(
      join(cwd, "CHANGELOG.md"),
      [
        ...createReleaseNotesFixtureLines(),
        "### Complete contribution record",
        "",
        "#### Pull requests",
        "",
        "- **PR #12** Original accounting.",
        "",
      ].join("\n"),
    );
    splitChangelog({ rootDir: cwd });
    const entryPath = join(cwd, "CHANGELOG/2026.7.1.md");
    const recordPath = join(cwd, "CHANGELOG/records/2026.7.1.md");
    const mirror = "## 2026.7.1\n\n<!-- openclaw-docs-mirror-v1 {} -->\n\nApproved reader prose.\n";
    writeFileSync(entryPath, mirror);
    const record = readFileSync(recordPath, "utf8");
    const index = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
    const result = runVerifier(cwd, {
      base: "absent",
      target: "absent",
      mainRef: null,
      json: false,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("docs-publication workflow");
    expect(readFileSync(entryPath, "utf8")).toBe(mirror);
    expect(readFileSync(recordPath, "utf8")).toBe(record);
    expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(index);
  });

  it("credits human maintainers but excludes automation identities", () => {
    expect(isEligibleHandle("human-contributor")).toBe(true);
    expect(isEligibleHandle("steipete")).toBe(true);
    expect(isEligibleHandle("steipete-oai")).toBe(false);
    expect(isEligibleHandle("hugin-bot")).toBe(false);
    expect(isEligibleHandle("roboclaw-bot")).toBe(false);
  });

  it("accepts only canonical commit PR suffixes", () => {
    const repeated = "Fix status (#102147) (#102147)";
    const distinct = "Fix status (#120582) (#120584)";
    expect(pullRequestTitleFromCommitSubject("Fix status (#102147)", 102147)).toBe("Fix status");
    expect(pullRequestTitleFromCommitSubject(repeated, 102147)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject(distinct, 120584)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject("Fix status(#102147)", 102147)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject("Fix status (#0102147)", 102147)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject(" Fix status (#102147)", 102147)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject("Fix status (#102147) ", 102147)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject("Fix status (#102148)", 102147)).toBeUndefined();
  });

  it("reads the exact target from a generated contribution record", () => {
    const target = "a".repeat(40);
    expect(
      contributionRecordTarget({
        source: `## 2026.7.2\n\n${contributionRecord("base", target, ["- **PR #123** fix: example."])}`,
      }),
    ).toBe(target);
  });

  it("reports deleted contextual references without rendering or crediting them", () => {
    const { cwd, base } = seedRepository("openclaw-release-notes-deleted-ref-", "main");
    git(cwd, [
      "commit",
      "--allow-empty",
      "-qm",
      "fix: preserve release references (#156166)",
      "-m",
      "#155121 took a similar approach and was closed by its author.",
    ]);
    const target = git(cwd, ["rev-parse", "HEAD"]);
    const gh = join(cwd, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
const data = {};
const errors = [];
const pullRequest = {
  __typename: "PullRequest", number: 156166, title: "fix: preserve release references",
  baseRefName: "main", mergedAt: "2026-01-01T00:00:00Z",
  mergeCommit: { oid: ${JSON.stringify(target)} },
  author: { __typename: "User", login: "contributor" },
  closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
};
for (const [, alias] of query.matchAll(/(c\\d+): repository/g)) {
  data[alias] = { object: { associatedPullRequests: { nodes: [pullRequest], pageInfo: { hasNextPage: false } } } };
}
for (const [, alias] of query.matchAll(/(n\\d+): repository/g)) {
  data[alias] = { issueOrPullRequest: alias === "n156166" ? pullRequest : null };
  if (alias === "n155121") errors.push({ type: "NOT_FOUND", path: [alias, "issueOrPullRequest"], message: "Could not resolve ..." });
}
console.log(JSON.stringify({ data, errors }));
process.exitCode = errors.length ? 1 : 0;
`,
    );
    chmodSync(gh, 0o755);
    splitChangelog({ rootDir: cwd });
    const manifestPath = join(cwd, "manifest.json");
    const result = runVerifier(cwd, {
      base,
      target,
      manifest: manifestPath,
      extraArgs: ["--no-github-snapshot"],
      env: { PATH: `${cwd}:${process.env.PATH}` },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("unavailable contextual references (GitHub NOT_FOUND): #155121\n");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.unavailableReferences).toEqual([
      { number: 155121, commits: [target.slice(0, 12)] },
    ]);
    expect(manifest.pullRequests).toMatchObject([{ number: 156166, thanks: ["contributor"] }]);
    expect(manifest.pullRequests).toHaveLength(1);
    expect(manifest.pullRequests[0].relatedReferences).toEqual([]);
    expect(JSON.parse(result.stdout).source.references).toBe(1);
    const record = readFileSync(join(cwd, "CHANGELOG/records/2026.7.1.md"), "utf8");
    expect(record).toContain("**PR #156166** Thanks @contributor.");
    expect(record).not.toContain("155121");
  });

  it("sorts and deduplicates unavailable contextual references", () => {
    const hash = "b".repeat(40);
    expect(
      classifyUnavailableContextualReferences({
        unresolved: [155121, 155120, 155119],
        notFound: new Set([155120, 155121]),
        activeCommits: [
          { hash, subject: "fix: source", body: "#155121 #155121 #155120" },
          { hash: "a".repeat(40), subject: "fix: follow-up", body: "#155121" },
        ],
        protectedReferences: new Set(),
        highestResolved: 156166,
      }),
    ).toEqual({
      unavailable: [
        { number: 155120, commits: ["bbbbbbbbbbbb"] },
        { number: 155121, commits: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"] },
      ],
      stillUnresolved: [155119],
    });
  });

  it.each([
    { subject: "fix: implementation (#155121)" },
    { body: "Fixes #155121." },
    { body: "Resolves #12 and #155121." },
    { protectedReference: true },
    { notFound: false },
    { highestResolved: 155121 },
    { body: "No contextual reference." },
    { otherSubject: "fix: #155121" },
  ])("preserves required or unclassified references: %j", (scenario) => {
    expect(
      classifyUnavailableContextualReferences({
        unresolved: [155121],
        notFound: new Set(scenario.notFound === false ? [] : [155121]),
        activeCommits: [
          {
            hash: "a".repeat(40),
            subject: scenario.subject ?? "fix: source",
            body: scenario.body ?? "#155121 took a similar approach.",
          },
          { hash: "b".repeat(40), subject: scenario.otherSubject ?? "fix: follow-up", body: "" },
        ],
        protectedReferences: new Set(scenario.protectedReference ? [155121] : []),
        highestResolved: scenario.highestResolved ?? 156166,
      }),
    ).toEqual({ unavailable: [], stillUnresolved: [155121] });
  });

  it.each([
    { type: "NOT_FOUND", path: ["n155121", "issueOrPullRequest"], expected: [155121] },
    { type: "FORBIDDEN", path: ["n155121", "issueOrPullRequest"], expected: [] },
    { type: "not_found", path: ["n155121", "issueOrPullRequest"], expected: [] },
    { type: "NOT_FOUND", path: ["n155122", "issueOrPullRequest"], expected: [] },
    { type: "NOT_FOUND", path: ["n155121"], expected: [] },
    { type: "NOT_FOUND", path: ["n155121", "issueOrPullRequest", "author"], expected: [] },
    { type: "NOT_FOUND", path: ["n155121", "otherField"], expected: [] },
    { type: "NOT_FOUND", path: undefined, expected: [] },
  ])("captures only exact NOT_FOUND issue/PR paths: %j", ({ type, path, expected }) => {
    expect(
      githubNotFoundReferences(
        {
          data: { n155121: { issueOrPullRequest: null } },
          errors: [{ type, path, message: "Could not resolve ..." }],
        },
        [155121],
      ),
    ).toEqual(expected);
    expect(githubNotFoundReferences({ data: { n155121: null } }, [155121])).toEqual([]);
  });

  it.each(["covered", "noncanonical", "ambiguous"])(
    "recovers vanished PRs only from exact covered provenance: %s",
    (mode) => {
      const number = 102147;
      const commit = {
        authorHandle: "release-operator",
        closingReferences: [102146],
        coauthors: [],
        committedAt: "2026-07-01T12:00:00Z",
        hash: "a".repeat(40),
        pullRequests: [],
        references: [number],
        subject:
          mode === "noncanonical"
            ? `Fix status; refs #${number}`
            : mode === "ambiguous"
              ? `Fix status (#${number})`
              : `Fix silent maintenance delivery status (#${number})`,
      };
      const source = {
        activeCommits: [
          commit,
          ...(mode === "ambiguous"
            ? [
                {
                  ...commit,
                  committedAt: "2026-07-02T12:00:00Z",
                  hash: "d".repeat(40),
                  subject: `Fix status again (#${number})`,
                },
              ]
            : []),
        ],
        pullRequests: new Set<number>(),
        target: "c".repeat(40),
      };
      const nodes = new Map();
      const recovered = recoverUnavailablePullRequests({
        numbers: [number],
        nodes,
        record: {
          pullRequests: new Map([[number, { references: [], thanks: ["coolmanns"] }]]),
        },
        recordTarget: "b".repeat(40),
        source,
        isAncestor: (left: string, right: string) =>
          mode !== "ambiguous" ||
          (left === "b".repeat(40) && right === source.target) ||
          (left === commit.hash && right === "b".repeat(40)),
      });

      if (mode !== "covered") {
        expect(recovered).toEqual(new Map());
        return;
      }

      expect(recovered.get(number)).toMatchObject({
        __typename: "PullRequest",
        number,
        title: "Fix silent maintenance delivery status",
        mergedAt: commit.committedAt,
        mergeCommit: { oid: commit.hash },
        recordedThanks: ["coolmanns"],
      });
      expect(commit.pullRequests).toEqual([number]);
      expect(source.pullRequests).toEqual(new Set([number]));
      expect(recovered.get(number)).not.toHaveProperty("author");
    },
  );

  it("stores default GitHub snapshots in the shared Git common directory", () => {
    const commonDir = resolve("/tmp/openclaw-shared-git");
    expect(defaultGithubSnapshotPath("a".repeat(40), "b".repeat(40), commonDir)).toBe(
      join(
        commonDir,
        "openclaw-release-cache",
        `verify-release-notes-${"a".repeat(40)}-${"b".repeat(40)}.json`,
      ),
    );
  });

  it.each(["commit", "CLI"])("accepts exact release provenance from %s inputs", (mode) => {
    const hash = "a".repeat(40);
    const payload = `${hash} -> #1, #2`;
    const args =
      mode === "CLI"
        ? parseArgs([
            "--base",
            "base",
            "--target",
            "target",
            "--version",
            "2026.8.1",
            "--release-provenance",
            payload,
          ]).releaseProvenance
        : [];
    const body =
      mode === "commit"
        ? `Release provenance: ${payload}
Release provenance for ${hash} -> #3`
        : "";
    expect(collectReleaseProvenanceOverrides([{ hash, body }], args)).toEqual(
      new Map([[hash, [1, 2]]]),
    );
    if (mode === "CLI") {
      expect(args).toEqual([payload]);
    } else {
      expect(releaseProvenanceMarkers(body)).toEqual([{ commit: hash, pullRequests: [1, 2] }]);
      expect(resolvedReleasePullRequests([3], [], false, [1, 2])).toEqual([1, 2]);
      expect(releasePullRequestReferencesToSuppress([], "fix: subject (#3)", [1, 2], true)).toEqual(
        [3],
      );
    }
  });

  it.each(["commit", "CLI"])(
    "rejects malformed, out-of-range, or conflicting %s provenance",
    (mode) => {
      const hash = "a".repeat(40);
      const collect = (payloads: string[]) =>
        collectReleaseProvenanceOverrides(
          [
            {
              hash,
              body:
                mode === "commit"
                  ? payloads.map((value) => `Release provenance: ${value}`).join("\n")
                  : "",
            },
          ],
          mode === "CLI" ? payloads : [],
        );
      const malformed =
        mode === "CLI"
          ? [
              "short -> #1",
              `${hash} -> #1 trailing`,
              `${hash} -> #1\nRelease provenance: ${hash} -> #2`,
              `${hash} -> #1\n`,
              `${hash} -> #1,\n#2`,
              `${hash} -> #1\r\n`,
            ]
          : ["short -> #1"];
      for (const value of malformed) {
        expect(() => collect([value])).toThrow("invalid release provenance marker");
      }
      expect(() => collect([`${"b".repeat(40)} -> #1`])).toThrow(
        "targets commit outside the active range",
      );
      expect(() => collect([`${hash} -> #1`, `${hash} -> #2`])).toThrow(
        `conflicting release provenance markers for ${hash}`,
      );
      if (mode === "CLI") {
        expect(() =>
          collectReleaseProvenanceOverrides(
            [{ hash, body: `Release provenance: ${hash} -> #1` }],
            [`${hash} -> #2`],
          ),
        ).toThrow(`conflicting release provenance markers for ${hash}`);
      }
    },
  );

  it("requires release provenance PRs to be merged into current main", () => {
    const releaseCommit = "a".repeat(40);
    const mainCommit = "b".repeat(40);
    const mergeCommit = "c".repeat(40);
    const overrides = new Map([[releaseCommit, [104905]]]);
    const validNode = {
      __typename: "PullRequest",
      baseRefName: "main",
      mergeCommit: { oid: mergeCommit },
      mergedAt: "2026-07-12T00:00:00Z",
    };

    const validate = (
      node: Omit<typeof validNode, "mergedAt"> & { mergedAt: string | null },
      ancestor = true,
    ) =>
      validateReleaseProvenanceOverrides(
        overrides,
        new Map([[104905, node]]),
        mainCommit,
        () => ancestor,
      );
    expect(() => validate(validNode)).not.toThrow();
    for (const node of [
      { ...validNode, baseRefName: "release/2026.7.1" },
      { ...validNode, mergedAt: null },
    ]) {
      expect(() => validate(node)).toThrow("references non-main PR #104905");
    }
    expect(() => validate(validNode, false)).toThrow("references non-main PR #104905");
  });

  it("validates release provenance PRs that shipped-ref subtraction left unresolved", () => {
    const releaseCommit = "a".repeat(40);
    const mainCommit = "b".repeat(40);
    const overrides = new Map([[releaseCommit, [104905]]]);
    const mainNode = {
      __typename: "PullRequest",
      baseRefName: "main",
      mergeCommit: { oid: "c".repeat(40) },
      mergedAt: "2026-07-12T00:00:00Z",
    };
    const requested: number[][] = [];
    const resolveWith = (node?: unknown) => (numbers: number[]) => {
      requested.push(numbers);
      return new Map(node ? [[104905, node]] : []);
    };

    const validate = (node?: unknown) =>
      validateReleaseProvenanceOverrides(
        overrides,
        new Map(),
        mainCommit,
        () => true,
        resolveWith(node),
      );
    expect(() => validate(mainNode)).not.toThrow();
    expect(requested).toEqual([[104905]]);
    for (const node of [{ ...mainNode, baseRefName: "release/2026.7.1" }, undefined]) {
      expect(() => validate(node)).toThrow("references non-main PR #104905");
    }
  });

  it("matches canonical main commits only by unambiguous provenance", () => {
    const identity = {
      authorEmail: "maintainer@example.com",
      authorName: "Maintainer",
      changedPaths: new Set(["src/channel.ts"]),
      subject: "fix(channel): preserve durable replies",
    };
    const main = { ...identity, body: "", hash: "a".repeat(40), pullRequests: [123] };
    const release = {
      ...identity,
      body: "Backport of #123 to release/2026.7.1.",
      hash: "b".repeat(40),
    };
    const matches = (patch = {}, candidates = [main]) =>
      canonicalMainCommitMatches({ ...release, ...patch }, candidates);
    expect(matches()).toEqual([main.hash]);
    expect(
      matches({
        body: `(cherry picked from commit ${main.hash})`,
        authorEmail: "other@example.com",
        authorName: "Other",
      }),
    ).toEqual([main.hash]);
    expect(
      matches({ body: "", changedPaths: new Set(["src/channel.ts", "src/release.ts"]) }),
    ).toEqual([main.hash]);
    for (const patch of [
      { authorEmail: "other@example.com", authorName: "Other" },
      { changedPaths: new Set(["src/other.ts"]) },
      { body: "Related #123.", subject: "different" },
    ]) {
      expect(matches(patch)).toEqual([]);
    }
    expect(matches({}, [{ ...main, pullRequests: [], body: "Original main PR #123." }])).toEqual(
      [],
    );
    expect(matches({}, [{ ...main, pullRequests: [999], subject: release.subject }])).toEqual([]);
    expect(matches({}, [main, { ...main, hash: "c".repeat(40) }])).toEqual([]);
    expect(matches({ body: "" }, [main, { ...main, hash: "c".repeat(40) }])).toEqual([]);
    expect(
      matches({}, [
        main,
        { ...main, hash: "c".repeat(40), pullRequests: [], body: "Original main PR #123." },
      ]),
    ).toEqual([main.hash]);
    const subject = "fix(gateway): retain work admission";
    expect(
      matches({ body: "", subject: `${subject} (#120582) (#120584)` }, [
        { ...main, subject: `${subject} (#120582)` },
      ]),
    ).toEqual([main.hash]);
    expect(
      matches({ body: "", subject: `${subject}(#120582) (#120584)` }, [
        { ...main, subject: `${subject} (#120582)` },
      ]),
    ).toEqual([]);
    expect(canonicalPullRequests([456], [], true)).toEqual([]);
    expect(canonicalPullRequests([456], [])).toEqual([456]);
    expect(canonicalPullRequests([456], [123])).toEqual([123]);
  });

  it.each(["reuse", "checkpoint", "transient-error", "target-mismatch"])(
    "preserves exact-range GitHub snapshot lifecycle: %s",
    (mode) => {
      const filePath = join(tempDirs.make("release-snapshot-"), "snapshot.json");
      let fetches = 0;
      const fetchedArgs: string[][] = [];
      const fetchApi = (args: string[]) => {
        fetches += 1;
        fetchedArgs.push(args);
        return mode === "transient-error" && fetches === 1
          ? { errors: [{ message: "rate limited" }] }
          : { data: fetches };
      };
      const options = { base: "a".repeat(40), target: "b".repeat(40), filePath };
      const state = createGithubSnapshotState({
        ...options,
        ...(mode === "checkpoint" ? { checkpointEvery: 2 } : {}),
      });
      const args = ["graphql", "-f", "query=one"];
      const first = githubApiWithSnapshot(args, fetchApi, state);
      if (mode === "transient-error") {
        expect(first).toEqual({ errors: [{ message: "rate limited" }] });
        expect(state.dirty).toBe(false);
        expect(state.responses).toEqual({});
        expect(githubApiWithSnapshot(args, fetchApi, state)).toEqual({ data: 2 });
        expect([state.misses, fetches]).toEqual([2, 2]);
      } else if (mode === "checkpoint") {
        expect(state).toMatchObject({ dirty: true, writesSincePersist: 1 });
        const secondArgs = ["graphql", "-f", "query=two"];
        githubApiWithSnapshot(secondArgs, fetchApi, state);
        expect(state).toMatchObject({ dirty: false, writesSincePersist: 0 });
        expect(JSON.parse(readFileSync(filePath, "utf8")).responses).toHaveProperty(
          JSON.stringify(secondArgs),
        );
      } else if (mode === "target-mismatch") {
        persistGithubSnapshot(state);
        expect(() => createGithubSnapshotState({ ...options, target: "c".repeat(40) })).toThrow(
          "use --refresh-github-snapshot",
        );
      } else {
        expect(first).toEqual({ data: 1 });
        expect(
          githubApiWithSnapshot(["repos/openclaw/openclaw/releases/tags/v1"], fetchApi, state),
        ).toEqual({ data: 2 });
        persistGithubSnapshot(state);
        const second = createGithubSnapshotState(options);
        expect(githubApiWithSnapshot(args, fetchApi, second)).toEqual({ data: 1 });
        expect(fetchedArgs).toEqual([args, ["repos/openclaw/openclaw/releases/tags/v1"]]);
        expect(second).toMatchObject({ hits: 1, misses: 0 });
        expect(fetches).toBe(2);
      }
    },
  );

  it.each([
    ["feat: squash", '* Revert "nested"', undefined],
    ['Revert "fix: original"', "", "b"],
    ["Revert squash", '* Revert "nested"', "c"],
    ["chore: revert dependency guard", '* Revert "nested"', "d"],
    ["revert: restore default", "The replacement broke endpoints.", "e"],
  ])("recognizes top-level revert: %s", (subject, context, expected) => {
    const hash = (expected ?? "a").repeat(40);
    expect(standardRevertedHash(`${subject}\n\n${context}\n\nThis reverts commit ${hash}.`)).toBe(
      expected ? hash : undefined,
    );
  });

  it("counts only top-level Highlights bullets and enforces the 5-8 policy input", () => {
    const highlights = [
      "### Highlights",
      "",
      "- One",
      "  - nested detail",
      "- Two",
      "- Three",
      "- Four",
      "- Five",
      "",
      "### Changes",
      "",
      "- Not a highlight",
    ].join("\n");
    const overLimit = highlights.replace("- Five", "- Five\n- Six\n- Seven\n- Eight\n- Nine");

    expect(countTopLevelSectionBullets(highlights, "Highlights")).toBe(5);
    expect(countTopLevelSectionBullets(overLimit, "Highlights")).toBe(9);
    expect(highlightCountError(highlights)).toBeUndefined();
    expect(highlightCountError(overLimit)).toBe(
      "### Highlights must contain 5-8 top-level bullets; found 9",
    );
  });

  it.each(["seed", "shipped"])("bounds prior-release references to their %s provenance", (mode) => {
    const nodes = new Map<number, { __typename: string }>([
      [97118, { __typename: "PullRequest" }],
      [102000, { __typename: "PullRequest" }],
    ]);
    if (mode === "seed") {
      nodes.set(98565, { __typename: "Issue" });
    }
    const params = {
      noteReferences: mode === "seed" ? [97118, 98565] : [],
      recordedReferences: [97118, 102000],
      excludedRecordedReferences: new Set(mode === "shipped" ? [97118] : []),
      sourcePullRequests: new Set([102000]),
      sourceReferences: mode === "seed" ? [102000, 98565] : [102000],
      seededPullRequests: new Set<number>(),
      nodes,
    };
    expect(contaminatingPullRequestReferences(params)).toEqual(mode === "seed" ? [97118] : []);
    expect(
      contaminatingPullRequestReferences({
        ...params,
        ...(mode === "seed"
          ? { seededPullRequests: new Set([97118]) }
          : { noteReferences: [97118] }),
      }),
    ).toEqual(mode === "seed" ? [] : [97118]);
  });

  it("ignores the stale generated record while rewriting it", () => {
    const record = {
      pullRequests: new Map([[1, { references: [2], thanks: [] }]]),
      legacyIssues: new Map(),
    };
    expect(renderedContributionRecordReferences(record, true)).toEqual([]);
    expect(renderedContributionRecordReferences(record, false)).toEqual([1, 2]);
  });

  it("excludes Unreleased records from a cumulative shipped tag boundary", () => {
    const changelog = `## Unreleased\n\n${contributionRecord("base", "a".repeat(40), ["- **PR #1** fix: not shipped."])}
## 2026.6.11\n\n${contributionRecord("base", "HEAD", ["- **PR #2** fix: shipped."])}`;

    expect([...cumulativeShippedPullRequests(changelog, "test baseline")]).toEqual([2]);
  });

  it("subtracts cumulative shipped PRs deterministically from the source inventory", () => {
    const source = {
      pullRequests: new Set([1, 2, 3]),
      references: [1, 2, 4],
    };

    const result = subtractShippedPullRequests(source, [
      { ref: "v2026.6.11", pullRequests: new Set([1, 2]) },
      { ref: "v2026.6.10", pullRequests: new Set([2, 4]) },
    ]);

    expect([...source.pullRequests]).toEqual([3]);
    expect(source.references).toEqual([]);
    expect(result.baselines).toEqual([
      { ref: "v2026.6.10", count: 2, pullRequests: [2, 4] },
      { ref: "v2026.6.11", count: 1, pullRequests: [1] },
    ]);
    expect([...result.pullRequests].toSorted((a, b) => a - b)).toEqual([1, 2, 4]);
  });

  it("removes rewrite-excluded references from an existing contribution record", () => {
    const record = {
      pullRequests: new Map([
        [1, { references: [2, 10], thanks: [] }],
        [2, { references: [11], thanks: [] }],
      ]),
      legacyIssues: new Map([
        [10, { references: [], thanks: [] }],
        [11, { references: [], thanks: [] }],
      ]),
    };

    const filtered = withoutExcludedContributionRecords(record, new Set([2, 10]));

    expect([...filtered.pullRequests]).toEqual([
      [1, { externalReferences: [], references: [], thanks: [] }],
    ]);
    expect([...filtered.legacyIssues]).toEqual([
      [11, { externalReferences: [], references: [], thanks: [] }],
    ]);
  });

  it("does not treat the shipped baseline inventory as current release-note references", () => {
    const baselines = [{ ref: "v2026.6.11", count: 2, pullRequests: [1, 2] }];
    const section = [
      "## 2026.7.1",
      "",
      "- Fixes #1 in the current range.",
      "",
      "### Complete contribution record",
      "",
      "Shipped baseline exclusions: v2026.6.11 (2 PRs: #1, #2).",
      "",
      "- **PR #3** fix: current work.",
    ].join("\n");

    expect(releaseNoteReferences(section, baselines)).toEqual([1, 3]);
  });

  it.each([
    {
      name: "CSS palette comparisons in a commit message",
      source: [
        "fix(control-ui): darken the Absolutely surface ramp (#130239)",
        "",
        "--bg #262624 sat above Dash #1a1210, Claw #0e1015, and Knot #080808.",
        "Steps the ramp down (--bg #262624 -> #1c1c1a).",
      ].join("\n"),
      expected: [130239],
    },
    {
      name: "issue refs after CSS colors on the same line",
      source: "--bg #262624 (fixes #123), refs #1234, #123456, and #12345678.",
      expected: [123, 1234, 123456, 12345678],
    },
    {
      name: "short and alpha CSS values and numeric color transitions",
      source:
        "--fg: #123; --border:#1234; --bg #123456 -> #654321; --alpha: #12345678 → #87654321. (#456)",
      expected: [456],
    },
    {
      name: "qualified references beside CSS values",
      source: "OpenClaw/OpenClaw#123 --bg #262624; openclaw/openclaw#456 and Other/Repo#123456.",
      expected: [123, 456],
    },
    {
      name: "ordinary Markdown and code references",
      source:
        "**PR #123**; `#456`; [#789](https://github.com/openclaw/openclaw/issues/789)\n```text\n#123456\n```\n`--bg: #262624` (#1234)",
      expected: [123, 456, 789, 123456, 1234],
    },
    {
      name: "complete numeric reference tokens",
      source:
        "#1a1210 #0e1015 #080808 #fff #123abc #456_def &#123; file#456; #123 #1234 #123456 #12345678",
      expected: [123, 1234, 123456, 12345678],
    },
    {
      name: "non-color custom-property prose and cross-line references",
      source: "--bg fixes #123; --border relates to #456.\n--bg\n#789",
      expected: [123, 456, 789],
    },
  ])("extracts release references from $name", ({ source, expected }) => {
    expect(releaseNoteReferences(source, [])).toEqual(expected);
  });

  it.each([
    { reference: "", expected: [] },
    {
      reference: " (fixes #262624)",
      expected: [
        "editorial release prose references non-editorial chore PR #262624 (chore)",
        "missing editorial Thanks @alice for PR #262624",
      ],
    },
  ])("validates editorial credit after a CSS color: '$reference'", ({ reference, expected }) => {
    const source = [
      "## 2026.8.1",
      "### Highlights",
      "- One.",
      "- Two.",
      "- Three.",
      "- Four.",
      "- Five.",
      "### Changes",
      "### Fixes",
      `- Set --bg #262624${reference}.`,
      "### Complete contribution record",
      `This audited record covers the complete base..${"a".repeat(40)} history: 1 merged PR.`,
      "#### Pull requests",
      "- **PR #262624** Thanks @alice.",
    ].join("\n");
    const entry = {
      number: 262624,
      title: "chore: unrelated tooling",
      type: "chore",
      editorialEligible: false,
      externalReferences: [],
      linkedIssues: [],
      thanks: ["alice"],
    };

    expect(
      ledgerChecks({ source }, [entry], new Map([[262624, { __typename: "PullRequest" }]]), []),
    ).toEqual(expected);
  });

  it("credits the original PR, not its backport, and rejects stale generated thanks", () => {
    const { cwd, base, changelog } = seedRepository("openclaw-release-credit-", "main");
    const originalMessage =
      "fix: preserve playback errors (#21)\n\nFixes #20\nCo-authored-by: Helper <helper@example.invalid>";
    writeFileSync(join(cwd, "playback.txt"), "fixed\n");
    const original = commitAll(cwd, originalMessage);
    git(cwd, ["checkout", "-qb", "release", base]);
    commitAll(cwd, "chore: release preparation");
    git(cwd, ["cherry-pick", "-x", original]);
    git(cwd, [
      "commit",
      "--amend",
      "-qm",
      `${git(cwd, ["log", "-1", "--format=%B"])}\nCo-authored-by: RomneyDa <6581799+RomneyDa@users.noreply.github.com>`,
    ]);
    const target = git(cwd, ["rev-parse", "HEAD"]);
    const stale = `${changelog}- Preserve playback errors by @steipete and @original-helper. (#21) Thanks @RomneyDa.\n\n${contributionRecord(base, target, ["- **PR #21** Related #20. Thanks @RomneyDa."])}`;
    writeFileSync(join(cwd, "CHANGELOG.md"), stale);
    const seed = commitAll(cwd, "docs: old credit");
    const gh = join(cwd, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}\n
const original = ${JSON.stringify(original)};
const target = ${JSON.stringify(target)};
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
const data = {};
for (const [, alias, hash] of query.matchAll(/(c\\d+): repository[\\s\\S]*?object\\(expression: "([0-9a-f]+)"\\)/g)) {
  data[alias] = { object: {
    associatedPullRequests: { nodes: hash === original ? [{ number: 21, mergedAt: "2020-01-01T00:00:00Z", mergeCommit: { oid: original } }] : [], pageInfo: { hasNextPage: false } },
    authors: { nodes: [{ email: "helper@example.invalid", user: { login: "original-helper" } }, ...(hash === target ? [{ email: "6581799+RomneyDa@users.noreply.github.com", user: { login: "RomneyDa" } }] : [])] },
    author: { user: { login: "release-operator" } }
  } };
}
for (const [, alias, rawNumber] of query.matchAll(/(n\\d+): repository[\\s\\S]*?issueOrPullRequest\\(number: (\\d+)\\)/g)) {
  const number = Number(rawNumber);
  data[alias] = { issueOrPullRequest: number === 21 ? {
    __typename: "PullRequest", number, title: "fix: preserve playback errors", baseRefName: "main",
    mergedAt: "2020-01-01T00:00:00Z", mergeCommit: { oid: original, message: ${JSON.stringify(originalMessage)} },
    author: { __typename: "User", login: "steipete" }, closingIssuesReferences: { nodes: [{ number: 20 }], pageInfo: { hasNextPage: false } }
  } : { __typename: "Issue", number, title: "Playback failed", author: { __typename: "User", login: "reporter" }, closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } } } };
}
for (const [, alias, login] of query.matchAll(/(u\\d+): user\\(login: "([^"]+)"\\)/g)) data[alias] = { __typename: "User", login };
console.log(JSON.stringify({ data }));
`,
    );
    chmodSync(gh, 0o755);
    splitChangelog({ rootDir: cwd });
    const run = (write: boolean) =>
      runVerifier(cwd, {
        base,
        target,
        mainRef: original,
        write,
        extraArgs: ["--seed-ref", seed],
        env: { PATH: `${cwd}:${process.env.PATH}` },
      });
    const generated = run(true);
    expect(generated.stderr).toBe("");
    expect(generated.status, generated.stdout).toBe(0);
    const entryPath = join(cwd, "CHANGELOG/2026.7.1.md");
    const section = readFileSync(entryPath, "utf8");
    expect(section).toContain(
      "- **PR #21** Related #20. Thanks @steipete and @original-helper and @reporter.",
    );
    expect(section).toContain("(#21) Thanks @steipete, @original-helper, and @reporter.");
    expect(section).not.toContain("@RomneyDa");
    expect(section).not.toContain("@release-operator");
    const checked = run(false);
    expect(checked.status, checked.stderr + checked.stdout).toBe(0);
    writeReleaseChangelog({
      rootDir: cwd,
      version: "2026.7.1",
      section: section.replaceAll("Thanks @steipete", "Thanks @RomneyDa and @steipete"),
    });
    const rejected = run(false);
    expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stdout).errors).toEqual(
      expect.arrayContaining([
        "unexpected Thanks @RomneyDa for #21",
        "unexpected editorial Thanks @RomneyDa",
      ]),
    );
    const repaired = run(true);
    expect(repaired.status, repaired.stderr + repaired.stdout).toBe(0);
    expect(readFileSync(entryPath, "utf8")).toBe(section);
  });

  it.each([0, 1, 2])(
    "accounts for merged side ancestry with %i reversals without duplicating shipped PRs",
    (reversals) => {
      const cwd = tempDirs.make("openclaw-release-notes-ancestry-");
      git(cwd, ["init", "-q", "-b", "main"]);
      const changelog = createReleaseNotesFixtureLines().join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
      const commit = (subject: string, file: string) => {
        writeFileSync(join(cwd, file), subject);
        git(cwd, ["add", file]);
        git(cwd, ["commit", "-qm", subject]);
        return git(cwd, ["rev-parse", "HEAD"]);
      };
      git(cwd, ["add", "CHANGELOG.md"]);
      const base = commit("chore: existing work (#9)", "base.txt");
      git(cwd, ["checkout", "-qb", "side"]);
      const first = commit("fix: side contribution", "first.txt");
      git(cwd, ["checkout", "-qb", "nested-side"]);
      const second = commit("fix: same contribution follow-up", "second.txt");
      git(cwd, ["checkout", "-q", "side"]);
      git(cwd, ["merge", "--no-ff", "-qm", "merge: nested side work", "nested-side"]);
      const nestedMerge = git(cwd, ["rev-parse", "HEAD"]);
      const withdrawn = commit("fix: withdrawable contribution", "withdrawn.txt");
      const shipped = commit("fix: separately shipped contribution", "shipped.txt");
      git(cwd, ["checkout", "-q", "main"]);
      commit("chore: main work", "main.txt");
      git(cwd, ["merge", "--no-ff", "-qm", "merge: side work", "side"]);
      let reversed = withdrawn;
      for (let index = 0; index < reversals; index += 1) {
        git(cwd, ["revert", "--no-edit", reversed]);
        reversed = git(cwd, ["rev-parse", "HEAD"]);
      }
      const target = git(cwd, ["rev-parse", "HEAD"]);

      // A divergent stable tag already contains PR #12; its side commit is in
      // this Git range, so subtraction must happen after complete discovery.
      git(cwd, ["checkout", "-qb", "shipped-release", base]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        `## 2026.6.1\n\n${contributionRecord(base, base, ["- **PR #12** Thanks @contributor."], "1 in-range PR + 0 retained seed-only PRs = 1 unique PR.")}`,
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "docs: shipped record"]);
      git(cwd, ["tag", "v2026.6.1"]);
      git(cwd, ["checkout", "-q", "main"]);

      // Exercise the real CLI and Git DAG. Only GitHub's external boundary is
      // replaced; associations have no PR suffix for the collector to guess.
      const associations = {
        [first]: 10,
        [second]: 10,
        [withdrawn]: 11,
        [shipped]: 12,
        [nestedMerge]: 13,
      };
      const gh = join(cwd, "gh");
      writeFileSync(
        gh,
        `#!${process.execPath}\n
const associations = ${JSON.stringify(associations)};
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
const data = {};
for (const [, alias, hash] of query.matchAll(/(c\\d+): repository[\\s\\S]*?object\\(expression: "([0-9a-f]+)"\\)/g)) {
  const number = associations[hash];
  data[alias] = { object: {
    associatedPullRequests: { nodes: number ? [{ number, mergedAt: "2026-01-01T00:00:00Z", mergeCommit: { oid: hash } }] : [], pageInfo: { hasNextPage: false, endCursor: null } },
    author: { user: { login: "steipete" } },
  } };
}
for (const [, alias, rawNumber] of query.matchAll(/(n\\d+): repository[\\s\\S]*?issueOrPullRequest\\(number: (\\d+)\\)/g)) {
  data[alias] = { issueOrPullRequest: { __typename: "PullRequest", number: Number(rawNumber), title: "fix: contribution", baseRefName: "main", mergedAt: "2026-01-01T00:00:00Z", author: { __typename: "User", login: "contributor" }, closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
}
console.log(JSON.stringify({ data }));
`,
      );
      chmodSync(gh, 0o755);
      const manifestPath = join(cwd, "manifest.json");
      splitChangelog({ rootDir: cwd });
      const result = runVerifier(cwd, {
        base,
        target,
        manifest: manifestPath,
        extraArgs: ["--shipped-ref", "v2026.6.1"],
        env: { PATH: `${cwd}:${process.env.PATH}` },
      });
      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(
        manifest.pullRequests.map((entry: { number: number }) => entry.number).toSorted(),
      ).toEqual(reversals === 1 ? [10, 13] : [10, 11, 13]);
      expect(manifest.pullRequests[0].thanks).toEqual(["contributor"]);
      expect(manifest.shippedBaselines).toEqual([
        { ref: "v2026.6.1", count: 1, pullRequests: [12] },
      ]);
      expect(
        readFileSync(join(cwd, "CHANGELOG/2026.7.1.md"), "utf8").match(/\*\*PR #10\*\*/g),
      ).toHaveLength(1);
    },
  );

  it.each([
    { message: "Exact-head CI #41 passed.", accepted: true },
    { message: "CI run #41 passed.", accepted: true },
    { message: "Actions run #41 passed.", accepted: true },
    { message: "workflow run #41 passed.", accepted: true },
    { message: "CI #41 passed.", node: "Issue", accepted: true },
    { message: "CI #41 passed.", node: "PullRequest", accepted: true },
    { message: "Related #41.", accepted: false },
    { message: "CI #41 passed.", reverted: true, other: "Related #41.", accepted: false },
    { message: "CI #41 passed. Fixes #41.", accepted: false },
    { message: "CI openclaw/openclaw#41 passed.", accepted: false },
    { message: "CI #41 passed.", other: "Related #41.", accepted: false },
    { message: "CI #41 passed.", note: "Related #41.", accepted: false },
    { message: "CI #41 passed.", identity: "missing", accepted: false },
    { message: "CI #41 passed.", identity: "wrong-id", accepted: false },
    { message: "CI #41 passed.", identity: "wrong-repo", accepted: false },
    { message: "CI #2147483647 passed.", node: "Issue", accepted: true },
    { message: "CI run #34244092230 passed.", accepted: true },
    { message: "Related #34244092230.", accepted: false },
    { message: "CI #34244092230 passed. Fixes #34244092230.", accepted: false },
    { message: "CI #34244092230 passed.", identity: "missing", accepted: false },
    { message: "CI #34244092230 passed.", identity: "wrong-id", accepted: false },
    { message: "CI #34244092230 passed.", identity: "wrong-repo", accepted: false },
  ])("classifies active workflow references without losing issue accounting: %j", (scenario) => {
    const referenceNumber = Number(scenario.message.match(/#(\d+)/)?.[1]);
    const { cwd, base } = seedRepository(
      "openclaw-release-notes-runs-",
      "main",
      [...createReleaseNotesFixtureLines(), scenario.note ?? "", ""].join("\n"),
    );
    writeFileSync(join(cwd, "validation.txt"), scenario.message);
    git(cwd, ["add", "validation.txt"]);
    git(cwd, ["commit", "-qm", "chore: validation", "-m", scenario.message]);
    if (scenario.reverted) {
      git(cwd, ["revert", "--no-edit", "HEAD"]);
    }
    if (scenario.other) {
      git(cwd, ["commit", "--allow-empty", "-qm", "chore: follow-up", "-m", scenario.other]);
    }
    const target = git(cwd, ["rev-parse", "HEAD"]);
    const gh = join(cwd, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}\n
const scenario = ${JSON.stringify(scenario)};
const referenceNumber = ${referenceNumber};
if (process.argv[3] === "repos/openclaw/openclaw/actions/runs/" + referenceNumber) {
  require("node:fs").appendFileSync("run-requests", referenceNumber + "\\n");
  console.log(JSON.stringify(scenario.identity === "missing" ? { message: "Not Found" } : {
    id: scenario.identity === "wrong-id" ? referenceNumber + 1 : referenceNumber,
    repository: { full_name: scenario.identity === "wrong-repo" ? "other/repository" : "openclaw/openclaw" },
    pull_requests: [],
  }));
  process.exit(0);
}
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
if ([...query.matchAll(/issueOrPullRequest\\(number: (\\d+)\\)/g)].some(([, number]) => Number(number) > 2147483647)) {
  console.log(JSON.stringify({ errors: [{ message: "Int cannot represent non 32-bit signed integer value" }] }));
  process.exit(1);
}
const data = {};
for (const [, alias] of query.matchAll(/(c\\d+): repository/g)) {
  data[alias] = { object: { associatedPullRequests: { nodes: [], pageInfo: { hasNextPage: false } }, author: { user: { login: "steipete" } } } };
}
for (const [, alias] of query.matchAll(/(n\\d+): repository/g)) {
  data[alias] = { issueOrPullRequest: scenario.node ? {
    __typename: scenario.node, number: referenceNumber, title: "chore: validation", baseRefName: "main",
    mergedAt: "2026-01-01T00:00:00Z", mergeCommit: { oid: ${JSON.stringify(target)} }, author: { __typename: "User", login: "steipete" },
    closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
  } : null };
}
console.log(JSON.stringify({ data }));
`,
    );
    chmodSync(gh, 0o755);
    const manifestPath = join(cwd, "manifest.json");
    splitChangelog({ rootDir: cwd });
    const result = runVerifier(cwd, {
      base,
      target,
      manifest: manifestPath,
      env: { PATH: `${cwd}:${process.env.PATH}` },
    });
    if (!scenario.accepted) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `GitHub could not resolve source references: #${referenceNumber}`,
      );
      return;
    }
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.source.references).toBe(scenario.node ? 1 : 0);
    expect(manifest.pullRequests.map((entry: { number: number }) => entry.number)).toEqual(
      scenario.node === "PullRequest" ? [referenceNumber] : [],
    );
    if (!scenario.node) {
      expect(manifest.directCommits[0].references).toEqual([]);
      expect(manifest.workflowRuns).toEqual([
        { id: referenceNumber, repository: "openclaw/openclaw" },
      ]);
    } else {
      expect(() => readFileSync(join(cwd, "run-requests"))).toThrow();
    }
  });

  it.each([
    "exact",
    "double-revert",
    "before-base",
    "before-base-double",
    "before-base-triple",
    "three-targets",
    "non-utf8",
    "overlapping",
    "extra-change",
    "partial",
    "unknown-target",
    "nonancestor",
    "merge-target",
    "abbreviated",
    "duplicate",
    "multiple-declarations",
    "prose",
    "non-revert-subject",
  ])("proves explicit multi-commit reversal accounting: %s", (mode) => {
    const cwd = tempDirs.make("openclaw-release-notes-multi-revert-");
    git(cwd, ["init", "-q", "-b", "main"]);
    const prose = createReleaseNotesFixtureLines().join("\n");
    writeFileSync(join(cwd, "CHANGELOG.md"), prose);
    writeFileSync(join(cwd, "alpha.txt"), "original\n");
    writeFileSync(join(cwd, "beta.bin"), Buffer.from([0, 255, 1]));
    const commit = (subject: string) => {
      git(cwd, ["add", "."]);
      git(cwd, ["commit", "-qm", subject]);
      return git(cwd, ["rev-parse", "HEAD"]);
    };
    const originalBase = commit("chore: baseline");
    writeFileSync(
      join(cwd, "alpha.txt"),
      mode === "non-utf8" ? Buffer.from([97, 255, 10]) : "first\n",
    );
    const first = commit("chore: first source (#21)");
    writeFileSync(join(cwd, "beta.bin"), Buffer.from([0, 254, 2]));
    if (mode === "overlapping") {
      writeFileSync(join(cwd, "alpha.txt"), "second\n");
    }
    const second = commit("chore: second source (#22)");
    let third: string | undefined;
    if (mode === "three-targets") {
      writeFileSync(join(cwd, "third.txt"), "third\n");
      third = commit("chore: third source (#23)");
    }
    writeFileSync(
      join(cwd, "CHANGELOG.md"),
      `${prose}\n### Complete contribution record\n\nThis audited record covers the complete ${originalBase}..${second} history: 2 in-range PRs + 0 retained seed-only PRs = 2 unique PRs.\n\n#### Pull requests\n\n- **PR #21** chore: first source.\n- **PR #22** chore: second source.\n`,
    );
    const seed = commit("docs: preserve source ledger");
    let declaredSecond = second;
    if (mode === "nonancestor" || mode === "merge-target") {
      git(cwd, ["checkout", "-qb", "side", originalBase]);
      writeFileSync(join(cwd, "side.txt"), "side\n");
      declaredSecond = commit("chore: side source");
      git(cwd, ["checkout", "-q", "main"]);
      if (mode === "merge-target") {
        git(cwd, ["merge", "--no-ff", "-qm", "merge side", "side"]);
        declaredSecond = git(cwd, ["rev-parse", "HEAD"]);
      }
    }
    git(cwd, [
      "revert",
      "--no-commit",
      ...(third ? [third] : []),
      second,
      ...(mode === "partial" ? [] : [first]),
    ]);
    if (mode === "extra-change") {
      writeFileSync(join(cwd, "extra.txt"), "unrelated change\n");
    }
    if (mode === "unknown-target") {
      declaredSecond = "1".repeat(40);
    }
    if (mode === "duplicate") {
      declaredSecond = first;
    }
    let declaration = `Reverts ${first} and ${declaredSecond} to restore the previous behavior.`;
    if (third) {
      declaration = `Reverts ${first}, ${second}, and ${third}.`;
    }
    if (mode === "abbreviated") {
      declaration = `Reverts ${first.slice(0, 12)} and ${second.slice(0, 12)}.`;
    } else if (mode === "multiple-declarations") {
      declaration = `${declaration}\n\n${declaration}`;
    } else if (mode === "prose") {
      declaration = `Discussion: ${declaration}`;
    }
    git(cwd, ["add", "."]);
    git(cwd, [
      "commit",
      "-qm",
      mode === "non-revert-subject" ? "chore: describe changes" : "chore: revert source changes",
      "-m",
      declaration,
    ]);
    let base = mode.startsWith("before-base") ? seed : originalBase;
    if (mode === "before-base-double") {
      base = git(cwd, ["rev-parse", "HEAD"]);
    }
    if (["double-revert", "before-base-double", "before-base-triple"].includes(mode)) {
      git(cwd, ["revert", "--no-edit", "HEAD"]);
    }
    if (mode === "before-base-triple") {
      base = git(cwd, ["rev-parse", "HEAD"]);
      git(cwd, ["revert", "--no-edit", "HEAD"]);
    }
    const target = git(cwd, ["rev-parse", "HEAD"]);
    const associations = { [first]: 21, [second]: 22, ...(third ? { [third]: 23 } : {}) };
    const gh = join(cwd, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}\n
const associations = ${JSON.stringify(associations)};
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
const data = {};
for (const [, alias, hash] of query.matchAll(/(c\\d+): repository[\\s\\S]*?object\\(expression: "([0-9a-f]+)"\\)/g)) {
 const number = associations[hash];
 data[alias] = { object: { associatedPullRequests: { nodes: number ? [{ number, mergedAt: "2020-01-01T00:00:00Z", mergeCommit: { oid: hash } }] : [], pageInfo: { hasNextPage: false } }, author: { user: { login: "steipete" } } } };
}
for (const [, alias, number] of query.matchAll(/(n\\d+): repository[\\s\\S]*?issueOrPullRequest\\(number: (\\d+)\\)/g)) {
 data[alias] = { issueOrPullRequest: { __typename: "PullRequest", number: Number(number), title: "chore: source", baseRefName: "main", mergedAt: "2020-01-01T00:00:00Z", author: { __typename: "User", login: "steipete" }, closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } };
}
console.log(JSON.stringify({ data }));
`,
    );
    chmodSync(gh, 0o755);
    const privateTmp = join(cwd, "private-proof-tmp");
    mkdirSync(privateTmp);
    const index = join(cwd, git(cwd, ["rev-parse", "--git-path", "index"]));
    const originalIndex = readFileSync(index);
    const originalObjects = git(cwd, ["count-objects", "-v"]);
    const hooks = join(cwd, "test-hooks");
    mkdirSync(hooks);
    const hook = join(hooks, "post-index-change");
    writeFileSync(hook, "#!/bin/sh\nprintf unexpected > hook-fired\n");
    chmodSync(hook, 0o755);
    git(cwd, ["config", "core.hooksPath", hooks]);
    git(cwd, ["config", "diff.external", hook]);

    const manifestPath = join(cwd, "manifest.json");
    splitChangelog({ rootDir: cwd });
    const result = runVerifier(cwd, {
      base,
      target,
      manifest: manifestPath,
      extraArgs: ["--seed-ref", seed],
      env: { TMPDIR: privateTmp, PATH: `${cwd}:${process.env.PATH}` },
    });
    expect(readFileSync(index)).toEqual(originalIndex);
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(target);
    expect(git(cwd, ["count-objects", "-v"])).toBe(originalObjects);
    expect(readdirSync(privateTmp)).toEqual([]);
    expect(readdirSync(cwd)).not.toContain("hook-fired");
    if (
      ["extra-change", "partial", "unknown-target", "nonancestor", "merge-target"].includes(mode)
    ) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("could not verify explicit multi-commit revert");
      return;
    }
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const removed = [
      "exact",
      "before-base",
      "before-base-triple",
      "three-targets",
      "non-utf8",
      "overlapping",
    ].includes(mode);
    expect(
      manifest.pullRequests.map((entry: { number: number }) => entry.number).toSorted(),
    ).toEqual(removed ? [] : [21, 22]);
  });

  it.each([
    "body-only",
    "future-associated",
    "stale-row",
    "reachable-body",
    "explicit-seed",
    "canonical-carrier",
    "backport-carrier",
    "provenance-carrier",
    "unresolved-body",
  ])("bounds contribution membership to the frozen source graph: %s", (mode) => {
    const cwd = tempDirs.make("openclaw-release-notes-membership-");
    git(cwd, ["init", "-q", "-b", "release"]);
    const prose = createReleaseNotesFixtureLines().join("\n");
    writeFileSync(join(cwd, "CHANGELOG.md"), prose);
    const commitAt = (message: string, day: number) => {
      git(cwd, ["add", "."]);
      const date = `2026-07-0${day}T12:00:00Z`;
      git(cwd, ["commit", "--allow-empty", "-qm", message], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
      return git(cwd, ["rev-parse", "HEAD"]);
    };
    const base = commitAt("chore: baseline", 1);
    writeFileSync(join(cwd, "support.txt"), "independent supporting repair\n");
    const source = commitAt(
      "chore: supporting repair (#21)\n\nRelated: #22\nThis repair is independent of the performance work.",
      2,
    );
    git(cwd, ["checkout", "-qb", "later-main"]);
    writeFileSync(join(cwd, "performance.txt"), "performance implementation\n");
    const future = commitAt("chore: performance work (#22)", 3);
    git(cwd, ["checkout", "-q", "release"]);
    let main = source;
    let carrier: string | undefined;
    if (mode === "reachable-body") {
      git(cwd, ["merge", "--ff-only", "later-main"]);
    } else if (mode.endsWith("-carrier")) {
      main = future;
      commitAt("chore: release preparation", 4);
      if (mode === "canonical-carrier") {
        git(cwd, ["cherry-pick", "-x", future], { GIT_COMMITTER_DATE: "2026-07-05T12:00:00Z" });
        carrier = git(cwd, ["rev-parse", "HEAD"]);
      } else {
        writeFileSync(join(cwd, "performance.txt"), "performance implementation\n");
        carrier = commitAt(
          mode === "backport-carrier"
            ? "chore: release performance backport\n\nBackport of #22 to release/fixture."
            : "chore: carry selected implementation",
          5,
        );
      }
    }
    let seed: string | undefined;
    if (mode === "explicit-seed") {
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        `${prose}\n### Complete contribution record\n\nThis audited record covers the complete ${base}..${source} history: 1 in-range PR + 1 retained seed-only PR = 2 unique PRs.\n\n#### Pull requests\n\n- **PR #21** chore: supporting repair.\n- **PR #22** chore: performance work.\n`,
      );
      seed = commitAt("docs: retain an explicit historical seed", 4);
    }
    const target = commitAt("chore: final release preparation", 6);
    if (
      ["body-only", "future-associated", "stale-row", "explicit-seed", "unresolved-body"].includes(
        mode,
      )
    ) {
      expect(() => git(cwd, ["merge-base", "--is-ancestor", future, target])).toThrow();
      expect(() => git(cwd, ["merge-base", "--is-ancestor", future, main])).toThrow();
      expect(() => git(cwd, ["cat-file", "-e", `${target}:performance.txt`])).toThrow();
    }
    if (mode === "stale-row") {
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        `${prose}\n### Complete contribution record\n\nThis audited record covers the complete ${base}..${target} history: 2 in-range PRs + 0 retained seed-only PRs = 2 unique PRs.\n\n#### Pull requests\n\n- **PR #21** chore: supporting repair.\n- **PR #22** chore: performance work.\n`,
      );
    }
    const gh = join(cwd, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}\n
const mode = ${JSON.stringify(mode)};
const source = ${JSON.stringify(source)};
const future = ${JSON.stringify(future)};
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
const data = {};
const nodeFor = (number) => ({ number, mergedAt: number === 21 ? "2026-07-02T12:00:00Z" : "2026-07-03T12:00:00Z", mergeCommit: { oid: number === 21 ? source : future } });
for (const [, alias, hash] of query.matchAll(/(c\\d+): repository[\\s\\S]*?object\\(expression: "([0-9a-f]+)"\\)/g)) {
 const numbers = hash === source ? (mode === "future-associated" ? [21, 22] : [21]) : hash === future && mode.endsWith("-carrier") ? [22] : [];
 data[alias] = { object: { associatedPullRequests: { nodes: numbers.map(nodeFor), pageInfo: { hasNextPage: false } }, author: { user: { login: "steipete" } } } };
}
for (const [, alias, rawNumber] of query.matchAll(/(n\\d+): repository[\\s\\S]*?issueOrPullRequest\\(number: (\\d+)\\)/g)) {
 const number = Number(rawNumber);
 data[alias] = { issueOrPullRequest: mode === "unresolved-body" && number === 22 ? null : { ...nodeFor(number), __typename: "PullRequest", title: number === 21 ? (mode === "body-only" ? "chore: supporting repair (Related #22)" : "chore: supporting repair") : "chore: performance work", baseRefName: "main", author: { __typename: "User", login: "steipete" }, closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } };
}
console.log(JSON.stringify({ data }));
`,
    );
    chmodSync(gh, 0o755);
    const manifestPath = join(cwd, "manifest.json");
    splitChangelog({ rootDir: cwd });
    const run = (write: boolean) =>
      runVerifier(cwd, {
        base,
        target,
        mainRef: main,
        manifest: manifestPath,
        write,
        extraArgs: [
          ...(seed ? ["--seed-ref", seed] : []),
          ...(mode === "provenance-carrier" ? ["--release-provenance", `${carrier} -> #22`] : []),
        ],
        env: { PATH: `${cwd}:${process.env.PATH}` },
      });
    if (mode === "stale-row") {
      const stale = run(false);
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toContain("outside");
    }
    const result = run(true);
    if (mode === "unresolved-body") {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("could not resolve source references: #22");
      return;
    }
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const included = mode === "reachable-body" || mode.endsWith("-carrier") || Boolean(seed);
    expect(
      manifest.pullRequests.map((entry: { number: number }) => entry.number).toSorted(),
    ).toEqual(included ? [21, 22] : [21]);
    expect(manifest.source.inRangePullRequests).toBe(included && !seed ? 2 : 1);
    expect(manifest.source.retainedSeedOnlyPullRequests).toBe(seed ? 1 : 0);
    expect(manifest.source.references).toBe(2);
    if (mode === "body-only") {
      const generated = readFileSync(join(cwd, "CHANGELOG/2026.7.1.md"), "utf8");
      writeReleaseChangelog({
        rootDir: cwd,
        version: "2026.7.1",
        section: generated.replace("**PR #21**", "**PR #21** Related #22."),
      });
      const verified = run(false);
      expect(verified.stderr).toBe("");
      expect(verified.status, verified.stdout).toBe(0);
    }
  });

  it.each([
    { mode: "recover", attempts: 2, error: undefined, waits: [500] },
    { mode: "exhaust", attempts: 5, error: "unexpected EOF", waits: [500, 1000, 2000, 4000] },
    { mode: "auth", attempts: 1, error: "Bad credentials", waits: [] },
    { mode: "missing-data", attempts: 1, error: "did not include data", waits: [] },
    { mode: "schema", attempts: 1, error: "Field unknownField does not exist", waits: [] },
  ])("handles GraphQL transport failure at the CLI boundary: $mode", (scenario) => {
    const { cwd, base, changelog } = seedRepository("openclaw-release-notes-transport-", "main");
    const target = commitAll(cwd, "chore: source contribution");
    const gh = join(cwd, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}\n
const fs = require("node:fs");
const mode = ${JSON.stringify(scenario.mode)};
const state = fs.existsSync("request-state.json") ? JSON.parse(fs.readFileSync("request-state.json", "utf8")) : { attempts: 0, settled: false };
if (!state.settled) {
  state.attempts += 1;
  fs.writeFileSync("request-state.json", JSON.stringify(state));
  if (mode === "exhaust" || (mode === "recover" && state.attempts === 1)) {
    process.stderr.write('Post "https://api.github.com/graphql": unexpected EOF\\n');
    process.exit(1);
  }
  if (mode === "auth") {
    console.log(JSON.stringify({ message: "Bad credentials", status: 401 }));
    process.stderr.write("gh: Bad credentials (HTTP 401)\\n");
    process.exit(1);
  }
  if (mode === "missing-data") {
    console.log(JSON.stringify({ unexpected: "shape" }));
    process.exit(0);
  }
  if (mode === "schema") {
    console.log(JSON.stringify({ errors: [{ type: "GRAPHQL_VALIDATION_FAILED", message: "Field unknownField does not exist on type Repository" }] }));
    process.exit(0);
  }
  state.settled = true;
  fs.writeFileSync("request-state.json", JSON.stringify(state));
}
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
const data = {};
for (const [, alias] of query.matchAll(/(c\\d+): repository/g)) {
  data[alias] = { object: { associatedPullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, author: { user: { login: "steipete" } } } };
}
console.log(JSON.stringify({ data }));
`,
    );
    chmodSync(gh, 0o755);
    const waitsPath = join(cwd, "waits.jsonl");
    const preload = join(cwd, "record-waits.mjs");
    writeFileSync(waitsPath, "");
    writeFileSync(
      preload,
      `import fs from "node:fs";
Atomics.wait = function (...args) {
  const result = "timed-out";
  fs.appendFileSync(${JSON.stringify(waitsPath)}, JSON.stringify({ timeout: args[3], result }) + "\\n");
  return result;
};
`,
    );
    const manifestPath = join(cwd, "manifest.json");
    splitChangelog({ rootDir: cwd });
    const result = runVerifier(cwd, {
      base,
      target,
      manifest: manifestPath,
      preload,
      env: { PATH: `${cwd}:${process.env.PATH}` },
    });
    const requests = JSON.parse(readFileSync(join(cwd, "request-state.json"), "utf8"));
    expect(requests.attempts, result.stderr).toBe(scenario.attempts);
    if (scenario.error) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(scenario.error);
      expect(readFileSync(join(cwd, "CHANGELOG/2026.7.1.md"), "utf8")).toBe(
        changelog.slice(changelog.indexOf("## 2026.7.1")),
      );
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(manifestPath, "utf8")).source.directCommits).toBe(1);
      expect(readFileSync(join(cwd, "CHANGELOG/2026.7.1.md"), "utf8")).toContain(
        "### Complete contribution record",
      );
    }
    const waits = readFileSync(waitsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { timeout: number; result: string });
    expect(waits).toEqual(scenario.waits.map((timeout) => ({ timeout, result: "timed-out" })));
  });

  it.each(["symbolic target", "release-only base", "nonancestor base"])(
    "validates the release range at the CLI boundary: %s",
    (mode) => {
      const { cwd, base: root } = seedRepository("openclaw-release-notes-");
      if (mode === "release-only base") {
        writeFileSync(join(cwd, "main.txt"), "main\n");
        commitAll(cwd, "main");
        git(cwd, ["branch", "main-ref"]);

        git(cwd, ["checkout", "-qb", "release", root]);
        writeFileSync(join(cwd, "release.txt"), "release\n");
        commitAll(cwd, "release");
        git(cwd, ["tag", "beta-base"]);
      } else if (mode === "nonancestor base") {
        git(cwd, ["branch", "target"]);
        writeFileSync(join(cwd, "base.txt"), "base\n");
        commitAll(cwd, "base");
        git(cwd, ["tag", "base-ref"]);
        git(cwd, ["checkout", "-q", "target"]);
        writeFileSync(join(cwd, "target.txt"), "target\n");
        commitAll(cwd, "target");
      }
      if (mode !== "nonancestor base") {
        splitChangelog({ rootDir: cwd });
      }
      const result = runVerifier(cwd, {
        base:
          mode === "release-only base"
            ? "beta-base"
            : mode === "nonancestor base"
              ? "base-ref"
              : "HEAD",
        mainRef: mode === "release-only base" ? "main-ref" : "HEAD",
        write: mode !== "nonancestor base",
        json: mode === "symbolic target",
      });
      if (mode === "nonancestor base") {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "release range base base-ref must be an ancestor of target HEAD",
        );
        return;
      }
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      if (mode === "symbolic target") {
        expect(JSON.parse(result.stdout).target).toBe(root);
        expect(readFileSync(join(cwd, "CHANGELOG/2026.7.1.md"), "utf8")).toContain(
          `This audited record covers the complete HEAD..${root} history:`,
        );
      }
    },
  );

  it("leaves split artifacts untouched when the rendered ledger fails validation", () => {
    const { cwd, changelog } = seedRepository(
      "openclaw-release-notes-",
      undefined,
      createReleaseNotesFixtureLines()
        .filter((line) => !["- Two.", "- Three.", "- Four.", "- Five."].includes(line))
        .join("\n"),
    );
    const manifestPath = join(cwd, "release-manifest.json");

    splitChangelog({ rootDir: cwd });
    const index = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
    const result = runVerifier(cwd, { manifest: manifestPath, json: false });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("1 errors");
    expect(result.stdout).toContain("- ### Highlights must contain 5-8 top-level bullets; found 1");
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 3,
      version: "2026.7.1",
      source: {
        inRangePullRequests: 0,
        retainedSeedOnlyPullRequests: 0,
        uniquePullRequests: 0,
      },
    });
    expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(index);
    expect(readFileSync(join(cwd, "CHANGELOG/2026.7.1.md"), "utf8")).toBe(
      changelog.slice(changelog.indexOf("## 2026.7.1")),
    );
  });
});
