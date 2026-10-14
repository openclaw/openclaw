import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { createFanoutMatrixFixture } from "../../scripts/lib/code-mode-matrix-fanout-tasks.js";
import type { MatrixPerformanceEvaluation } from "../../scripts/lib/code-mode-matrix-performance-types.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Report = {
  stage: string;
  nonce: string;
  rowCount: number;
  eligibleCount: number;
  totalCents: number;
  excludedIds: string[];
  unavailableSources: string[];
  auditPassed: boolean;
};
type FixtureTool = {
  name: string;
  execute: (id: string, input: unknown) => Promise<{ details: unknown }>;
};
type ToolFactory = {
  create: (context: { sessionKey: string; assertInvocationCurrent: () => void }) => FixtureTool[];
};

it("scores child submissions and rejects incorrect, missing, excessive, and premature fanout evidence", async () => {
  const fixture = createFanoutMatrixFixture("fanout-dependency", 2);
  const workspace = tempDirs.make("openclaw-fanout-fixture-");
  const receiptsPath = path.join(workspace, "receipts.jsonl");
  const entry = path.join(workspace, "fixture.mjs");
  await fs.writeFile(receiptsPath, "");
  await fs.writeFile(entry, fixture.pluginSource!);
  const factories: ToolFactory[] = [];
  const plugin = (await import(pathToFileURL(entry).href)) as {
    default: (api: {
      pluginConfig: { receiptsPath: string };
      registerTool: (factory: ToolFactory) => void;
    }) => void;
  };
  plugin.default({
    pluginConfig: { receiptsPath },
    registerTool: (factory) => factories.push(factory),
  });
  const invoke = async (stage: string, name: string, input: unknown, parent = false) => {
    const tool = factories
      .flatMap((factory) =>
        factory.create({
          sessionKey: parent ? "agent:qa:main" : `agent:qa:subagent:${stage}`,
          assertInvocationCurrent() {},
        }),
      )
      .find((candidate) => candidate.name === name);
    expect(tool).toBeDefined();
    return (await tool!.execute(`call-${stage}-${name}`, input)).details;
  };
  await expect(invoke("A", "matrix_fanout_read", { stage: "A" }, true)).rejects.toThrow(
    "actual collector child",
  );
  const reports: Report[] = [];
  const empty = (stage: string): Report => ({
    stage,
    nonce: "fanout-r2-v1",
    rowCount: 0,
    eligibleCount: 0,
    totalCents: 0,
    excludedIds: [],
    unavailableSources: [],
    auditPassed: false,
  });
  await expect(invoke("F", "matrix_fanout_submit", { report: empty("F") })).rejects.toThrow(
    "predecessor reports",
  );
  await invoke("A", "matrix_fanout_read", { stage: "A" });
  for (const stage of ["A", "B", "C", "D", "E"]) {
    const report = empty(stage);
    const source = (await invoke(stage, "matrix_fanout_read", { stage })) as {
      source?: string;
      status?: string;
      records?: { id: string; status: string; amountCents: number | string | null }[];
    };
    if (source.status === "unavailable") {
      report.unavailableSources = [source.source!];
    } else {
      for (const row of source.records!) {
        report.rowCount += 1;
        if (row.status !== "posted" || row.amountCents === null) {
          report.excludedIds.push(row.id);
        } else {
          report.eligibleCount += 1;
          report.totalCents += Number(row.amountCents);
        }
      }
    }
    await invoke(stage, "matrix_fanout_submit", { report });
    reports.push(report);
  }
  const reconciliation = empty("F");
  for (const report of reports.slice(0, 4)) {
    reconciliation.rowCount += report.rowCount;
    reconciliation.eligibleCount += report.eligibleCount;
    reconciliation.totalCents += report.totalCents;
    reconciliation.excludedIds.push(...report.excludedIds);
  }
  expect(reconciliation.rowCount).toBe(68);
  expect(reconciliation.eligibleCount).toBe(44);
  const audit = {
    ...reconciliation,
    stage: "G",
    unavailableSources: reports[4]!.unavailableSources,
    auditPassed: true,
  };
  await invoke("F", "matrix_fanout_submit", { report: reconciliation });
  await invoke("G", "matrix_fanout_submit", { report: audit });
  await expect(invoke("G", "matrix_fanout_submit", { report: audit })).rejects.toThrow(
    "already submitted",
  );
  const artifact = {
    nonce: "fanout-r2-v1",
    shards: reports.slice(0, 4),
    availability: reports[4],
    reconciliation,
    audit,
  };
  await fs.writeFile(path.join(workspace, "fanout-result.json"), JSON.stringify(artifact));
  const taskResponseAt = Date.now();
  const stages = ["A", "B", "C", "D", "E", "F", "G"];
  const starts = [2, 3, 4, 10, 11, 23, 32];
  const ends = [10, 11, 12, 20, 21, 30, 40];
  const taskRecords = stages.map((stage, index) => ({
    runtime: "subagent",
    runId: `run-${stage}`,
    label: `fanout-r2-v1-${stage}`,
    childSessionKey: `agent:qa:subagent:${stage}`,
    requesterSessionKey: "agent:qa:main",
    status: "succeeded",
    createdAt: index < 5 ? 1 : index === 5 ? 22 : 31,
    startedAt: starts[index],
    endedAt: ends[index],
  }));
  const evidence: MatrixPerformanceEvaluation = {
    workspace,
    taskResponseAt,
    receipts: (await fs.readFile(receiptsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    taskRecords,
    trace: {
      calls: [],
      outcomes: [],
      assistantTurns: 8,
      models: [],
      activities: taskRecords.map((task) => ({
        name: "sessions_spawn",
        input: { label: task.label, collect: true, outputSchema: { type: "object" } },
        result: { status: "accepted", runId: task.runId },
        isError: false,
      })),
    },
  };
  expect(Object.values(await fixture.evaluate(evidence)).every(Boolean)).toBe(true);
  const rejectedSpawn = {
    name: "sessions_spawn",
    input: {},
    result: { status: "error", error: "task is required" },
    isError: true,
  };
  const recoveredEvidence = {
    ...evidence,
    trace: {
      ...evidence.trace,
      activities: [rejectedSpawn, ...evidence.trace.activities],
    },
  };
  expect(Object.values(await fixture.evaluate(recoveredEvidence)).every(Boolean)).toBe(true);
  const cases: {
    name: string;
    check: string;
    patch: Partial<MatrixPerformanceEvaluation>;
  }[] = [
    { name: "missing child", check: "exactChildren", patch: { taskRecords: taskRecords.slice(1) } },
    {
      name: "eighth accepted child",
      check: "collectorLaunches",
      patch: {
        trace: {
          ...evidence.trace,
          activities: [
            ...evidence.trace.activities,
            {
              name: "sessions_spawn",
              input: {
                label: "fanout-r2-v1-H",
                collect: true,
                outputSchema: { type: "object" },
              },
              result: { status: "accepted", runId: "run-H" },
              isError: false,
            },
          ],
        },
      },
    },
    {
      name: "child completes after parent response",
      check: "completedByResponse",
      patch: {
        taskRecords: taskRecords.map((task, index) =>
          index === 6 ? Object.assign({}, task, { endedAt: taskResponseAt + 1 }) : task,
        ),
      },
    },
    {
      name: "response cutoff missing",
      check: "completedByResponse",
      patch: { taskResponseAt: undefined },
    },
    {
      name: "submission arrives after parent response",
      check: "exactSubmissions",
      patch: {
        receipts: evidence.receipts.map((row) =>
          isRecord(row) && row.kind === "fanout-submit" && row.stage === "G"
            ? Object.assign({}, row, { at: taskResponseAt + 1 })
            : row,
        ),
      },
    },
    {
      name: "source read by a different child",
      check: "completeSourceReads",
      patch: {
        receipts: evidence.receipts.map((row) =>
          isRecord(row) && row.kind === "fanout-read" && row.stage === "A"
            ? { ...row, sessionKey: "agent:qa:subagent:B" }
            : row,
        ),
      },
    },
    {
      name: "invented child identity",
      check: "exactSubmissions",
      patch: {
        taskRecords: taskRecords.map((task, index) =>
          index === 0 ? { ...task, childSessionKey: "agent:qa:subagent:invented" } : task,
        ),
      },
    },
    {
      name: "premature reconciliation",
      check: "dependencyOrder",
      patch: {
        taskRecords: taskRecords.map((task, index) =>
          index === 5 ? { ...task, createdAt: 19 } : task,
        ),
      },
    },
    {
      name: "excessive concurrency",
      check: "boundedConcurrency",
      patch: {
        taskRecords: taskRecords.map((task, index) =>
          index === 3 ? Object.assign({}, task, { startedAt: 5 }) : task,
        ),
      },
    },
    {
      name: "child still running",
      check: "settledChildren",
      patch: {
        taskRecords: taskRecords.map((task, index) =>
          index === 6 ? Object.assign({}, task, { status: "running", endedAt: undefined }) : task,
        ),
      },
    },
    {
      name: "announcing child",
      check: "collectorLaunches",
      patch: {
        trace: {
          ...evidence.trace,
          activities: evidence.trace.activities.map((activity, index) =>
            index === 0 ? { ...activity, input: { ...activity.input, collect: false } } : activity,
          ),
        },
      },
    },
  ];
  for (const testCase of cases) {
    const checks = await fixture.evaluate({ ...evidence, ...testCase.patch });
    expect(Object.values(checks).every(Boolean), testCase.name).toBe(false);
    expect(checks[testCase.check], testCase.name).toBe(false);
  }
  await fs.writeFile(
    path.join(workspace, "fanout-result.json"),
    JSON.stringify({ ...artifact, audit: { ...audit, totalCents: 1 } }),
  );
  expect((await fixture.evaluate(evidence)).finalArtifact).toBe(false);
});
