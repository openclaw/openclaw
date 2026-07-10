import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contaminatingPullRequestReferences,
  commitOutputTransaction,
  countTopLevelSectionBullets,
  githubApi,
  highlightCountError,
  hydrateExactGitCommits,
  pullRequestMergedByTarget,
  releaseNoteReferences,
  resolvePullRequestCommitLists,
  standardRevertedHash,
  toolingIdentity,
  withoutExcludedContributionRecords,
} from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";

const verifier = resolve(
  ".agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs",
);

function git(cwd: string, args: string[], { input }: { input?: Buffer | string } = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "test@openclaw.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "test@openclaw.invalid",
    },
    input,
  }).trim();
}

function exactGithubGitFixture() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-github-git-objects-"));
  const target = join(root, "target");
  const source = join(root, "source");
  mkdirSync(target);
  git(target, ["init", "-q"]);
  git(target, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(target, "base.txt"), "base\n");
  git(target, ["add", "base.txt"]);
  git(target, ["commit", "-qm", "base"]);
  const parent = git(target, ["rev-parse", "HEAD"]);
  const baseBlob = git(target, ["rev-parse", `${parent}:base.txt`]);

  git(root, ["clone", "-q", target, source]);
  const addedContent = "added\n";
  writeFileSync(join(source, "added.txt"), addedContent);
  git(source, ["add", "added.txt"]);
  const tree = git(source, ["write-tree"]);
  const addedBlob = git(source, ["hash-object", "added.txt"]);
  const payload = [
    `tree ${tree}`,
    `parent ${parent}`,
    "author OpenClaw Test <test@openclaw.invalid> 1700000000 +0000",
    "committer OpenClaw Test <test@openclaw.invalid> 1700000000 +0000",
    "",
    "orphan provenance",
    "",
  ].join("\n");
  const signature = [
    "-----BEGIN SSH SIGNATURE-----",
    "U1NIU0lHAAAAAQAAABRvcGVuY2xhdy10ZXN0LWtleQ==",
    "-----END SSH SIGNATURE-----",
    "",
  ].join("\n");
  const headerBoundary = payload.indexOf("\n\n");
  const rawCommit = `${payload.slice(0, headerBoundary)}\ngpgsig ${signature.slice(0, -1).replaceAll("\n", "\n ")}\n\n${payload.slice(headerBoundary + 2)}`;
  const commit = git(source, ["hash-object", "-w", "-t", "commit", "--stdin"], {
    input: rawCommit,
  });
  const commitPath = `repos/openclaw/openclaw/git/commits/${commit}`;
  const treePath = `repos/openclaw/openclaw/git/trees/${tree}`;
  const blobPath = `repos/openclaw/openclaw/git/blobs/${addedBlob}`;
  const responses = new Map<string, unknown>([
    [
      commitPath,
      {
        parents: [{ sha: parent }],
        sha: commit,
        tree: { sha: tree },
        verification: { payload, reason: "unknown_key", signature, verified: false },
      },
    ],
    [
      treePath,
      {
        sha: tree,
        tree: [
          { mode: "100644", path: "base.txt", sha: baseBlob, type: "blob" },
          { mode: "100644", path: "added.txt", sha: addedBlob, type: "blob" },
        ],
        truncated: false,
      },
    ],
    [
      blobPath,
      {
        content: Buffer.from(addedContent).toString("base64"),
        encoding: "base64",
        sha: addedBlob,
        size: Buffer.byteLength(addedContent),
      },
    ],
  ]);
  return { addedBlob, blobPath, commit, commitPath, responses, root, target, tree, treePath };
}

describe("release-note verification", () => {
  it("preserves GitHub pull request member order across pages", () => {
    const first = "b".repeat(40);
    const second = "a".repeat(40);
    const pages = [
      {
        p0: {
          pullRequest: {
            commits: {
              nodes: [{ commit: { oid: first } }],
              pageInfo: { endCursor: "next", hasNextPage: true },
              totalCount: 2,
            },
            number: 12,
          },
        },
      },
      {
        p0: {
          pullRequest: {
            commits: {
              nodes: [{ commit: { oid: second } }],
              pageInfo: { endCursor: null, hasNextPage: false },
              totalCount: 2,
            },
            number: 12,
          },
        },
      },
    ];
    const commits = resolvePullRequestCommitLists([12], {
      fetchPage: () => pages.shift()!,
    });
    expect(commits.get(12)).toEqual([first, second]);
  });

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

  it("retries truncated JSON and exit-zero HTML with sanitized exhausted context", () => {
    const query = "query { viewer { login } }";
    const responses = [
      '{"data":{"viewer":{"login":"openclaw"}}',
      "<html><body>upstream unavailable</body></html>",
      '{"data":{"viewer":{"login":"openclaw"}}}',
    ];
    const sleeps: number[] = [];
    const result = githubApi(["graphql", "-f", `query=${query}`], {
      execute: () => responses.shift()!,
      retryDelaysMs: [10, 20],
      sleep: (delayMs: number) => sleeps.push(delayMs),
    });
    expect(result).toEqual({ data: { viewer: { login: "openclaw" } } });
    expect(sleeps).toEqual([10, 20]);

    const secret = `github_pat_${"secret".repeat(8)}`;
    let exhausted: unknown;
    try {
      githubApi(["graphql", "-f", `query=${query}`], {
        execute: () => `<html><body>upstream unavailable ${secret}</body></html>`,
        retryDelaysMs: [0, 0],
        sleep: () => undefined,
      });
    } catch (error) {
      exhausted = error;
    }
    expect(exhausted).toBeInstanceOf(Error);
    expect((exhausted as Error).message).toMatch(
      /^GitHub API graphql query sha256=[0-9a-f]{64} failed after 3\/3 attempts: non-JSON body prefix=/,
    );
    try {
      githubApi(["graphql", "-f", `query=${query}`], {
        execute: () => `<html><body>upstream unavailable ${secret}</body></html>`,
        retryDelaysMs: [],
      });
    } catch (error) {
      expect(String(error)).toContain("[redacted-token]");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("retries only transient nonzero API failures and never accepts their JSON stdout", () => {
    const query = "query { viewer { login } }";
    const sleeps: number[] = [];
    let calls = 0;
    const result = githubApi(["graphql", "-f", `query=${query}`], {
      execute: () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("command failed"), {
            status: 1,
            stderr: "HTTP 429: secondary rate limit",
            stdout: '{"message":"API rate limit exceeded"}',
          });
        }
        return '{"data":{"viewer":{"login":"openclaw"}}}';
      },
      retryDelaysMs: [10],
      sleep: (delayMs: number) => sleeps.push(delayMs),
    });
    expect(result).toEqual({ data: { viewer: { login: "openclaw" } } });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([10]);

    const secret = `github_pat_${"private".repeat(8)}`;
    let permanentCalls = 0;
    expect(() =>
      githubApi(["graphql", "-f", `query=${query}`], {
        execute: () => {
          permanentCalls += 1;
          throw Object.assign(new Error(`command included ${secret} and ${query}`), {
            status: 1,
            stderr: "HTTP 401: Bad credentials",
            stdout: '{"message":"Bad credentials"}',
          });
        },
        retryDelaysMs: [10, 20],
        sleep: () => {
          throw new Error("permanent API failures must not sleep");
        },
      }),
    ).toThrow(/failed after 1\/3 attempts: error response prefix=/);
    expect(permanentCalls).toBe(1);
  });

  it("hydrates an exact signed commit retained only by the GitHub Git database API", () => {
    const fixture = exactGithubGitFixture();
    try {
      const fetched: string[] = [];
      hydrateExactGitCommits([fixture.commit], {
        cwd: fixture.target,
        fetchJson: (path: string) => {
          fetched.push(path);
          const response = fixture.responses.get(path);
          if (!response) {
            throw new Error(`unexpected GitHub Git object request: ${path}`);
          }
          return structuredClone(response);
        },
      });

      expect(git(fixture.target, ["cat-file", "-t", fixture.commit])).toBe("commit");
      expect(git(fixture.target, ["cat-file", "-t", fixture.tree])).toBe("tree");
      expect(git(fixture.target, ["cat-file", "-t", fixture.addedBlob])).toBe("blob");
      expect(
        git(fixture.target, ["diff-tree", "--no-commit-id", "--name-only", "-r", fixture.commit]),
      ).toBe("added.txt");
      expect(fetched).toEqual([fixture.commitPath, fixture.treePath, fixture.blobPath]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("fails closed before writing an unverifiable, mismatched, or over-bound commit", () => {
    const fixture = exactGithubGitFixture();
    try {
      const fetchJson = (path: string) => {
        const response = fixture.responses.get(path);
        if (!response) {
          throw new Error(`unexpected GitHub Git object request: ${path}`);
        }
        return structuredClone(response);
      };
      const commit = fixture.responses.get(fixture.commitPath) as Record<string, unknown>;
      const verification = commit.verification as Record<string, unknown>;
      fixture.responses.set(fixture.commitPath, {
        ...commit,
        verification: { ...verification, payload: null },
      });
      expect(() =>
        hydrateExactGitCommits([fixture.commit], { cwd: fixture.target, fetchJson }),
      ).toThrow(`GitHub cannot reconstruct signed commit ${fixture.commit}`);
      fixture.responses.set(fixture.commitPath, commit);

      const blob = fixture.responses.get(fixture.blobPath) as Record<string, unknown>;
      const tampered = Buffer.from("tampered\n");
      fixture.responses.set(fixture.blobPath, {
        ...blob,
        content: tampered.toString("base64"),
        size: tampered.length,
      });
      expect(() =>
        hydrateExactGitCommits([fixture.commit], {
          cwd: fixture.target,
          fetchJson,
        }),
      ).toThrow(`Git blob ${fixture.addedBlob} hash mismatch`);
      expect(() =>
        hydrateExactGitCommits([fixture.commit], {
          cwd: fixture.target,
          fetchJson,
          maxObjects: 1,
        }),
      ).toThrow("GitHub Git object hydration exceeded 1 objects");
      expect(
        spawnSync("git", ["cat-file", "-e", fixture.commit], { cwd: fixture.target }).status,
      ).not.toBe(0);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("parses and documents trusted adapted backport provenance", () => {
    const valid = `501:${"a".repeat(40)}:${"b".repeat(40)}`;
    const accepted = spawnSync(
      process.execPath,
      [verifier, "--help", "--provenance-pr-adapted", valid],
      { encoding: "utf8" },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("--provenance-pr-adapted");

    const rejected = spawnSync(
      process.execPath,
      [
        verifier,
        "--base",
        "HEAD",
        "--target",
        "HEAD",
        "--version",
        "2026.7.1",
        "--provenance-pr-adapted",
        "invalid",
      ],
      { encoding: "utf8" },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("invalid --provenance-pr-adapted value");
  });

  it("parses only disjoint witnessed comparison-member overlap acknowledgements", () => {
    const source = "a".repeat(40);
    const target = "b".repeat(40);
    const witness = "c".repeat(40);
    const valid = `501:${source}:${target}:${witness}`;
    const accepted = spawnSync(
      process.execPath,
      [
        verifier,
        "--help",
        "--comparison-base",
        "main",
        "--tooling-commit",
        "d".repeat(40),
        "--tooling-tree",
        "e".repeat(40),
        "--comparison-pr-member-overlap",
        valid,
      ],
      { encoding: "utf8" },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("--comparison-pr-member-overlap");
    expect(accepted.stdout).toContain("independent");

    const invalid = spawnSync(
      process.execPath,
      [
        verifier,
        "--base",
        "HEAD",
        "--target",
        "HEAD",
        "--version",
        "2026.7.1",
        "--comparison-pr-member-overlap",
        `501:${source}:${target}`,
      ],
      { encoding: "utf8" },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("invalid --comparison-pr-member-overlap value");

    const missingComparison = spawnSync(
      process.execPath,
      [verifier, "--help", "--comparison-pr-member-overlap", valid],
      { encoding: "utf8" },
    );
    expect(missingComparison.status).not.toBe(0);
    expect(missingComparison.stderr).toContain(
      "--comparison-pr-member-overlap requires --comparison-base main",
    );

    const duplicatePullRequest = spawnSync(
      process.execPath,
      [
        verifier,
        "--help",
        "--comparison-base",
        "main",
        "--tooling-commit",
        "d".repeat(40),
        "--tooling-tree",
        "e".repeat(40),
        "--comparison-pr-member-overlap",
        valid,
        "--comparison-pr-member-overlap",
        `501:${"f".repeat(40)}:${"1".repeat(40)}:${"2".repeat(40)}`,
      ],
      { encoding: "utf8" },
    );
    expect(duplicatePullRequest.status).not.toBe(0);
    expect(duplicatePullRequest.stderr).toContain(
      "--comparison-pr-member-overlap PR numbers must be unique",
    );

    const overlappingRoles = spawnSync(
      process.execPath,
      [
        verifier,
        "--help",
        "--comparison-base",
        "main",
        "--tooling-commit",
        "d".repeat(40),
        "--tooling-tree",
        "e".repeat(40),
        "--comparison-pr-member-overlap",
        `501:${source}:${source}:${witness}`,
      ],
      { encoding: "utf8" },
    );
    expect(overlappingRoles.status).not.toBe(0);
    expect(overlappingRoles.stderr).toContain(
      "--comparison-pr-member-overlap source, target, and witness SHAs must be disjoint",
    );

    const subsetAccepted = spawnSync(
      process.execPath,
      [
        verifier,
        "--help",
        "--comparison-base",
        "main",
        "--tooling-commit",
        "d".repeat(40),
        "--tooling-tree",
        "e".repeat(40),
        "--comparison-pr-member-subset-overlap",
        valid,
      ],
      { encoding: "utf8" },
    );
    expect(subsetAccepted.status, subsetAccepted.stderr).toBe(0);
    expect(subsetAccepted.stdout).toContain("--comparison-pr-member-subset-overlap");
    expect(subsetAccepted.stdout).toContain("strict");

    const sharedOverlapPullRequest = spawnSync(
      process.execPath,
      [
        verifier,
        "--help",
        "--comparison-base",
        "main",
        "--tooling-commit",
        "d".repeat(40),
        "--tooling-tree",
        "e".repeat(40),
        "--comparison-pr-member-overlap",
        valid,
        "--comparison-pr-member-subset-overlap",
        `501:${"f".repeat(40)}:${"1".repeat(40)}:${"2".repeat(40)}`,
      ],
      { encoding: "utf8" },
    );
    expect(sharedOverlapPullRequest.status).not.toBe(0);
    expect(sharedOverlapPullRequest.stderr).toContain(
      "comparison-overlap PR numbers must be disjoint",
    );

    const sharedProvenanceTarget = "9".repeat(40);
    const ownershipTargetCollision = spawnSync(
      process.execPath,
      [
        verifier,
        "--help",
        "--provenance-pr-adapted",
        `601:${"f".repeat(40)}:${sharedProvenanceTarget}`,
        "--provenance-pr-partial",
        `602:${"1".repeat(40)}:${sharedProvenanceTarget}`,
      ],
      { encoding: "utf8" },
    );
    expect(ownershipTargetCollision.status).not.toBe(0);
    expect(ownershipTargetCollision.stderr).toContain(
      "adapted, integrated, and partial provenance target SHAs must be disjoint",
    );
  });

  it("parses and documents immutable trusted tooling identity", () => {
    const commit = "a".repeat(40);
    const tree = "b".repeat(40);
    const accepted = spawnSync(
      process.execPath,
      [verifier, "--help", "--tooling-commit", commit, "--tooling-tree", tree],
      { encoding: "utf8" },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("--tooling-commit");
    expect(accepted.stdout).toContain("--tooling-tree");

    const incomplete = spawnSync(
      process.execPath,
      [verifier, "--help", "--tooling-commit", commit],
      { encoding: "utf8" },
    );
    expect(incomplete.status).not.toBe(0);
    expect(incomplete.stderr).toContain(
      "--tooling-commit and --tooling-tree must be supplied together",
    );

    const untrustedComparison = spawnSync(
      process.execPath,
      [
        verifier,
        "--base",
        "HEAD",
        "--target",
        "HEAD",
        "--version",
        "2026.7.1",
        "--comparison-base",
        "main",
      ],
      { encoding: "utf8" },
    );
    expect(untrustedComparison.status).not.toBe(0);
    expect(untrustedComparison.stderr).toContain(
      "--comparison-base main requires --tooling-commit and --tooling-tree",
    );
  });

  it("verifies trusted tooling commit, tree, and executed module bytes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-tooling-identity-"));
    const paths = [
      ".agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs",
      ".agents/skills/openclaw-changelog-update/scripts/lib/github-team-inventory.mjs",
      ".agents/skills/openclaw-changelog-update/scripts/lib/release-source-inventory.mjs",
      "scripts/render-github-release-notes.mjs",
    ];
    try {
      git(cwd, ["init", "-q"]);
      for (const path of paths) {
        const target = join(cwd, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(resolve(path)));
      }
      git(cwd, ["add", "."]);
      git(cwd, ["commit", "-qm", "trusted tooling"]);
      const commit = git(cwd, ["rev-parse", "HEAD"]);
      const tree = git(cwd, ["show", "-s", "--format=%T", commit]);

      expect(toolingIdentity({ toolingCommit: commit, toolingTree: tree }, { cwd })).toMatchObject({
        aggregateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        trustedSource: { commit, tree, verifiedFiles: 4 },
      });
      expect(() =>
        toolingIdentity({ toolingCommit: commit, toolingTree: "0".repeat(40) }, { cwd }),
      ).toThrow("--tooling-tree does not match");

      writeFileSync(
        join(cwd, "scripts/render-github-release-notes.mjs"),
        `${readFileSync(resolve("scripts/render-github-release-notes.mjs"), "utf8")}\n// mismatch\n`,
      );
      git(cwd, ["add", "."]);
      git(cwd, ["commit", "-qm", "mismatched tooling"]);
      const mismatchCommit = git(cwd, ["rev-parse", "HEAD"]);
      const mismatchTree = git(cwd, ["show", "-s", "--format=%T", mismatchCommit]);
      expect(() =>
        toolingIdentity({ toolingCommit: mismatchCommit, toolingTree: mismatchTree }, { cwd }),
      ).toThrow("executed tooling file scripts/render-github-release-notes.mjs does not match");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("parses and documents grouped integrated backport provenance", () => {
    const target = "c".repeat(40);
    const accepted = spawnSync(
      process.execPath,
      [
        verifier,
        "--help",
        "--provenance-pr-integrated",
        `501:${"a".repeat(40)}:${target}`,
        "--provenance-pr-integrated",
        `501:${"b".repeat(40)}:${target}`,
      ],
      { encoding: "utf8" },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("--provenance-pr-integrated");

    const rejected = spawnSync(
      process.execPath,
      [
        verifier,
        "--base",
        "HEAD",
        "--target",
        "HEAD",
        "--version",
        "2026.7.1",
        "--provenance-pr-integrated",
        "invalid",
      ],
      { encoding: "utf8" },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("invalid --provenance-pr-integrated value");

    const conflicting = spawnSync(
      process.execPath,
      [
        verifier,
        "--help",
        "--provenance-pr-integrated",
        `501:${"a".repeat(40)}:${target}`,
        "--provenance-pr-integrated",
        `502:${"b".repeat(40)}:${target}`,
      ],
      { encoding: "utf8" },
    );
    expect(conflicting.status).not.toBe(0);
    expect(conflicting.stderr).toContain(
      "--provenance-pr-integrated target SHAs must map to one pull request",
    );
  });

  it("binds seeded PR merge time to the seed target", () => {
    const target = "a".repeat(40);
    const timestamp = Date.parse("2026-07-09T00:00:00Z");

    expect(
      pullRequestMergedByTarget(
        {
          mergedAt: "2026-07-08T23:59:59Z",
          mergeCommit: { oid: "b".repeat(40) },
        },
        target,
        timestamp,
      ),
    ).toBe(true);
    expect(
      pullRequestMergedByTarget(
        {
          mergedAt: "2026-07-09T00:00:01.001Z",
          mergeCommit: { oid: target },
        },
        target,
        timestamp,
      ),
    ).toBe(false);
    expect(
      pullRequestMergedByTarget(
        {
          mergedAt: "2026-07-09T00:00:01Z",
          mergeCommit: { oid: target },
        },
        target,
        timestamp,
      ),
    ).toBe(true);
    expect(
      pullRequestMergedByTarget(
        {
          mergedAt: "2026-07-09T00:00:01Z",
          mergeCommit: { oid: "b".repeat(40) },
        },
        target,
        timestamp,
      ),
    ).toBe(false);
  });

  it("rejects a malformed seed contribution record before carrying it forward", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-seed-"));
    try {
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
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
          "### Complete contribution record",
          "",
          `This audited record covers the complete HEAD..${"a".repeat(40)} history: 0 merged PRs.`,
          `This audited record covers the complete HEAD..${"b".repeat(40)} history: 0 merged PRs.`,
          "",
          "#### Pull requests",
          "",
        ].join("\n"),
      );
      git(cwd, ["init", "-q"]);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const manifestPath = join(cwd, "release-manifest.json");

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--seed-ref",
          "HEAD",
          "--manifest",
          manifestPath,
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "seed ref HEAD must contain exactly one complete contribution record provenance line; found 2",
      );
      expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toContain(`HEAD..${"b".repeat(40)}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("records the resolved seed authorization in the manifest", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-seed-manifest-"));
    try {
      const initialChangelog = [
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
      ].join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), initialChangelog);
      git(cwd, ["init", "-q"]);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const root = git(cwd, ["rev-parse", "HEAD"]);
      const seedChangelog = [
        initialChangelog,
        "### Complete contribution record",
        "",
        `This audited record covers the complete ${root}..${root} history: 0 merged PRs.`,
        "",
        "#### Pull requests",
        "",
      ].join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), seedChangelog);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "seed ledger"]);
      const seed = git(cwd, ["rev-parse", "HEAD"]);
      const manifestPath = join(cwd, "release-manifest.json");
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      const ghx = join(bin, "ghx");
      writeFileSync(
        ghx,
        `#!/bin/sh
cat <<'JSON'
{"data":{"c0":{"object":{"associatedPullRequests":{"totalCount":0,"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}
JSON
`,
      );
      chmodSync(ghx, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          root,
          "--source-target",
          root,
          "--target",
          seed,
          "--max-changelog-tail",
          "1",
          "--version",
          "2026.7.1",
          "--seed-ref",
          seed,
          "--manifest",
          manifestPath,
          "--write-ledger",
          "--json",
        ],
        {
          cwd,
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
        seedAuthorization: {
          commit: seed,
          ref: seed,
          releaseSectionSha256: createHash("sha256")
            .update(seedChangelog.slice(seedChangelog.indexOf("## 2026.7.1")).trimEnd())
            .digest("hex"),
          target: root,
        },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("requires a manifest for ledger rewrites", () => {
    const result = spawnSync(
      process.execPath,
      [
        verifier,
        "--base",
        "HEAD",
        "--target",
        "HEAD",
        "--version",
        "2026.7.1",
        "--write-ledger",
        "--json",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--write-ledger requires --manifest");
  });

  it("rejects manifest paths that alias the verified changelog in audit mode", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-manifest-alias-"));
    try {
      const changelog = [
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
      ].join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
      symlinkSync("CHANGELOG.md", join(cwd, "manifest-link.json"));
      git(cwd, ["init", "-q"]);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);

      for (const manifestPath of [
        join(cwd, "CHANGELOG.md"),
        join(cwd, "changelog.md"),
        join(cwd, "manifest-link.json"),
      ]) {
        const result = spawnSync(
          process.execPath,
          [
            verifier,
            "--base",
            "HEAD",
            "--target",
            "HEAD",
            "--version",
            "2026.7.1",
            "--manifest",
            manifestPath,
            "--json",
          ],
          { cwd, encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("--manifest must not alias CHANGELOG.md");
        expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(changelog);
      }

      rmSync(join(cwd, "CHANGELOG.md"));
      const brokenAlias = join(cwd, "broken-manifest-link.json");
      symlinkSync("CHANGELOG.md", brokenAlias);
      const brokenAliasResult = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--manifest",
          brokenAlias,
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(brokenAliasResult.status).not.toBe(0);
      expect(brokenAliasResult.stderr).toContain("--manifest must not alias CHANGELOG.md");
      expect(lstatSync(brokenAlias).isSymbolicLink()).toBe(true);
      expect(readlinkSync(brokenAlias)).toBe("CHANGELOG.md");
      expect(() => readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toThrow();
      expect(() => readFileSync(brokenAlias, "utf8")).toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("atomically rejects output when a verified input changes before commit", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-output-"));
    try {
      const changelog = join(cwd, "CHANGELOG.md");
      const manifest = join(cwd, "manifest.json");
      writeFileSync(changelog, "original\n");
      const expectedChangelog = { bytes: Buffer.from("original\n"), exists: true };
      const expectedManifest = { bytes: Buffer.alloc(0), exists: false };

      expect(() =>
        commitOutputTransaction([
          {
            content: "candidate\n",
            expected: expectedChangelog,
            path: changelog,
          },
          {
            content: "alias\n",
            expected: expectedChangelog,
            path: `${cwd}/./CHANGELOG.md`,
          },
        ]),
      ).toThrow("release output transaction paths must be unique");
      expect(readFileSync(changelog, "utf8")).toBe("original\n");
      expect(() =>
        commitOutputTransaction([
          {
            content: "candidate\n",
            expected: expectedChangelog,
            path: changelog,
          },
          {
            content: "case alias\n",
            expected: expectedChangelog,
            path: join(cwd, "changelog.md"),
          },
        ]),
      ).toThrow("release output transaction paths must be unique");

      expect(() =>
        commitOutputTransaction(
          [
            {
              content: "candidate\n",
              expected: expectedChangelog,
              path: changelog,
            },
            {
              content: "{}\n",
              expected: expectedManifest,
              path: manifest,
            },
          ],
          {
            beforeCommit: () => writeFileSync(changelog, "external mutation\n"),
          },
        ),
      ).toThrow("release output changed during verification");
      expect(readFileSync(changelog, "utf8")).toBe("external mutation\n");
      expect(() => readFileSync(manifest, "utf8")).toThrow();
      expect(readdirSync(cwd).some((path) => path.includes(".tmp-"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("checks the output being replaced last before each rename", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-output-last-check-"));
    try {
      const first = join(cwd, "first.txt");
      const second = join(cwd, "second.txt");
      writeFileSync(first, "old first\n");
      writeFileSync(second, "old second\n");

      expect(() =>
        commitOutputTransaction(
          [
            {
              content: "new first\n",
              expected: { bytes: Buffer.from("old first\n"), exists: true },
              path: first,
            },
            {
              content: "new second\n",
              expected: { bytes: Buffer.from("old second\n"), exists: true },
              path: second,
            },
          ],
          {
            afterSnapshotCheck: ({ index, state }) => {
              if (index === 0 && state.path === second) {
                writeFileSync(first, "external first\n");
              }
            },
          },
        ),
      ).toThrow("release output changed during commit");
      expect(readFileSync(first, "utf8")).toBe("external first\n");
      expect(readFileSync(second, "utf8")).toBe("old second\n");
      expect(readdirSync(cwd).some((path) => path.includes(".tmp-"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("guards read-only inputs while committing a separate output", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-output-guard-"));
    try {
      const changelog = join(cwd, "CHANGELOG.md");
      const manifest = join(cwd, "manifest.json");
      writeFileSync(changelog, "old changelog\n");
      writeFileSync(manifest, "old manifest\n");

      expect(() =>
        commitOutputTransaction(
          [
            {
              content: "new manifest\n",
              expected: { bytes: Buffer.from("old manifest\n"), exists: true },
              path: manifest,
            },
          ],
          {
            beforeRename: () => writeFileSync(changelog, "external changelog\n"),
            guards: [
              {
                expected: { bytes: Buffer.from("old changelog\n"), exists: true },
                path: changelog,
              },
            ],
          },
        ),
      ).toThrow("release output changed during commit");
      expect(readFileSync(changelog, "utf8")).toBe("external changelog\n");
      expect(readFileSync(manifest, "utf8")).toBe("old manifest\n");
      expect(readdirSync(cwd).some((path) => path.includes(".tmp-"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("commits a failure sentinel independently of concurrent input changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-output-sentinel-"));
    try {
      const changelog = join(cwd, "CHANGELOG.md");
      const manifest = join(cwd, "manifest.json");
      writeFileSync(changelog, "old changelog\n");
      writeFileSync(manifest, '{"status":"pass","old":true}\n');

      commitOutputTransaction(
        [
          {
            content: '{"status":"pending"}\n',
            expected: {
              bytes: Buffer.from('{"status":"pass","old":true}\n'),
              exists: true,
            },
            failureSentinel: true,
            path: manifest,
          },
        ],
        {
          beforeCommit: () => writeFileSync(changelog, "external changelog\n"),
        },
      );

      expect(readFileSync(changelog, "utf8")).toBe("external changelog\n");
      expect(readFileSync(manifest, "utf8")).toBe('{"status":"pending"}\n');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("commits a pending manifest before the changelog and a pass manifest last", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-output-order-"));
    try {
      const changelog = join(cwd, "CHANGELOG.md");
      const manifest = join(cwd, "manifest.json");
      writeFileSync(changelog, "original\n");
      writeFileSync(manifest, '{"status":"old"}\n');
      const observed: string[] = [];

      commitOutputTransaction(
        [
          {
            content: '{"status":"pending"}\n',
            expected: { bytes: Buffer.from('{"status":"old"}\n'), exists: true },
            failureSentinel: true,
            path: manifest,
          },
          {
            content: "candidate\n",
            expected: { bytes: Buffer.from("original\n"), exists: true },
            path: changelog,
          },
          {
            content: '{"status":"pass"}\n',
            path: manifest,
            replacesPrevious: true,
          },
        ],
        {
          afterRename: ({ output }) => {
            observed.push(`${output.path}:${readFileSync(output.path, "utf8").trim()}`);
          },
        },
      );

      expect(observed).toEqual([
        `${manifest}:{"status":"pending"}`,
        `${changelog}:candidate`,
        `${manifest}:{"status":"pass"}`,
      ]);
      expect(readFileSync(changelog, "utf8")).toBe("candidate\n");
      expect(readFileSync(manifest, "utf8")).toBe('{"status":"pass"}\n');
      expect(readdirSync(cwd).some((path) => /\.(?:tmp|restore)-/.test(path))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rolls back a partial changelog and manifest commit", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-output-rollback-"));
    try {
      const changelog = join(cwd, "CHANGELOG.md");
      const manifest = join(cwd, "manifest.json");
      writeFileSync(changelog, "original\n");
      writeFileSync(manifest, '{"status":"old"}\n');

      expect(() =>
        commitOutputTransaction(
          [
            {
              content: '{"status":"pending"}\n',
              expected: { bytes: Buffer.from('{"status":"old"}\n'), exists: true },
              failureSentinel: true,
              path: manifest,
            },
            {
              content: "candidate\n",
              expected: { bytes: Buffer.from("original\n"), exists: true },
              path: changelog,
            },
            {
              content: '{"status":"pass"}\n',
              path: manifest,
              replacesPrevious: true,
            },
          ],
          {
            afterRename: ({ index }) => {
              if (index === 1) {
                throw new Error("injected partial write");
              }
            },
          },
        ),
      ).toThrow("injected partial write");
      expect(readFileSync(changelog, "utf8")).toBe("original\n");
      expect(readFileSync(manifest, "utf8")).toBe('{"status":"pending"}\n');
      expect(readdirSync(cwd).some((path) => /\.(?:tmp|restore)-/.test(path))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("preserves a concurrent changelog mutation before the final manifest", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-output-concurrent-"));
    try {
      const changelog = join(cwd, "CHANGELOG.md");
      const manifest = join(cwd, "manifest.json");
      writeFileSync(changelog, "original\n");
      writeFileSync(manifest, '{"status":"old"}\n');

      expect(() =>
        commitOutputTransaction(
          [
            {
              content: '{"status":"pending"}\n',
              expected: { bytes: Buffer.from('{"status":"old"}\n'), exists: true },
              failureSentinel: true,
              path: manifest,
            },
            {
              content: "candidate\n",
              expected: { bytes: Buffer.from("original\n"), exists: true },
              path: changelog,
            },
            {
              content: '{"status":"pass"}\n',
              path: manifest,
              replacesPrevious: true,
            },
          ],
          {
            beforeRename: ({ index }) => {
              if (index === 2) {
                writeFileSync(changelog, "external mutation\n");
              }
            },
          },
        ),
      ).toThrow(/release output rollback incomplete: .*CHANGELOG\.md no longer matches/);
      expect(readFileSync(changelog, "utf8")).toBe("external mutation\n");
      expect(readFileSync(manifest, "utf8")).toBe('{"status":"pending"}\n');
      expect(readdirSync(cwd).some((path) => /\.(?:tmp|restore)-/.test(path))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports incomplete rollback without overwriting a concurrent manifest mutation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-output-rollback-conflict-"));
    try {
      const changelog = join(cwd, "CHANGELOG.md");
      const manifest = join(cwd, "manifest.json");
      writeFileSync(changelog, "original\n");
      writeFileSync(manifest, '{"status":"old"}\n');

      expect(() =>
        commitOutputTransaction(
          [
            {
              content: '{"status":"pending"}\n',
              expected: { bytes: Buffer.from('{"status":"old"}\n'), exists: true },
              failureSentinel: true,
              path: manifest,
            },
            {
              content: "candidate\n",
              expected: { bytes: Buffer.from("original\n"), exists: true },
              path: changelog,
            },
            {
              content: '{"status":"pass"}\n',
              path: manifest,
              replacesPrevious: true,
            },
          ],
          {
            afterRename: ({ index }) => {
              if (index === 0) {
                writeFileSync(manifest, '{"status":"external"}\n');
              }
            },
          },
        ),
      ).toThrow(
        /release output rollback incomplete: .*manifest\.json no longer matches transaction output .*sha256=/,
      );
      expect(readFileSync(changelog, "utf8")).toBe("original\n");
      expect(readFileSync(manifest, "utf8")).toBe('{"status":"external"}\n');
      expect(readdirSync(cwd).some((path) => /\.(?:tmp|restore)-/.test(path))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

  it("rejects prior-release PRs from prose or the existing record unless explicitly seeded", () => {
    const nodes = new Map([
      [97118, { __typename: "PullRequest" }],
      [102000, { __typename: "PullRequest" }],
      [98565, { __typename: "Issue" }],
    ]);
    const params = {
      noteReferences: [97118, 98565],
      recordedReferences: [97118, 102000],
      sourcePullRequests: new Set([102000]),
      sourceReferences: [102000, 98565],
      seededPullRequests: new Set<number>(),
      nodes,
    };

    expect(contaminatingPullRequestReferences(params)).toEqual([97118]);
    expect(
      contaminatingPullRequestReferences({
        ...params,
        seededPullRequests: new Set([97118]),
      }),
    ).toEqual([]);
  });

  it("accepts exact shipped tags that predate complete contribution records", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        ["# Changelog", "", "## 2026.6.8", "", "### Changes", "", "- Legacy release."].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "legacy release"]);
      git(cwd, ["tag", "v2026.6.8"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
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
          "## 2026.6.8",
          "",
          "### Changes",
          "",
          "- Legacy release.",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "current release"]);
      const manifestPath = join(cwd, "release-manifest.json");

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--shipped-ref",
          "v2026.6.8",
          "--manifest",
          manifestPath,
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).shippedBaselines).toEqual([
        { count: 0, pullRequests: [], ref: "v2026.6.8" },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

  it("records a canonical target SHA when --target is symbolic", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
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
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const targetSha = git(cwd, ["rev-parse", "HEAD"]);
      const manifestPath = join(cwd, "release-manifest.json");

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--manifest",
          manifestPath,
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).target).toBe(targetSha);
      expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toContain(
        `This audited record covers the complete HEAD..${targetSha} history:`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rewrites stale contribution rows without treating them as source references", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
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
          "### Complete contribution record",
          "",
          "This audited record covers the complete HEAD..HEAD history: 1 merged PR.",
          "",
          "#### Pull requests",
          "",
          "- **PR #999999999**",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      const ghx = join(bin, "ghx");
      writeFileSync(
        ghx,
        `#!/bin/sh
cat <<'JSON'
{"data":{"n999999999":{"issueOrPullRequest":{"__typename":"PullRequest","number":999999999,"title":"fix: stale fixture (#999999998)","mergedAt":"2020-01-01T00:00:00Z","author":null,"closingIssuesReferences":{"totalCount":1,"nodes":[{"number":999999998}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}},"n999999998":{"issueOrPullRequest":{"__typename":"Issue","number":999999998,"title":"linked issue","author":null,"closedByPullRequestsReferences":{"totalCount":0,"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}
JSON
`,
      );
      chmodSync(ghx, 0o755);
      const manifestPath = join(cwd, "release-manifest.json");

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--manifest",
          manifestPath,
          "--write-ledger",
          "--json",
        ],
        {
          cwd,
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );

      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      const expectedReconciliation = {
        canonicalRows: { count: 0 },
        currentRows: { count: 0, members: [] },
        staleRows: { count: 0, members: [] },
      };
      expect(JSON.parse(result.stdout).reconciliation).toMatchObject(expectedReconciliation);
      const rewrittenChangelog = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
      expect(rewrittenChangelog).not.toContain("#999999999");
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
        schemaVersion: 6,
        status: "pass",
        artifacts: {
          changelogSha256: createHash("sha256").update(rewrittenChangelog).digest("hex"),
        },
        invocation: {
          base: "HEAD",
          maxChangelogTail: 1,
          seedRef: null,
          sourceTarget: "HEAD",
          target: "HEAD",
          toolingCommit: null,
          toolingTree: null,
          writeLedger: true,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        reconciliation: expectedReconciliation,
        reconciliations: {
          afterWrite: expectedReconciliation,
          beforeWrite: {
            canonicalRows: { count: 0 },
            currentRows: { count: 1, members: [999999999] },
            staleRows: { count: 1, members: [999999999] },
          },
        },
        seedAuthorization: null,
        source: {
          issues: 0,
          pullRequests: 0,
          referenceEntries: {
            count: 0,
            records: [],
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
          references: 0,
        },
        tooling: {
          aggregateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          files: expect.arrayContaining([
            expect.objectContaining({
              path: ".agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs",
              sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            }),
            expect.objectContaining({
              path: ".agents/skills/openclaw-changelog-update/scripts/lib/github-team-inventory.mjs",
              sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            }),
            expect.objectContaining({
              path: ".agents/skills/openclaw-changelog-update/scripts/lib/release-source-inventory.mjs",
              sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            }),
            expect.objectContaining({
              path: "scripts/render-github-release-notes.mjs",
              sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            }),
          ]),
          trustedSource: null,
        },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("writes an audit manifest when release-note validation fails", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      const changelog = [
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
        "",
        "### Changes",
        "",
        "### Fixes",
      ].join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
      git(cwd, ["init", "-q"]);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const manifestPath = join(cwd, "release-manifest.json");
      writeFileSync(manifestPath, "sentinel\n");

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--manifest",
          manifestPath,
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(1);
      expect(JSON.parse(result.stdout).errors).toContain(
        "### Highlights must contain 5-8 top-level bullets; found 4",
      );
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
        schemaVersion: 6,
        status: "fail",
        artifacts: {
          changelogSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          releaseSectionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        base: "HEAD",
        invocation: {
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          writeLedger: false,
        },
        target: expect.stringMatching(/^[0-9a-f]{40}$/),
        reconciliation: {
          canonicalRows: { count: 0, members: [] },
        },
        reconciliations: {
          afterWrite: {
            canonicalRows: { count: 0, members: [] },
          },
          beforeWrite: {
            canonicalRows: { count: 0, members: [] },
          },
        },
        seedAuthorization: null,
        tooling: {
          aggregateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          trustedSource: null,
        },
      });
      expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(changelog);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("invalidates a stale pass manifest when a ledger write fails validation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-failed-write-"));
    try {
      const changelog = [
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
        "",
        "### Changes",
        "",
        "### Fixes",
      ].join("\n");
      const changelogPath = join(cwd, "CHANGELOG.md");
      const manifestPath = join(cwd, "release-manifest.json");
      writeFileSync(changelogPath, changelog);
      writeFileSync(
        manifestPath,
        `${JSON.stringify({ schemaVersion: 6, stale: true, status: "pass" })}\n`,
      );
      git(cwd, ["init", "-q"]);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--manifest",
          manifestPath,
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(1);
      expect(JSON.parse(result.stdout).errors).toContain(
        "### Highlights must contain 5-8 top-level bullets; found 4",
      );
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
        schemaVersion: 6,
        status: "fail",
        invocation: {
          writeLedger: true,
        },
      });
      expect(readFileSync(manifestPath, "utf8")).not.toContain('"stale":true');
      expect(readFileSync(changelogPath, "utf8")).toBe(changelog);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("invalidates a stale pass manifest before fallible verifier work", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-early-failure-"));
    try {
      const changelog = [
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
      ].join("\n");
      const changelogPath = join(cwd, "CHANGELOG.md");
      const manifestPath = join(cwd, "release-manifest.json");
      const stalePass = `${JSON.stringify({ schemaVersion: 6, stale: true, status: "pass" })}\n`;
      writeFileSync(changelogPath, changelog);
      writeFileSync(manifestPath, stalePass);
      git(cwd, ["init", "-q"]);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);

      const run = (version: string) =>
        spawnSync(
          process.execPath,
          [
            verifier,
            "--base",
            "HEAD",
            "--target",
            "HEAD",
            "--version",
            version,
            "--manifest",
            manifestPath,
            "--json",
          ],
          { cwd, encoding: "utf8" },
        );
      const expectPending = (version: string, changelogExists = true) => {
        expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
          schemaVersion: 6,
          status: "pending",
          invocation: {
            version,
            writeLedger: false,
          },
        });
        expect(readFileSync(manifestPath, "utf8")).not.toContain('"stale":true');
        if (changelogExists) {
          expect(readFileSync(changelogPath, "utf8")).toBe(changelog);
        } else {
          expect(() => readFileSync(changelogPath, "utf8")).toThrow();
        }
      };

      const missingVersion = run("2099.1.1");
      expect(missingVersion.status).not.toBe(0);
      expect(missingVersion.stderr).toContain("CHANGELOG.md does not contain ## 2099.1.1");
      expectPending("2099.1.1");

      writeFileSync(manifestPath, stalePass);
      const head = git(cwd, ["rev-parse", "HEAD"]);
      writeFileSync(join(cwd, ".git", "shallow"), `${head}\n`);
      const shallowHistory = run("2026.7.1");
      expect(shallowHistory.status).not.toBe(0);
      expect(shallowHistory.stderr).toContain(
        "release source inventory refuses shallow Git repositories",
      );
      expectPending("2026.7.1");

      rmSync(join(cwd, ".git", "shallow"));
      writeFileSync(manifestPath, stalePass);
      rmSync(changelogPath);
      const missingChangelog = run("2026.7.1");
      expect(missingChangelog.status).not.toBe(0);
      expect(missingChangelog.stderr).toContain("CHANGELOG.md does not exist");
      expectPending("2026.7.1", false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses the raw merge base when the shipped release line diverged", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
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
          "### Complete contribution record",
          "",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      git(cwd, ["branch", "target"]);

      writeFileSync(join(cwd, "base.txt"), "base\n");
      git(cwd, ["add", "base.txt"]);
      git(cwd, ["commit", "-qm", "base"]);
      git(cwd, ["tag", "base-ref"]);

      git(cwd, ["checkout", "-q", "target"]);
      const target = git(cwd, ["rev-parse", "HEAD"]);
      const manifestPath = join(cwd, "release-manifest.json");

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "base-ref",
          "--target",
          "HEAD",
          "--version",
          "2026.7.1",
          "--manifest",
          manifestPath,
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mergeBase: target,
        target,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
