import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateKovaWorkflowEvidence } from "../../scripts/lib/kova-workflow-evidence.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Pair = {
  scenario: string;
  state: string;
};

const PROFILE = "release";
const TARGET = "local-build:/work/openclaw";
const MODEL = "gpt-5.6";
const INCLUDE_FILTERS = ["scenario:scenario-a", "scenario:scenario-b"];
const FIRST_PAIR: Pair = { scenario: "scenario-a", state: "state-a" };
const PAIRS: Pair[] = [FIRST_PAIR, { scenario: "scenario-b", state: "state-b" }];
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function record(pair: Pair, repeatIndex: number, repeat: number, authMode: "live" | "mock") {
  return {
    scenario: pair.scenario,
    state: { id: pair.state },
    status: "PASS",
    repeat: {
      index: repeatIndex,
      total: repeat,
    },
    auth: {
      mode: authMode,
      environmentDependent: authMode === "live",
    },
    providerEvidence: {
      authMode,
      available: true,
      environmentDependent: authMode === "live",
      requestCount: 1,
      ...(authMode === "live" ? { models: [{ value: MODEL, count: 1 }] } : {}),
      source: authMode === "live" ? "openclaw-timeline" : "mock-provider-log",
    },
  };
}

function fixture(authMode: "live" | "mock" = "mock") {
  const live = authMode === "live";
  const pairs = live ? [FIRST_PAIR] : PAIRS;
  const repeat = live ? 1 : 2;
  const includeFilters = live ? ["scenario:scenario-a"] : INCLUDE_FILTERS;
  const common = {
    profile: { id: PROFILE },
    target: TARGET,
    controls: { include: includeFilters, repeat },
  };
  const laneReport = {
    ...common,
    schemaVersion: "kova.report.v1",
    mode: "execution",
    auth: { requestedMode: authMode, live: { environmentDependent: live } },
    records: pairs.flatMap((pair) =>
      Array.from({ length: repeat }, (_, index) => record(pair, index + 1, repeat, authMode)),
    ),
  };
  return {
    laneReport,
    validate: () =>
      validateKovaWorkflowEvidence({
        plan: {
          ...common,
          schemaVersion: "kova.matrix.plan.v1",
          entries: pairs.map((pair) => ({
            scenario: { id: pair.scenario },
            state: { id: pair.state },
            status: "SELECTED",
          })),
        },
        report: laneReport,
        profile: PROFILE,
        target: TARGET,
        repeat,
        includeFilters,
        authMode,
        expectedModel: MODEL,
      }),
  };
}

describe("Kova workflow evidence", () => {
  it("rejects collapsed repeat coverage", () => {
    const { laneReport, validate } = fixture();
    laneReport.records.pop();

    expect(validate).toThrow("lane report collapsed scenario-b/state-b coverage to 1/2 repeats");
  });

  it("rejects live records backed by mock-provider evidence", () => {
    const { laneReport, validate } = fixture("live");
    laneReport.records[0]!.providerEvidence.source = "mock-provider-log";

    expect(validate).toThrow(
      "live record scenario-a/state-a provider source was mock-provider-log",
    );
  });

  it("accepts live timeline evidence with observed provider requests", () => {
    const { validate } = fixture("live");

    expect(validate()).toEqual({
      authMode: "live",
      pairCount: 1,
      recordCount: 1,
      repeat: 1,
    });
  });

  it("rejects live evidence for a different provider model", () => {
    const { laneReport, validate } = fixture("live");
    laneReport.records[0]!.providerEvidence.models = [{ value: "gpt-5.5", count: 1 }];

    expect(validate).toThrow("live record scenario-a/state-a provider model did not match gpt-5.6");
  });

  it("rejects mixed live provider models", () => {
    const { laneReport, validate } = fixture("live");
    const providerEvidence = laneReport.records[0]!.providerEvidence;
    providerEvidence.requestCount = 2;
    providerEvidence.models = [
      { value: MODEL, count: 1 },
      { value: "gpt-5.5", count: 1 },
    ];

    expect(validate).toThrow(
      "live record scenario-a/state-a provider model evidence was not exact",
    );
  });

  it("rejects live provider model count drift", () => {
    const { laneReport, validate } = fixture("live");
    laneReport.records[0]!.providerEvidence.models = [{ value: MODEL, count: 2 }];

    expect(validate).toThrow(
      "live record scenario-a/state-a provider model count did not match request count",
    );
  });

  it("rejects malformed JSON through the CLI", () => {
    const root = tempRoots.make("openclaw-kova-evidence-");
    const planPath = join(root, "plan.json");
    const reportPath = join(root, "report.json");
    writeFileSync(planPath, "{not-json");
    writeFileSync(reportPath, JSON.stringify(fixture().laneReport));
    const result = spawnSync(
      process.execPath,
      [
        "scripts/lib/kova-workflow-evidence.mts",
        ...Object.entries({
          plan: planPath,
          report: reportPath,
          profile: PROFILE,
          target: TARGET,
          repeat: "2",
          include: INCLUDE_FILTERS.join(","),
          model: MODEL,
          auth: "mock",
        }).flatMap(([key, value]) => [`--${key}`, value]),
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--plan is not valid JSON");
  });
});
