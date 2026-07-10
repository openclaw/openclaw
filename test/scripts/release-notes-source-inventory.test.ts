import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  summarizeTeamUniverseMembers,
  summarizeTeamUniverseRecords,
  teamUniverseWindowQuery,
} from "../../.agents/skills/openclaw-changelog-update/scripts/lib/github-team-inventory.mjs";
import {
  assertCompleteReleaseSourceInventory,
  buildReleaseSourceInventory,
  canonicalGitEnvironment,
} from "../../.agents/skills/openclaw-changelog-update/scripts/lib/release-source-inventory.mjs";
import { sourceContributionsFromInventory } from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type CommitFiles = Record<string, string>;

let indexSequence = 0;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function git(
  cwd: string,
  args: string[],
  { env, input }: { env?: NodeJS.ProcessEnv; input?: Buffer | string } = {},
) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: canonicalGitEnvironment(env),
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function withRepository<T>(run: (cwd: string) => T): T {
  const cwd = tempDirs.make("openclaw-release-source-inventory-");
  git(cwd, ["init", "-q", "--initial-branch=main"]);
  git(cwd, ["config", "user.name", "OpenClaw Test"]);
  git(cwd, ["config", "user.email", "test@openclaw.invalid"]);
  return run(cwd);
}

function createCommit(
  cwd: string,
  {
    authorTimestamp,
    body,
    files,
    parents = [],
    subject,
    timestamp,
  }: {
    authorTimestamp?: number;
    body?: string;
    files: CommitFiles;
    parents?: string[];
    subject: string;
    timestamp: number;
  },
) {
  indexSequence += 1;
  const indexPath = join(cwd, `.release-source-index-${indexSequence}`);
  const authorDate = new Date((authorTimestamp ?? timestamp) * 1000).toISOString();
  const commitDate = new Date(timestamp * 1000).toISOString();
  const env = {
    GIT_AUTHOR_DATE: authorDate,
    GIT_COMMITTER_DATE: commitDate,
    GIT_INDEX_FILE: indexPath,
  };
  try {
    git(cwd, ["read-tree", "--empty"], { env });
    for (const [path, content] of Object.entries(files).toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const blob = git(cwd, ["hash-object", "-w", "--stdin"], { input: content });
      git(cwd, ["update-index", "--add", "--cacheinfo", "100644", blob, path], { env });
    }
    const tree = git(cwd, ["write-tree"], { env });
    const message = body ? `${subject}\n\n${body}\n` : `${subject}\n`;
    return git(cwd, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], {
      env,
      input: message,
    });
  } finally {
    rmSync(indexPath, { force: true });
  }
}

function completeAssociations(owners: Map<string, number[]>) {
  return (commits: string[]) =>
    new Map(commits.map((commit) => [commit, owners.get(commit) ?? []]));
}

function completeEvidence(
  owners: Map<string, number[]>,
  pullRequests = new Map<
    number,
    null | {
      __typename: "Issue" | "PullRequest";
      mergedAt?: string | null;
      number: number;
    }
  >(),
  {
    comparison,
    pullRequestCommits = new Map<number, string[]>(),
    pullRequestMetadata = new Map(),
  }: {
    comparison?: unknown;
    pullRequestCommits?: Map<number, string[]>;
    pullRequestMetadata?: Map<number, unknown>;
  } = {},
) {
  const ownerCommitsByPullRequest = new Map<number, string[]>();
  for (const [commit, numbers] of owners) {
    for (const number of numbers) {
      const commits = ownerCommitsByPullRequest.get(number) ?? [];
      commits.push(commit);
      ownerCommitsByPullRequest.set(number, commits);
    }
  }
  const commitsFor = (number: number) =>
    pullRequestCommits.get(number) ?? ownerCommitsByPullRequest.get(number) ?? [];
  const metadataFor = (number: number) => {
    const provided = pullRequestMetadata.get(number);
    if (provided) {
      return provided;
    }
    const commits = commitsFor(number);
    const headCommit = commits.at(-1);
    if (!headCommit) {
      return undefined;
    }
    const node = pullRequests.get(number);
    const mergedAt =
      node?.__typename === "PullRequest" && typeof node.mergedAt === "string"
        ? node.mergedAt
        : "1970-01-01T00:00:01.000Z";
    return {
      baseBranch: "main",
      baseCommit: commits[0],
      headCommit,
      mergeCommit: headCommit,
      mergedAt,
      number,
    };
  };
  return {
    resolveAssociations: completeAssociations(owners),
    resolveComparisonPullRequests: () => comparison,
    resolvePullRequestCommits: (numbers: number[]) =>
      new Map(numbers.map((number) => [number, commitsFor(number)])),
    resolvePullRequestMetadata: (numbers: number[]) =>
      new Map(numbers.map((number) => [number, metadataFor(number)])),
    resolvePullRequests: (numbers: number[]) =>
      new Map(
        numbers.map((number) => [
          number,
          pullRequests.has(number)
            ? (pullRequests.get(number) ?? null)
            : {
                __typename: "PullRequest",
                mergedAt: "1970-01-01T00:00:01.000Z",
                number,
              },
        ]),
      ),
  };
}

function commitRecord(inventory: ReturnType<typeof buildReleaseSourceInventory>, commit: string) {
  const record = inventory.commits.find((entry) => entry.commit === commit);
  expect(record).toBeDefined();
  return record!;
}

describe("release source inventory", () => {
  it("keeps evidence hashes stable under hostile local diff and attribute configuration", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "ordered.txt": "unchanged\n",
        "repeated.txt": "D\nC\nB\nA\nD\nC\nB\nA\nD\nC\nB\nA\nD\nC\nB\nA\nD\nC\nB\nA\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const target = createCommit(cwd, {
        files: {
          ...rootFiles,
          "ordered.txt": "changed\n",
          "repeated.txt": "D\nC\nB\nA\nC\nB\nA\nC\nB\nD\nC\nB\nA\nD\nC\nA\n",
        },
        parents: [root],
        subject: "fix: repeated-line behavior",
        timestamp: 20,
      });
      const build = () =>
        buildReleaseSourceInventory(
          { baseRef: root, cwd, sourceTargetRef: target },
          completeEvidence(new Map()),
        );
      const baseline = build();
      const attributesPath = join(cwd, ".git", "hostile-attributes");
      const orderPath = join(cwd, ".git", "hostile-diff-order");
      writeFileSync(attributesPath, "*.txt -diff\n");
      writeFileSync(orderPath, "repeated.txt\nordered.txt\n");
      for (const [key, value] of [
        ["core.attributesFile", attributesPath],
        ["core.quotePath", "false"],
        ["diff.algorithm", "histogram"],
        ["diff.context", "9"],
        ["diff.indentHeuristic", "true"],
        ["diff.interHunkContext", "99"],
        ["diff.mnemonicPrefix", "true"],
        ["diff.noprefix", "true"],
        ["diff.orderFile", orderPath],
        ["diff.renames", "copies"],
        ["diff.suppressBlankEmpty", "true"],
      ]) {
        git(cwd, ["config", key, value]);
      }
      const hostilePathspecEnvironment = {
        GIT_GLOB_PATHSPECS: "1",
        GIT_ICASE_PATHSPECS: "1",
        GIT_LITERAL_PATHSPECS: "0",
        GIT_NOGLOB_PATHSPECS: "1",
      };
      const previousPathspecEnvironment = new Map(
        Object.keys(hostilePathspecEnvironment).map((key) => [key, process.env[key]]),
      );
      const hostile = (() => {
        Object.assign(process.env, hostilePathspecEnvironment);
        try {
          return build();
        } finally {
          for (const [key, value] of previousPathspecEnvironment) {
            if (value === undefined) {
              delete process.env[key];
            } else {
              process.env[key] = value;
            }
          }
        }
      })();

      const canonicalEnvironment = canonicalGitEnvironment(hostilePathspecEnvironment);
      expect(canonicalEnvironment).toMatchObject({
        GIT_ATTR_NOSYSTEM: "1",
        GIT_LITERAL_PATHSPECS: "1",
        LC_ALL: "C",
      });
      expect(canonicalEnvironment.GIT_GLOB_PATHSPECS).toBeUndefined();
      expect(canonicalEnvironment.GIT_ICASE_PATHSPECS).toBeUndefined();
      expect(canonicalEnvironment.GIT_NOGLOB_PATHSPECS).toBeUndefined();
      expect(hostile.sha256).toBe(baseline.sha256);
      expect(commitRecord(hostile, target)).toEqual(commitRecord(baseline, target));
    }));

  it("rejects mutable repository-local info attributes", () =>
    withRepository((cwd) => {
      const root = createCommit(cwd, {
        files: { "CHANGELOG.md": "# Changelog\n" },
        subject: "chore: root",
        timestamp: 10,
      });
      writeFileSync(join(cwd, ".git", "info", "attributes"), "*.md -diff\n");

      expect(() =>
        buildReleaseSourceInventory(
          { baseRef: root, cwd, sourceTargetRef: root },
          completeEvidence(new Map()),
        ),
      ).toThrow("release source inventory refuses a non-empty Git info/attributes file");
    }));

  it("enumerates divergent target ancestry and keeps contextual references out of ownership", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "README.md": "root\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const divergentBase = createCommit(cwd, {
        files: { ...rootFiles, "base-only.txt": "published line\n" },
        parents: [root],
        subject: "chore: divergent published base",
        timestamp: 20,
      });
      const directFiles = { ...rootFiles, "direct.txt": "direct work\n" };
      const direct = createCommit(cwd, {
        files: directFiles,
        parents: [root],
        subject: "fix: direct behavior",
        timestamp: 30,
      });
      const contextualFiles = { ...directFiles, "mainline.txt": "mainline\n" };
      const contextual = createCommit(cwd, {
        body: "Context: #999",
        files: contextualFiles,
        parents: [direct],
        subject: "fix: contextual follow-up",
        timestamp: 40,
      });
      const sideFiles = { ...directFiles, "side.txt": "side branch\n" };
      const side = createCommit(cwd, {
        files: sideFiles,
        parents: [direct],
        subject: "feat: side branch behavior",
        timestamp: 50,
      });
      const mergeFiles = { ...contextualFiles, "side.txt": "side branch\n" };
      const merge = createCommit(cwd, {
        files: mergeFiles,
        parents: [contextual, side],
        subject: "Merge branch 'side'",
        timestamp: 60,
      });
      const strict = createCommit(cwd, {
        body: "Source-PR: #102",
        files: { ...mergeFiles, "strict.txt": "strict source\n" },
        parents: [merge],
        subject: "fix: strict source ownership",
        timestamp: 70,
      });

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: divergentBase,
          cwd,
          sourceTargetRef: strict,
        },
        completeEvidence(new Map([[side, [101]]])),
      );

      expect(inventory.range.mergeBase).toBe(root);
      expect(inventory.partitions.commits.universe.members).toEqual(
        [direct, contextual, side, merge, strict].toSorted(),
      );
      expect(inventory.commits.map((entry) => entry.commit)).toEqual([
        direct,
        contextual,
        side,
        merge,
        strict,
      ]);
      expect(commitRecord(inventory, direct)).toMatchObject({
        disposition: "direct",
        pullRequests: [],
      });
      expect(commitRecord(inventory, contextual)).toMatchObject({
        disposition: "direct",
        explicitPullRequestReferences: [],
        pullRequests: [],
        references: [999],
      });
      expect(commitRecord(inventory, side)).toMatchObject({
        disposition: "pull-request",
        evidence: [{ method: "association", number: 101, sourceCommit: side }],
        pullRequests: [101],
      });
      expect(commitRecord(inventory, merge)).toMatchObject({
        disposition: "structural-merge",
        parents: [contextual, side],
      });
      expect(commitRecord(inventory, strict)).toMatchObject({
        disposition: "pull-request",
        evidence: [{ method: "explicit-reference", number: 102, sourceCommit: strict }],
        explicitPullRequestReferences: [102],
        pullRequests: [102],
      });
      expect(inventory.partitions.commits).toMatchObject({
        direct: { count: 2 },
        pullRequest: { count: 2 },
        structuralMerge: { count: 1 },
        universe: { count: 5 },
      });
      expect(inventory.partitions.pullRequests.included.members).toEqual([101, 102]);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("requires strict ownership references to be merged pull requests by the source cutoff", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const strict = createCommit(cwd, {
        body: "Co-authored-by: Contributor <contributor@example.com>",
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: strict source ownership (#501)",
        timestamp: 20,
      });
      const invalidEvidence = [
        {
          label: "unmerged pull request",
          node: {
            __typename: "PullRequest" as const,
            mergedAt: null,
            number: 501,
          },
        },
        {
          label: "late pull request",
          node: {
            __typename: "PullRequest" as const,
            mergedAt: "1970-01-01T00:00:21.000Z",
            number: 501,
          },
        },
      ];

      for (const evidence of invalidEvidence) {
        const inventory = buildReleaseSourceInventory(
          { baseRef: root, cwd, sourceTargetRef: strict },
          completeEvidence(new Map(), new Map([[501, evidence.node]])),
        );
        expect(commitRecord(inventory, strict), evidence.label).toMatchObject({
          disposition: "unresolved",
        });
        expect(() => assertCompleteReleaseSourceInventory(inventory)).toThrow(
          "is not a merged pull request by the source target cutoff",
        );
      }

      const issueReferenceInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: strict },
        completeEvidence(new Map(), new Map([[501, { __typename: "Issue", number: 501 }]])),
      );
      expect(commitRecord(issueReferenceInventory, strict)).toMatchObject({
        disposition: "direct",
        explicitPullRequestReferences: [],
        pullRequests: [],
        references: [501],
      });
      expect(assertCompleteReleaseSourceInventory(issueReferenceInventory)).toBe(
        issueReferenceInventory,
      );
      expect(issueReferenceInventory.referenceSnapshots).toMatchObject({
        count: 1,
        records: [{ mergedAt: null, number: 501, type: "Issue" }],
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      const required = createCommit(cwd, {
        body: "Source-PR: #501",
        files: { ...rootFiles, "required.txt": "new\n" },
        parents: [root],
        subject: "fix: required source ownership",
        timestamp: 20,
      });
      const requiredInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: required },
        completeEvidence(new Map(), new Map([[501, { __typename: "Issue", number: 501 }]])),
      );
      expect(commitRecord(requiredInventory, required)).toMatchObject({
        disposition: "unresolved",
      });
      expect(() => assertCompleteReleaseSourceInventory(requiredInventory)).toThrow(
        "is not a merged pull request by the source target cutoff",
      );

      const inventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: strict },
        completeEvidence(
          new Map(),
          new Map([
            [
              501,
              {
                __typename: "PullRequest",
                mergedAt: "1970-01-01T00:00:20.000Z",
                number: 501,
              },
            ],
          ]),
        ),
      );
      expect(commitRecord(inventory, strict)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [501],
      });
      expect(inventory.referenceSnapshots).toMatchObject({
        count: 1,
        records: [
          {
            mergedAt: "1970-01-01T00:00:20.000Z",
            number: 501,
            type: "PullRequest",
          },
        ],
      });
      const source = sourceContributionsFromInventory(inventory, new Map([[strict, ["alice"]]]));
      expect(source.activeCommits[0].coauthors).toEqual(["alice"]);
      expect(source.coauthorsByReference.get(501)).toEqual(new Set(["alice"]));
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      const exactMergeSkewInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: strict },
        completeEvidence(
          new Map([[strict, [501]]]),
          new Map([
            [
              501,
              {
                __typename: "PullRequest",
                mergedAt: "1970-01-01T00:00:21.000Z",
                number: 501,
              },
            ],
          ]),
        ),
      );
      expect(commitRecord(exactMergeSkewInventory, strict)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [501],
      });
      expect(assertCompleteReleaseSourceInventory(exactMergeSkewInventory)).toBe(
        exactMergeSkewInventory,
      );
    }));

  it("resolves exact cherry provenance and fails closed on ambiguous trusted patches", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "ambiguous.txt": "value=old\n",
        "cherry.txt": "old\n",
        "operator.txt": "old\n",
        "unique.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const cherryOrigin = createCommit(cwd, {
        files: { ...rootFiles, "cherry.txt": "new\n" },
        parents: [root],
        subject: "fix: cherry source",
        timestamp: 20,
      });
      const candidateOne = createCommit(cwd, {
        files: { ...rootFiles, "ambiguous.txt": "value = new\n" },
        parents: [root],
        subject: "fix: candidate one",
        timestamp: 22,
      });
      const candidateTwo = createCommit(cwd, {
        files: { ...rootFiles, "ambiguous.txt": "value = new\n" },
        parents: [root],
        subject: "fix: candidate two",
        timestamp: 23,
      });
      const patchIdCollision = createCommit(cwd, {
        files: { ...rootFiles, "ambiguous.txt": "value  =  new\n" },
        parents: [root],
        subject: "fix: whitespace collision",
        timestamp: 24,
      });
      const uniqueCandidate = createCommit(cwd, {
        files: { ...rootFiles, "unique.txt": "new\n" },
        parents: [root],
        subject: "fix: unique trusted source",
        timestamp: 25,
      });
      const operatorOrigin = createCommit(cwd, {
        files: { ...rootFiles, "operator.txt": "new\n" },
        parents: [root],
        subject: "fix: operator-supplied source",
        timestamp: 26,
      });
      const operatorPullRequestCommit = createCommit(cwd, {
        files: { ...rootFiles, "operator.txt": "new\n" },
        parents: [root],
        subject: "fix: pull request member",
        timestamp: 27,
      });
      const nonEquivalentOrigin = createCommit(cwd, {
        files: { ...rootFiles, "operator.txt": "source\n" },
        parents: [root],
        subject: "fix: conflict-adjusted source",
        timestamp: 28,
      });
      const cherry = createCommit(cwd, {
        body: `(cherry picked from commit ${cherryOrigin})`,
        files: { ...rootFiles, "cherry.txt": "new\n" },
        parents: [root],
        subject: "fix: cherry source",
        timestamp: 30,
      });
      const ambiguous = createCommit(cwd, {
        files: {
          ...rootFiles,
          "ambiguous.txt": "value = new\n",
          "cherry.txt": "new\n",
        },
        parents: [cherry],
        subject: "fix: ambiguous source",
        timestamp: 40,
      });
      const uniqueBackport = createCommit(cwd, {
        files: {
          ...rootFiles,
          "cherry.txt": "new\n",
          "unique.txt": "new\n",
        },
        parents: [cherry],
        subject: "fix: unique trusted source",
        timestamp: 41,
      });
      const operatorBackport = createCommit(cwd, {
        body: `(cherry picked from commit ${operatorOrigin})`,
        files: { ...rootFiles, "operator.txt": "new\n" },
        parents: [root],
        subject: "fix: operator-supplied source",
        timestamp: 42,
      });
      const nonEquivalentBackport = createCommit(cwd, {
        body: `(cherry picked from commit ${nonEquivalentOrigin})`,
        files: { ...rootFiles, "operator.txt": "backport\n" },
        parents: [root],
        subject: "fix: conflict-adjusted source (#306)",
        timestamp: 43,
      });
      const owners = new Map<string, number[]>([
        [cherryOrigin, [201]],
        [candidateOne, [301]],
        [candidateTwo, [302]],
        [patchIdCollision, [303]],
        [uniqueCandidate, [304]],
      ]);

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceRefs: [candidateOne, candidateTwo, patchIdCollision],
          sourceTargetRef: ambiguous,
        },
        completeEvidence(owners),
      );

      expect(commitRecord(inventory, cherry)).toMatchObject({
        disposition: "pull-request",
        evidence: [
          {
            method: "cherry-origin-association",
            number: 201,
            sourceCommit: cherryOrigin,
          },
        ],
        pullRequests: [201],
      });
      expect(commitRecord(inventory, ambiguous)).toMatchObject({
        disposition: "unresolved",
        pullRequests: [],
      });
      expect(inventory.unresolved).toContainEqual({
        commit: ambiguous,
        kind: "ownership",
        pullRequests: [301, 302],
        reason: "ownership evidence resolves to more than one pull request",
      });
      expect(inventory.unresolved.some((entry) => entry.pullRequests?.includes(303))).toBe(false);
      expect(inventory.partitions.pullRequests.included.members).toEqual([201]);
      expect(() => assertCompleteReleaseSourceInventory(inventory)).toThrow(
        "ownership evidence resolves to more than one pull request",
      );

      const uniqueInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceRefs: [uniqueCandidate],
          sourceTargetRef: uniqueBackport,
        },
        completeEvidence(owners),
      );
      expect(commitRecord(uniqueInventory, uniqueBackport)).toMatchObject({
        disposition: "pull-request",
        evidence: [
          {
            method: "trusted-patch-association",
            number: 304,
            sourceCommit: uniqueCandidate,
          },
        ],
        pullRequests: [304],
      });
      expect(assertCompleteReleaseSourceInventory(uniqueInventory)).toBe(uniqueInventory);

      const directCherryInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          sourceTargetRef: operatorBackport,
        },
        completeEvidence(owners),
      );
      expect(commitRecord(directCherryInventory, operatorBackport)).toMatchObject({
        disposition: "direct",
        pullRequests: [],
        verifiedCherryPickOrigins: [operatorOrigin],
      });
      expect(assertCompleteReleaseSourceInventory(directCherryInventory)).toBe(
        directCherryInventory,
      );

      const trustedInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenancePullRequests: [{ commitRef: operatorOrigin, number: 305 }],
          sourceTargetRef: operatorBackport,
        },
        completeEvidence(owners, new Map(), {
          pullRequestCommits: new Map([[305, [operatorPullRequestCommit]]]),
        }),
      );
      expect(commitRecord(trustedInventory, operatorBackport)).toMatchObject({
        disposition: "pull-request",
        evidence: [
          {
            method: "trusted-pr-provenance",
            number: 305,
            pullRequestCommit: operatorPullRequestCommit,
            sourceCommit: operatorOrigin,
          },
        ],
        pullRequests: [305],
      });
      expect(trustedInventory.range.provenancePullRequests).toEqual([
        {
          commit: operatorOrigin,
          details: [
            expect.objectContaining({
              method: "trusted-pr-provenance",
              number: 305,
              pullRequestCommit: operatorPullRequestCommit,
              targetCommit: operatorBackport,
              trailerOrigin: operatorOrigin,
            }),
          ],
          matchedCommits: [operatorBackport],
          number: 305,
          ref: operatorOrigin,
        },
      ]);
      expect(trustedInventory.pullRequestSnapshots).toMatchObject({
        count: 1,
        records: [
          {
            baseBranch: "main",
            baseCommit: operatorPullRequestCommit,
            commits: [operatorPullRequestCommit],
            headCommit: operatorPullRequestCommit,
            mergeCommit: operatorPullRequestCommit,
            mergedAt: "1970-01-01T00:00:01.000Z",
            number: 305,
          },
        ],
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(assertCompleteReleaseSourceInventory(trustedInventory)).toBe(trustedInventory);

      const revertedOperatorBackport = createCommit(cwd, {
        body: `This reverts commit ${operatorBackport}.`,
        files: rootFiles,
        parents: [operatorBackport],
        subject: 'Revert "fix: operator-supplied source"',
        timestamp: 44,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePullRequests: [{ commitRef: operatorOrigin, number: 305 }],
            sourceTargetRef: revertedOperatorBackport,
          },
          completeEvidence(owners, new Map(), {
            pullRequestCommits: new Map([[305, [operatorPullRequestCommit]]]),
          }),
        ),
      ).toThrow(`trusted provenance target commit ${operatorBackport} is not active`);

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePullRequests: [{ commitRef: uniqueCandidate, number: 305 }],
            sourceTargetRef: operatorBackport,
          },
          completeEvidence(owners, new Map(), {
            pullRequestCommits: new Map([[305, [operatorPullRequestCommit]]]),
          }),
        ),
      ).toThrow("must match exactly one pull request commit");

      const conflictAdjustedInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          sourceTargetRef: nonEquivalentBackport,
        },
        completeEvidence(owners),
      );
      expect(commitRecord(conflictAdjustedInventory, nonEquivalentBackport)).toMatchObject({
        disposition: "unresolved",
        nonEquivalentCherryPickOrigins: [nonEquivalentOrigin],
        pullRequests: [],
        verifiedCherryPickOrigins: [],
      });
      expect(conflictAdjustedInventory.unresolved).toContainEqual({
        commit: nonEquivalentBackport,
        kind: "ownership",
        pullRequests: [306],
        reason: "non-equivalent cherry-pick provenance requires reviewed adaptation ownership",
      });
      expect(() => assertCompleteReleaseSourceInventory(conflictAdjustedInventory)).toThrow(
        "non-equivalent cherry-pick provenance requires reviewed adaptation ownership",
      );
    }));

  it("accepts only a reviewed strict-path-subset partial backport", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        ":(exclude)a.txt": "old\n",
        "b.txt": "old\n",
        "c.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const source = createCommit(cwd, {
        files: {
          ...rootFiles,
          ":(exclude)a.txt": "new\n",
          "b.txt": "new\n",
          "c.txt": "new\n",
        },
        parents: [root],
        subject: "feat: source feature",
        timestamp: 20,
      });
      const target = createCommit(cwd, {
        body: `Partial backport of ${source}.\n\nBackport of #401.`,
        files: {
          ...rootFiles,
          ":(exclude)a.txt": "new\n",
          "b.txt": "new\n",
        },
        parents: [root],
        subject: "feat: partial release backport",
        timestamp: 30,
      });
      const altered = createCommit(cwd, {
        body: `Partial backport of ${source}.\n\nBackport of #401.`,
        files: {
          ...rootFiles,
          ":(exclude)a.txt": "different\n",
          "b.txt": "new\n",
        },
        parents: [root],
        subject: "feat: altered partial release backport",
        timestamp: 31,
      });
      const whitespaceAltered = createCommit(cwd, {
        body: `Partial backport of ${source}.\n\nBackport of #401.`,
        files: {
          ...rootFiles,
          ":(exclude)a.txt": "new \n",
          "b.txt": "new\n",
        },
        parents: [root],
        subject: "feat: whitespace-altered partial release backport",
        timestamp: 32,
      });
      const ambiguous = createCommit(cwd, {
        body: `Partial backport of ${source}.\n\nPartial backport of ${source}.\n\nBackport of #401.`,
        files: {
          ...rootFiles,
          ":(exclude)a.txt": "new\n",
          "b.txt": "new\n",
        },
        parents: [root],
        subject: "feat: ambiguous partial release backport",
        timestamp: 33,
      });
      const evidence = completeEvidence(new Map([[source, [401]]]), new Map(), {
        pullRequestCommits: new Map([[401, [source]]]),
      });

      const unreviewed = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: target },
        evidence,
      );
      expect(commitRecord(unreviewed, target).disposition).toBe("unresolved");
      expect(unreviewed.unresolved).toContainEqual({
        commit: target,
        kind: "ownership",
        pullRequests: [401],
        reason: "partial backport provenance requires reviewed partial ownership",
      });
      expect(() => assertCompleteReleaseSourceInventory(unreviewed)).toThrow(
        "partial backport provenance requires reviewed partial ownership",
      );

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenancePartialPullRequests: [
            { number: 401, sourceCommitRef: source, targetCommitRef: target },
          ],
          sourceTargetRef: target,
        },
        evidence,
      );
      expect(commitRecord(inventory, target)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [401],
        trustedPartialPullRequest: {
          method: "trusted-pr-partial-backport",
          number: 401,
          omittedPaths: ["c.txt"],
          sourceCommit: source,
          sourcePaths: [":(exclude)a.txt", "b.txt", "c.txt"],
          targetCommit: target,
          targetPaths: [":(exclude)a.txt", "b.txt"],
        },
      });
      expect(inventory.range.provenancePartialPullRequests).toEqual([
        expect.objectContaining({
          number: 401,
          sourceCommit: source,
          targetCommit: target,
          details: expect.objectContaining({
            method: "trusted-pr-partial-backport",
            omittedPaths: ["c.txt"],
          }),
        }),
      ]);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePartialPullRequests: [
              { number: 401, sourceCommitRef: source, targetCommitRef: altered },
            ],
            sourceTargetRef: altered,
          },
          evidence,
        ),
      ).toThrow("does not preserve the exact path patch for :(exclude)a.txt");
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePartialPullRequests: [
              { number: 401, sourceCommitRef: source, targetCommitRef: ambiguous },
            ],
            sourceTargetRef: ambiguous,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent partial backport");
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePartialPullRequests: [
              {
                number: 401,
                sourceCommitRef: source,
                targetCommitRef: whitespaceAltered,
              },
            ],
            sourceTargetRef: whitespaceAltered,
          },
          evidence,
        ),
      ).toThrow("does not preserve the exact path patch for :(exclude)a.txt");
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenancePartialPullRequests: [
              { number: 401, sourceCommitRef: source, targetCommitRef: target },
              { number: 402, sourceCommitRef: source, targetCommitRef: target },
            ],
            sourceTargetRef: target,
          },
          completeEvidence(new Map([[source, [401, 402]]]), new Map(), {
            pullRequestCommits: new Map([
              [401, [source]],
              [402, [source]],
            ]),
          }),
        ),
      ).toThrow("target commits must be unique");
    }));

  it("accepts only an active same-path conflict-resolved adapted backport", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "a.txt": "old\n",
        "b.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const sourceFiles = {
        ...rootFiles,
        "a.txt": "source\n",
        "b.txt": "source\n",
      };
      const pullRequestCommit = createCommit(cwd, {
        files: sourceFiles,
        parents: [root],
        subject: "fix: pull request source",
        timestamp: 20,
      });
      const origin = createCommit(cwd, {
        files: sourceFiles,
        parents: [root],
        subject: "fix: landed source",
        timestamp: 21,
      });
      const targetFiles = {
        ...rootFiles,
        "a.txt": "source\n",
        "b.txt": "release adaptation\n",
      };
      const target = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})`,
        files: targetFiles,
        parents: [root],
        subject: "fix: adapted release backport",
        timestamp: 30,
      });
      const evidence = completeEvidence(new Map([[pullRequestCommit, [501]]]), new Map(), {
        pullRequestCommits: new Map([[501, [pullRequestCommit]]]),
      });
      const provenanceAdaptedPullRequests = [
        {
          number: 501,
          originCommitRef: origin,
          targetCommitRef: target,
        },
      ];

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceAdaptedPullRequests,
          sourceTargetRef: target,
        },
        evidence,
      );
      expect(commitRecord(inventory, target)).toMatchObject({
        disposition: "pull-request",
        nonEquivalentCherryPickOrigins: [origin],
        pullRequests: [501],
        trustedAdaptedPullRequest: {
          method: "trusted-pr-adapted-backport",
          number: 501,
          originCommit: origin,
          paths: ["a.txt", "b.txt"],
          pullRequestCommit,
          targetCommit: target,
        },
      });
      expect(inventory.range.provenanceAdaptedPullRequests).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            method: "trusted-pr-adapted-backport",
            originAuthor: expect.objectContaining({ name: "OpenClaw Test" }),
            originPatchId: expect.any(String),
            pullRequestCommitAuthor: expect.objectContaining({ name: "OpenClaw Test" }),
            targetCommitAuthor: expect.objectContaining({ name: "OpenClaw Test" }),
            targetPatchId: expect.any(String),
          }),
          number: 501,
          originCommit: origin,
          targetCommit: target,
        }),
      ]);
      expect(inventory.range.provenanceAdaptedPullRequests[0].details.originPatchId).not.toBe(
        inventory.range.provenanceAdaptedPullRequests[0].details.targetPatchId,
      );
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      const exactTarget = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})`,
        files: sourceFiles,
        parents: [root],
        subject: "fix: exact release backport",
        timestamp: 31,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: exactTarget,
              },
            ],
            sourceTargetRef: exactTarget,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const wrongPaths = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})`,
        files: { ...rootFiles, "a.txt": "source\n" },
        parents: [root],
        subject: "fix: incomplete adapted release backport",
        timestamp: 32,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: wrongPaths,
              },
            ],
            sourceTargetRef: wrongPaths,
          },
          evidence,
        ),
      ).toThrow("must change exactly the same non-empty paths");

      const whitespaceOnlyTarget = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})`,
        files: {
          ...rootFiles,
          "a.txt": "source \n",
          "b.txt": "source \n",
        },
        parents: [root],
        subject: "fix: whitespace-only adapted release backport",
        timestamp: 32,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: whitespaceOnlyTarget,
              },
            ],
            sourceTargetRef: whitespaceOnlyTarget,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const duplicateTrailer = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})\n(cherry picked from commit ${origin})`,
        files: targetFiles,
        parents: [root],
        subject: "fix: duplicated adapted provenance",
        timestamp: 33,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: duplicateTrailer,
              },
            ],
            sourceTargetRef: duplicateTrailer,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const differentTrailer = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})\n(cherry picked from commit ${pullRequestCommit})`,
        files: targetFiles,
        parents: [root],
        subject: "fix: ambiguous adapted provenance",
        timestamp: 34,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: differentTrailer,
              },
            ],
            sourceTargetRef: differentTrailer,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const partialTrailer = createCommit(cwd, {
        body: `(cherry picked from commit ${origin})\nPartial backport of ${pullRequestCommit}.`,
        files: targetFiles,
        parents: [root],
        subject: "fix: mixed adapted provenance",
        timestamp: 35,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 501,
                originCommitRef: origin,
                targetCommitRef: partialTrailer,
              },
            ],
            sourceTargetRef: partialTrailer,
          },
          evidence,
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const revertedTarget = createCommit(cwd, {
        body: `This reverts commit ${target}.`,
        files: rootFiles,
        parents: [target],
        subject: 'Revert "fix: adapted release backport"',
        timestamp: 40,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests,
            sourceTargetRef: revertedTarget,
          },
          evidence,
        ),
      ).toThrow(`trusted adapted target commit ${target} is not active`);
    }));

  it("accepts only a fully evidenced adapted squash-aggregate backport", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "a.txt": "old\n",
        "b.txt": "old\n",
        "main-only.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const mainBaseFiles = {
        ...rootFiles,
        "main-only.txt": "advanced\n",
      };
      const mainBase = createCommit(cwd, {
        files: mainBaseFiles,
        parents: [root],
        subject: "fix: advance main independently",
        timestamp: 18,
      });
      const memberOneFiles = {
        ...rootFiles,
        "a.txt": "source\n",
      };
      const memberOne = createCommit(cwd, {
        files: memberOneFiles,
        parents: [root],
        subject: "feat: add first provider path",
        timestamp: 20,
      });
      const memberTwoFiles = {
        ...memberOneFiles,
        "b.txt": "source\n",
      };
      const memberTwo = createCommit(cwd, {
        files: memberTwoFiles,
        parents: [memberOne],
        subject: "fix: complete provider path",
        timestamp: 21,
      });
      const squashFiles = {
        ...mainBaseFiles,
        "a.txt": "source\n",
        "b.txt": "source\n",
      };
      const squashMerge = createCommit(cwd, {
        files: squashFiles,
        parents: [mainBase],
        subject: "fix: squash provider pull request (#701)",
        timestamp: 22,
      });
      const targetFiles = {
        ...rootFiles,
        "a.txt": "source\n",
        "b.txt": "release adaptation\n",
      };
      const target = createCommit(cwd, {
        body: `(cherry picked from commit ${squashMerge})`,
        files: targetFiles,
        parents: [root],
        subject: "fix: adapted provider release backport",
        timestamp: 30,
      });
      const pullRequestMetadata = {
        baseBranch: "main",
        baseCommit: mainBase,
        headCommit: memberTwo,
        mergeCommit: squashMerge,
        mergedAt: "1970-01-01T00:00:01.000Z",
        number: 701,
      };
      const evidenceFor = ({
        metadata = pullRequestMetadata,
        members = [memberOne, memberTwo],
        owners = new Map([
          [memberOne, [701]],
          [memberTwo, [701]],
          [squashMerge, [701]],
        ]),
      }: {
        metadata?: typeof pullRequestMetadata;
        members?: string[];
        owners?: Map<string, number[]>;
      } = {}) =>
        completeEvidence(owners, new Map(), {
          pullRequestCommits: new Map([[701, members]]),
          pullRequestMetadata: new Map([[701, metadata]]),
        });
      const provenanceAdaptedPullRequests = [
        {
          number: 701,
          originCommitRef: squashMerge,
          targetCommitRef: target,
        },
      ];

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceAdaptedPullRequests,
          sourceTargetRef: target,
        },
        evidenceFor(),
      );
      expect(commitRecord(inventory, target)).toMatchObject({
        disposition: "pull-request",
        nonEquivalentCherryPickOrigins: [squashMerge],
        pullRequests: [701],
        trustedAdaptedPullRequest: {
          aggregate: {
            baseCommit: root,
            headCommit: memberTwo,
            paths: { count: 2, members: ["a.txt", "b.txt"] },
          },
          method: "trusted-pr-adapted-squash-aggregate-backport",
          number: 701,
          originCommit: squashMerge,
          pathPartitions: {
            adapted: { count: 1, members: ["b.txt"] },
            exact: { count: 1, members: ["a.txt"] },
          },
          pullRequest: pullRequestMetadata,
          pullRequestMembers: {
            count: 2,
            members: [memberOne, memberTwo].toSorted(),
          },
          squashMerge: {
            commit: squashMerge,
            parent: mainBase,
            paths: { count: 2, members: ["a.txt", "b.txt"] },
          },
          target: {
            commit: target,
            parent: root,
            paths: { count: 2, members: ["a.txt", "b.txt"] },
          },
          targetCommit: target,
        },
      });
      const details = commitRecord(inventory, target).trustedAdaptedPullRequest;
      expect(details.coverageEquation).toBe(
        "2 target paths = 1 exact aggregate paths + 1 adapted aggregate paths",
      );
      expect(details.exactPathEvidence).toEqual([
        expect.objectContaining({
          aggregatePatchId: expect.any(String),
          mergePatchId: expect.any(String),
          path: "a.txt",
          proofMethod: "bidirectional-path-state",
          targetPatchId: expect.any(String),
        }),
      ]);
      expect(details.adaptedPathEvidence).toEqual([
        expect.objectContaining({
          aggregatePatchId: expect.any(String),
          mergePatchId: expect.any(String),
          path: "b.txt",
          proofMethod: "operator-reviewed-conflict-adaptation",
          targetPatchId: expect.any(String),
        }),
      ]);
      expect(details.adaptedPathEvidence[0].aggregatePatchId).not.toBe(
        details.adaptedPathEvidence[0].targetPatchId,
      );
      expect(details.pullRequestMemberEvidence).toEqual([
        expect.objectContaining({ commit: memberOne, patchId: expect.any(String) }),
        expect.objectContaining({ commit: memberTwo, patchId: expect.any(String) }),
      ]);
      expect(inventory.range.provenanceAdaptedPullRequests).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            method: "trusted-pr-adapted-squash-aggregate-backport",
          }),
          number: 701,
          originCommit: squashMerge,
          targetCommit: target,
        }),
      ]);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      const nonLexicalMembers = [memberOne, memberTwo].toSorted().reverse();
      const nonLexicalInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceAdaptedPullRequests,
          sourceTargetRef: target,
        },
        evidenceFor({ members: nonLexicalMembers }),
      );
      expect(nonLexicalMembers).not.toEqual(nonLexicalMembers.toSorted());
      expect(nonLexicalInventory.pullRequestSnapshots.records[0].commits).toEqual(
        nonLexicalMembers.toSorted(),
      );
      expect(assertCompleteReleaseSourceInventory(nonLexicalInventory)).toBe(nonLexicalInventory);

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests,
            sourceTargetRef: target,
          },
          evidenceFor({ members: [memberOne] }),
        ),
      ).toThrow("pull request snapshot evidence for #701 is inconsistent");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests,
            sourceTargetRef: target,
          },
          evidenceFor({
            owners: new Map([
              [memberOne, [701]],
              [memberTwo, [701]],
            ]),
          }),
        ),
      ).toThrow("is not the immutable associated squash merge for the pull request");

      const unrelatedMember = createCommit(cwd, {
        files: { ...rootFiles, "unrelated.txt": "unrelated\n" },
        parents: [root],
        subject: "fix: unrelated pull request member",
        timestamp: 23,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests,
            sourceTargetRef: target,
          },
          evidenceFor({ members: [memberOne, memberTwo, unrelatedMember] }),
        ),
      ).toThrow("pull request members do not exactly cover the aggregate ancestry");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests,
            sourceTargetRef: target,
          },
          evidenceFor({
            metadata: { ...pullRequestMetadata, mergeCommit: memberTwo },
          }),
        ),
      ).toThrow("is not the immutable associated squash merge for the pull request");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests,
            sourceTargetRef: target,
          },
          evidenceFor({
            owners: new Map([
              [memberOne, [701]],
              [memberTwo, [701]],
            ]),
          }),
        ),
      ).toThrow("is not the immutable associated squash merge for the pull request");

      const driftedSquash = createCommit(cwd, {
        files: {
          ...squashFiles,
          "b.txt": "squash drift\n",
        },
        parents: [mainBase],
        subject: "fix: drifted squash provider pull request (#701)",
        timestamp: 23,
      });
      const driftedTarget = createCommit(cwd, {
        body: `(cherry picked from commit ${driftedSquash})`,
        files: targetFiles,
        parents: [root],
        subject: "fix: adapted drifted provider release backport",
        timestamp: 31,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 701,
                originCommitRef: driftedSquash,
                targetCommitRef: driftedTarget,
              },
            ],
            sourceTargetRef: driftedTarget,
          },
          evidenceFor({
            metadata: { ...pullRequestMetadata, mergeCommit: driftedSquash },
            owners: new Map([
              [memberOne, [701]],
              [memberTwo, [701]],
              [driftedSquash, [701]],
            ]),
          }),
        ),
      ).toThrow("squash merge does not exactly reproduce the pull request aggregate");

      const wrongPaths = createCommit(cwd, {
        body: `(cherry picked from commit ${squashMerge})`,
        files: { ...rootFiles, "a.txt": "release adaptation\n" },
        parents: [root],
        subject: "fix: incomplete squash release backport",
        timestamp: 32,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 701,
                originCommitRef: squashMerge,
                targetCommitRef: wrongPaths,
              },
            ],
            sourceTargetRef: wrongPaths,
          },
          evidenceFor(),
        ),
      ).toThrow("must change exactly the same non-empty paths");

      const exactTarget = createCommit(cwd, {
        body: `(cherry picked from commit ${squashMerge})`,
        files: memberTwoFiles,
        parents: [root],
        subject: "fix: exact squash release backport",
        timestamp: 33,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 701,
                originCommitRef: squashMerge,
                targetCommitRef: exactTarget,
              },
            ],
            sourceTargetRef: exactTarget,
          },
          evidenceFor(),
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const allAdapted = createCommit(cwd, {
        body: `(cherry picked from commit ${squashMerge})`,
        files: {
          ...rootFiles,
          "a.txt": "release adaptation too\n",
          "b.txt": "release adaptation\n",
        },
        parents: [root],
        subject: "fix: entirely adapted squash release backport",
        timestamp: 34,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 701,
                originCommitRef: squashMerge,
                targetCommitRef: allAdapted,
              },
            ],
            sourceTargetRef: allAdapted,
          },
          evidenceFor(),
        ),
      ).toThrow("must preserve exact aggregate paths and adapt at least one aggregate path");

      const duplicateTrailer = createCommit(cwd, {
        body:
          `(cherry picked from commit ${squashMerge})\n` +
          `(cherry picked from commit ${squashMerge})`,
        files: targetFiles,
        parents: [root],
        subject: "fix: ambiguous squash release backport",
        timestamp: 35,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 701,
                originCommitRef: squashMerge,
                targetCommitRef: duplicateTrailer,
              },
            ],
            sourceTargetRef: duplicateTrailer,
          },
          evidenceFor(),
        ),
      ).toThrow("is not a canonical non-equivalent cherry-pick adaptation");

      const revertedTarget = createCommit(cwd, {
        body: `This reverts commit ${target}.`,
        files: rootFiles,
        parents: [target],
        subject: 'Revert "fix: adapted provider release backport"',
        timestamp: 40,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests,
            sourceTargetRef: revertedTarget,
          },
          evidenceFor(),
        ),
      ).toThrow(`trusted adapted target commit ${target} is not active`);
    }));

  it("accepts only an active explicit multi-source integrated backport", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "a.txt": "old\n",
        "b.txt": "old\n",
        "c.txt": "old\n",
        "d.txt": "old\n",
        "omitted.txt": "old\n",
        "prefix.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const integrationFiles = {
        ...rootFiles,
        "c.txt": "integrated\n",
        "d.txt": "integrated\n",
        "omitted.txt": "integrated but omitted\n",
      };
      const integrationSource = createCommit(cwd, {
        files: integrationFiles,
        parents: [root],
        subject: "fix: earlier pull request integration",
        timestamp: 20,
      });
      const primaryParentFiles = {
        ...integrationFiles,
        "prefix.txt": "aligned\n",
      };
      const primaryParent = createCommit(cwd, {
        files: primaryParentFiles,
        parents: [integrationSource],
        subject: "fix: align pull request prefix",
        timestamp: 21,
      });
      const primaryFiles = {
        ...primaryParentFiles,
        "a.txt": "source\n",
        "b.txt": "source\n",
      };
      const primarySource = createCommit(cwd, {
        files: primaryFiles,
        parents: [primaryParent],
        subject: "fix: pull request head",
        timestamp: 22,
      });
      const mergeCommit = createCommit(cwd, {
        files: primaryFiles,
        parents: [root],
        subject: "fix: merged pull request",
        timestamp: 23,
      });
      const targetParentFiles = {
        ...rootFiles,
        "prefix.txt": "aligned\n",
      };
      const targetParent = createCommit(cwd, {
        body: `(cherry picked from commit ${primaryParent})`,
        files: targetParentFiles,
        parents: [root],
        subject: "fix: align release prefix",
        timestamp: 24,
      });
      const targetFiles = {
        ...targetParentFiles,
        "a.txt": "source\n",
        "b.txt": "release adaptation\n",
        "c.txt": "integrated\n",
        "d.txt": "integrated\n",
      };
      const target = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: targetFiles,
        parents: [targetParent],
        subject: "fix: integrated release backport",
        timestamp: 30,
      });
      const pullRequestCommits = [integrationSource, primaryParent, primarySource];
      const pullRequestMetadata = {
        baseBranch: "main",
        baseCommit: root,
        headCommit: primarySource,
        mergeCommit,
        mergedAt: "1970-01-01T00:00:01.000Z",
        number: 601,
      };
      const evidence = completeEvidence(
        new Map([
          [integrationSource, [601]],
          [primaryParent, [601]],
          [primarySource, [601]],
        ]),
        new Map(),
        {
          pullRequestCommits: new Map([[601, pullRequestCommits]]),
          pullRequestMetadata: new Map([[601, pullRequestMetadata]]),
        },
      );
      const provenanceIntegratedPullRequests = [
        {
          number: 601,
          sourceCommitRef: primarySource,
          targetCommitRef: target,
        },
        {
          number: 601,
          sourceCommitRef: integrationSource,
          targetCommitRef: target,
        },
      ];

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceIntegratedPullRequests,
          sourceTargetRef: target,
        },
        evidence,
      );
      expect(commitRecord(inventory, target)).toMatchObject({
        disposition: "pull-request",
        nonEquivalentCherryPickOrigins: [primarySource],
        pullRequests: [601],
        trustedIntegratedPullRequest: {
          method: "trusted-pr-adapted-integration-backport",
          number: 601,
          originCommit: primarySource,
          parentAlignment: {
            primaryParentCommit: primaryParent,
            targetParentCommit: targetParent,
          },
          pathPartitions: {
            adaptedPrimary: { count: 1, members: ["b.txt"] },
            exactIntegration: { count: 2, members: ["c.txt", "d.txt"] },
            exactPrimary: { count: 1, members: ["a.txt"] },
          },
          primarySource: {
            commit: primarySource,
            paths: { count: 2, members: ["a.txt", "b.txt"] },
          },
          pullRequest: pullRequestMetadata,
          targetCommit: target,
          targetPaths: {
            count: 4,
            members: ["a.txt", "b.txt", "c.txt", "d.txt"],
          },
        },
      });
      expect(
        commitRecord(inventory, target).trustedIntegratedPullRequest.integrationSources,
      ).toEqual([
        expect.objectContaining({
          commit: integrationSource,
          contributionPaths: {
            count: 2,
            members: ["c.txt", "d.txt"],
            sha256: expect.any(String),
          },
          omittedPaths: {
            count: 1,
            members: ["omitted.txt"],
            sha256: expect.any(String),
          },
          paths: {
            count: 3,
            members: ["c.txt", "d.txt", "omitted.txt"],
            sha256: expect.any(String),
          },
        }),
      ]);
      expect(inventory.pullRequestSnapshots.records).toEqual([
        expect.objectContaining({
          commits: pullRequestCommits.toSorted(),
          number: 601,
        }),
      ]);
      expect(inventory.range.provenanceIntegratedPullRequests).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            method: "trusted-pr-adapted-integration-backport",
            pullRequestCommits: {
              count: 3,
              members: [...pullRequestCommits].toSorted(),
              sha256: expect.any(String),
            },
          }),
          number: 601,
          sources: [
            { commit: integrationSource, ref: integrationSource },
            { commit: primarySource, ref: primarySource },
          ].toSorted((left, right) => left.commit.localeCompare(right.commit)),
          targetCommit: target,
        }),
      ]);
      expect(inventory.partitions.commits.manifestDirect.members).toContain(target);
      expect(inventory.partitions.commits.directOwnershipOverlap.members).toContain(target);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: [provenanceIntegratedPullRequests[0]],
            sourceTargetRef: target,
          },
          evidence,
        ),
      ).toThrow("must bind at least two unique pull request source commits");

      const nonMember = createCommit(cwd, {
        files: { ...rootFiles, "c.txt": "integrated\n" },
        parents: [root],
        subject: "fix: unrelated source",
        timestamp: 25,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: [
              provenanceIntegratedPullRequests[0],
              { number: 601, sourceCommitRef: nonMember, targetCommitRef: target },
            ],
            sourceTargetRef: target,
          },
          evidence,
        ),
      ).toThrow("contains a source commit that is not an exact pull request member");

      const siblingIntegration = createCommit(cwd, {
        files: {
          ...rootFiles,
          "c.txt": "integrated\n",
          "d.txt": "integrated\n",
        },
        parents: [root],
        subject: "fix: non-ancestral integration source",
        timestamp: 26,
      });
      const siblingEvidence = completeEvidence(new Map(), new Map(), {
        pullRequestCommits: new Map([[601, [siblingIntegration, primaryParent, primarySource]]]),
        pullRequestMetadata: new Map([[601, pullRequestMetadata]]),
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: [
              provenanceIntegratedPullRequests[0],
              {
                number: 601,
                sourceCommitRef: siblingIntegration,
                targetCommitRef: target,
              },
            ],
            sourceTargetRef: target,
          },
          siblingEvidence,
        ),
      ).toThrow("integration sources must be strict one-parent ancestors of the PR head");

      const integrationRevertFiles = {
        ...integrationFiles,
        "c.txt": "old\n",
      };
      const integrationRevert = createCommit(cwd, {
        files: integrationRevertFiles,
        parents: [integrationSource],
        subject: "fix: revert one integration path",
        timestamp: 27,
      });
      const revertedPrimaryParentFiles = {
        ...integrationRevertFiles,
        "prefix.txt": "aligned\n",
      };
      const revertedPrimaryParent = createCommit(cwd, {
        files: revertedPrimaryParentFiles,
        parents: [integrationRevert],
        subject: "fix: align pull request after integration revert",
        timestamp: 28,
      });
      const revertedPrimaryFiles = {
        ...revertedPrimaryParentFiles,
        "a.txt": "source\n",
        "b.txt": "source\n",
      };
      const revertedPrimarySource = createCommit(cwd, {
        files: revertedPrimaryFiles,
        parents: [revertedPrimaryParent],
        subject: "fix: pull request head after integration revert",
        timestamp: 29,
      });
      const revertedTargetParent = createCommit(cwd, {
        body: `(cherry picked from commit ${revertedPrimaryParent})`,
        files: targetParentFiles,
        parents: [root],
        subject: "fix: align release prefix after integration revert",
        timestamp: 30,
      });
      const revertedPathTarget = createCommit(cwd, {
        body: `(cherry picked from commit ${revertedPrimarySource})`,
        files: targetFiles,
        parents: [revertedTargetParent],
        subject: "fix: release backport restores reverted integration path",
        timestamp: 31,
      });
      const revertedPullRequestCommits = [
        integrationSource,
        integrationRevert,
        revertedPrimaryParent,
        revertedPrimarySource,
      ];
      const revertedPathEvidence = completeEvidence(
        new Map(revertedPullRequestCommits.map((commit) => [commit, [601]])),
        new Map(),
        {
          pullRequestCommits: new Map([[601, revertedPullRequestCommits]]),
          pullRequestMetadata: new Map([
            [
              601,
              {
                ...pullRequestMetadata,
                headCommit: revertedPrimarySource,
              },
            ],
          ]),
        },
      );
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: [
              {
                number: 601,
                sourceCommitRef: revertedPrimarySource,
                targetCommitRef: revertedPathTarget,
              },
              {
                number: 601,
                sourceCommitRef: integrationSource,
                targetCommitRef: revertedPathTarget,
              },
            ],
            sourceTargetRef: revertedPathTarget,
          },
          revertedPathEvidence,
        ),
      ).toThrow("integration path c.txt did not survive unchanged into the PR head parent");

      const wrongHeadEvidence = completeEvidence(new Map(), new Map(), {
        pullRequestCommits: new Map([[601, pullRequestCommits]]),
        pullRequestMetadata: new Map([
          [601, { ...pullRequestMetadata, headCommit: primaryParent }],
        ]),
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests,
            sourceTargetRef: target,
          },
          wrongHeadEvidence,
        ),
      ).toThrow("is not a canonical adapted multi-source pull request backport");

      const missingTrailer = createCommit(cwd, {
        files: targetFiles,
        parents: [targetParent],
        subject: "fix: integrated release backport without trailer",
        timestamp: 31,
      });
      const missingTrailerProvenance = provenanceIntegratedPullRequests.map((entry) => ({
        ...entry,
        targetCommitRef: missingTrailer,
      }));
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: missingTrailerProvenance,
            sourceTargetRef: missingTrailer,
          },
          evidence,
        ),
      ).toThrow("is not a canonical adapted multi-source pull request backport");

      const duplicateTrailer = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})\n(cherry picked from commit ${primarySource})`,
        files: targetFiles,
        parents: [targetParent],
        subject: "fix: integrated release backport with duplicate trailer",
        timestamp: 31,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: duplicateTrailer,
            })),
            sourceTargetRef: duplicateTrailer,
          },
          evidence,
        ),
      ).toThrow("is not a canonical adapted multi-source pull request backport");

      const unalignedTargetParent = createCommit(cwd, {
        files: targetParentFiles,
        parents: [root],
        subject: "fix: release prefix without source trailer",
        timestamp: 25,
      });
      const unalignedTarget = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: targetFiles,
        parents: [unalignedTargetParent],
        subject: "fix: integrated backport on unaligned parent",
        timestamp: 32,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: unalignedTarget,
            })),
            sourceTargetRef: unalignedTarget,
          },
          evidence,
        ),
      ).toThrow("is not a canonical adapted multi-source pull request backport");

      const missingPrimaryPath = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: { ...targetFiles, "a.txt": "old\n" },
        parents: [targetParent],
        subject: "fix: integrated backport missing primary path",
        timestamp: 32,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: missingPrimaryPath,
            })),
            sourceTargetRef: missingPrimaryPath,
          },
          evidence,
        ),
      ).toThrow("must add paths to the complete non-empty PR-head path set");

      const unmatchedIntegration = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: { ...targetFiles, "extra.txt": "unowned\n" },
        parents: [targetParent],
        subject: "fix: integrated backport with unowned path",
        timestamp: 33,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: unmatchedIntegration,
            })),
            sourceTargetRef: unmatchedIntegration,
          },
          evidence,
        ),
      ).toThrow("must map integration path extra.txt to exactly one explicit PR member");

      const noExactPrimary = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: {
          ...targetFiles,
          "a.txt": "release adaptation too\n",
        },
        parents: [targetParent],
        subject: "fix: integrated backport without exact primary path",
        timestamp: 34,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: noExactPrimary,
            })),
            sourceTargetRef: noExactPrimary,
          },
          evidence,
        ),
      ).toThrow("must preserve exact PR-head paths and adapt at least one PR-head path");

      const noAdaptedPrimary = createCommit(cwd, {
        body: `(cherry picked from commit ${primarySource})`,
        files: {
          ...targetFiles,
          "b.txt": "source\n",
        },
        parents: [targetParent],
        subject: "fix: integrated backport without primary adaptation",
        timestamp: 35,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests: provenanceIntegratedPullRequests.map((entry) => ({
              ...entry,
              targetCommitRef: noAdaptedPrimary,
            })),
            sourceTargetRef: noAdaptedPrimary,
          },
          evidence,
        ),
      ).toThrow("must preserve exact PR-head paths and adapt at least one PR-head path");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceAdaptedPullRequests: [
              {
                number: 601,
                originCommitRef: primarySource,
                targetCommitRef: target,
              },
            ],
            provenanceIntegratedPullRequests,
            sourceTargetRef: target,
          },
          evidence,
        ),
      ).toThrow("adapted, integrated, and partial provenance target commits must be disjoint");

      const revertedTarget = createCommit(cwd, {
        body: `This reverts commit ${target}.`,
        files: targetParentFiles,
        parents: [target],
        subject: 'Revert "fix: integrated release backport"',
        timestamp: 40,
      });
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            provenanceIntegratedPullRequests,
            sourceTargetRef: revertedTarget,
          },
          evidence,
        ),
      ).toThrow(`trusted integrated target commit ${target} is not active`);
    }));

  it("classifies an unassociated same-second ancestral merge as comparison boundary", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "root\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 9,
      });
      const boundaryCommit = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "boundary\n" },
        parents: [root],
        subject: "fix: pre-fork merged work",
        timestamp: 10,
      });
      const base = createCommit(cwd, {
        files: {
          ...rootFiles,
          "base.txt": "published\n",
          "state.txt": "boundary\n",
        },
        parents: [boundaryCommit],
        subject: "chore: published base",
        timestamp: 15,
      });
      const sourceTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "release.txt": "release\n",
          "state.txt": "boundary\n",
        },
        parents: [boundaryCommit],
        subject: "fix: release work",
        timestamp: 20,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: boundaryCommit,
          mergeCommit: boundaryCommit,
          mergedAt: "1970-01-01T00:00:10.500Z",
          number: 101,
        },
      ];
      const members = summarizeTeamUniverseMembers([101]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:20Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 20_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 20_000, startTimestamp: 10_000 },
      };

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: base,
          comparisonBaseBranch: "main",
          cwd,
          sourceTargetRef: sourceTarget,
        },
        completeEvidence(new Map(), new Map(), { comparison }),
      );

      expect(inventory.comparison).toMatchObject({
        comparisonOnly: { members: [101] },
        partitionEvidence: {
          boundary: {
            records: [
              {
                mergeBase: boundaryCommit,
                mergeCommit: boundaryCommit,
                mergedAt: "1970-01-01T00:00:10.500Z",
                method: "same-second-ancestral-merge",
                pullRequest: 101,
                windowStartTimestamp: 10_000,
              },
            ],
          },
        },
        partitions: {
          postForkNotBackported: { count: 0 },
          shippedOrBoundary: { members: [101] },
        },
        unclassified: { count: 0 },
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("does not attribute comparison PR member patches already present in common ancestry", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "shared.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const sharedFiles = {
        ...rootFiles,
        "shared.txt": "common\n",
      };
      const shared = createCommit(cwd, {
        files: sharedFiles,
        parents: [root],
        subject: "fix: land shared state",
        timestamp: 20,
      });
      const sourceTarget = createCommit(cwd, {
        files: { ...sharedFiles, "release.txt": "release\n" },
        parents: [shared],
        subject: "fix: release work",
        timestamp: 40,
      });
      const pullRequestDuplicate = createCommit(cwd, {
        files: sharedFiles,
        parents: [root],
        subject: "fix: re-author shared state",
        timestamp: 15,
      });
      const pullRequestHead = createCommit(cwd, {
        files: { ...sharedFiles, "pull-request.txt": "new\n" },
        parents: [pullRequestDuplicate],
        subject: "fix: add post-fork work",
        timestamp: 25,
      });
      const mainParent = createCommit(cwd, {
        files: { ...sharedFiles, "main.txt": "main\n" },
        parents: [shared],
        subject: "fix: advance main",
        timestamp: 30,
      });
      const mergeCommit = createCommit(cwd, {
        files: {
          ...sharedFiles,
          "main.txt": "main\n",
          "pull-request.txt": "new\n",
        },
        parents: [mainParent],
        subject: "fix: merge post-fork work",
        timestamp: 35,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: pullRequestHead,
          mergeCommit,
          mergedAt: "1970-01-01T00:00:35.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers([202]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:40Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 40_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 40_000, startTimestamp: 10_000 },
      };

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          comparisonBaseBranch: "main",
          cwd,
          sourceTargetRef: sourceTarget,
        },
        completeEvidence(new Map(), new Map(), {
          comparison,
          pullRequestCommits: new Map([[202, [pullRequestDuplicate, pullRequestHead]]]),
        }),
      );

      expect(inventory.comparison).toMatchObject({
        comparisonOnly: { members: [202] },
        partitionEvidence: {
          postFork: {
            records: [
              expect.objectContaining({
                patchEquivalentCommits: [],
                pullRequest: 202,
                suppressedCommonAncestryPatchMatches: expect.arrayContaining([
                  expect.objectContaining({
                    candidateCommit: pullRequestDuplicate,
                    commonAncestrySurvivalProof: expect.objectContaining({
                      sharedAncestryCommit: shared,
                      sourceTarget,
                    }),
                    targetCommit: sourceTarget,
                  }),
                ]),
              }),
            ],
          },
        },
        partitions: {
          postForkNotBackported: { members: [202] },
        },
        unclassified: { count: 0 },
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      const removed = createCommit(cwd, {
        files: {
          ...rootFiles,
          "release.txt": "release\n",
        },
        parents: [sourceTarget],
        subject: "revert: remove shared state",
        timestamp: 41,
      });
      const reapplied = createCommit(cwd, {
        files: {
          ...sharedFiles,
          "release.txt": "release\n",
        },
        parents: [removed],
        subject: "fix: reapply shared state",
        timestamp: 42,
      });
      const reappliedQuery = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:42Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const reappliedComparison = {
        ...comparison,
        query: reappliedQuery,
        segments: comparison.segments.map((segment) => ({
          ...segment,
          query: reappliedQuery,
          window: { ...segment.window, endTimestamp: 42_000 },
        })),
        window: { ...comparison.window, endTimestamp: 42_000 },
      };
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            sourceTargetRef: reapplied,
          },
          completeEvidence(new Map(), new Map(), {
            comparison: reappliedComparison,
            pullRequestCommits: new Map([[202, [pullRequestDuplicate, pullRequestHead]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #202 has target provenance");
    }));

  it("owns an exact source merge commit from immutable comparison metadata", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const mergedFiles = {
        ...rootFiles,
        "state.txt": "merged\n",
      };
      const pullRequestHead = createCommit(cwd, {
        files: mergedFiles,
        parents: [root],
        subject: "fix: pull request head",
        timestamp: 15,
      });
      const externalHotfix = createCommit(cwd, {
        files: {
          ...rootFiles,
          "state.txt": "hotfix\n",
        },
        parents: [root],
        subject: "fix: external hotfix",
        timestamp: 16,
      });
      const sourceMergeCommit = createCommit(cwd, {
        body: `(cherry picked from commit ${externalHotfix})`,
        files: mergedFiles,
        parents: [root],
        subject: "fix: landed squash with misleading cherry-pick trailer",
        timestamp: 20,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...mergedFiles,
          "CHANGELOG.md": "# Changelog\n\n- Release ledger.\n",
        },
        parents: [sourceMergeCommit],
        subject: "docs: finalize release ledger",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: pullRequestHead,
          mergeCommit: sourceMergeCommit,
          mergedAt: "1970-01-01T00:00:20.000Z",
          number: 101,
        },
      ];
      const comparisonFor = (comparisonRecords: typeof records) => {
        const members = summarizeTeamUniverseMembers(
          comparisonRecords.map((record) => record.number),
        );
        const recordEvidence = summarizeTeamUniverseRecords(comparisonRecords);
        const query = teamUniverseWindowQuery({
          base: "main",
          end: "1970-01-01T00:00:20Z",
          repository: "openclaw/openclaw",
          start: "1970-01-01T00:00:10Z",
        });
        return {
          baseBranch: "main",
          count: members.count,
          pullRequests: members.members,
          query,
          records: recordEvidence.records,
          recordsSha256: recordEvidence.sha256,
          repository: "openclaw/openclaw",
          segments: [
            {
              count: members.count,
              pullRequests: members.members,
              query,
              recordsSha256: recordEvidence.sha256,
              sha256: members.sha256,
              window: { endTimestamp: 20_000, startTimestamp: 10_000 },
            },
          ],
          sha256: members.sha256,
          window: { endTimestamp: 20_000, startTimestamp: 10_000 },
        };
      };
      const comparison = comparisonFor(records);

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          comparisonBaseBranch: "main",
          cwd,
          finalTargetRef: finalTarget,
          sourceTargetRef: sourceMergeCommit,
        },
        completeEvidence(new Map([[sourceMergeCommit, [101]]]), new Map(), { comparison }),
      );

      expect(commitRecord(inventory, sourceMergeCommit)).toMatchObject({
        associatedPullRequests: [101],
        disposition: "pull-request",
        evidence: [
          {
            method: "comparison-merge-commit",
            number: 101,
            sourceCommit: sourceMergeCommit,
          },
        ],
        nonEquivalentCherryPickOrigins: [externalHotfix],
        pullRequests: [101],
      });
      expect(inventory.partitions.commits.manifestDirect.members).not.toContain(sourceMergeCommit);
      expect(inventory.partitions.commits.directOwnershipOverlap.members).not.toContain(
        sourceMergeCommit,
      );
      expect(inventory.comparison).toMatchObject({
        canonical: { members: [101] },
        comparisonOnly: { count: 0 },
        overlap: { members: [101] },
        partitions: {
          postForkNotBackported: { count: 0 },
        },
        unclassified: { count: 0 },
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      const inventoryWithoutAssociation = buildReleaseSourceInventory(
        {
          baseRef: root,
          comparisonBaseBranch: "main",
          cwd,
          finalTargetRef: finalTarget,
          sourceTargetRef: sourceMergeCommit,
        },
        completeEvidence(new Map(), new Map(), { comparison }),
      );
      expect(commitRecord(inventoryWithoutAssociation, sourceMergeCommit).evidence).toEqual(
        commitRecord(inventory, sourceMergeCommit).evidence,
      );
      expect(inventoryWithoutAssociation.associationSnapshots).not.toEqual(
        inventory.associationSnapshots,
      );
      expect(inventoryWithoutAssociation.sha256).not.toBe(inventory.sha256);

      const lateComparison = comparisonFor([
        {
          ...records[0],
          mergedAt: "1970-01-01T00:00:22.000Z",
        },
      ]);
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: sourceMergeCommit,
          },
          completeEvidence(new Map(), new Map(), { comparison: lateComparison }),
        ),
      ).toThrow("merged pull request comparison resolver returned invalid PR metadata");

      const duplicateOwnerComparison = comparisonFor([
        ...records,
        {
          ...records[0],
          number: 102,
        },
      ]);
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: sourceMergeCommit,
          },
          completeEvidence(new Map(), new Map(), { comparison: duplicateOwnerComparison }),
        ),
      ).toThrow("maps to more than one pull request");
    }));

  it("reconciles exact merged-main comparison members and rejects hidden backports", () =>
    withRepository((cwd) => {
      const rootFiles = {
        ":(exclude)survivor.txt": "old\n",
        "CHANGELOG.md": "# Changelog\n",
        "other.txt": "old\n",
        "old-backport.txt": "old\n",
        "release.txt": "old\n",
        "post-fork.txt": "keep=old\ntransient=base\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const oldBackport = createCommit(cwd, {
        files: { ...rootFiles, "old-backport.txt": "new\n" },
        parents: [root],
        subject: "fix: older main PR backport",
        timestamp: 15,
      });
      const releaseCommit = createCommit(cwd, {
        files: {
          ...rootFiles,
          "old-backport.txt": "new\n",
          "release.txt": "new\n",
        },
        parents: [oldBackport],
        subject: "fix: released work",
        timestamp: 20,
      });
      const postForkFirst = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nTemporary PR note.\n",
          "post-fork.txt": "keep=new\ntransient=temp\n",
        },
        parents: [root],
        subject: "feat: later main work",
        timestamp: 24,
      });
      const postForkHead = createCommit(cwd, {
        files: { ...rootFiles, "post-fork.txt": "keep=new\ntransient=base\n" },
        parents: [postForkFirst],
        subject: "chore(changelog): defer release note",
        timestamp: 25,
      });
      const postForkMerge = createCommit(cwd, {
        files: { ...rootFiles, "post-fork.txt": "keep=new\ntransient=base\n" },
        parents: [root],
        subject: "feat: later main work (#202)",
        timestamp: 26,
      });
      const pathspecCleanup = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nTemporary pathspec note.\n",
          "other.txt": "new\n",
        },
        parents: [root],
        subject: "docs(changelog): add temporary pathspec note",
        timestamp: 24,
      });
      const pathspecHead = createCommit(cwd, {
        files: {
          ...rootFiles,
          ":(exclude)survivor.txt": "new\n",
          "other.txt": "new\n",
        },
        parents: [pathspecCleanup],
        subject: "feat: preserve literal pathspec survivor",
        timestamp: 25,
      });
      const pathspecMerge = createCommit(cwd, {
        files: {
          ...rootFiles,
          ":(exclude)survivor.txt": "new\n",
          "other.txt": "new\n",
        },
        parents: [root],
        subject: "feat: preserve literal pathspec survivor (#203)",
        timestamp: 27,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "old-backport.txt": "new\n",
          "release.txt": "new\n",
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
        },
        parents: [releaseCommit],
        subject: "docs(changelog): finalize notes",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: oldBackport,
          headCommit: releaseCommit,
          mergeCommit: releaseCommit,
          mergedAt: "1970-01-01T00:00:20.000Z",
          number: 101,
        },
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: postForkHead,
          mergeCommit: postForkMerge,
          mergedAt: "1970-01-01T00:00:19.000Z",
          number: 202,
        },
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: pathspecHead,
          mergeCommit: pathspecMerge,
          mergedAt: "1970-01-01T00:00:19.000Z",
          number: 203,
        },
      ];
      const members = summarizeTeamUniverseMembers(records.map((record) => record.number));
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:20Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: members.count,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: members.count,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 20_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 20_000, startTimestamp: 10_000 },
      };
      const evidence = completeEvidence(
        new Map([
          [oldBackport, [303]],
          [releaseCommit, [101]],
        ]),
        new Map(),
        {
          comparison,
          pullRequestCommits: new Map([
            [202, [postForkFirst, postForkHead]],
            [203, [pathspecCleanup, pathspecHead]],
          ]),
          pullRequestMetadata: new Map([
            [
              303,
              {
                baseBranch: "main",
                baseCommit: "c".repeat(40),
                headCommit: "d".repeat(40),
                mergeCommit: "e".repeat(40),
                mergedAt: "1970-01-01T00:00:05.000Z",
                number: 303,
              },
            ],
          ]),
        },
      );
      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          comparisonBaseBranch: "main",
          cwd,
          finalTargetRef: finalTarget,
          sourceTargetRef: releaseCommit,
        },
        evidence,
      );
      expect(inventory.comparison).toMatchObject({
        canonical: { members: [101, 303] },
        canonicalOnly: { members: [303] },
        comparisonOnly: { members: [202, 203] },
        partitions: {
          postForkNotBackported: { members: [202, 203] },
        },
        unclassified: { count: 0 },
      });
      expect(inventory.schemaVersion).toBe(4);
      expect(inventory.comparison?.records).toEqual({
        count: recordEvidence.count,
        records: recordEvidence.records,
        sha256: recordEvidence.sha256,
      });
      expect(inventory.associationSnapshots.records).toEqual(
        expect.arrayContaining([
          {
            allPullRequests: [303],
            commit: oldBackport,
            pullRequests: [303],
          },
          {
            allPullRequests: [101],
            commit: releaseCommit,
            pullRequests: [101],
          },
        ]),
      );
      expect(inventory.comparison?.targetAssociatedOutsideSearch).toMatchObject({
        records: [
          expect.objectContaining({
            omissionReason: "merged-before-search-window",
            number: 303,
            targetCommits: [oldBackport],
          }),
        ],
      });
      expect(inventory.comparison?.partitionEvidence.postFork).toMatchObject({
        count: 2,
      });
      expect(
        inventory.comparison?.partitionEvidence.postFork.records.find(
          (record) => record.pullRequest === 203,
        )?.patchEquivalentCommits,
      ).toEqual([]);

      const pathspecTargetParent = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nTemporary pathspec note.\n",
        },
        parents: [root],
        subject: "docs(changelog): release temporary pathspec note",
        timestamp: 18,
      });
      const hiddenPathspecMember = createCommit(cwd, {
        files: {
          ...rootFiles,
          ":(exclude)survivor.txt": "new\n",
        },
        parents: [pathspecTargetParent],
        subject: "feat: hidden literal pathspec member backport",
        timestamp: 20,
      });
      const hiddenPathspecTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          ":(exclude)survivor.txt": "new\n",
          "CHANGELOG.md": "# Changelog\n\nFinal hidden pathspec notes.\n",
        },
        parents: [hiddenPathspecMember],
        subject: "docs(changelog): finalize hidden pathspec notes",
        timestamp: 30,
      });
      const pathspecRecords = records.filter((record) => record.number === 203);
      const pathspecMembers = summarizeTeamUniverseMembers([203]);
      const pathspecRecordEvidence = summarizeTeamUniverseRecords(pathspecRecords);
      const pathspecComparison = {
        ...comparison,
        count: 1,
        pullRequests: pathspecMembers.members,
        records: pathspecRecordEvidence.records,
        recordsSha256: pathspecRecordEvidence.sha256,
        segments: comparison.segments.map((segment) => ({
          ...segment,
          count: 1,
          pullRequests: pathspecMembers.members,
          recordsSha256: pathspecRecordEvidence.sha256,
          sha256: pathspecMembers.sha256,
        })),
        sha256: pathspecMembers.sha256,
      };
      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: hiddenPathspecTarget,
            sourceTargetRef: hiddenPathspecMember,
          },
          completeEvidence(new Map(), new Map(), {
            comparison: pathspecComparison,
            pullRequestCommits: new Map([[203, [pathspecCleanup, pathspecHead]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #203 has target provenance");

      const expectHiddenProvenance = (sourceTarget, target) => {
        const hiddenRecords = records.map((record) =>
          record.number === 101
            ? {
                ...record,
                headCommit: sourceTarget,
                mergeCommit: sourceTarget,
              }
            : record,
        );
        const hiddenRecordEvidence = summarizeTeamUniverseRecords(hiddenRecords);
        const hiddenComparison = {
          ...comparison,
          records: hiddenRecordEvidence.records,
          recordsSha256: hiddenRecordEvidence.sha256,
          segments: comparison.segments.map((segment) => ({
            ...segment,
            recordsSha256: hiddenRecordEvidence.sha256,
          })),
        };
        expect(() =>
          buildReleaseSourceInventory(
            {
              baseRef: root,
              comparisonBaseBranch: "main",
              cwd,
              finalTargetRef: target,
              sourceTargetRef: sourceTarget,
            },
            completeEvidence(new Map(), new Map(), {
              comparison: hiddenComparison,
              pullRequestCommits: new Map([
                [101, [sourceTarget]],
                [202, [postForkFirst, postForkHead]],
                [203, [pathspecCleanup, pathspecHead]],
              ]),
            }),
          ),
        ).toThrow("has target provenance");
      };
      const partialMemberBackport = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nTemporary PR note.\n",
          "post-fork.txt": "keep=new\ntransient=temp\n",
        },
        parents: [root],
        subject: "feat: exact partial-survival member backport",
        timestamp: 20,
      });
      const partialMemberFinalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nTemporary PR note.\n\nFinal partial notes.\n",
          "post-fork.txt": "keep=new\ntransient=temp\n",
        },
        parents: [partialMemberBackport],
        subject: "docs(changelog): finalize partial notes",
        timestamp: 30,
      });
      expectHiddenProvenance(partialMemberBackport, partialMemberFinalTarget);

      const hiddenBackport = createCommit(cwd, {
        files: { ...rootFiles, "post-fork.txt": "keep=new\ntransient=base\n" },
        parents: [root],
        subject: "feat: hidden release backport",
        timestamp: 20,
      });
      const hiddenFinalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "post-fork.txt": "keep=new\ntransient=base\n",
          "CHANGELOG.md": "# Changelog\n\nFinal hidden notes.\n",
        },
        parents: [hiddenBackport],
        subject: "docs(changelog): finalize hidden notes",
        timestamp: 30,
      });
      expectHiddenProvenance(hiddenBackport, hiddenFinalTarget);
    }));

  it("acknowledges one independently witnessed PR-member overlap without attributing the PR", () =>
    withRepository((cwd) => {
      const baseOverlap = [
        "old",
        "keep-1",
        "keep-2",
        "keep-3",
        "keep-4",
        "keep-5",
        "keep-6",
        "keep-7",
        "keep-8",
        "",
      ].join("\n");
      const directOverlap = baseOverlap.replace(/^old$/m, "member");
      const removedAndMutatedOverlap = baseOverlap.replace("keep-8", "main-mutated");
      const branchBaseOverlap = `${baseOverlap.trimEnd()}\nbranch-context\n`;
      const memberBranchOverlap = branchBaseOverlap.replace(/^old$/m, "member");
      const headOverlap = `${memberBranchOverlap.trimEnd()}\nhead-extra\n`;
      const droppedOverlap = `${branchBaseOverlap.trimEnd()}\nhead-extra\n`;
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "cleanup.txt": "stable\n",
        "other.txt": "base\n",
        "overlap.txt": baseOverlap,
        "release.txt": "base\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const branchSetup = createCommit(cwd, {
        files: { ...rootFiles, "overlap.txt": branchBaseOverlap },
        parents: [root],
        subject: "test: add branch context",
        timestamp: 14,
      });
      const member = createCommit(cwd, {
        files: { ...rootFiles, "overlap.txt": memberBranchOverlap },
        parents: [branchSetup],
        subject: "fix: overlapping PR member",
        timestamp: 15,
      });
      const temporary = createCommit(cwd, {
        files: {
          ...rootFiles,
          "cleanup.txt": "temporary\n",
          "overlap.txt": memberBranchOverlap,
        },
        parents: [member],
        subject: "test: add branch-local state",
        timestamp: 16,
      });
      const cleanup = createCommit(cwd, {
        files: { ...rootFiles, "overlap.txt": memberBranchOverlap },
        parents: [temporary],
        subject: "test: remove branch-local state",
        timestamp: 17,
      });
      const head = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "head\n",
          "overlap.txt": headOverlap,
        },
        parents: [cleanup],
        subject: "feat: broader pull request head",
        timestamp: 18,
      });
      const duplicateMember = createCommit(cwd, {
        files: { ...rootFiles, "overlap.txt": memberBranchOverlap },
        parents: [branchSetup],
        subject: "fix: duplicate overlapping member",
        timestamp: 19,
      });
      const literalMember = createCommit(cwd, {
        files: { ...rootFiles, "overlap.txt": directOverlap },
        parents: [root],
        subject: "fix: literal raw-diff backport",
        timestamp: 15,
      });
      const literalHead = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "head\n",
          "overlap.txt": headOverlap,
        },
        parents: [literalMember],
        subject: "feat: broader literal pull request head",
        timestamp: 18,
      });
      const witness = createCommit(cwd, {
        authorTimestamp: 20,
        files: { ...rootFiles, "overlap.txt": directOverlap },
        parents: [root],
        subject: "test: align overlap metadata",
        timestamp: 25,
      });
      const target = createCommit(cwd, {
        authorTimestamp: 20,
        files: { ...rootFiles, "overlap.txt": directOverlap },
        parents: [root],
        subject: "test: align overlap metadata",
        timestamp: 30,
      });
      const merge = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "head\n",
          "overlap.txt": headOverlap,
        },
        parents: [witness],
        subject: "feat: broader pull request head (#202)",
        timestamp: 40,
      });
      const sourceTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "overlap.txt": directOverlap,
          "release.txt": "released\n",
        },
        parents: [target],
        subject: "fix: release-only work",
        timestamp: 50,
      });
      const record = {
        baseBranch: "main",
        baseCommit: root,
        headCommit: head,
        mergeCommit: merge,
        mergedAt: "1970-01-01T00:00:40.000Z",
        number: 202,
      };
      const comparisonFor = (nextRecord = record, endTimestamp = 50) => {
        const members = summarizeTeamUniverseMembers([nextRecord.number]);
        const recordEvidence = summarizeTeamUniverseRecords([nextRecord]);
        const query = teamUniverseWindowQuery({
          base: "main",
          end: new Date(endTimestamp * 1000).toISOString().replace(".000Z", "Z"),
          repository: "openclaw/openclaw",
          start: "1970-01-01T00:00:10Z",
        });
        return {
          baseBranch: "main",
          count: members.count,
          pullRequests: members.members,
          query,
          records: recordEvidence.records,
          recordsSha256: recordEvidence.sha256,
          repository: "openclaw/openclaw",
          segments: [
            {
              count: members.count,
              pullRequests: members.members,
              query,
              recordsSha256: recordEvidence.sha256,
              sha256: members.sha256,
              window: { endTimestamp: endTimestamp * 1000, startTimestamp: 10_000 },
            },
          ],
          sha256: members.sha256,
          window: { endTimestamp: endTimestamp * 1000, startTimestamp: 10_000 },
        };
      };
      const defaultPullRequestCommits = [branchSetup, member, temporary, cleanup, head];
      const build = ({
        comparison = comparisonFor(),
        overlap = {
          number: 202,
          sourceCommitRef: member,
          targetCommitRef: target,
          witnessCommitRef: witness,
        },
        owners = new Map<string, number[]>([[member, [202]]]),
        provenancePullRequests = [] as { commitRef: string; number: number }[],
        pullRequestCommits = defaultPullRequestCommits,
        referenceNodes = new Map<
          number,
          null | {
            __typename: "Issue" | "PullRequest";
            mergedAt?: string | null;
            number: number;
          }
        >(),
        targetRef = sourceTarget,
        finalTargetRef = targetRef,
      } = {}) =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            comparisonPullRequestMemberOverlaps: [overlap],
            cwd,
            finalTargetRef,
            provenancePullRequests,
            sourceTargetRef: targetRef,
          },
          completeEvidence(owners, referenceNodes, {
            comparison,
            pullRequestCommits: new Map([[202, pullRequestCommits]]),
          }),
        );

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            sourceTargetRef: sourceTarget,
          },
          completeEvidence(new Map([[member, [202]]]), new Map(), {
            comparison: comparisonFor(),
            pullRequestCommits: new Map([[202, [branchSetup, member, temporary, cleanup, head]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #202 has target provenance");

      const inventory = build();
      expect(commitRecord(inventory, target)).toMatchObject({
        disposition: "direct",
        pullRequests: [],
      });
      expect(inventory.comparison).toMatchObject({
        canonical: { count: 0 },
        comparisonOnly: { members: [202] },
        partitionAudit: {
          missing: [],
          overlaps: [],
          unexpected: [],
        },
        partitions: { postForkNotBackported: { members: [202] } },
      });
      expect(inventory.partitions.commits).toMatchObject({
        directOwnershipOverlap: { count: 0 },
        exclusiveDirect: { count: 2 },
        manifestDirect: { count: 2 },
      });
      expect(inventory.partitions.directReconciliation.equation).toBe(
        "2 manifest-direct - 0 PR-owned overlap = 2 exclusive-direct",
      );
      expect(inventory.range.comparisonPullRequestMemberOverlaps).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            merge: expect.objectContaining({
              firstParentCandidateLineOverlap: {
                count: 0,
                members: [],
                sha256: expect.any(String),
              },
            }),
            method: "reviewed-nonownership-exact-member-overlap",
            ownershipAttributed: false,
            scannerMatches: { count: 2, records: expect.any(Array), sha256: expect.any(String) },
            source: expect.objectContaining({
              commit: member,
              diffSha256: expect.not.stringMatching(commitRecord(inventory, target).diffSha256),
            }),
            target: expect.objectContaining({ commit: target }),
            witness: expect.objectContaining({
              commit: witness,
              fullAncestryExactPathMatches: expect.objectContaining({ members: [witness] }),
            }),
          }),
          number: 202,
          sourceCommit: member,
          targetCommit: target,
          witnessCommit: witness,
        }),
      ]);
      const overlapDetails = inventory.range.comparisonPullRequestMemberOverlaps[0].details;
      expect(overlapDetails.branchLocalCleanupCandidates).toMatchObject({
        count: 1,
        records: [
          expect.objectContaining({
            commit: cleanup,
            kind: "pull-request",
            proofMethod: "zero-context-round-trip-on-pr-base-and-head",
          }),
        ],
      });
      expect(overlapDetails.scannerMatches).toMatchObject({
        count: 2,
        records: expect.arrayContaining([
          expect.objectContaining({
            candidateCommit: member,
            candidateKind: "pull-request",
            targetCommit: target,
          }),
          expect.objectContaining({
            candidateCommit: member,
            candidateKind: "pull-request-final-tree",
            targetCommit: sourceTarget,
          }),
        ]),
      });
      expect(overlapDetails.source.associations).toMatchObject({
        count: 1,
        members: [202],
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(overlapDetails.target.associations).toMatchObject({
        count: 0,
        members: [],
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(overlapDetails.witness).toMatchObject({
        allAncestryPathHistory: {
          count: 2,
          members: [root, witness].toSorted(),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        associations: {
          count: 0,
          members: [],
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        firstParentPathHistory: {
          count: 2,
          members: [root, witness].toSorted(),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        firstParentSurvivalStates: expect.objectContaining({
          count: 1,
          records: [
            expect.objectContaining({
              commit: witness,
              path: "overlap.txt",
            }),
          ],
        }),
        fullAncestryExactPathMatches: {
          count: 1,
          members: [witness],
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        revertedCommits: expect.objectContaining({ members: [] }),
      });
      expect(overlapDetails.witness.firstParentSurvivalStates.records[0].stateSha256).toBe(
        overlapDetails.witness.firstParentSurvivalStates.records[0].targetStateSha256,
      );
      expect(overlapDetails.topology).toMatchObject({
        baseAncestorOfMergeParent: true,
        pullRequestMergedAtTimestamp: 40_000,
        sourceAncestorOfHead: true,
        sourceAncestorOfMerge: false,
        sourceAncestorOfMergeParent: false,
        sourceAncestorOfTarget: false,
        sourceAncestorOfWitness: false,
        sourceCutoffTimestamp: 50_000,
        targetAncestorOfHead: false,
        targetAncestorOfMerge: false,
        targetAncestorOfMergeParent: false,
        targetAncestorOfSource: false,
        targetAncestorOfWitness: false,
        witnessAncestorOfHead: false,
        witnessAncestorOfMergeParent: true,
        witnessAncestorOfSource: false,
        witnessAncestorOfTarget: false,
      });
      expect(overlapDetails.topology.pullRequestMemberRelations).toMatchObject({
        count: defaultPullRequestCommits.length,
        records: expect.arrayContaining(
          defaultPullRequestCommits.map((commit) => ({
            commit,
            memberAncestorOfTarget: false,
            memberAncestorOfWitness: false,
            targetAncestorOfMember: false,
            witnessAncestorOfMember: false,
          })),
        ),
      });
      const overlapPathEvidence = overlapDetails.aggregate.overlapPaths.records[0];
      expect(overlapPathEvidence.targetStateSha256).toBe(
        overlapPathEvidence.targetCommitStateSha256,
      );
      expect(overlapPathEvidence.targetStateSha256).toBe(
        overlapPathEvidence.witnessCommitStateSha256,
      );
      expect(overlapPathEvidence.targetStateSha256).toBe(
        overlapPathEvidence.mergeParentStateSha256,
      );
      expect(overlapPathEvidence.hunkAnchor).toMatchObject({
        aggregateBaseCommit: root,
        aggregateBaseStateSha256: overlapPathEvidence.hunkAnchor.targetParentStateSha256,
        candidateBoundary: 1,
        path: "overlap.txt",
        sourceCommit: member,
        sourceParent: branchSetup,
        targetCommit: target,
        targetParent: root,
      });
      expect(
        new Set([
          overlapPathEvidence.baseStateSha256,
          overlapPathEvidence.headStateSha256,
          overlapPathEvidence.targetStateSha256,
        ]).size,
      ).toBe(3);
      expect(overlapPathEvidence.hunkAnchor.hunks).toMatchObject({
        count: 1,
        records: [
          expect.objectContaining({
            aggregateBasePreimageOccurrences: 1,
            sourceCommitPostimageOccurrences: 1,
            sourceParentPreimageOccurrences: 1,
            targetCommitPostimageOccurrences: 1,
            targetParentPreimageOccurrences: 1,
          }),
        ],
      });
      expect(overlapPathEvidence.hunkAnchor.setupHunks.count).toBe(1);
      expect(overlapPathEvidence.hunkAnchor.setupHunks.records[0].newStart).toBeGreaterThan(
        overlapPathEvidence.hunkAnchor.candidateBoundary,
      );
      const postForkRecord = inventory.comparison?.partitionEvidence.postFork.records.find(
        (entry) => entry.pullRequest === 202,
      );
      expect(postForkRecord).toMatchObject({
        patchEquivalentCommits: [],
        reviewedMemberOverlap: expect.objectContaining({
          ownershipAttributed: false,
          target: expect.objectContaining({ commit: target }),
          witness: expect.objectContaining({ commit: witness }),
        }),
      });
      const contributions = sourceContributionsFromInventory(inventory);
      expect([...contributions.pullRequests]).not.toContain(202);
      expect(contributions.activeCommits.flatMap((entry) => entry.pullRequests)).not.toContain(202);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      expect(() =>
        build({
          overlap: {
            number: 202,
            sourceCommitRef: duplicateMember,
            targetCommitRef: target,
            witnessCommitRef: witness,
          },
          pullRequestCommits: [branchSetup, member, duplicateMember, temporary, cleanup, head],
        }),
      ).toThrow("is not an isolated direct exact-member overlap");
      expect(() =>
        build({
          pullRequestCommits: [branchSetup, member, duplicateMember, temporary, cleanup, head],
        }),
      ).toThrow("does not select exactly one non-cleanup pull request member");
      expect(() =>
        build({
          comparison: comparisonFor({
            ...record,
            headCommit: literalHead,
          }),
          overlap: {
            number: 202,
            sourceCommitRef: literalMember,
            targetCommitRef: target,
            witnessCommitRef: witness,
          },
          owners: new Map([[literalMember, [202]]]),
          pullRequestCommits: [literalMember, literalHead],
        }),
      ).toThrow("is not an isolated direct exact-member overlap");
      expect(() =>
        build({
          provenancePullRequests: [{ commitRef: branchSetup, number: 202 }],
        }),
      ).toThrow("trusted comparison overlap and provenance pull request numbers must be disjoint");
      expect(() =>
        build({
          provenancePullRequests: [{ commitRef: member, number: 303 }],
        }),
      ).toThrow("trusted comparison overlap commits and provenance commits must be disjoint");
      expect(() =>
        build({
          owners: new Map([
            [member, [202]],
            [target, [303]],
          ]),
        }),
      ).toThrow("is not an isolated direct exact-member overlap");
      expect(() =>
        build({
          owners: new Map([
            [member, [202]],
            [witness, [303]],
          ]),
        }),
      ).toThrow("is not an isolated direct exact-member overlap");
      expect(() =>
        build({
          owners: new Map([
            [member, [202]],
            [target, [202]],
          ]),
        }),
      ).toThrow("is not a comparison-only post-fork pull request");
      expect(() =>
        build({
          pullRequestCommits: [branchSetup, member, temporary, cleanup, target, head],
        }),
      ).toThrow("is not an isolated direct exact-member overlap");
      expect(() =>
        build({
          pullRequestCommits: [branchSetup, member, temporary, cleanup, witness, head],
        }),
      ).toThrow("is not an isolated direct exact-member overlap");

      const mergeWithoutWitness = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "head\n",
          "overlap.txt": headOverlap,
        },
        parents: [root],
        subject: "feat: merge without independent witness (#202)",
        timestamp: 40,
      });
      expect(() =>
        build({
          comparison: comparisonFor({
            ...record,
            mergeCommit: mergeWithoutWitness,
          }),
        }),
      ).toThrow("is not an isolated direct exact-member overlap");

      const droppedMerge = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "head\n",
          "overlap.txt": droppedOverlap,
        },
        parents: [witness],
        subject: "feat: merge drops overlapping member (#202)",
        timestamp: 40,
      });
      expect(() =>
        build({
          comparison: comparisonFor({
            ...record,
            mergeCommit: droppedMerge,
          }),
        }),
      ).toThrow("does not prove immutable member survival and aggregate omission");

      const sideBranchWitness = createCommit(cwd, {
        authorTimestamp: 20,
        files: { ...rootFiles, "overlap.txt": directOverlap },
        parents: [root],
        subject: "test: align overlap metadata",
        timestamp: 27,
      });
      const mergedWitnessParent = createCommit(cwd, {
        files: { ...rootFiles, "overlap.txt": directOverlap },
        parents: [witness, sideBranchWitness],
        subject: "test: merge duplicate witness branch",
        timestamp: 28,
      });
      const mergeWithSecondWitness = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "head\n",
          "overlap.txt": headOverlap,
        },
        parents: [mergedWitnessParent],
        subject: "feat: broader pull request head (#202)",
        timestamp: 40,
      });
      expect(() =>
        build({
          comparison: comparisonFor({
            ...record,
            mergeCommit: mergeWithSecondWitness,
          }),
        }),
      ).toThrow("does not have exactly one independent main witness");

      const witnessRemoval = createCommit(cwd, {
        files: { ...rootFiles, "overlap.txt": removedAndMutatedOverlap },
        parents: [witness],
        subject: "test: remove witnessed overlap",
        timestamp: 26,
      });
      const witnessReintroduction = createCommit(cwd, {
        files: {
          ...rootFiles,
          "main-extra.txt": "bundled\n",
          "overlap.txt": directOverlap,
        },
        parents: [witnessRemoval],
        subject: "test: reintroduce overlap with unrelated work",
        timestamp: 27,
      });
      const mergeAfterReintroduction = createCommit(cwd, {
        files: {
          ...rootFiles,
          "main-extra.txt": "bundled\n",
          "other.txt": "head\n",
          "overlap.txt": headOverlap,
        },
        parents: [witnessReintroduction],
        subject: "feat: broader pull request head (#202)",
        timestamp: 40,
      });
      expect(() =>
        build({
          comparison: comparisonFor({
            ...record,
            mergeCommit: mergeAfterReintroduction,
          }),
        }),
      ).toThrow("does not preserve the main witness on its first-parent path");

      const branchyHead = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "head\n",
          "overlap.txt": headOverlap,
        },
        parents: [head, target],
        subject: "test: merge release target into pull request head",
        timestamp: 35,
      });
      expect(() =>
        build({
          comparison: comparisonFor({
            ...record,
            headCommit: branchyHead,
          }),
          pullRequestCommits: [branchSetup, member, temporary, cleanup, head, branchyHead],
        }),
      ).toThrow("is not an isolated direct exact-member overlap");

      const referencedWitness = createCommit(cwd, {
        authorTimestamp: 20,
        files: { ...rootFiles, "overlap.txt": directOverlap },
        parents: [root],
        subject: "test: align overlap metadata (#303)",
        timestamp: 26,
      });
      const referencedTarget = createCommit(cwd, {
        authorTimestamp: 20,
        files: { ...rootFiles, "overlap.txt": directOverlap },
        parents: [root],
        subject: "test: align overlap metadata (#303)",
        timestamp: 31,
      });
      const referencedMerge = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "head\n",
          "overlap.txt": headOverlap,
        },
        parents: [referencedWitness],
        subject: "feat: broader pull request head (#202)",
        timestamp: 40,
      });
      const referencedSourceTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "overlap.txt": directOverlap,
          "release.txt": "released\n",
        },
        parents: [referencedTarget],
        subject: "fix: referenced release-only work",
        timestamp: 50,
      });
      expect(() =>
        build({
          comparison: comparisonFor({
            ...record,
            mergeCommit: referencedMerge,
          }),
          overlap: {
            number: 202,
            sourceCommitRef: member,
            targetCommitRef: referencedTarget,
            witnessCommitRef: referencedWitness,
          },
          referenceNodes: new Map([[303, { __typename: "Issue", number: 303 }]]),
          targetRef: referencedSourceTarget,
        }),
      ).toThrow("is not an isolated direct exact-member overlap");

      const lateTarget = createCommit(cwd, {
        authorTimestamp: 20,
        files: { ...rootFiles, "overlap.txt": directOverlap },
        parents: [root],
        subject: "test: align overlap metadata",
        timestamp: 45,
      });
      const lateSourceTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "overlap.txt": directOverlap,
          "release.txt": "released\n",
        },
        parents: [lateTarget],
        subject: "fix: late release-only work",
        timestamp: 50,
      });
      expect(() =>
        build({
          overlap: {
            number: 202,
            sourceCommitRef: member,
            targetCommitRef: lateTarget,
            witnessCommitRef: witness,
          },
          targetRef: lateSourceTarget,
        }),
      ).toThrow("is not an isolated direct exact-member overlap");

      const preMergeSourceTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "overlap.txt": directOverlap,
          "release.txt": "released\n",
        },
        parents: [target],
        subject: "fix: pre-merge release cutoff",
        timestamp: 35,
      });
      const postMergeChangelogTail = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
          "overlap.txt": directOverlap,
          "release.txt": "released\n",
        },
        parents: [preMergeSourceTarget],
        subject: "docs(changelog): finalize after merge",
        timestamp: 50,
      });
      expect(() =>
        build({
          comparison: comparisonFor(
            {
              ...record,
              mergedAt: "1970-01-01T00:00:35.000Z",
            },
            35,
          ),
          finalTargetRef: postMergeChangelogTail,
          targetRef: preMergeSourceTarget,
        }),
      ).not.toThrow();
    }));

  it("rejects a shifted duplicate member hidden behind an ancestral PR base", () =>
    withRepository((cwd) => {
      const oldBlock = [
        "entry",
        "  value=old",
        "  keep=1",
        "  keep=2",
        "  keep=3",
        "  keep=4",
        "  keep=5",
        "  keep=6",
        "",
      ].join("\n");
      const newBlock = oldBlock.replace("value=old", "value=new");
      const repeatedBase = `${oldBlock}${oldBlock}`;
      const directState = `${newBlock}${oldBlock}`;
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "other.txt": "base\n",
        "release.txt": "base\n",
        "shifted.txt": repeatedBase,
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const pullRequestBase = createCommit(cwd, {
        files: { ...rootFiles, "shifted.txt": oldBlock },
        parents: [root],
        subject: "test: remove one repeated block",
        timestamp: 12,
      });
      const member = createCommit(cwd, {
        files: { ...rootFiles, "shifted.txt": newBlock },
        parents: [pullRequestBase],
        subject: "fix: edit remaining repeated block",
        timestamp: 15,
      });
      const head = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "head\n",
          "shifted.txt": newBlock,
        },
        parents: [member],
        subject: "feat: broader pull request head",
        timestamp: 18,
      });
      const restoredMainBase = createCommit(cwd, {
        files: rootFiles,
        parents: [pullRequestBase],
        subject: "test: restore repeated main state",
        timestamp: 20,
      });
      const witness = createCommit(cwd, {
        authorTimestamp: 21,
        files: { ...rootFiles, "shifted.txt": directState },
        parents: [restoredMainBase],
        subject: "test: align shifted metadata",
        timestamp: 25,
      });
      const target = createCommit(cwd, {
        authorTimestamp: 21,
        files: { ...rootFiles, "shifted.txt": directState },
        parents: [root],
        subject: "test: align shifted metadata",
        timestamp: 30,
      });
      const merge = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "head\n",
          "shifted.txt": directState,
        },
        parents: [witness],
        subject: "feat: broader pull request head (#204)",
        timestamp: 40,
      });
      const sourceTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "release.txt": "released\n",
          "shifted.txt": directState,
        },
        parents: [target],
        subject: "fix: release-only work",
        timestamp: 50,
      });
      const record = {
        baseBranch: "main",
        baseCommit: pullRequestBase,
        headCommit: head,
        mergeCommit: merge,
        mergedAt: "1970-01-01T00:00:40.000Z",
        number: 204,
      };
      const members = summarizeTeamUniverseMembers([204]);
      const recordEvidence = summarizeTeamUniverseRecords([record]);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:50Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: members.count,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: members.count,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 50_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 50_000, startTimestamp: 10_000 },
      };

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            comparisonPullRequestMemberOverlaps: [
              {
                number: 204,
                sourceCommitRef: member,
                targetCommitRef: target,
                witnessCommitRef: witness,
              },
            ],
            cwd,
            finalTargetRef: sourceTarget,
            sourceTargetRef: sourceTarget,
          },
          completeEvidence(new Map([[member, [204]]]), new Map(), {
            comparison,
            pullRequestCommits: new Map([[204, [member, head]]]),
          }),
        ),
      ).toThrow("overlap path shifted.txt lacks a unique immutable hunk anchor");
    }));

  it("accepts an explicit strict member subset already owned by a broader main commit", () =>
    withRepository((cwd) => {
      const oldOverlap = [
        "alpha=0.142.0",
        "beta=0.142.0",
        "candidate-a=0.142.0",
        "candidate-b=0.142.0",
        "candidate-c=0.142.0",
        "",
      ].join("\n");
      const broadOverlap = oldOverlap.replaceAll("0.142.0", "0.143.0");
      const landedIntermediateOverlap = broadOverlap
        .replace("candidate-a=0.143.0", "candidate-a=0.142.0")
        .replace("candidate-b=0.143.0", "candidate-b=0.142.0")
        .replace("candidate-c=0.143.0", "candidate-c=0.142.0");
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "feature.txt": "base\n",
        "overlap.txt": oldOverlap,
        "release.txt": "base\n",
        "version.txt": "0.142.0\n",
      };
      const broadFiles = {
        ...rootFiles,
        "overlap.txt": broadOverlap,
        "version.txt": "0.143.0\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const witness = createCommit(cwd, {
        authorTimestamp: 20,
        files: broadFiles,
        parents: [root],
        subject: "chore: bump runtime to 0.143.0",
        timestamp: 25,
      });
      const target = createCommit(cwd, {
        authorTimestamp: 20,
        files: broadFiles,
        parents: [root],
        subject: "chore: bump runtime to 0.143.0",
        timestamp: 30,
      });
      const sourceFeature = createCommit(cwd, {
        authorTimestamp: 32,
        files: {
          ...broadFiles,
          "feature.txt": "head\n",
          "overlap.txt": landedIntermediateOverlap,
        },
        parents: [root],
        subject: "feat: add shared runtime behavior",
        timestamp: 33,
      });
      const sourceMember = createCommit(cwd, {
        authorTimestamp: 35,
        files: { ...broadFiles, "feature.txt": "head\n" },
        parents: [sourceFeature],
        subject: "test: align version fixtures",
        timestamp: 35,
      });
      const landedFeature = createCommit(cwd, {
        authorTimestamp: 32,
        files: {
          ...broadFiles,
          "feature.txt": "head\n",
          "overlap.txt": landedIntermediateOverlap,
        },
        parents: [witness],
        subject: "feat: add shared runtime behavior",
        timestamp: 40,
      });
      const landedMember = createCommit(cwd, {
        authorTimestamp: 35,
        files: { ...broadFiles, "feature.txt": "head\n" },
        parents: [landedFeature],
        subject: "test: align version fixtures",
        timestamp: 41,
      });
      const sourceTarget = createCommit(cwd, {
        files: { ...broadFiles, "release.txt": "released\n" },
        parents: [target],
        subject: "fix: release-only work",
        timestamp: 50,
      });
      const record = {
        baseBranch: "main",
        baseCommit: root,
        headCommit: sourceMember,
        mergeCommit: landedMember,
        mergedAt: "1970-01-01T00:00:41.000Z",
        number: 205,
      };
      const members = summarizeTeamUniverseMembers([205]);
      const recordEvidence = summarizeTeamUniverseRecords([record]);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:50Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: members.count,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: members.count,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 50_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 50_000, startTimestamp: 10_000 },
      };
      const referenceNodes = new Map([
        [
          999,
          {
            __typename: "PullRequest" as const,
            mergedAt: "1970-01-01T00:00:25.000Z",
            number: 999,
          },
        ],
      ]);
      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          comparisonBaseBranch: "main",
          comparisonPullRequestMemberSubsetOverlaps: [
            {
              number: 205,
              sourceCommitRef: sourceMember,
              targetCommitRef: target,
              witnessCommitRef: witness,
            },
          ],
          cwd,
          finalTargetRef: sourceTarget,
          sourceTargetRef: sourceTarget,
        },
        completeEvidence(
          new Map([
            [sourceMember, [205]],
            [witness, [999]],
          ]),
          referenceNodes,
          {
            comparison,
            pullRequestCommits: new Map([[205, [sourceFeature, sourceMember]]]),
          },
        ),
      );

      expect(inventory.range.comparisonPullRequestMemberSubsetOverlaps).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            landedStack: expect.objectContaining({
              baseCommit: witness,
              candidateLineOverlap: expect.objectContaining({ count: 0 }),
              commits: expect.objectContaining({ count: 2 }),
              mergeCommit: landedMember,
            }),
            method: "reviewed-nonownership-strict-member-subset-overlap",
            ownershipAttributed: false,
            scannerMatches: expect.objectContaining({ count: 2 }),
            source: expect.objectContaining({ commit: sourceMember }),
            target: expect.objectContaining({ commit: target }),
            witness: expect.objectContaining({
              associations: expect.objectContaining({ members: [999] }),
              commit: witness,
            }),
          }),
          number: 205,
          sourceCommit: sourceMember,
          targetCommit: target,
          witnessCommit: witness,
        }),
      ]);
      const postForkRecord = inventory.comparison?.partitionEvidence.postFork.records.find(
        (entry) => entry.pullRequest === 205,
      );
      expect(postForkRecord).toMatchObject({
        patchEquivalentCommits: [],
        reviewedMemberSubsetOverlap: expect.objectContaining({
          ownershipAttributed: false,
          target: expect.objectContaining({ commit: target }),
          witness: expect.objectContaining({ commit: witness }),
        }),
      });
      expect(sourceContributionsFromInventory(inventory).pullRequests.has(205)).toBe(false);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("does not infer provenance from a shifted duplicate zero-context hunk", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "catalog.txt": [
          "legacy-provider",
          "  input=legacy",
          "  cost=0",
          "",
          "catalog-end",
          "",
        ].join("\n"),
        "release.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const pullRequestFirst = createCommit(cwd, {
        files: {
          ...rootFiles,
          "catalog.txt": [
            "legacy-provider",
            "  input=legacy",
            "  cost=0",
            "",
            "new-provider",
            "  input=new",
            "  cost=1",
            "",
            "catalog-end",
            "",
          ].join("\n"),
        },
        parents: [root],
        subject: "feat: add new provider",
        timestamp: 20,
      });
      const pullRequestHead = createCommit(cwd, {
        files: {
          ...rootFiles,
          "catalog.txt": [
            "legacy-provider",
            "  input=legacy",
            "  cost=0",
            "",
            "new-provider",
            "  input=new",
            "  cost=0",
            "",
            "catalog-end",
            "",
          ].join("\n"),
        },
        parents: [pullRequestFirst],
        subject: "fix: zero plan billing",
        timestamp: 21,
      });
      const releaseCommit = createCommit(cwd, {
        files: { ...rootFiles, "release.txt": "new\n" },
        parents: [root],
        subject: "fix: release-only work",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: pullRequestHead,
          mergeCommit: pullRequestHead,
          mergedAt: "1970-01-01T00:00:25.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers([202]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:30Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 30_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 30_000, startTimestamp: 10_000 },
      };

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          comparisonBaseBranch: "main",
          cwd,
          sourceTargetRef: releaseCommit,
        },
        completeEvidence(new Map(), new Map(), {
          comparison,
          pullRequestCommits: new Map([[202, [pullRequestFirst, pullRequestHead]]]),
        }),
      );

      expect(inventory.comparison).toMatchObject({
        partitionEvidence: {
          postFork: {
            records: [
              expect.objectContaining({
                aggregateBaseStateProof: {
                  baseCommit: root,
                  headCommit: pullRequestHead,
                  method: "target-matches-aggregate-base-path-state",
                  paths: [
                    {
                      baseStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
                      headStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
                      path: "catalog.txt",
                      targetStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
                    },
                  ],
                  sourceExclusivePathCommits: {
                    count: 0,
                    members: [],
                    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
                  },
                  targetCommit: releaseCommit,
                },
                patchEquivalentCommits: [],
                pullRequest: 202,
                suppressedAmbiguousPatchMatches: [
                  expect.objectContaining({
                    candidateCommit: pullRequestHead,
                    proofStrength: "ambiguous-target-provenance",
                  }),
                ],
              }),
            ],
          },
        },
        partitions: {
          postForkNotBackported: { members: [202] },
        },
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("does not classify canonically reverted hidden post-fork backports as absent", () => {
    for (const backportShape of ["exact", "split", "combined"] as const) {
      withRepository((cwd) => {
        const rootFiles = {
          "CHANGELOG.md": "# Changelog\n",
          "catalog.txt": [
            "legacy-provider",
            "  input=legacy",
            "  cost=0",
            "",
            "catalog-end",
            "",
          ].join("\n"),
        };
        const intermediateFiles = {
          ...rootFiles,
          "catalog.txt": [
            "legacy-provider",
            "  input=legacy",
            "  cost=0",
            "",
            "new-provider",
            "  input=new",
            "  cost=1",
            "",
            "catalog-end",
            "",
          ].join("\n"),
        };
        const finalFiles = {
          ...rootFiles,
          "catalog.txt": [
            "legacy-provider",
            "  input=legacy",
            "  cost=0",
            "",
            "new-provider",
            "  input=new",
            "  cost=0",
            "",
            "catalog-end",
            "",
          ].join("\n"),
        };
        const root = createCommit(cwd, {
          files: rootFiles,
          subject: "chore: root",
          timestamp: 10,
        });
        const pullRequestFirst = createCommit(cwd, {
          files: intermediateFiles,
          parents: [root],
          subject: "feat: add new provider",
          timestamp: 20,
        });
        const pullRequestHead = createCommit(cwd, {
          files: finalFiles,
          parents: [pullRequestFirst],
          subject: "fix: zero plan billing",
          timestamp: 21,
        });

        let sourceTarget;
        let sourceTimestamp;
        if (backportShape === "split") {
          const releaseFirst = createCommit(cwd, {
            files: intermediateFiles,
            parents: [root],
            subject: "feat: split release provider backport",
            timestamp: 30,
          });
          const releaseHead = createCommit(cwd, {
            files: finalFiles,
            parents: [releaseFirst],
            subject: "fix: split release billing backport",
            timestamp: 31,
          });
          const revertHead = createCommit(cwd, {
            body: `This reverts commit ${releaseHead}.`,
            files: intermediateFiles,
            parents: [releaseHead],
            subject: 'Revert "fix: split release billing backport"',
            timestamp: 40,
          });
          sourceTarget = createCommit(cwd, {
            body: `This reverts commit ${releaseFirst}.`,
            files: rootFiles,
            parents: [revertHead],
            subject: 'Revert "feat: split release provider backport"',
            timestamp: 41,
          });
          sourceTimestamp = 41;
        } else {
          const hiddenBackport = createCommit(cwd, {
            files:
              backportShape === "combined"
                ? { ...finalFiles, "release.txt": "release-only\n" }
                : finalFiles,
            parents: [root],
            subject: "feat: release provider backport",
            timestamp: 30,
          });
          sourceTarget = createCommit(cwd, {
            body: `This reverts commit ${hiddenBackport}.`,
            files: rootFiles,
            parents: [hiddenBackport],
            subject: 'Revert "feat: release provider backport"',
            timestamp: 40,
          });
          sourceTimestamp = 40;
        }

        const records = [
          {
            baseBranch: "main",
            baseCommit: root,
            headCommit: pullRequestHead,
            mergeCommit: pullRequestHead,
            mergedAt: "1970-01-01T00:00:25.000Z",
            number: 202,
          },
        ];
        const members = summarizeTeamUniverseMembers([202]);
        const recordEvidence = summarizeTeamUniverseRecords(records);
        const query = teamUniverseWindowQuery({
          base: "main",
          end: `1970-01-01T00:00:${sourceTimestamp}Z`,
          repository: "openclaw/openclaw",
          start: "1970-01-01T00:00:10Z",
        });
        const comparison = {
          baseBranch: "main",
          count: 1,
          pullRequests: members.members,
          query,
          records: recordEvidence.records,
          recordsSha256: recordEvidence.sha256,
          repository: "openclaw/openclaw",
          segments: [
            {
              count: 1,
              pullRequests: members.members,
              query,
              recordsSha256: recordEvidence.sha256,
              sha256: members.sha256,
              window: { endTimestamp: sourceTimestamp * 1000, startTimestamp: 10_000 },
            },
          ],
          sha256: members.sha256,
          window: { endTimestamp: sourceTimestamp * 1000, startTimestamp: 10_000 },
        };

        expect(() =>
          buildReleaseSourceInventory(
            {
              baseRef: root,
              comparisonBaseBranch: "main",
              cwd,
              sourceTargetRef: sourceTarget,
            },
            completeEvidence(new Map(), new Map(), {
              comparison,
              pullRequestCommits: new Map([[202, [pullRequestFirst, pullRequestHead]]]),
            }),
          ),
        ).toThrow("comparison-only pull request #202 has target provenance");
      });
    }
  });

  it("keeps add-then-rename members eligible for provenance", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const added = createCommit(cwd, {
        files: { ...rootFiles, "old.ts": "export const value = 1;\n" },
        parents: [root],
        subject: "feat: add provider",
        timestamp: 20,
      });
      const renamed = createCommit(cwd, {
        files: { ...rootFiles, "new.ts": "export const value = 1;\n" },
        parents: [added],
        subject: "refactor: rename provider module",
        timestamp: 21,
      });
      const hiddenBackport = createCommit(cwd, {
        files: { ...rootFiles, "old.ts": "export const value = 1;\n" },
        parents: [root],
        subject: "feat: hidden provider backport",
        timestamp: 22,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
          "old.ts": "export const value = 1;\n",
        },
        parents: [hiddenBackport],
        subject: "docs(changelog): finalize notes",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: renamed,
          mergeCommit: renamed,
          mergedAt: "1970-01-01T00:00:21.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers([202]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:22Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 22_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 22_000, startTimestamp: 10_000 },
      };

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: hiddenBackport,
          },
          completeEvidence(new Map(), new Map(), {
            comparison,
            pullRequestCommits: new Map([[202, [added, renamed]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #202 has target provenance");
    }));

  it("keeps duplicate-line dependent members eligible for provenance", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "other.txt": "old\n",
        "release.txt": "old\n",
        "state.txt": "new\nA\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const setup = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "new\n",
          "state.txt": "new\nold\n",
        },
        parents: [root],
        subject: "feat: prepare provider state",
        timestamp: 20,
      });
      const head = createCommit(cwd, {
        files: {
          ...rootFiles,
          "other.txt": "new\n",
          "state.txt": "new\nnew\n",
        },
        parents: [setup],
        subject: "fix: finalize provider state",
        timestamp: 21,
      });
      const releaseContext = createCommit(cwd, {
        files: {
          ...rootFiles,
          "release.txt": "new\n",
          "state.txt": "new\nold\n",
        },
        parents: [root],
        subject: "fix: release-only context",
        timestamp: 22,
      });
      const hiddenBackport = createCommit(cwd, {
        files: {
          ...rootFiles,
          "release.txt": "new\n",
          "state.txt": "new\nnew\n",
        },
        parents: [releaseContext],
        subject: "fix: hidden dependent member",
        timestamp: 23,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
          "release.txt": "new\n",
          "state.txt": "new\nnew\n",
        },
        parents: [hiddenBackport],
        subject: "docs(changelog): finalize notes",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: head,
          mergeCommit: head,
          mergedAt: "1970-01-01T00:00:22.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers([202]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:23Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 23_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 23_000, startTimestamp: 10_000 },
      };

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: hiddenBackport,
          },
          completeEvidence(new Map(), new Map(), {
            comparison,
            pullRequestCommits: new Map([[202, [setup, head]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #202 has target provenance");
    }));

  it("rejects a hidden squashed backport of a multi-commit pull request", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "first.txt": "old\n",
        "second.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const first = createCommit(cwd, {
        files: { ...rootFiles, "first.txt": "new\n" },
        parents: [root],
        subject: "fix: first PR member",
        timestamp: 20,
      });
      const head = createCommit(cwd, {
        files: { ...rootFiles, "first.txt": "new\n", "second.txt": "new\n" },
        parents: [first],
        subject: "fix: second PR member",
        timestamp: 21,
      });
      const squashedBackport = createCommit(cwd, {
        files: { ...rootFiles, "first.txt": "new\n", "second.txt": "new\n" },
        parents: [root],
        subject: "fix: hidden squashed backport",
        timestamp: 22,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "first.txt": "new\n",
          "second.txt": "new\n",
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
        },
        parents: [squashedBackport],
        subject: "docs(changelog): finalize notes",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: head,
          mergeCommit: head,
          mergedAt: "1970-01-01T00:00:21.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers([202]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:22Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 22_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 22_000, startTimestamp: 10_000 },
      };

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: squashedBackport,
          },
          completeEvidence(new Map(), new Map(), {
            comparison,
            pullRequestCommits: new Map([[202, [first, head]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #202 has target provenance");
    }));

  it("rejects a post-fork pull request split across target commits with same-file context", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "one=old\nmiddle=base\nthree=old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const pullRequestHead = createCommit(cwd, {
        files: {
          ...rootFiles,
          "state.txt": "one=new\nmiddle=base\nthree=new\n",
        },
        parents: [root],
        subject: "fix: later main work",
        timestamp: 20,
      });
      const releaseContext = createCommit(cwd, {
        files: {
          ...rootFiles,
          "state.txt": "release-header\none=old\nmiddle=release\nthree=old\n",
        },
        parents: [root],
        subject: "fix: release-only context",
        timestamp: 21,
      });
      const releaseFirst = createCommit(cwd, {
        files: {
          ...rootFiles,
          "state.txt": "release-header\none=new\nmiddle=release\nthree=old\n",
        },
        parents: [releaseContext],
        subject: "fix: hidden first member",
        timestamp: 22,
      });
      const releaseHead = createCommit(cwd, {
        files: {
          ...rootFiles,
          "state.txt": "release-header\none=new\nmiddle=release\nthree=new\n",
        },
        parents: [releaseFirst],
        subject: "fix: hidden second member",
        timestamp: 23,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
          "state.txt": "release-header\none=new\nmiddle=release\nthree=new\n",
        },
        parents: [releaseHead],
        subject: "docs(changelog): finalize notes",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: pullRequestHead,
          mergeCommit: pullRequestHead,
          mergedAt: "1970-01-01T00:00:22.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers([202]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:23Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 23_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 23_000, startTimestamp: 10_000 },
      };

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: releaseHead,
          },
          completeEvidence(new Map(), new Map(), {
            comparison,
            pullRequestCommits: new Map([[202, [pullRequestHead]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #202 has target provenance");
    }));

  it("rejects an individual post-fork PR member embedded in a combined target commit", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "a.txt": "old\n",
        "b.txt": "old\n",
        "extra.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const first = createCommit(cwd, {
        files: { ...rootFiles, "a.txt": "new\n" },
        parents: [root],
        subject: "fix: first PR member",
        timestamp: 20,
      });
      const head = createCommit(cwd, {
        files: { ...rootFiles, "a.txt": "new\n", "b.txt": "new\n" },
        parents: [first],
        subject: "fix: second PR member",
        timestamp: 21,
      });
      const combinedTarget = createCommit(cwd, {
        files: { ...rootFiles, "a.txt": "new\n", "extra.txt": "release\n" },
        parents: [root],
        subject: "fix: combined release work",
        timestamp: 22,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "CHANGELOG.md": "# Changelog\n\nFinal notes.\n",
          "a.txt": "new\n",
          "extra.txt": "release\n",
        },
        parents: [combinedTarget],
        subject: "docs(changelog): finalize notes",
        timestamp: 30,
      });
      const records = [
        {
          baseBranch: "main",
          baseCommit: root,
          headCommit: head,
          mergeCommit: head,
          mergedAt: "1970-01-01T00:00:21.000Z",
          number: 202,
        },
      ];
      const members = summarizeTeamUniverseMembers([202]);
      const recordEvidence = summarizeTeamUniverseRecords(records);
      const query = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:22Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 1,
        pullRequests: members.members,
        query,
        records: recordEvidence.records,
        recordsSha256: recordEvidence.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 1,
            pullRequests: members.members,
            query,
            recordsSha256: recordEvidence.sha256,
            sha256: members.sha256,
            window: { endTimestamp: 22_000, startTimestamp: 10_000 },
          },
        ],
        sha256: members.sha256,
        window: { endTimestamp: 22_000, startTimestamp: 10_000 },
      };

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            comparisonBaseBranch: "main",
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: combinedTarget,
          },
          completeEvidence(new Map(), new Map(), {
            comparison,
            pullRequestCommits: new Map([[202, [first, head]]]),
          }),
        ),
      ).toThrow("comparison-only pull request #202 has target provenance");
    }));

  it("ignores provenance commits newer than the source cutoff", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const candidate = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: trusted source",
        timestamp: 15,
      });
      const cherry = createCommit(cwd, {
        body: `(cherry picked from commit ${candidate})`,
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: trusted source",
        timestamp: 20,
      });
      const future = createCommit(cwd, {
        files: { ...rootFiles, "future.txt": "future\n", "state.txt": "new\n" },
        parents: [candidate],
        subject: "fix: future provenance",
        timestamp: 30,
      });
      const requestedAssociations: string[] = [];

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          provenanceRefs: [future],
          sourceTargetRef: cherry,
        },
        {
          resolveAssociations: (commits: string[]) => {
            requestedAssociations.push(...commits);
            return completeAssociations(new Map([[candidate, [201]]]))(commits);
          },
          resolvePullRequests: () => new Map(),
        },
      );

      expect(requestedAssociations).toContain(candidate);
      expect(requestedAssociations).not.toContain(future);
      expect(commitRecord(inventory, cherry)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [201],
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("tracks exact revert parity and rejects a forged inverse", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const original = createCommit(cwd, {
        body: "Fixes #402",
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: change state",
        timestamp: 20,
      });
      const siblingFiles = {
        ...rootFiles,
        "sibling.txt": "still active\n",
        "state.txt": "new\n",
      };
      const sibling = createCommit(cwd, {
        files: siblingFiles,
        parents: [original],
        subject: "fix: keep the same pull request active",
        timestamp: 25,
      });
      const revert = createCommit(cwd, {
        body: `This reverts commit ${original}.`,
        files: { ...siblingFiles, "state.txt": "old\n" },
        parents: [sibling],
        subject: 'Revert "fix: change state"',
        timestamp: 30,
      });
      const restore = createCommit(cwd, {
        body: `This reverts commit ${revert}.`,
        files: siblingFiles,
        parents: [revert],
        subject: 'Revert "Revert fix: change state"',
        timestamp: 40,
      });
      const replacement = createCommit(cwd, {
        body: "Fixes #402",
        files: {
          ...siblingFiles,
          "replacement.txt": "replacement\n",
          "state.txt": "old\n",
        },
        parents: [revert],
        subject: "fix: replace reverted issue work",
        timestamp: 45,
      });
      const forged = createCommit(cwd, {
        body: `This reverts commit ${original}.`,
        files: { ...rootFiles, "state.txt": "forged\n" },
        parents: [original],
        subject: 'Revert "fix: change state"',
        timestamp: 50,
      });
      const originalOnlyOwners = new Map<string, number[]>([[original, [401]]]);
      const owners = new Map<string, number[]>([
        [original, [401]],
        [sibling, [401]],
      ]);

      const fullyRevertedInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: revert },
        completeEvidence(originalOnlyOwners),
      );
      expect(fullyRevertedInventory.partitions.pullRequests.included.members).toEqual([]);
      expect(commitRecord(fullyRevertedInventory, revert).revertEvidence).toContainEqual({
        proofMethod: "exact-inverse-patch",
        targetCommit: original,
      });
      expect(
        [...sourceContributionsFromInventory(fullyRevertedInventory).revertedReferences].toSorted(
          (left, right) => left - right,
        ),
      ).toEqual([401, 402]);

      const comparisonRecord = {
        baseBranch: "main",
        baseCommit: root,
        headCommit: original,
        mergeCommit: original,
        mergedAt: "1970-01-01T00:00:20.000Z",
        number: 401,
      };
      const comparisonMembers = summarizeTeamUniverseMembers([401]);
      const comparisonRecords = summarizeTeamUniverseRecords([comparisonRecord]);
      const comparisonQuery = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:30Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparisonInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          comparisonBaseBranch: "main",
          cwd,
          sourceTargetRef: revert,
        },
        completeEvidence(originalOnlyOwners, new Map(), {
          comparison: {
            baseBranch: "main",
            count: 1,
            pullRequests: comparisonMembers.members,
            query: comparisonQuery,
            records: comparisonRecords.records,
            recordsSha256: comparisonRecords.sha256,
            repository: "openclaw/openclaw",
            segments: [
              {
                count: 1,
                pullRequests: comparisonMembers.members,
                query: comparisonQuery,
                recordsSha256: comparisonRecords.sha256,
                sha256: comparisonMembers.sha256,
                window: { endTimestamp: 30_000, startTimestamp: 10_000 },
              },
            ],
            sha256: comparisonMembers.sha256,
            window: { endTimestamp: 30_000, startTimestamp: 10_000 },
          },
        }),
      );
      expect(comparisonInventory.comparison?.partitionEvidence.netReverted).toMatchObject({
        records: [
          {
            pullRequest: 401,
            revertEdges: [
              {
                proofMethod: "exact-inverse-patch",
                revertCommit: revert,
                targetCommit: original,
              },
            ],
            targetCommits: [original],
          },
        ],
      });

      const revertedInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: revert },
        completeEvidence(owners),
      );
      expect(commitRecord(revertedInventory, original).disposition).toBe("reverted");
      expect(commitRecord(revertedInventory, revert).disposition).toBe("direct");
      expect(revertedInventory.partitions.pullRequests.included.members).toEqual([401]);
      expect(
        [...sourceContributionsFromInventory(revertedInventory).revertedReferences].toSorted(
          (left, right) => left - right,
        ),
      ).toEqual([402]);
      expect(assertCompleteReleaseSourceInventory(revertedInventory)).toBe(revertedInventory);

      const restoredInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: restore },
        completeEvidence(owners),
      );
      expect(commitRecord(restoredInventory, original)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [401],
      });
      expect(commitRecord(restoredInventory, revert).disposition).toBe("reverted");
      expect(commitRecord(restoredInventory, restore).disposition).toBe("direct");
      expect(restoredInventory.partitions.pullRequests.included.members).toEqual([401]);
      expect(sourceContributionsFromInventory(restoredInventory).revertedReferences.size).toBe(0);
      expect(assertCompleteReleaseSourceInventory(restoredInventory)).toBe(restoredInventory);

      const replacementInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: replacement },
        completeEvidence(owners),
      );
      expect(sourceContributionsFromInventory(replacementInventory).revertedReferences.size).toBe(
        0,
      );

      const forgedInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: forged },
        completeEvidence(owners),
      );
      expect(commitRecord(forgedInventory, forged).disposition).toBe("unresolved");
      expect(forgedInventory.unresolved).toContainEqual({
        commit: forged,
        kind: "revert",
        reason: `revert lacks verified exact-inverse or GitHub-associated subject-bound squash evidence for ancestor ${original}`,
      });
      expect(() => assertCompleteReleaseSourceInventory(forgedInventory)).toThrow(
        "revert lacks verified exact-inverse or GitHub-associated subject-bound squash evidence for ancestor",
      );
    }));

  it("projects every subject-bound target from a composite GitHub squash revert", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "a.txt": "old\n",
        "b.txt": "old\n",
        "CHANGELOG.md": "# Changelog\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const first = createCommit(cwd, {
        files: { ...rootFiles, "a.txt": "new\n" },
        parents: [root],
        subject: "fix: first behavior (#501)",
        timestamp: 20,
      });
      const second = createCommit(cwd, {
        files: { ...rootFiles, "a.txt": "new\n", "b.txt": "new\n" },
        parents: [first],
        subject: "fix: second behavior (#503)",
        timestamp: 30,
      });
      const squashRevert = createCommit(cwd, {
        body: [
          '* Revert "fix: second behavior (#503)"',
          "",
          `This reverts commit ${second}.`,
          "",
          '* Revert "fix: first behavior (#501)"',
          "",
          `This reverts commit ${first}.`,
          "",
          "* fix: preserve adjacent behavior",
        ].join("\n"),
        files: {
          ...rootFiles,
          "a.txt": "old with adjacent fix\n",
          "b.txt": "old with adjacent fix\n",
        },
        parents: [second],
        subject: "chore: revert original behaviors (#502)",
        timestamp: 40,
      });
      const forgedSquashRevert = createCommit(cwd, {
        body: [
          '* Revert "fix: unrelated behavior (#999)"',
          "",
          `This reverts commit ${second}.`,
          "",
          "* fix: preserve adjacent behavior",
        ].join("\n"),
        files: {
          ...rootFiles,
          "a.txt": "old with adjacent fix\n",
          "b.txt": "old with adjacent fix\n",
        },
        parents: [second],
        subject: "chore: revert unrelated behavior (#504)",
        timestamp: 41,
      });
      const owners = new Map([
        [first, [501]],
        [second, [503]],
        [squashRevert, [502]],
        [forgedSquashRevert, [504]],
      ]);
      const inventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: squashRevert },
        completeEvidence(owners),
      );

      expect(commitRecord(inventory, first).disposition).toBe("reverted");
      expect(commitRecord(inventory, second).disposition).toBe("reverted");
      expect(commitRecord(inventory, squashRevert)).toMatchObject({
        disposition: "pull-request",
        pullRequests: [502],
        revertEvidence: expect.arrayContaining([
          {
            associatedPullRequests: [502],
            proofMethod: "subject-bound-github-squash",
            quotedSubject: "fix: first behavior (#501)",
            targetCommit: first,
          },
          {
            associatedPullRequests: [502],
            proofMethod: "subject-bound-github-squash",
            quotedSubject: "fix: second behavior (#503)",
            targetCommit: second,
          },
        ]),
      });
      expect(inventory.partitions.pullRequests.included.members).toEqual([502]);
      const source = sourceContributionsFromInventory(inventory);
      expect(source.activeCommits).toContainEqual(
        expect.objectContaining({
          hash: squashRevert,
          isRevert: true,
          references: [502],
        }),
      );
      expect(source.references).toEqual([502]);
      expect([...source.revertedReferences].toSorted((left, right) => left - right)).toEqual([
        501, 503,
      ]);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      const forgedInventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: forgedSquashRevert },
        completeEvidence(owners),
      );
      expect(commitRecord(forgedInventory, forgedSquashRevert).disposition).toBe("unresolved");
      expect(forgedInventory.unresolved).toContainEqual({
        commit: forgedSquashRevert,
        kind: "revert",
        reason: `revert lacks verified exact-inverse or GitHub-associated subject-bound squash evidence for ancestor ${second}`,
      });
      expect(() => assertCompleteReleaseSourceInventory(forgedInventory)).toThrow(
        "revert lacks verified exact-inverse or GitHub-associated subject-bound squash evidence",
      );
    }));

  it("keeps nested squash-body revert markers active when the owner is not a revert", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const original = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: original behavior (#501)",
        timestamp: 20,
      });
      const nestedMarker = createCommit(cwd, {
        body: [
          '* Revert "fix: original behavior (#501)"',
          "",
          `This reverts commit ${original}.`,
          "",
          "* feat: retain the original behavior",
        ].join("\n"),
        files: { ...rootFiles, "adjacent.txt": "added\n", "state.txt": "new\n" },
        parents: [original],
        subject: "feat: preserve nested squash context (#502)",
        timestamp: 30,
      });
      const inventory = buildReleaseSourceInventory(
        { baseRef: root, cwd, sourceTargetRef: nestedMarker },
        completeEvidence(
          new Map([
            [original, [501]],
            [nestedMarker, [502]],
          ]),
        ),
      );

      expect(commitRecord(inventory, original).disposition).toBe("pull-request");
      expect(commitRecord(inventory, nestedMarker).disposition).toBe("pull-request");
      expect(inventory.partitions.pullRequests.included.members).toEqual([501, 502]);
      expect(sourceContributionsFromInventory(inventory).references).toEqual([501, 502]);
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("projects an exact outside-range revert and clears it after an in-range restore", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const originalFiles = { ...rootFiles, "state.txt": "new\n" };
      const original = createCommit(cwd, {
        body: "Fixes #702",
        files: originalFiles,
        parents: [root],
        subject: "fix: pre-range behavior",
        timestamp: 20,
      });
      const revert = createCommit(cwd, {
        body: `This reverts commit ${original}.`,
        files: rootFiles,
        parents: [original],
        subject: 'Revert "fix: pre-range behavior"',
        timestamp: 30,
      });
      const restore = createCommit(cwd, {
        body: `This reverts commit ${revert}.`,
        files: originalFiles,
        parents: [revert],
        subject: 'Revert "Revert fix: pre-range behavior"',
        timestamp: 40,
      });
      const owners = new Map<string, number[]>([[original, [701]]]);

      const revertedInventory = buildReleaseSourceInventory(
        { baseRef: original, cwd, sourceTargetRef: revert },
        completeEvidence(owners),
      );
      expect(commitRecord(revertedInventory, revert)).toMatchObject({
        disposition: "direct",
        revertedExternalPullRequests: [701],
        revertedExternalReferences: [702],
      });
      expect(
        [...sourceContributionsFromInventory(revertedInventory).revertedReferences].toSorted(
          (left, right) => left - right,
        ),
      ).toEqual([701, 702]);
      expect(assertCompleteReleaseSourceInventory(revertedInventory)).toBe(revertedInventory);

      const restoredInventory = buildReleaseSourceInventory(
        { baseRef: original, cwd, sourceTargetRef: restore },
        completeEvidence(owners),
      );
      expect(commitRecord(restoredInventory, revert).disposition).toBe("reverted");
      expect(commitRecord(restoredInventory, restore)).toMatchObject({
        disposition: "direct",
        revertedExternalPullRequests: [],
        revertedExternalReferences: [],
      });
      expect(sourceContributionsFromInventory(restoredInventory).revertedReferences.size).toBe(0);
      expect(assertCompleteReleaseSourceInventory(restoredInventory)).toBe(restoredInventory);

      const forgedFiles = { ...rootFiles, "state.txt": "forged\n" };
      const forgedExternalRevert = createCommit(cwd, {
        body: `This reverts commit ${original}.`,
        files: forgedFiles,
        parents: [original],
        subject: 'Revert "fix: pre-range behavior"',
        timestamp: 25,
      });
      const undoForgedExternalRevert = createCommit(cwd, {
        body: `This reverts commit ${forgedExternalRevert}.`,
        files: originalFiles,
        parents: [forgedExternalRevert],
        subject: 'Revert "Revert fix: pre-range behavior"',
        timestamp: 35,
      });
      const forgedInventory = buildReleaseSourceInventory(
        {
          baseRef: forgedExternalRevert,
          cwd,
          sourceTargetRef: undoForgedExternalRevert,
        },
        completeEvidence(owners),
      );
      expect(commitRecord(forgedInventory, undoForgedExternalRevert)).toMatchObject({
        disposition: "unresolved",
      });
      expect(() => assertCompleteReleaseSourceInventory(forgedInventory)).toThrow(
        `external revert ${forgedExternalRevert} does not exactly invert ancestor ${original}`,
      );
    }));

  it("fails closed when a forged shipped-baseline revert would hide an exact duplicate", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const sourceDuplicate = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: duplicate release patch",
        timestamp: 20,
      });
      const shippedOriginal = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "new\n" },
        parents: [root],
        subject: "fix: already shipped patch",
        timestamp: 30,
      });
      const forgedBaselineRevert = createCommit(cwd, {
        body: `This reverts commit ${shippedOriginal}.`,
        files: { ...rootFiles, "state.txt": "forged\n" },
        parents: [shippedOriginal],
        subject: 'Revert "fix: already shipped patch"',
        timestamp: 40,
      });

      const shippedInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          shippedRefs: [shippedOriginal],
          sourceTargetRef: sourceDuplicate,
        },
        completeEvidence(new Map()),
      );
      expect(commitRecord(shippedInventory, sourceDuplicate)).toMatchObject({
        disposition: "shipped",
        shippedEvidence: [{ commits: [shippedOriginal], ref: shippedOriginal }],
      });

      const validBaselineRevert = createCommit(cwd, {
        body: `This reverts commit ${shippedOriginal}.`,
        files: rootFiles,
        parents: [shippedOriginal],
        subject: 'Revert "fix: already shipped patch"',
        timestamp: 35,
      });
      const revertedBaselineInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          shippedRefs: [validBaselineRevert],
          sourceTargetRef: sourceDuplicate,
        },
        completeEvidence(new Map()),
      );
      expect(revertedBaselineInventory.range.shipped).toEqual([
        expect.objectContaining({
          activeCommits: {
            count: 1,
            members: [validBaselineRevert],
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          history: {
            count: 2,
            members: [shippedOriginal, validBaselineRevert].toSorted(),
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          revertEdges: {
            count: 1,
            records: [
              {
                proofMethod: "exact-inverse-patch",
                revertCommit: validBaselineRevert,
                targetCommit: shippedOriginal,
              },
            ],
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        }),
      ]);
      expect(commitRecord(revertedBaselineInventory, sourceDuplicate).disposition).toBe("direct");

      const sourceAfterBoundary = createCommit(cwd, {
        files: {
          ...rootFiles,
          "later.txt": "active\n",
          "state.txt": "new\n",
        },
        parents: [shippedOriginal],
        subject: "fix: post-boundary source work",
        timestamp: 36,
      });
      const boundaryRevertInventory = buildReleaseSourceInventory(
        {
          baseRef: shippedOriginal,
          cwd,
          shippedRefs: [validBaselineRevert],
          sourceTargetRef: sourceAfterBoundary,
        },
        completeEvidence(new Map()),
      );
      expect(boundaryRevertInventory.range.shipped).toEqual([
        expect.objectContaining({
          activeCommits: expect.objectContaining({ members: [validBaselineRevert] }),
          history: expect.objectContaining({ members: [validBaselineRevert] }),
          revertEdges: expect.objectContaining({
            records: [
              {
                proofMethod: "exact-inverse-patch",
                revertCommit: validBaselineRevert,
                targetCommit: shippedOriginal,
              },
            ],
          }),
        }),
      ]);

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            shippedRefs: [forgedBaselineRevert],
            sourceTargetRef: sourceDuplicate,
          },
          completeEvidence(new Map()),
        ),
      ).toThrow(
        `shipped baseline ${forgedBaselineRevert} revert ${forgedBaselineRevert} lacks verified exact-inverse or GitHub-associated subject-bound squash evidence for ${shippedOriginal}`,
      );
    }));

  it("excludes active source PRs already ancestral to a shipped ref", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "old\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const shippedChange = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "shipped\n" },
        parents: [root],
        subject: "fix: already shipped source PR",
        timestamp: 20,
      });
      const sourceTarget = createCommit(cwd, {
        files: {
          ...rootFiles,
          "later.txt": "active\n",
          "state.txt": "shipped\n",
        },
        parents: [shippedChange],
        subject: "fix: later active source PR",
        timestamp: 30,
      });

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          shippedRefs: [shippedChange],
          sourceTargetRef: sourceTarget,
        },
        completeEvidence(
          new Map([
            [shippedChange, [101]],
            [sourceTarget, [102]],
          ]),
        ),
      );

      expect(commitRecord(inventory, shippedChange)).toMatchObject({
        disposition: "shipped",
        shippedEvidence: [
          {
            commits: [shippedChange],
            method: "baseline-commit-patch",
            ref: shippedChange,
          },
        ],
      });
      expect(commitRecord(inventory, sourceTarget).disposition).toBe("pull-request");
      expect(inventory.partitions.pullRequests).toMatchObject({
        included: { members: [102] },
        shipped: { members: [101] },
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);
    }));

  it("recognizes exact shipped content across split and squashed commit forms", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n",
        "state.txt": "zero\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const shippedFirst = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "one\n" },
        parents: [root],
        subject: "fix: shipped first member",
        timestamp: 20,
      });
      const shippedHead = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "two\n" },
        parents: [shippedFirst],
        subject: "fix: shipped second member",
        timestamp: 21,
      });
      const sourceSquash = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "two\n" },
        parents: [root],
        subject: "fix: source squash",
        timestamp: 30,
      });
      const splitBaseline = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          shippedRefs: [shippedHead],
          sourceTargetRef: sourceSquash,
        },
        completeEvidence(
          new Map([
            [shippedFirst, [101]],
            [shippedHead, [101]],
            [sourceSquash, [101]],
          ]),
        ),
      );
      expect(commitRecord(splitBaseline, sourceSquash)).toMatchObject({
        disposition: "shipped",
        shippedEvidence: [
          expect.objectContaining({
            method: "baseline-final-tree",
            ref: shippedHead,
          }),
        ],
      });

      const shippedSquash = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "two\n" },
        parents: [root],
        subject: "fix: shipped squash",
        timestamp: 40,
      });
      const sourceFirst = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "one\n" },
        parents: [root],
        subject: "fix: source first member",
        timestamp: 50,
      });
      const sourceHead = createCommit(cwd, {
        files: { ...rootFiles, "state.txt": "two\n" },
        parents: [sourceFirst],
        subject: "fix: source second member",
        timestamp: 51,
      });
      const squashedBaseline = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          shippedRefs: [shippedSquash],
          sourceTargetRef: sourceHead,
        },
        completeEvidence(
          new Map([
            [shippedSquash, [102]],
            [sourceFirst, [102]],
            [sourceHead, [102]],
          ]),
        ),
      );
      expect(commitRecord(squashedBaseline, sourceFirst)).toMatchObject({
        disposition: "shipped",
        shippedEvidence: [
          expect.objectContaining({
            method: "baseline-final-tree-pull-request-aggregate",
            sourceCommits: [sourceFirst, sourceHead],
            treeProof: {
              candidateBaseCommit: root,
              candidateCommit: sourceHead,
              candidateDiffSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              candidatePatchId: expect.stringMatching(/^[0-9a-f]{40}$/),
              changedPaths: ["state.txt"],
              proofMethod: "reverse-then-forward-apply-exact-target-tree",
              proofStrength: "exact",
              targetCommit: shippedSquash,
              targetTree: expect.stringMatching(/^[0-9a-f]{40}$/),
            },
          }),
        ],
      });
      expect(commitRecord(squashedBaseline, sourceHead).disposition).toBe("shipped");
      expect(squashedBaseline.partitions.pullRequests.included.members).not.toContain(102);

      const contextGap = "keep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nkeep-6\n";
      const contextualBase = createCommit(cwd, {
        files: {
          ...rootFiles,
          "context.txt": `one=old\ntwo=old\n${contextGap}extra=base\n`,
        },
        parents: [root],
        subject: "chore: contextual base",
        timestamp: 60,
      });
      const shippedContext = createCommit(cwd, {
        files: {
          ...rootFiles,
          "context.txt": `one=old\ntwo=old\n${contextGap}extra=release\n`,
        },
        parents: [contextualBase],
        subject: "fix: shipped same-file context",
        timestamp: 61,
      });
      const shippedContextFirst = createCommit(cwd, {
        files: {
          ...rootFiles,
          "context.txt": `one=new\ntwo=old\n${contextGap}extra=release\n`,
        },
        parents: [shippedContext],
        subject: "fix: shipped contextual first member",
        timestamp: 62,
      });
      const shippedContextHead = createCommit(cwd, {
        files: {
          ...rootFiles,
          "context.txt": `one=new\ntwo=new\n${contextGap}extra=release\n`,
        },
        parents: [shippedContextFirst],
        subject: "fix: shipped contextual second member",
        timestamp: 63,
      });
      const contextualSourceSquash = createCommit(cwd, {
        files: {
          ...rootFiles,
          "context.txt": `one=new\ntwo=new\n${contextGap}extra=base\n`,
        },
        parents: [contextualBase],
        subject: "fix: source contextual squash",
        timestamp: 64,
      });
      const contextualInventory = buildReleaseSourceInventory(
        {
          baseRef: contextualBase,
          cwd,
          shippedRefs: [shippedContextHead],
          sourceTargetRef: contextualSourceSquash,
        },
        completeEvidence(new Map([[contextualSourceSquash, [103]]])),
      );
      expect(commitRecord(contextualInventory, contextualSourceSquash)).toMatchObject({
        disposition: "shipped",
        shippedEvidence: [
          expect.objectContaining({
            method: "baseline-final-tree",
            ref: shippedContextHead,
            treeProof: {
              candidateBaseCommit: contextualBase,
              candidateCommit: contextualSourceSquash,
              candidateDiffSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              candidatePatchId: expect.stringMatching(/^[0-9a-f]{40}$/),
              changedPaths: ["context.txt"],
              proofMethod: "reverse-then-forward-apply-exact-target-tree",
              proofStrength: "exact",
              targetCommit: shippedContextHead,
              targetTree: expect.stringMatching(/^[0-9a-f]{40}$/),
            },
          }),
        ],
      });
    }));

  it("accepts one terminal CHANGELOG-only child and requires complete association keys", () =>
    withRepository((cwd) => {
      const rootFiles = {
        "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n\nInitial release.\n",
        "src/app.ts": "export const value = 1;\n",
      };
      const root = createCommit(cwd, {
        files: rootFiles,
        subject: "chore: root",
        timestamp: 10,
      });
      const sourceFiles = {
        ...rootFiles,
        "src/app.ts": "export const value = 2;\n",
      };
      const sourceTarget = createCommit(cwd, {
        files: sourceFiles,
        parents: [root],
        subject: "fix: product behavior",
        timestamp: 20,
      });
      const finalTarget = createCommit(cwd, {
        files: {
          ...sourceFiles,
          "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n\nFinal release notes.\n",
        },
        parents: [sourceTarget],
        subject: "docs(changelog): finalize release notes",
        timestamp: 30,
      });
      const invalidFinalTarget = createCommit(cwd, {
        files: {
          ...sourceFiles,
          "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n\nInvalid release notes.\n",
          "src/app.ts": "export const value = 3;\n",
        },
        parents: [sourceTarget],
        subject: "docs(changelog): mix product bytes",
        timestamp: 40,
      });

      const inventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          finalTargetRef: finalTarget,
          sourceTargetRef: sourceTarget,
        },
        completeEvidence(new Map()),
      );
      expect(inventory.range.sourceTail).toMatchObject({
        commits: [
          {
            commit: finalTarget,
            parent: sourceTarget,
            paths: ["CHANGELOG.md"],
            subject: "docs(changelog): finalize release notes",
          },
        ],
        count: 1,
        maxCommits: 1,
      });
      expect(assertCompleteReleaseSourceInventory(inventory)).toBe(inventory);

      const emptyMembers = summarizeTeamUniverseMembers([]);
      const emptyRecords = summarizeTeamUniverseRecords([]);
      const comparisonQuery = teamUniverseWindowQuery({
        base: "main",
        end: "1970-01-01T00:00:20Z",
        repository: "openclaw/openclaw",
        start: "1970-01-01T00:00:10Z",
      });
      const comparison = {
        baseBranch: "main",
        count: 0,
        pullRequests: emptyMembers.members,
        query: comparisonQuery,
        records: emptyRecords.records,
        recordsSha256: emptyRecords.sha256,
        repository: "openclaw/openclaw",
        segments: [
          {
            count: 0,
            pullRequests: emptyMembers.members,
            query: comparisonQuery,
            recordsSha256: emptyRecords.sha256,
            sha256: emptyMembers.sha256,
            window: { endTimestamp: 20_000, startTimestamp: 10_000 },
          },
        ],
        sha256: emptyMembers.sha256,
        window: { endTimestamp: 20_000, startTimestamp: 10_000 },
      };
      let requestedComparisonWindow:
        | {
            endTimestamp: number;
            startTimestamp: number;
          }
        | undefined;
      const comparisonEvidence = completeEvidence(new Map());
      comparisonEvidence.resolveComparisonPullRequests = (window) => {
        requestedComparisonWindow = window;
        return comparison;
      };
      const comparisonInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          comparisonBaseBranch: "main",
          cwd,
          finalTargetRef: finalTarget,
          sourceTargetRef: sourceTarget,
        },
        comparisonEvidence,
      );
      expect(requestedComparisonWindow).toMatchObject({
        endTimestamp: 20_000,
        startTimestamp: 10_000,
      });
      expect(comparisonInventory.comparison).toMatchObject({
        records: { count: 0 },
        unclassified: { count: 0 },
      });

      const partitionedInventory = buildReleaseSourceInventory(
        {
          baseRef: root,
          cwd,
          sourceTargetRef: sourceTarget,
        },
        {
          resolveAssociations: (commits: string[]) => ({
            allPullRequests: new Map(
              commits.map((commit) => [commit, commit === sourceTarget ? [900] : []]),
            ),
            pullRequests: new Map(commits.map((commit) => [commit, []])),
          }),
        },
      );
      expect(partitionedInventory.associationSnapshots).toMatchObject({
        count: 1,
        records: [
          {
            allPullRequests: [900],
            commit: sourceTarget,
            pullRequests: [],
          },
        ],
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            sourceTargetRef: sourceTarget,
          },
          {
            resolveAssociations: (commits: string[]) => ({
              allPullRequests: new Map(commits.map((commit) => [commit, []])),
              pullRequests: new Map(
                commits.map((commit) => [commit, commit === sourceTarget ? [900] : []]),
              ),
            }),
          },
        ),
      ).toThrow("is not a complete-evidence subset");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            sourceTargetRef: sourceTarget,
          },
          {
            resolveAssociations: (commits: string[]) =>
              new Map([...commits.map((commit) => [commit, []] as const), [root, []]]),
          },
        ),
      ).toThrow("evidence keys do not exactly match the requested universe");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            finalTargetRef: invalidFinalTarget,
            sourceTargetRef: sourceTarget,
          },
          completeEvidence(new Map()),
        ),
      ).toThrow("must be a linear association-free, reference-free CHANGELOG.md-only tail");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: sourceTarget,
          },
          {
            resolveAssociations: (commits: string[]) => ({
              allPullRequests: new Map(
                commits.map((commit) => [commit, commit === finalTarget ? [900] : []]),
              ),
              pullRequests: new Map(commits.map((commit) => [commit, []])),
            }),
          },
        ),
      ).toThrow("must be a linear association-free, reference-free CHANGELOG.md-only tail");

      expect(() =>
        buildReleaseSourceInventory(
          {
            baseRef: root,
            cwd,
            finalTargetRef: finalTarget,
            sourceTargetRef: sourceTarget,
          },
          {
            resolveAssociations: (commits: string[]) =>
              new Map(
                commits.filter((commit) => commit !== finalTarget).map((commit) => [commit, []]),
              ),
          },
        ),
      ).toThrow(`association evidence is missing commit ${finalTarget}`);
    }));
});
