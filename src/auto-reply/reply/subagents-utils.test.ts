import { expect, it } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.js";
import { buildSubagentRunView } from "../../agents/subagents/registry/subagent-run-view.js";
import { resolveSubagentEntryForToken } from "./commands-subagents/shared.js";
import { resolveSubagentLabel } from "./subagents-utils.js";

const now = 1_700_000_000_000;
type RunOverrides = Partial<Omit<SubagentRunRecord, "execution">> & {
  startedAt?: number;
  endedAt?: number;
};
function run(runId: string, overrides: RunOverrides = {}): SubagentRunRecord {
  const { startedAt, endedAt, ...fields } = overrides;
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "default task",
    cleanup: "keep",
    createdAt: now - 2_000,
    ...fields,
    execution:
      endedAt === undefined
        ? { status: "running", startedAt }
        : { status: "terminal", startedAt, endedAt },
  };
}
const view = (runs: SubagentRunRecord[]) =>
  buildSubagentRunView({ runs, now, countPendingDescendantRuns: () => 0, recentMinutes: 30 });

it("resolves subagent label with fallback", () => {
  expect([
    resolveSubagentLabel(run("label", { label: "  runner " })),
    resolveSubagentLabel(run("task", { label: " ", task: "  task value " })),
    resolveSubagentLabel(run("empty", { label: " ", task: " " })),
  ]).toEqual(["runner", "task value", "subagent"]);
});

it("sorts by startedAt then createdAt descending", () => {
  expect(
    view([
      run("a", { createdAt: 10 }),
      run("b", { startedAt: 15, createdAt: 5 }),
      run("c", { startedAt: 12, createdAt: 20 }),
    ]).latest.map((entry) => entry.runId),
  ).toEqual(["b", "c", "a"]);
});

const labels = [
  run("run-alpha-1", { label: "Alpha Core" }),
  run("run-alpha-2", { label: "Alpha Orbit" }),
  run("run-beta-1", { label: "Beta Worker" }),
];
const numbered = [
  run("running", { createdAt: now - 8_000 }),
  run("recent", { createdAt: now - 6_000, endedAt: now - 60_000 }),
  run("old", { createdAt: now - 7_000, endedAt: now - 7_200_000 }),
];
const aliases = [
  run("review", { label: "review", taskName: "code_review" }),
  run("docs", { label: "docs", taskName: "review_docs" }),
  run("copy", { label: "Review copy", taskName: "copy_review" }),
];

it.each([
  [[run("old"), run("new", { createdAt: now - 500 })], " last ", "new"],
  [numbered, "1", "running"],
  [numbered, "2", "recent"],
  [numbered, "3", "⚠️ Invalid subagent index: 3"],
  [[run("abc", { childSessionKey: "agent:beta:subagent:xyz" })], "agent:beta:subagent:xyz", "abc"],
  [
    labels,
    "agent:beta:subagent:missing",
    "⚠️ Unknown subagent session: agent:beta:subagent:missing",
  ],
  [labels, "beta worker", "run-beta-1"],
  [labels, "beta", "run-beta-1"],
  [labels, "run-beta", "run-beta-1"],
  [labels, "alpha core", "run-alpha-1"],
  [labels, "alpha", "⚠️ Ambiguous subagent label prefix: alpha"],
  [labels, "run-alpha", "⚠️ Ambiguous run id prefix: run-alpha"],
  [labels, "missing", "⚠️ Unknown subagent id: missing"],
  [labels, undefined, "⚠️ Missing subagent id."],
  [
    [run("a", { label: "dup" }), run("b", { label: "dup" })],
    "dup",
    "⚠️ Ambiguous subagent label: dup",
  ],
  [aliases, "code_review", "review"],
  [aliases, "copy_", "copy"],
  [aliases, "review_", "docs"],
  [aliases, "review", "review"],
] satisfies Array<[SubagentRunRecord[], string | undefined, string]>)(
  "resolves target %s / %s",
  (runs, token, expected) => {
    const result = resolveSubagentEntryForToken(view(runs), token);
    expect("entry" in result ? result.entry.runId : result.reply.reply?.text).toBe(expected);
  },
);

it.each([false, true])("prefers current runs with a reused handle (same child=%s)", (sameChild) => {
  const common = { label: "same worker", taskName: "review_subagents" };
  const runs = [
    run("old", {
      ...common,
      childSessionKey: sameChild ? "agent:main:subagent:worker" : "agent:main:subagent:old",
      createdAt: now - (sameChild ? 10_000 : 7_200_000),
      startedAt: now - (sameChild ? 10_000 : 7_200_000),
      endedAt: now - (sameChild ? 5_000 : 5_400_000),
    }),
    run("new", {
      ...common,
      childSessionKey: sameChild ? "agent:main:subagent:worker" : "agent:main:subagent:new",
      createdAt: now - 1_000,
      startedAt: now - 1_000,
    }),
  ];
  const result = resolveSubagentEntryForToken(
    view(runs),
    sameChild ? "same worker" : "review_subagents",
  );
  expect(result).toMatchObject({ entry: { runId: "new" } });
});
