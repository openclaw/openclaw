import { describe, expect, it } from "vitest";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import { refitTestTimings, type CiTimingRun } from "../../scripts/lib/ci-test-timings-refit.mts";
import { createCompactSplitTimingGeneration } from "../../scripts/lib/vitest-shard-metadata.mts";

const file = "test/scripts/measured.test.ts";
function toolingLog(
  cost: number,
  outcome = "0",
  nativeSeconds?: number,
  fileName = file,
  summary: {
    configs?: string[];
    includePatterns?: string[];
    testFiles?: string[];
    durations?: string[];
  } = {},
) {
  const shard_name = "core-tooling-1-hosted-1";
  const configs = summary.configs ?? ["test/vitest/vitest.tooling.config.ts"];
  const includePatterns = summary.includePatterns ?? [fileName];
  const timing_key = createCompactSplitTimingGeneration({
    configs,
    parentShardName: "core-tooling-1",
    stripes: [includePatterns],
  }).timingKeys[0]!;
  return [
    `2026-09-20T01:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([{ shard_name, timing_key, configs, includePatterns }])}`,
    `2026-09-20T01:00:00Z [shard:${timing_key}] begin`,
    `2026-09-20T01:00:01Z [shard:${shard_name}] ✓ tooling ${fileName} > first case ${cost * 500}ms`,
    `2026-09-20T01:00:02Z [shard:${shard_name}] ✓ tooling ${fileName} > second case ${cost * 500}ms`,
    ...(nativeSeconds === undefined
      ? []
      : [
          `2026-09-20T01:00:03Z [shard:${shard_name}] ✓ tooling ${fileName} (2 tests) ${nativeSeconds}s`,
        ]),
    ...(summary.testFiles ?? []).map(
      (value) => `2026-09-20T01:00:04Z [shard:${shard_name}] Test Files ${value}`,
    ),
    ...(summary.durations ?? ["400s (tests 99%)"]).map(
      (value) => `2026-09-20T01:00:04Z [shard:${shard_name}] Duration ${value}`,
    ),
    `2026-09-20T01:00:05Z [shard:${timing_key}] end (exit ${outcome})`,
  ].join("\n");
}
function run(id: number, text = toolingLog(200), hosted = false): CiTimingRun {
  return {
    id,
    createdAt: "2026-09-20T01:00:00Z",
    completeInventory: false,
    logs: [
      { kind: "tooling", text, labels: [hosted ? "ubuntu-24.04" : "blacksmith-4vcpu-ubuntu-2404"] },
    ],
  };
}

describe("PR tooling timing weights", () => {
  it("ignores nested reporters outside the shard inventory and retains measured zero-time files", () => {
    const text = toolingLog(0).replace(
      "Duration 400s",
      "✓ tooling ../../tmp/nested.test.ts > nested fixture 9000ms\n2026-09-20T01:00:04Z [shard:core-tooling-1-hosted-1] ✓ tooling test/scripts/unselected.test.ts (1 test) 9000ms\n2026-09-20T01:00:04Z [shard:core-tooling-1-hosted-1] Duration 400s",
    );
    expect(
      refitTestTimings([run(1, text), run(2, text)]).timings.toolingFileSeconds.blacksmith,
    ).toEqual({ [file]: 1 });
    const missingDescriptor = text.split("\n").slice(1).join("\n");
    expect(
      refitTestTimings([run(3, missingDescriptor), run(4, missingDescriptor)]).timings
        .toolingFileSeconds.blacksmith,
    ).toEqual({});
  });
  it("requires independent runs, preserves runner profiles and prefers complete native file time", () => {
    const first = run(1, toolingLog(200, "0", 120));
    expect(refitTestTimings([first, first]).timings.toolingFileSeconds.blacksmith).toEqual({});
    const result = refitTestTimings([
      first,
      run(2, toolingLog(300, "0", 140)),
      run(3, toolingLog(9999, "0", 9000)),
      run(4, toolingLog(50), true),
      run(5, toolingLog(70), true),
    ]);
    expect(result.timings.toolingFileSeconds).toEqual({
      blacksmith: { [file]: 130 },
      github: { [file]: 60 },
    });
    expect(result.timings.compactGroupSeconds).toEqual({ blacksmith: {}, github: {} });
    expect(result.timings.runtimePlacementTimings).toEqual({ blacksmith: [], github: [] });
  });

  type TimingCase = {
    label: string;
    summary?: Parameters<typeof toolingLog>[4];
    nativeSeconds?: number;
    mutate?: (text: string) => string;
    expected: number | undefined;
  };
  it.each<TimingCase>([
    { label: "singleton wall", expected: 190 },
    { label: "native file time", nativeSeconds: 120, expected: 120 },
    { label: "missing file summary", summary: { testFiles: [] }, expected: 391 },
    { label: "skipped file", summary: { testFiles: ["1 passed | 1 skipped (2)"] }, expected: 391 },
    { label: "multiple invocations", summary: { durations: ["190.06s", "20s"] }, expected: 391 },
    {
      label: "multiple declared files",
      summary: { includePatterns: [file, "other.test.ts"] },
      expected: 391,
    },
    {
      label: "multiple configs",
      summary: { configs: ["test/vitest/vitest.tooling.config.ts", "other.config.ts"] },
      expected: 391,
    },
    { label: "another config", summary: { configs: ["other.config.ts"] }, expected: 391 },
    ...[
      ["nested summary", "Test Files 1 passed (1)", "[shard:nested] Test Files 1 passed (1)"],
      ["nested duration", "Duration 190.06s", "[shard:nested] Duration 20s"],
      [
        "foreign file",
        "Test Files 1 passed (1)",
        "✓ tooling test/scripts/unselected.test.ts > nested fixture 9000ms",
      ],
    ].map(([label, from, nested]) => ({
      label: label!,
      expected: 391,
      mutate: (text: string) =>
        text.replace(
          from!,
          `${nested}\n2026-09-20T01:00:04Z [shard:core-tooling-1-hosted-1] ${from}`,
        ),
    })),
    {
      label: "repeated begin",
      expected: 391,
      mutate: (text) =>
        text
          .split("\n")
          .flatMap((line) => (line.endsWith("] begin") ? [line, line] : [line]))
          .join("\n"),
    },
    {
      label: "no matched file",
      expected: undefined,
      mutate: (text) =>
        text
          .split("\n")
          .filter((line) => !line.includes("✓ tooling"))
          .join("\n"),
    },
    {
      label: "failed",
      expected: undefined,
      mutate: (text) => text.replace("end (exit 0)", "end (exit 1)"),
    },
    {
      label: "unfinished",
      expected: undefined,
      mutate: (text) => text.split("\n").slice(0, -1).join("\n"),
    },
    { label: "no duration", summary: { durations: [] }, expected: undefined },
    {
      label: "other family",
      expected: undefined,
      mutate: (text) => text.replaceAll("core-tooling", "agentic-gateway"),
    },
  ])(
    "prices only complete, unambiguous tooling observations: $label",
    ({ summary, nativeSeconds, mutate, expected }) => {
      const text = toolingLog(391, "0", nativeSeconds, file, {
        testFiles: ["1 passed (1)"],
        durations: ["190.06s"],
        ...summary,
      });
      const observed = mutate?.(text) ?? text;
      expect(
        refitTestTimings([run(1, observed), run(2, observed)]).timings.toolingFileSeconds
          .blacksmith,
      ).toEqual(expected === undefined ? {} : { [file]: expected });
    },
  );

  it("seeds one explicit run, retains absent files in partial PRs, and respects the write threshold", () => {
    const seed = refitTestTimings([run(1)], undefined, { seedTooling: true }).timings;
    expect(seed.toolingFileSeconds.blacksmith).toEqual({ [file]: 200 });
    expect(seed.source).toContain("seed from successful pull_request CI merge-ref runs: 1");
    const partial = [2, 3, 4].map((id) =>
      run(id, toolingLog(10, "0", undefined, "test/scripts/other.test.ts")),
    );
    const refitted = refitTestTimings(partial, seed).timings;
    expect(refitted.toolingFileSeconds.blacksmith).toEqual({
      [file]: 200,
      "test/scripts/other.test.ts": 10,
    });
    expect(
      refitTestTimings([run(5, toolingLog(210)), run(6, toolingLog(220))], refitted).timings,
    ).toEqual(refitted);
  });
});
