// Kova report gate tests use trimmed values from a real deep-profile release report.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateToleratedKovaReport,
  evaluateToleratedPartialKovaReport,
  evaluateToleratedProfiledKovaReport,
} from "../../scripts/lib/kova-report-gate.mts";

type JsonObject = Record<string, unknown>;
type PathPart = number | string;
type ReportMutation = [string, (report: JsonObject) => void];

const tempRoots: string[] = [];
const SCRIPT_PATH = "scripts/lib/kova-report-gate.mts";
const SCENARIO = "agent-cold-warm-message";
const STATE = "mock-openai-provider";
const SURFACE = "agent-cli-local-turn";
const PROFILED_INTERPRETATION =
  "instrumented run; CPU/RSS can include profiler and diagnostic overhead";
const INSTRUMENTED_PERFORMANCE_INTERPRETATION =
  "instrumented diagnostic run; CPU, RSS, and latency can include profiler overhead";
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

function valueAt(root: unknown, path: PathPart[]): unknown {
  let current = root;
  for (const part of path) {
    current = typeof part === "number" ? arrayAt(current)[part] : objectAt(current)[part];
  }
  return current;
}

function setAt(root: unknown, path: PathPart[], value: unknown): void {
  const parent = valueAt(root, path.slice(0, -1));
  const key = path.at(-1);
  if (typeof key === "number") {
    arrayAt(parent)[key] = value;
  } else if (typeof key === "string") {
    objectAt(parent)[key] = value;
  } else {
    throw new TypeError("empty fixture path");
  }
}

function deleteAt(root: unknown, path: PathPart[]): void {
  const parent = valueAt(root, path.slice(0, -1));
  const key = path.at(-1);
  if (typeof key !== "string") {
    throw new TypeError("delete fixture path must end in a string");
  }
  delete objectAt(parent)[key];
}

function metric(value: number) {
  return {
    classification: "stable",
    count: 1,
    max: value,
    median: value,
    min: value,
    p95: value,
    samples: [value],
  };
}

function commandResult() {
  return {
    command: "ocm @env -- openclaw agent --local",
    status: 0,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

function cleanupResult() {
  return { ...commandResult(), command: "ocm env destroy env --json" };
}

function targetCleanup() {
  return {
    command: "ocm runtime remove runtime --json",
    result: cleanupResult(),
    runtimeName: "runtime",
    status: "removed",
  };
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
    interpretation: deep ? PROFILED_INTERPRETATION : "normal user-path resource measurements",
    nodeProfile: deep,
    profileOnFailure: false,
    schemaVersion: "kova.profiling.v1",
  };
}

function infoCard() {
  return {
    kind: "filtered-required-scenario",
    scenario: "fresh-install",
    severity: "info",
    state: "fresh",
    status: "MISSING",
  };
}

function partialReport(): JsonObject {
  return {
    baseline: null,
    controls: {
      exclude: [],
      gate: true,
      include: [`scenario:${SCENARIO}`],
      repeat: 1,
    },
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
      required: [],
      schemaVersion: "kova.gate.v1",
      verdict: "PARTIAL",
      warning: [],
      warningCount: 0,
    },
    mode: "execution",
    performance: {
      groupCount: 1,
      groups: [
        {
          key: `${SCENARIO}|${SURFACE}|${STATE}`,
          metrics: {
            cpuPercentMax: metric(80),
            peakRssMb: metric(650),
          },
          profiledRunCount: 0,
          resourceInterpretation: "normal",
          sampleCount: 1,
          scenario: SCENARIO,
          state: STATE,
          statuses: { PASS: 1 },
          surface: SURFACE,
        },
      ],
      profiledRunCount: 0,
      repeat: 1,
      schemaVersion: "kova.performance.v1",
      unstableGroupCount: 0,
    },
    records: [
      {
        cleanup: "destroyed",
        cleanupResult: cleanupResult(),
        measurements: {
          cpuPercentMax: 80,
          peakRssMb: 650,
          profilingAffectsPerformanceMeasurements: false,
        },
        phases: [
          {
            commands: [commandResult().command],
            id: "agent-turn",
            results: [commandResult()],
          },
        ],
        profiling: profilingFixture(),
        scenario: SCENARIO,
        state: { id: STATE },
        status: "PASS",
        surface: SURFACE,
      },
    ],
    schemaVersion: "kova.report.v1",
    summary: { statuses: { PASS: 1 }, total: 1 },
    target: "local-build:/workspace/openclaw",
    targetCleanup: targetCleanup(),
  };
}

function profiledResourceReport(): JsonObject {
  const violationMessages = [
    "peak RSS 923.7 MB exceeded threshold 900 MB",
    "agent-process peak RSS 923.7 MB exceeded threshold 900 MB",
  ];
  const report = partialReport();
  Object.assign(objectAt(report.gate), {
    blockingCount: 1,
    cards: [
      infoCard(),
      {
        failedCommand: null,
        kind: "openclaw-failure",
        measurements: { cpuPercentMax: 156.2, peakRssMb: 923.7 },
        scenario: SCENARIO,
        severity: "blocking",
        state: STATE,
        status: "FAIL",
        summary: violationMessages[0],
        violations: violationMessages,
      },
    ],
    verdict: "DO_NOT_SHIP",
  });
  objectAt(report.performance).profiledRunCount = 1;
  Object.assign(objectAt(valueAt(report, ["performance", "groups", 0])), {
    metrics: { cpuPercentMax: metric(156.2), peakRssMb: metric(923.7) },
    profiledRunCount: 1,
    resourceInterpretation: "instrumented",
    statuses: { FAIL: 1 },
  });
  Object.assign(objectAt(valueAt(report, ["records", 0])), {
    measurements: {
      cpuPercentMax: 156.2,
      peakRssMb: 923.7,
      profilingAffectsPerformanceMeasurements: true,
      profilingAffectsResourceMeasurements: true,
      profilingBaselineEligible: false,
      profilingEnabled: true,
      profilingResourceInterpretation: PROFILED_INTERPRETATION,
      resourceByRole: { "agent-process": { maxCpuPercent: 156.2, peakRssMb: 923.7 } },
    },
    profiling: profilingFixture(true),
    status: "FAIL",
    violations: [
      {
        actual: 923.7,
        expected: "<= 900",
        kind: "threshold",
        message: violationMessages[0],
        metric: "peakRssMb",
      },
      {
        actual: 923.7,
        expected: "<= 900",
        kind: "resource",
        message: violationMessages[1],
        metric: "resourceByRole.agent-process.peakRssMb",
        role: "agent-process",
      },
    ],
  });
  report.summary = { statuses: { FAIL: 1 }, total: 1 };
  return report;
}

function attachPassingBaseline(report: JsonObject): void {
  report.baseline = {
    comparison: {
      baselineEntryCount: 1,
      generatedAt: "2026-07-09T00:00:00.000Z",
      groups: [],
      instrumentedPerformanceGroupCount: 0,
      instrumentedPerformanceGroups: [],
      missing: [],
      missingBaselineCount: 0,
      ok: true,
      regressionCount: 0,
      regressions: [],
      schemaVersion: "kova.baselineComparison.v1",
    },
    path: "/tmp/baseline.json",
  };
  objectAt(report.gate).baseline = {
    baselineEntryCount: 1,
    missing: [],
    missingBaselineCount: 0,
    instrumentedPerformanceGroupCount: 0,
    instrumentedPerformanceGroups: [],
    ok: true,
    regressedGroups: [],
    regressionCount: 0,
    schemaVersion: "kova.gateBaselineSummary.v1",
  };
}

function markRecordInstrumented(report: JsonObject, recordIndex = 0): JsonObject {
  const record = objectAt(valueAt(report, ["records", recordIndex]));
  const measurements = objectAt(record.measurements);
  record.profiling = {
    ...profilingFixture(true),
    affectsPerformanceMeasurements: true,
    interpretation: INSTRUMENTED_PERFORMANCE_INTERPRETATION,
  };
  measurements.profilingAffectsPerformanceMeasurements = true;
  const performance = objectAt(report.performance);
  const group = objectAt(arrayAt(performance.groups)[0]);
  performance.profiledRunCount = Number(performance.profiledRunCount) + 1;
  group.profiledRunCount = Number(group.profiledRunCount) + 1;
  setAt(report, ["performance", "groups", 0, "resourceInterpretation"], "instrumented");
  return record;
}

function setCompleteInstrumentedAssessment(record: JsonObject): void {
  const measurements = objectAt(record.measurements);
  measurements.performanceThresholdSkippedCount = 0;
  record.performanceThresholdAssessment = {
    complete: true,
    reason: null,
    rerun: null,
    schemaVersion: "kova.performanceThresholdAssessment.v1",
    skipped: [],
    skippedCount: 0,
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
  const measurements = objectAt(record.measurements);
  measurements.performanceThresholdSkippedCount = 1;
  record.performanceThresholdAssessment = {
    complete: false,
    reason: "instrumented-performance-measurement",
    rerun: "rerun without profiling for gateable performance evidence",
    schemaVersion: "kova.performanceThresholdAssessment.v1",
    skipped: [
      {
        actual,
        affectsRecordStatus: false,
        measurementMetric: "peakRssMb",
        message: `${metricId} was not adjudicated because the run was instrumented`,
        metric: metricId,
        observedOverThreshold: false,
        reason: "instrumented-performance-measurement",
        role: "status-cli",
        status: "SKIPPED",
        threshold,
      },
    ],
    skippedCount: 1,
  };
  const gate = objectAt(report.gate);
  if (!required) {
    arrayAt(gate.warning).push({ scenario: SCENARIO, state: STATE });
  }
  arrayAt(gate.cards).push({
    actual: `${metricId} ${actual}`,
    expected: `${metricId} <= ${threshold}`,
    failedCommand: null,
    impact:
      "This run can reject functional failures, but it cannot approve the release until the scenario is rerun without profiling.",
    kind: "instrumented-performance-thresholds",
    likelyOwner: "Kova",
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
    summary:
      "1 performance threshold(s) were not adjudicated because profiling can distort CPU, RSS, and latency.",
    title: "Instrumented Performance Evidence",
    violations: [],
  });
  gate.warningCount = Number(gate.warningCount) + 1;
  gate.instrumentedPerformanceIncompleteCount =
    Number(gate.instrumentedPerformanceIncompleteCount) + Number(required);
}

function stripInstrumentedPerformanceContract(report: JsonObject): JsonObject {
  const gate = objectAt(report.gate);
  delete gate.instrumentedPerformanceIncompleteCount;
  gate.cards = arrayAt(gate.cards).filter(
    (card) => objectAt(card).kind !== "instrumented-performance-thresholds",
  );
  for (const recordValue of arrayAt(report.records)) {
    const record = objectAt(recordValue);
    const measurements = objectAt(record.measurements);
    const profiling = objectAt(record.profiling);
    delete profiling.affectsPerformanceMeasurements;
    delete measurements.profilingAffectsPerformanceMeasurements;
    delete measurements.performanceThresholdSkippedCount;
    delete record.performanceThresholdAssessment;
  }
  return report;
}

function duplicatePassingRecord(report: JsonObject): void {
  const records = arrayAt(report.records);
  records.push(structuredClone(records[0]));
  const controls = objectAt(report.controls);
  controls.repeat = 2;
  report.summary = { statuses: { PASS: 2 }, total: 2 };
  const performance = objectAt(report.performance);
  performance.repeat = 2;
  const group = objectAt(arrayAt(performance.groups)[0]);
  group.sampleCount = 2;
  group.statuses = { PASS: 2 };
  for (const metricValue of Object.values(objectAt(group.metrics))) {
    const metricObject = objectAt(metricValue);
    metricObject.count = 2;
    metricObject.samples = [arrayAt(metricObject.samples)[0], arrayAt(metricObject.samples)[0]];
  }
}

function blockingCard(report: JsonObject): JsonObject {
  const cards = arrayAt(objectAt(report.gate).cards);
  const card = cards.find((candidate) => objectAt(candidate).severity === "blocking");
  return objectAt(card);
}

function addProfiledPassRecord(report: JsonObject): JsonObject {
  const scenario = "passing-agent-message";
  const records = arrayAt(report.records);
  const passRecord = objectAt(structuredClone(records[0]));
  passRecord.scenario = scenario;
  passRecord.status = "PASS";
  delete passRecord.violations;
  records.push(passRecord);

  const performance = objectAt(report.performance);
  const groups = arrayAt(performance.groups);
  const passGroup = objectAt(structuredClone(groups[0]));
  passGroup.key = `${scenario}|${SURFACE}|${STATE}`;
  passGroup.scenario = scenario;
  passGroup.statuses = { PASS: 1 };
  groups.push(passGroup);
  performance.groupCount = 2;
  performance.profiledRunCount = 2;
  report.summary = { statuses: { FAIL: 1, PASS: 1 }, total: 2 };
  return passRecord;
}

function writeReport(report: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-kova-report-"));
  tempRoots.push(root);
  const reportPath = join(root, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
  return reportPath;
}

function runGate(report: JsonObject, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, writeReport(report), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function expectProfiledRejection(report: JsonObject): void {
  expect(evaluateToleratedProfiledKovaReport(report).ok).toBe(false);
}

function expectPartialRejection(report: JsonObject): void {
  expect(evaluateToleratedPartialKovaReport(report).ok).toBe(false);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("scripts/lib/kova-report-gate.mts", () => {
  it("accepts a historical filtered PARTIAL v1 report only in automatic mode", () => {
    const report = stripInstrumentedPerformanceContract(partialReport());

    expect(evaluateToleratedKovaReport(report)).toEqual({
      classification: "filtered-partial",
      ok: true,
    });
    expect(evaluateToleratedKovaReport(report, STRICT_INSTRUMENTED_PERFORMANCE_OPTIONS).ok).toBe(
      false,
    );
  });

  it("accepts a historical profiled resource-only v1 report only in automatic mode", () => {
    const report = stripInstrumentedPerformanceContract(profiledResourceReport());

    expect(evaluateToleratedKovaReport(report)).toEqual({
      classification: "profiled-resource-only",
      ok: true,
    });
    expect(evaluateToleratedKovaReport(report, STRICT_INSTRUMENTED_PERFORMANCE_OPTIONS).ok).toBe(
      false,
    );
  });

  it("reconciles repeated instrumented warnings one-to-one", () => {
    const report = partialReport();
    duplicatePassingRecord(report);
    attachInstrumentedPerformanceWarning(report, 0, false);
    attachInstrumentedPerformanceWarning(report, 1, false);

    expect(evaluateToleratedPartialKovaReport(report)).toEqual({ ok: true });
  });

  it("accepts a declared collector-only phase without commands", () => {
    const report = partialReport();
    setAt(report, ["records", 0, "phases", 0], {
      collectionIntent: "post-ready-health",
      commands: [],
      driverKind: "none",
      evidence: ["startup logs"],
      id: "logs",
      metrics: { schemaVersion: "kova.envMetrics.v1" },
      results: [],
    });

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
    const record = objectAt(valueAt(report, ["records", 0]));
    record.cleanup = "already-absent";
    record.cleanupResult = {
      ...cleanupResult(),
      status: 1,
      stderr: "environment not found",
    };
    const cleanup = objectAt(report.targetCleanup);
    cleanup.status = "already-absent";
    cleanup.result = {
      ...cleanupResult(),
      status: 1,
      stderr: "runtime does not exist",
    };

    expect(evaluateToleratedPartialKovaReport(report)).toEqual({ ok: true });
  });

  it("accepts profiled RSS growth emitted as a soak violation", () => {
    const report = profiledResourceReport();
    const message = "resource-sampled RSS grew by 42 MB, over threshold 40 MB";
    setAt(report, ["records", 0, "measurements", "rssGrowthMb"], 42);
    setAt(
      report,
      ["records", 0, "violations"],
      [
        {
          actual: 42,
          expected: "<= 40",
          kind: "soak",
          message,
          metric: "rssGrowthMb",
        },
      ],
    );
    blockingCard(report).summary = message;
    blockingCard(report).violations = [message];

    expect(evaluateToleratedProfiledKovaReport(report)).toEqual({ ok: true });
  });

  it("accepts omitted violations on a profiled PASS record", () => {
    const report = profiledResourceReport();
    setCompleteInstrumentedAssessment(addProfiledPassRecord(report));

    expect(evaluateToleratedProfiledKovaReport(report)).toEqual({ ok: true });
  });

  const profiledMutations: ReportMutation[] = [
    [
      "rejects invalid metric classifications",
      (report) =>
        setAt(
          report,
          ["performance", "groups", 0, "metrics", "peakRssMb", "classification"],
          "unknown",
        ),
    ],
    [
      "rejects non-resource profiling violations",
      (report) => setAt(report, ["records", 0, "violations", 0, "metric"], "agentTurnMs"),
    ],
    [
      "rejects missing CPU samples in the matching group",
      (report) => deleteAt(report, ["performance", "groups", 0, "metrics", "cpuPercentMax"]),
    ],
    [
      "rejects unexpected info gate cards",
      (report) => {
        const cards = arrayAt(objectAt(report.gate).cards);
        cards.push({ ...infoCard(), kind: "openclaw-failure", status: "FAIL" });
        setAt(report, ["gate", "infoCount"], 2);
        setAt(report, ["gate", "missingRequiredCount"], 2);
      },
    ],
    [
      "rejects unexpected warning gate cards",
      (report) => {
        const cards = arrayAt(objectAt(report.gate).cards);
        cards.push({
          ...infoCard(),
          kind: "openclaw-failure",
          severity: "warning",
          status: "FAIL",
        });
        setAt(report, ["gate", "warningCount"], 1);
      },
    ],
  ];

  for (const [name, mutate] of profiledMutations) {
    it(name, () => {
      const report = profiledResourceReport();
      mutate(report);
      expectProfiledRejection(report);
    });
  }

  const partialMutations: ReportMutation[] = [
    [
      "rejects duplicate repeat cards that mask distinct assessments",
      (report) => {
        duplicatePassingRecord(report);
        attachInstrumentedPerformanceWarning(report, 0);
        attachInstrumentedPerformanceWarning(report, 1);
        setAt(
          report,
          ["records", 1, "performanceThresholdAssessment", "skipped", 0, "metric"],
          "cpuPercentMax",
        );
      },
    ],
  ];

  for (const [name, mutate] of partialMutations) {
    it(name, () => {
      const report = partialReport();
      mutate(report);
      expectPartialRejection(report);
    });
  }

  it.each([
    ["reused RSS", "peakRssMb", [640, 650], 650],
    ["reused CPU", "cpuPercentMax", [70, 80], 80],
  ] as const)("checks %s measurement samples at the CLI boundary", (_name, id, samples, second) => {
    const report = partialReport();
    duplicatePassingRecord(report);
    setAt(report, ["records", 1, "measurements", id], second);
    const [min, max] = samples;
    setAt(report, ["performance", "groups", 0, "metrics", id], {
      classification: "stable",
      count: 2,
      max,
      median: (min + max) / 2,
      min,
      p95: min + (max - min) * 0.95,
      samples,
    });
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, writeReport(report), "--require-instrumented-performance-contract"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    const label = id === "peakRssMb" ? "RSS" : "CPU";
    expect(result.stderr).toContain(`record ${label} samples did not match`);
  });

  it("keeps current-producer deep-profile failures non-zero at the CLI boundary", () => {
    const result = runGate(profiledResourceReport(), "--require-instrumented-performance-contract");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("current producer retained failure");
  });

  it("keeps required instrumented PARTIAL evidence non-zero at the CLI boundary", () => {
    const report = partialReport();
    attachInstrumentedPerformanceWarning(report);
    const result = runGate(report);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "PARTIAL gate had incomplete required instrumented performance evidence",
    );
  });

  it("requires the current producer contract when the CLI flag is present", () => {
    const result = runGate(
      stripInstrumentedPerformanceContract(partialReport()),
      "--require-instrumented-performance-contract",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("record profiling performance provenance drift");
  });
});
