import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import {
  resolveSubagentLabel,
  resolveSubagentTargetFromRuns,
  sortSubagentRuns,
} from "./subagents-utils.js";

const NOW_MS = 1_700_000_000_000;

function makeRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const id = overrides.runId ?? "run-default";
  return {
    runId: id,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${id}`,
    requesterSessionKey: overrides.requesterSessionKey ?? "agent:main:main",
    requesterDisplayKey: overrides.requesterDisplayKey ?? "main",
    task: overrides.task ?? "default task",
    cleanup: overrides.cleanup ?? "keep",
    createdAt: overrides.createdAt ?? NOW_MS - 2_000,
    ...overrides,
  };
}

function resolveTarget(runs: SubagentRunRecord[], token: string | undefined) {
  return resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: 30,
    label: (entry) => resolveSubagentLabel(entry),
    errors: {
      missingTarget: "missing",
      invalidIndex: (value) => `invalid:${value}`,
      unknownSession: (value) => `unknown-session:${value}`,
      ambiguousLabel: (value) => `ambiguous-label:${value}`,
      ambiguousLabelPrefix: (value) => `ambiguous-prefix:${value}`,
      ambiguousRunIdPrefix: (value) => `ambiguous-run:${value}`,
      unknownTarget: (value) => `unknown:${value}`,
    },
  });
}

describe("subagents utils", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves subagent label with fallback", () => {
    expect(resolveSubagentLabel(makeRun({ label: "  runner " }))).toBe("runner");
    expect(resolveSubagentLabel(makeRun({ label: " ", task: "  task value " }))).toBe("task value");
    expect(resolveSubagentLabel(makeRun({ label: " ", task: " " }), "fallback")).toBe("fallback");
  });

  it("sorts by startedAt then createdAt descending", () => {
    const sorted = sortSubagentRuns([
      makeRun({ runId: "a", createdAt: 10 }),
      makeRun({ runId: "b", startedAt: 15, createdAt: 5 }),
      makeRun({ runId: "c", startedAt: 12, createdAt: 20 }),
    ]);
    expect(sorted.map((entry) => entry.runId)).toEqual(["b", "c", "a"]);
  });

  it("selects last from sorted runs", () => {
    const runs = [
      makeRun({ runId: "old", createdAt: NOW_MS - 2_000 }),
      makeRun({ runId: "new", createdAt: NOW_MS - 500 }),
    ];
    const resolved = resolveTarget(runs, " last ");
    expect(resolved.entry?.runId).toBe("new");
  });

  it("resolves numeric index from running then recent finished order", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    const runs = [
      makeRun({
        runId: "running",
        label: "running",
        createdAt: NOW_MS - 8_000,
      }),
      makeRun({
        runId: "recent-finished",
        label: "recent",
        createdAt: NOW_MS - 6_000,
        endedAt: NOW_MS - 60_000,
      }),
      makeRun({
        runId: "old-finished",
        label: "old",
        createdAt: NOW_MS - 7_000,
        endedAt: NOW_MS - 2 * 60 * 60 * 1_000,
      }),
    ];

    expect(resolveTarget(runs, "1").entry?.runId).toBe("running");
    expect(resolveTarget(runs, "2").entry?.runId).toBe("recent-finished");
    expect(resolveTarget(runs, "3").error).toBe("invalid:3");
  });

  it("resolves session key target and unknown session errors", () => {
    const run = makeRun({ runId: "abc123", childSessionKey: "agent:beta:subagent:xyz" });
    expect(resolveTarget([run], "agent:beta:subagent:xyz").entry?.runId).toBe("abc123");
    expect(resolveTarget([run], "agent:beta:subagent:missing").error).toBe(
      "unknown-session:agent:beta:subagent:missing",
    );
  });

  it("resolves exact label, prefix, run-id prefix and ambiguity errors", () => {
    const runs = [
      makeRun({ runId: "run-alpha-1", label: "Alpha Core" }),
      makeRun({ runId: "run-alpha-2", label: "Alpha Orbit" }),
      makeRun({ runId: "run-beta-1", label: "Beta Worker" }),
    ];

    expect(resolveTarget(runs, "beta worker").entry?.runId).toBe("run-beta-1");
    expect(resolveTarget(runs, "beta").entry?.runId).toBe("run-beta-1");
    expect(resolveTarget(runs, "run-beta").entry?.runId).toBe("run-beta-1");

    expect(resolveTarget(runs, "alpha core").entry?.runId).toBe("run-alpha-1");
    expect(resolveTarget(runs, "alpha").error).toBe("ambiguous-prefix:alpha");
    expect(resolveTarget(runs, "run-alpha").error).toBe("ambiguous-run:run-alpha");
    expect(resolveTarget(runs, "missing").error).toBe("unknown:missing");
    expect(resolveTarget(runs, undefined).error).toBe("missing");
  });

  it("returns ambiguous exact label error before prefix/run id matching", () => {
    const runs = [
      makeRun({ runId: "run-a", label: "dup" }),
      makeRun({ runId: "run-b", label: "dup" }),
    ];
    expect(resolveTarget(runs, "dup").error).toBe("ambiguous-label:dup");
  });
});
