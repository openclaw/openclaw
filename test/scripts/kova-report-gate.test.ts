// Kova report gate tests use trimmed values from a real deep-profile release report.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  evaluateToleratedKovaReport,
  evaluateToleratedPartialKovaReport,
  evaluateToleratedProfiledKovaReport,
} from "../../scripts/lib/kova-report-gate.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type JsonObject = Record<string, unknown>;

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const SCRIPT_PATH = "scripts/lib/kova-report-gate.mts";
const SCENARIO = "agent-cold-warm-message";
const STATE = "mock-openai-provider";
const SURFACE = "agent-cli-local-turn";
const PROFILED_INTERPRETATION =
  "instrumented run; CPU/RSS can include profiler and diagnostic overhead";
const STRICT_INSTRUMENTED_PERFORMANCE_OPTIONS = {
  requireInstrumentedPerformanceContract: true,
};

function objectAt(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected object fixture value");
  }
  return value as JsonObject;
}

function arrayAt(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("expected array fixture value");
  }
  return value;
}

function at(root: unknown, ...path: (number | string)[]): JsonObject {
  let current = root;
  for (const part of path) {
    current = typeof part === "number" ? arrayAt(current)[part] : objectAt(current)[part];
  }
  return objectAt(current);
}

function metric(...samples: number[]) {
  return { classification: "stable", count: samples.length, samples };
}

function commandResult(command = "ocm @env -- openclaw agent --local") {
  return { command, status: 0, stderr: "", stdout: "", timedOut: false };
}

function profilingFixture(deep = false) {
  return {
    affectsPerformanceMeasurements: deep,
    affectsResourceMeasurements: deep,
    baselineEligible: !deep,
    deepProfile: deep,
    diagnosticReport: deep,
    enabled: deep,
    heapSnapshot: deep,
    nodeProfile: deep,
    profileOnFailure: false,
    interpretation: deep ? PROFILED_INTERPRETATION : "normal user-path resource measurements",
    schemaVersion: "kova.profiling.v1",
  };
}

function infoCard() {
  return {
    kind: "filtered-required-scenario",
    severity: "info",
    status: "MISSING",
  };
}

function makeViolation(
  kind: string,
  metricId: string,
  actual: number,
  message: string,
  role?: string,
) {
  return {
    actual,
    expected: kind === "soak" ? "<= 40" : "<= 900",
    kind,
    message,
    metric: metricId,
    ...(role ? { role } : {}),
  };
}

function makeRecord(deep = false): JsonObject {
  const cpuPercentMax = deep ? 156.2 : 80;
  const peakRssMb = deep ? 923.7 : 650;
  return {
    scenario: SCENARIO,
    surface: SURFACE,
    state: { id: STATE },
    status: deep ? "FAIL" : "PASS",
    cleanup: "destroyed",
    cleanupResult: commandResult("ocm env destroy env --json"),
    phases: [{ commands: [commandResult().command], results: [commandResult()] }],
    profiling: profilingFixture(deep),
    measurements: {
      cpuPercentMax,
      peakRssMb,
      profilingAffectsPerformanceMeasurements: deep,
      ...(deep
        ? {
            profilingAffectsResourceMeasurements: true,
            profilingBaselineEligible: false,
            profilingEnabled: true,
            profilingResourceInterpretation: PROFILED_INTERPRETATION,
            resourceByRole: { "agent-process": { maxCpuPercent: cpuPercentMax, peakRssMb } },
          }
        : {}),
    },
    ...(deep
      ? {
          violations: [
            makeViolation(
              "threshold",
              "peakRssMb",
              peakRssMb,
              "peak RSS 923.7 MB exceeded threshold 900 MB",
            ),
            makeViolation(
              "resource",
              "resourceByRole.agent-process.peakRssMb",
              peakRssMb,
              "agent-process peak RSS 923.7 MB exceeded threshold 900 MB",
              "agent-process",
            ),
          ],
        }
      : {}),
  };
}

function counts(records: JsonObject[]) {
  const statuses: Record<string, number> = {};
  for (const record of records) {
    const status = String(record.status);
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return statuses;
}

function syncRecords(report: JsonObject, records: JsonObject[]) {
  const profiled = (rows: JsonObject[]) =>
    rows.filter((row) => objectAt(row.profiling).enabled).length;
  const groups = [...new Set(records.map((record) => record.scenario))].map((scenario) => {
    const rows = records.filter((record) => record.scenario === scenario);
    return {
      key: `${String(scenario)}|${SURFACE}|${STATE}`,
      scenario,
      surface: SURFACE,
      state: STATE,
      statuses: counts(rows),
      sampleCount: rows.length,
      profiledRunCount: profiled(rows),
      resourceInterpretation: profiled(rows) ? "instrumented" : "normal",
      metrics: Object.fromEntries(
        ["cpuPercentMax", "peakRssMb"].map((id) => [
          id,
          metric(...rows.map((row) => Number(objectAt(row.measurements)[id]))),
        ]),
      ),
    };
  });
  report.records = records;
  report.summary = { statuses: counts(records), total: records.length };
  report.performance = {
    groups,
    groupCount: groups.length,
    profiledRunCount: profiled(records),
    repeat: objectAt(report.controls).repeat,
    schemaVersion: "kova.performance.v1",
    unstableGroupCount: 0,
  };
}

function partialReport(): JsonObject {
  const report = {
    baseline: null,
    controls: { exclude: [], gate: true, include: [`scenario:${SCENARIO}`], repeat: 1 },
    gate: {
      baseline: null,
      blockingCount: 0,
      cards: [infoCard()],
      complete: false,
      enabled: true,
      infoCount: 1,
      instrumentedPerformanceIncompleteCount: 0,
      missingRequiredCount: 1,
      ok: false,
      partial: true,
      schemaVersion: "kova.gate.v1",
      verdict: "PARTIAL",
      warning: [],
      warningCount: 0,
    },
    mode: "execution",
    schemaVersion: "kova.report.v1",
    target: "local-build:/workspace/openclaw",
    targetCleanup: {
      result: commandResult("ocm runtime remove runtime --json"),
      status: "removed",
    },
  };
  syncRecords(report, [makeRecord()]);
  return report;
}

function profiledResourceReport(): JsonObject {
  const report = partialReport();
  const record = makeRecord(true);
  syncRecords(report, [record]);
  const messages = arrayAt(record.violations).map((violation) => objectAt(violation).message);
  Object.assign(objectAt(report.gate), {
    blockingCount: 1,
    verdict: "DO_NOT_SHIP",
    cards: [
      infoCard(),
      {
        failedCommand: null,
        kind: "openclaw-failure",
        severity: "blocking",
        status: "FAIL",
        scenario: SCENARIO,
        state: STATE,
        summary: messages[0],
        violations: messages,
        measurements: { cpuPercentMax: 156.2, peakRssMb: 923.7 },
      },
    ],
  });
  return report;
}

function attachPassingBaseline(report: JsonObject): void {
  const common = {
    baselineEntryCount: 1,
    missing: [],
    missingBaselineCount: 0,
    ok: true,
    regressionCount: 0,
  };
  report.baseline = {
    comparison: {
      ...common,
      regressions: [],
      schemaVersion: "kova.baselineComparison.v1",
    },
  };
  objectAt(report.gate).baseline = {
    ...common,
    regressedGroups: [],
    schemaVersion: "kova.gateBaselineSummary.v1",
  };
}

function markRecordInstrumented(report: JsonObject, recordIndex = 0): JsonObject {
  const record = at(report, "records", recordIndex);
  record.profiling = profilingFixture(true);
  at(record, "measurements").profilingAffectsPerformanceMeasurements = true;
  syncRecords(report, arrayAt(report.records).map(objectAt));
  return record;
}

function setInstrumentedAssessment(record: JsonObject, skipped: JsonObject[] = []): void {
  objectAt(record.measurements).performanceThresholdSkippedCount = skipped.length;
  record.performanceThresholdAssessment = {
    complete: skipped.length === 0,
    reason: skipped.length ? "instrumented-performance-measurement" : null,
    rerun: skipped.length ? "rerun without profiling for gateable performance evidence" : null,
    schemaVersion: "kova.performanceThresholdAssessment.v1",
    skipped,
    skippedCount: skipped.length,
  };
}

function attachInstrumentedPerformanceWarning(
  report: JsonObject,
  recordIndex = 0,
  required = true,
): void {
  const metricId = "resourceByRole.status-cli.peakRssMb";
  const actual = 612.4;
  const threshold = 900;
  const record = markRecordInstrumented(report, recordIndex);
  setInstrumentedAssessment(record, [
    {
      actual,
      affectsRecordStatus: false,
      metric: metricId,
      reason: "instrumented-performance-measurement",
      status: "SKIPPED",
      threshold,
    },
  ]);
  const gate = objectAt(report.gate);
  if (!required) {
    arrayAt(gate.warning).push({ scenario: SCENARIO, state: STATE });
  }
  arrayAt(gate.cards).push({
    kind: "instrumented-performance-thresholds",
    measurements: {
      firstActual: actual,
      firstMetric: metricId,
      firstThreshold: threshold,
      skippedCount: 1,
    },
    required,
    scenario: SCENARIO,
    severity: "warning",
    state: STATE,
    status: "SKIPPED",
    violations: [],
  });
  gate.warningCount = Number(gate.warningCount) + 1;
  gate.instrumentedPerformanceIncompleteCount =
    Number(gate.instrumentedPerformanceIncompleteCount) + Number(required);
}

function stripInstrumentedPerformanceContract(report: JsonObject): JsonObject {
  const gate = objectAt(report.gate);
  delete gate.instrumentedPerformanceIncompleteCount;
  for (const recordValue of arrayAt(report.records)) {
    const record = objectAt(recordValue);
    const measurements = objectAt(record.measurements);
    const profiling = objectAt(record.profiling);
    delete profiling.affectsPerformanceMeasurements;
    delete measurements.profilingAffectsPerformanceMeasurements;
  }
  return report;
}

function duplicatePassingRecord(report: JsonObject): void {
  const records = arrayAt(report.records).map(objectAt);
  objectAt(report.controls).repeat = 2;
  syncRecords(report, [...records, structuredClone(records[0]!)]);
}

function addProfiledPassRecord(report: JsonObject): JsonObject {
  const records = arrayAt(report.records).map(objectAt);
  const passRecord = {
    ...structuredClone(records[0]),
    scenario: "passing-agent-message",
    status: "PASS",
  };
  delete objectAt(passRecord).violations;
  syncRecords(report, [...records, passRecord]);
  return passRecord;
}

function runGate(report: JsonObject, ...args: string[]) {
  const root = tempRoots.make("openclaw-kova-report-");
  const reportPath = join(root, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
  return spawnSync(process.execPath, [SCRIPT_PATH, reportPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

it.each([
  ["filtered-partial", partialReport],
  ["profiled-resource-only", profiledResourceReport],
] as const)(
  "accepts historical %s reports only in automatic mode",
  (classification, makeReport) => {
    const report = stripInstrumentedPerformanceContract(makeReport());
    expect(evaluateToleratedKovaReport(report)).toEqual({ classification, ok: true });
    expect(evaluateToleratedKovaReport(report, STRICT_INSTRUMENTED_PERFORMANCE_OPTIONS).ok).toBe(
      false,
    );
  },
);

it("reconciles repeated instrumented warnings one-to-one", () => {
  const report = partialReport();
  duplicatePassingRecord(report);
  attachInstrumentedPerformanceWarning(report, 0, false);
  attachInstrumentedPerformanceWarning(report, 1, false);

  expect(evaluateToleratedPartialKovaReport(report)).toEqual({ ok: true });
});

it("accepts a declared collector-only phase without commands", () => {
  const report = partialReport();
  at(report, "records", 0).phases = [
    {
      collectionIntent: "post-ready-health",
      commands: [],
      driverKind: "none",
      evidence: ["startup logs"],
      id: "logs",
      metrics: { schemaVersion: "kova.envMetrics.v1" },
      results: [],
    },
  ];

  expect(evaluateToleratedPartialKovaReport(report)).toEqual({ ok: true });
});

it("accepts independently matching non-regressing baseline evidence", () => {
  const partial = partialReport();
  const profiled = profiledResourceReport();
  attachPassingBaseline(partial);
  attachPassingBaseline(profiled);

  expect(evaluateToleratedPartialKovaReport(partial)).toEqual({ ok: true });
  expect(evaluateToleratedProfiledKovaReport(profiled)).toEqual({ ok: true });
});

it("accepts proven already-absent cleanup results", () => {
  const report = partialReport();
  const record = at(report, "records", 0);
  record.cleanup = "already-absent";
  record.cleanupResult = {
    ...commandResult(),
    status: 1,
    stderr: "environment not found",
  };
  const cleanup = objectAt(report.targetCleanup);
  cleanup.status = "already-absent";
  cleanup.result = {
    ...commandResult(),
    status: 1,
    stderr: "runtime does not exist",
  };

  expect(evaluateToleratedPartialKovaReport(report)).toEqual({ ok: true });
});

it("accepts profiled RSS growth emitted as a soak violation", () => {
  const report = profiledResourceReport();
  const message = "resource-sampled RSS grew by 42 MB, over threshold 40 MB";
  at(report, "records", 0, "measurements").rssGrowthMb = 42;
  at(report, "records", 0).violations = [makeViolation("soak", "rssGrowthMb", 42, message)];
  Object.assign(at(report, "gate", "cards", 1), { summary: message, violations: [message] });

  expect(evaluateToleratedProfiledKovaReport(report)).toEqual({ ok: true });
});

it("accepts omitted violations on a profiled PASS record", () => {
  const report = profiledResourceReport();
  setInstrumentedAssessment(addProfiledPassRecord(report));

  expect(evaluateToleratedProfiledKovaReport(report)).toEqual({ ok: true });
});

const profiledMutations: Array<[string, (report: JsonObject) => void]> = [
  [
    "rejects invalid metric classifications",
    (report) =>
      (at(report, "performance", "groups", 0, "metrics", "peakRssMb").classification = "unknown"),
  ],
  [
    "rejects non-resource profiling violations",
    (report) => (at(report, "records", 0, "violations", 0).metric = "agentTurnMs"),
  ],
  [
    "rejects missing CPU samples in the matching group",
    (report) => delete at(report, "performance", "groups", 0, "metrics").cpuPercentMax,
  ],
];

for (const [name, mutate] of profiledMutations) {
  it(name, () => {
    const report = profiledResourceReport();
    mutate(report);
    expect(evaluateToleratedProfiledKovaReport(report).ok).toBe(false);
  });
}

it.each(["info", "warning"])("rejects unexpected %s gate cards", (severity) => {
  const report = profiledResourceReport();
  const gate = objectAt(report.gate);
  arrayAt(gate.cards).push({ ...infoCard(), severity, kind: "openclaw-failure", status: "FAIL" });
  Object.assign(
    gate,
    severity === "info" ? { infoCount: 2, missingRequiredCount: 2 } : { warningCount: 1 },
  );
  expect(evaluateToleratedProfiledKovaReport(report).ok).toBe(false);
});

it("rejects duplicate repeat cards that mask distinct assessments", () => {
  const report = partialReport();
  duplicatePassingRecord(report);
  attachInstrumentedPerformanceWarning(report, 0);
  attachInstrumentedPerformanceWarning(report, 1);
  at(report, "records", 1, "performanceThresholdAssessment", "skipped", 0).metric = "cpuPercentMax";
  expect(evaluateToleratedPartialKovaReport(report).ok).toBe(false);
});

it.each([
  ["reused RSS", "peakRssMb", [640, 650], 650],
  ["reused CPU", "cpuPercentMax", [70, 80], 80],
] as const)("checks %s measurement samples at the CLI boundary", (_name, id, samples, second) => {
  const report = partialReport();
  duplicatePassingRecord(report);
  at(report, "records", 1, "measurements")[id] = second;
  at(report, "performance", "groups", 0, "metrics")[id] = metric(...samples);
  const result = runGate(report, "--require-instrumented-performance-contract");

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  const label = id === "peakRssMb" ? "RSS" : "CPU";
  expect(result.stderr).toContain(`record ${label} samples did not match`);
});

it.each([
  [
    "current producer retained failure",
    profiledResourceReport,
    ["--require-instrumented-performance-contract"],
  ],
  [
    "PARTIAL gate had incomplete required instrumented performance evidence",
    () => {
      const report = partialReport();
      attachInstrumentedPerformanceWarning(report);
      return report;
    },
    [],
  ],
  [
    "record profiling performance provenance drift",
    () => stripInstrumentedPerformanceContract(partialReport()),
    ["--require-instrumented-performance-contract"],
  ],
] as const)("rejects CLI evidence: %s", (message, makeReport, flags) => {
  const result = runGate(makeReport(), ...flags);
  expect(result).toMatchObject({ status: 1, stderr: expect.stringContaining(message) });
});
