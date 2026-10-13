import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  contributionRecordTarget,
  createGithubSnapshotState,
  cumulativeShippedPullRequests,
  githubApiWithSnapshot,
  ledgerChecks,
  persistGithubSnapshot,
  releaseNoteReferences,
  recoverUnavailablePullRequests,
  standardRevertedHash,
} from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";
import { splitChangelog, writeReleaseChangelog } from "../../scripts/lib/release-changelog.mjs";
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
    "- One.",
    "- Two.",
    "- Three.",
    "- Four.",
    "- Five.",
    "",
    "### Changes",
    "",
    "### Fixes",
    "",
  ];
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

  it("reads the exact target from a generated contribution record", () => {
    const target = "a".repeat(40);
    expect(
      contributionRecordTarget({
        source: [
          "## 2026.7.2",
          "",
          "### Complete contribution record",
          "",
          `This audited record covers the complete base..${target} history: 1 in-range PR + 0 retained seed-only PRs = 1 unique PR.`,
          "",
          "#### Pull requests",
          "",
          "- **PR #123** fix: example.",
        ].join("\n"),
      }),
    ).toBe(target);
  });

  it("reports deleted contextual references without rendering or crediting them", () => {
    const cwd = tempDirs.make("openclaw-release-notes-deleted-ref-");
    git(cwd, ["init", "-q", "-b", "main"]);
    writeFileSync(join(cwd, "CHANGELOG.md"), createReleaseNotesFixtureLines().join("\n"));
    git(cwd, ["add", "CHANGELOG.md"]);
    git(cwd, ["commit", "-qm", "chore: baseline"]);
    const base = git(cwd, ["rev-parse", "HEAD"]);
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

  it.each(["covered", "noncanonical", "ambiguous"])(
    "recovers vanished PRs only from exact covered provenance: %s",
    (mode) => {
      const number = 102147;
      const commit = {
        authorHandle: undefined,
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
        coauthorsByReference: new Map<number, Set<string>>(),
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
        author: { __typename: "User", login: "coolmanns" },
      });
      expect(commit.pullRequests).toEqual([number]);
      expect(source.pullRequests).toEqual(new Set([number]));
      expect(source.coauthorsByReference.get(number)).toEqual(new Set(["coolmanns"]));
    },
  );

  it.each(["reuse", "checkpoint", "transient-error", "target-mismatch"])(
    "preserves exact-range GitHub snapshot lifecycle: %s",
    (mode) => {
      const cwd = tempDirs.make("openclaw-release-notes-snapshot-");
      const filePath = join(cwd, "snapshot.json");
      let fetches = 0;
      const fetchApi = (args: string[]) => {
        fetches += 1;
        if (mode === "transient-error") {
          return fetches === 1
            ? { errors: [{ message: "rate limited" }] }
            : { data: { repository: { id: "repository-id" } } };
        }
        if (mode === "target-mismatch") {
          return { data: true };
        }
        return { data: { request: args, ...(mode === "reuse" ? { fetches } : {}) } };
      };
      const state = createGithubSnapshotState({
        base: "a".repeat(40),
        filePath,
        target: "b".repeat(40),
        ...(mode === "checkpoint" ? { checkpointEvery: 2 } : {}),
      });
      const args = ["graphql", "-f", "query=one"];
      const first = githubApiWithSnapshot(args, fetchApi, state);
      if (mode === "transient-error") {
        expect(first).toEqual({ errors: [{ message: "rate limited" }] });
        expect(state.dirty).toBe(false);
        expect(state.responses).toEqual({});
        expect(githubApiWithSnapshot(args, fetchApi, state)).toEqual({
          data: { repository: { id: "repository-id" } },
        });
        expect(state.misses).toBe(2);
        expect(fetches).toBe(2);
        return;
      }
      if (mode === "checkpoint") {
        expect(state.dirty).toBe(true);
        expect(state.writesSincePersist).toBe(1);
        githubApiWithSnapshot(["graphql", "-f", "query=two"], fetchApi, state);
        expect(state.dirty).toBe(false);
        expect(state.writesSincePersist).toBe(0);
        expect(JSON.parse(readFileSync(filePath, "utf8")).responses).toHaveProperty(
          JSON.stringify(["graphql", "-f", "query=two"]),
        );
        return;
      }
      if (mode === "target-mismatch") {
        persistGithubSnapshot(state);
        expect(() =>
          createGithubSnapshotState({ base: "a".repeat(40), filePath, target: "c".repeat(40) }),
        ).toThrow("use --refresh-github-snapshot");
        return;
      }
      expect(first).toEqual({
        data: {
          request: ["graphql", "-f", "query=one"],
          fetches: 1,
        },
      });
      expect(
        githubApiWithSnapshot(["repos/openclaw/openclaw/releases/tags/v1"], fetchApi, state),
      ).toEqual({
        data: {
          request: ["repos/openclaw/openclaw/releases/tags/v1"],
          fetches: 2,
        },
      });
      persistGithubSnapshot(state);

      const second = createGithubSnapshotState({
        base: "a".repeat(40),
        filePath,
        target: "b".repeat(40),
      });
      expect(githubApiWithSnapshot(["graphql", "-f", "query=one"], fetchApi, second)).toEqual({
        data: {
          request: ["graphql", "-f", "query=one"],
          fetches: 1,
        },
      });
      expect(second.hits).toBe(1);
      expect(second.misses).toBe(0);
      expect(fetches).toBe(2);
    },
  );

  it("ignores nested revert markers in squash-merge bodies", () => {
    const nestedRevert = [
      "feat(android): render display math (#101435)",
      "",
      "* feat(android): render display math",
      "",
      ' * Revert "docs(changelog): note display math"',
      "",
      `This reverts commit ${"a".repeat(40)}.`,
    ].join("\n");
    const topLevelRevert = [
      'Revert "fix(qa): keep smoke profile on one channel (#101173)" (#101184)',
      "",
      `This reverts commit ${"b".repeat(40)}.`,
    ].join("\n");
    const squashRevert = [
      "Revert chat session picker inline search (#85527)",
      "",
      '* Revert "fix(ui): keep chat session search inline (#85490)"',
      "",
      `This reverts commit ${"c".repeat(40)}.`,
      "",
      "* fix(ui): clear applied chat picker search on empty input",
    ].join("\n");
    const conventionalSquashRevert = [
      "chore: revert dependency guard backfill machinery (#87867)",
      "",
      '* Revert "ci: isolate dependency guard backfill label (#87882)"',
      "",
      `This reverts commit ${"d".repeat(40)}.`,
      "",
      "* ci: preserve clawsweeper bot label filter",
    ].join("\n");
    const explainedTopLevelRevert = [
      "revert: restore a provider default",
      "",
      "The replacement broke non-native endpoints.",
      "",
      `This reverts commit ${"e".repeat(40)}.`,
    ].join("\n");

    expect(standardRevertedHash(nestedRevert)).toBeUndefined();
    expect(standardRevertedHash(topLevelRevert)).toBe("b".repeat(40));
    expect(standardRevertedHash(squashRevert)).toBe("c".repeat(40));
    expect(standardRevertedHash(conventionalSquashRevert)).toBe("d".repeat(40));
    expect(standardRevertedHash(explainedTopLevelRevert)).toBe("e".repeat(40));
  });

  it("excludes Unreleased records from a cumulative shipped tag boundary", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete base..${"a".repeat(40)} history: 1 merged PR.`,
      "",
      "#### Pull requests",
      "",
      "- **PR #1** fix: not shipped.",
      "",
      "## 2026.6.11",
      "",
      "### Complete contribution record",
      "",
      "This audited record covers the complete base..HEAD history: 0 merged PRs.",
      "",
      "#### Pull requests",
      "",
      "- **PR #2** fix: shipped.",
    ].join("\n");

    expect([...cumulativeShippedPullRequests(changelog, "test baseline")]).toEqual([2]);
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
        [
          "## 2026.6.1",
          "",
          "### Complete contribution record",
          "",
          `This audited record covers the complete ${base}..${base} history: 1 in-range PR + 0 retained seed-only PRs = 1 unique PR.`,
          "",
          "#### Pull requests",
          "",
          "- **PR #12** Thanks @contributor.",
          "",
        ].join("\n"),
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
    const cwd = tempDirs.make("openclaw-release-notes-runs-");
    git(cwd, ["init", "-q", "-b", "main"]);
    writeFileSync(
      join(cwd, "CHANGELOG.md"),
      [...createReleaseNotesFixtureLines(), scenario.note ?? "", ""].join("\n"),
    );
    git(cwd, ["add", "CHANGELOG.md"]);
    git(cwd, ["commit", "-qm", "chore: base"]);
    const base = git(cwd, ["rev-parse", "HEAD"]);
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
    const cwd = tempDirs.make("openclaw-release-notes-transport-");
    git(cwd, ["init", "-q", "-b", "main"]);
    const changelog = createReleaseNotesFixtureLines().join("\n");
    writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
    git(cwd, ["add", "CHANGELOG.md"]);
    git(cwd, ["commit", "-qm", "chore: baseline"]);
    const base = git(cwd, ["rev-parse", "HEAD"]);
    git(cwd, ["commit", "--allow-empty", "-qm", "chore: source contribution"]);
    const target = git(cwd, ["rev-parse", "HEAD"]);
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
      const cwd = tempDirs.make("openclaw-release-notes-");
      git(cwd, ["init", "-q"]);
      writeFileSync(join(cwd, "CHANGELOG.md"), createReleaseNotesFixtureLines().join("\n"));
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const root = git(cwd, ["rev-parse", "HEAD"]);
      if (mode === "release-only base") {
        writeFileSync(join(cwd, "main.txt"), "main\n");
        git(cwd, ["add", "main.txt"]);
        git(cwd, ["commit", "-qm", "main"]);
        git(cwd, ["branch", "main-ref"]);

        git(cwd, ["checkout", "-qb", "release", root]);
        writeFileSync(join(cwd, "release.txt"), "release\n");
        git(cwd, ["add", "release.txt"]);
        git(cwd, ["commit", "-qm", "release"]);
        git(cwd, ["tag", "beta-base"]);
      } else if (mode === "nonancestor base") {
        git(cwd, ["branch", "target"]);
        writeFileSync(join(cwd, "base.txt"), "base\n");
        git(cwd, ["add", "base.txt"]);
        git(cwd, ["commit", "-qm", "base"]);
        git(cwd, ["tag", "base-ref"]);
        git(cwd, ["checkout", "-q", "target"]);
        writeFileSync(join(cwd, "target.txt"), "target\n");
        git(cwd, ["add", "target.txt"]);
        git(cwd, ["commit", "-qm", "target"]);
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
    const cwd = tempDirs.make("openclaw-release-notes-");
    git(cwd, ["init", "-q"]);
    const changelog = [
      "# Changelog",
      "",
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- Only one highlight.",
      "",
      "### Changes",
      "",
      "### Fixes",
      "",
    ].join("\n");
    writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
    git(cwd, ["add", "CHANGELOG.md"]);
    git(cwd, ["commit", "-qm", "initial"]);
    const manifestPath = join(cwd, "release-manifest.json");

    splitChangelog({ rootDir: cwd });
    const index = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
    const result = runVerifier(cwd, { manifest: manifestPath, json: false });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("1 errors");
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
