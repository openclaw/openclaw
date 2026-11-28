import { describe, expect, it } from "vitest";
import {
  contributionRecordFor,
  ledgerChecks,
  ledgerFor,
  renderContributionRecordEntry,
} from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";

const targetSha = "a".repeat(40);
const pullRequest = (title: string, extra = {}) => ({
  __typename: "PullRequest",
  author: { __typename: "User", login: "alice" },
  closingIssuesReferences: { nodes: [] },
  mergedAt: "2026-08-04T00:00:00Z",
  title,
  ...extra,
});
const recordEntry = (extra = {}) => ({
  number: 456,
  title: "Internal cleanup",
  editorialEligible: false,
  priorReferences: [],
  externalReferences: [],
  linkedIssues: [],
  thanks: [],
  ...extra,
});
const checkRecord = (source: string, entry: ReturnType<typeof recordEntry>) =>
  ledgerChecks({ source }, [entry], new Map([[entry.number, { __typename: "PullRequest" }]]), []);

function recordSection(line: string, partition = "1 merged PR.") {
  return [
    "## 2026.7.1",
    "### Highlights",
    [1, 2, 3, 4, 5].map((value) => `- Highlight ${value}.`).join("\n"),
    "### Changes",
    "### Fixes",
    "### Complete contribution record",
    `This audited record covers the complete base..${targetSha} history: ${partition}`,
    "#### Pull requests",
    line,
  ].join("\n\n");
}

function contributionLedger({
  nodes,
  seededPullRequests = [],
  sourcePullRequests = [],
  sourceReferences = [],
  baseTag = "v2026.7.2-beta.7",
  now = "2026-08-05T00:00:00Z",
  priorRecord = {
    legacyIssues: new Map(),
    pullRequests: new Map(
      seededPullRequests.map((number) => [
        number,
        { externalReferences: [], references: [], thanks: [] },
      ]),
    ),
  },
}: {
  nodes: Map<number, Record<string, unknown>>;
  seededPullRequests?: number[];
  sourcePullRequests?: number[];
  sourceReferences?: number[];
  baseTag?: string;
  now?: string;
  priorRecord?: ReturnType<typeof contributionRecordFor>;
}) {
  return ledgerFor(
    baseTag,
    targetSha,
    [...nodes.keys()],
    nodes,
    new Map(),
    { issuesByPullRequest: new Map() },
    priorRecord,
    new Set(sourcePullRequests),
    sourceReferences,
    [],
    new Set(),
    [],
    Date.parse(now),
    new Set([targetSha]),
  ) as ReturnType<typeof ledgerFor> & {
    provenance: {
      inRangePullRequests: number;
      retainedSeedOnlyPullRequests: number;
      uniquePullRequests: number;
    };
  };
}

describe("renderContributionRecordEntry", () => {
  it.each([
    ["refactor(plugins)!: remove a bundled workflow plugin", "refactor", true],
    ["refactor(plugins): simplify loader internals", "refactor", false],
    ["test: cover breaking plugin changes!", "test", false],
    ["feat(fleet): add resource controls and operator docs", "feat", true],
    ["fix(qa-matrix): preserve shared reply previews", "fix", false],
    ["feat(ci): add artifact reuse", "feat", false],
    ["Add operator docs", "other", false],
    ["Improve provider discovery", "other", true],
  ])("classifies release prose from declared type and scope: %s", (title, type, eligible) => {
    const nodes = new Map([[123, pullRequest(title)]]);
    const result = contributionLedger({ nodes, sourcePullRequests: [123] });
    expect(result.pullRequests).toMatchObject([
      { number: 123, type, editorialEligible: eligible, thanks: ["alice"] },
    ]);
    const source = [
      "## 2026.8.1",
      "### Highlights",
      ...[1, 2, 3, 4, 5].map((value) => `- Highlight ${value}.`),
      "### Changes",
      "- Explain the user impact. (#123) Thanks @alice.",
      "### Fixes",
      result.ledger,
    ].join("\n");
    expect(ledgerChecks({ source }, result.pullRequests, nodes, [])).toEqual(
      eligible
        ? []
        : [`editorial release prose references non-editorial ${type} PR #123 (${type})`],
    );
  });

  it.each([
    { thanks: " Thanks @alice and @bob.", expected: [] },
    {
      thanks: "",
      expected: [
        "missing editorial Thanks @alice for PR #456",
        "missing editorial Thanks @bob for directly landed work",
      ],
    },
    {
      thanks: " Thanks @alice and @bob and @outsider.",
      expected: ["unexpected editorial Thanks @outsider"],
    },
  ])(
    "validates explicit PR and direct-work thanks despite earlier mentions: '$thanks'",
    ({ thanks, expected }) => {
      const entry = recordEntry({ editorialEligible: true, thanks: ["alice"] });
      const source = recordSection("- **PR #456** Thanks @alice.").replace(
        "### Fixes",
        `### Fixes\n\n- Restore playback errors by @alice and @bob; reported alongside @outsider. (#456)${thanks}`,
      );
      const directCommits = [
        {
          subject: "fix: restore playback errors",
          closingReferences: [],
          contributors: ["bob"],
        },
      ];
      expect(
        ledgerChecks(
          { source },
          [entry],
          new Map([[456, { __typename: "PullRequest" }]]),
          directCommits,
        ),
      ).toEqual(expected);
    },
  );

  it("rebuilds seeded references without trusting old credits", () => {
    const related = "Related #45, OpenClaw/imsg#141, #67.";
    const priorRecord = contributionRecordFor({
      source: recordSection(
        `- **PR #125** ${related.replace("OpenClaw", "openclaw")} Thanks @alice and @bob.`,
      ),
    });
    expect(priorRecord.pullRequests.get(125)).toEqual({
      externalReferences: ["openclaw/imsg#141"],
      references: [45, 67],
      thanks: ["alice", "bob"],
    });
    const nodes = new Map<number, Record<string, unknown>>([
      [
        125,
        pullRequest("fix: local openclaw/openclaw#45, #45, and OpenClaw/imsg#141", {
          author: { __typename: "User", login: "carol" },
          mergedAt: "2026-07-08T00:00:00Z",
        }),
      ],
      ...[45, 67].map((number): [number, Record<string, unknown>] => [
        number,
        { __typename: "Issue", title: "Resolved issue" },
      ]),
    ]);

    const result = contributionLedger({
      baseTag: "v2026.6.11",
      nodes,
      priorRecord,
      sourcePullRequests: [125],
      now: "2026-07-09T00:00:00Z",
    });

    const line = `- **PR #125** ${related} Thanks @carol.`;
    expect(result.ledger).toContain(line);
    expect(renderContributionRecordEntry(result.pullRequests[0])).toBe(line);
  });

  it("counts associated and reachable source PRs before retained seed-only rows", () => {
    const nodes = new Map(
      [1, 2, 3].map((number) => [
        number,
        pullRequest(`fix: contribution ${number}`, {
          author: undefined,
          mergeCommit: { oid: targetSha },
        }),
      ]),
    );
    const result = contributionLedger({
      nodes,
      seededPullRequests: [1, 3],
      sourcePullRequests: [1],
      sourceReferences: [2],
    });

    expect(result.provenance).toEqual({
      inRangePullRequests: 2,
      retainedSeedOnlyPullRequests: 1,
      uniquePullRequests: 3,
    });
    expect(result.ledger).toContain("2 in-range PRs + 1 retained seed-only PR = 3 unique PRs.");
  });

  it("rejects a forged canonical range and seed partition", () => {
    const source = recordSection(
      "- **PR #456**",
      "0 in-range PRs + 1 retained seed-only PR = 1 unique PR.",
    );
    const entry = recordEntry({
      title: "fix: example",
      editorialEligible: true,
    });

    expect(
      ledgerChecks(
        {
          source,
          expectedProvenance: {
            inRangePullRequests: 1,
            retainedSeedOnlyPullRequests: 0,
            uniquePullRequests: 1,
          },
        },
        [entry],
        new Map([[456, { __typename: "PullRequest" }]]),
        [],
      ),
    ).toContain("contribution record provenance partition does not match generated inventory");
  });

  it("requires complete resolved issue tokens rather than matching substrings", () => {
    const source = recordSection("- **PR #456** Related openclaw/imsg#141.");
    const entry = recordEntry({
      linkedIssues: [{ number: 45 }, { number: 141 }],
    });

    expect(checkRecord(source, entry)).toEqual([
      "missing #45 on contribution record for PR #456",
      "missing #141 on contribution record for PR #456",
    ]);
  });

  it("does not require an out-of-range PR referenced by a PR title", () => {
    const line = "- **PR #456**";
    const source = recordSection(line);
    const entry = recordEntry({
      title: "docs: align backup rules (#123)",
      priorReferences: [123],
    });

    expect(renderContributionRecordEntry(entry)).toBe(line);
    expect(checkRecord(source, entry)).toEqual([]);
  });

  it("accepts case-only differences in cross-repository references", () => {
    const line = "- **PR #127** Related OpenClaw/imsg#143.";
    const source = recordSection(line);
    const entry = recordEntry({
      number: 127,
      externalReferences: ["openclaw/imsg#143"],
    });

    expect(checkRecord(source, entry)).toEqual([]);
  });
});
