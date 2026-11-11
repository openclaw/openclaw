import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateKovaWorkflowEvidence } from "../../scripts/lib/kova-workflow-evidence.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const PROFILE = "release";
const TARGET = "local-build:/work/openclaw";
const MODEL = "gpt-5.6";
const INCLUDE_FILTERS = ["scenario:scenario-a", "scenario:scenario-b"];
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function fixture(authMode: "live" | "mock" = "mock") {
  const live = authMode === "live";
  const pairs = live ? ["a"] : ["a", "b"];
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
    records: pairs.flatMap((id) =>
      Array.from({ length: repeat }, (_, index) => ({
        scenario: `scenario-${id}`,
        state: { id: `state-${id}` },
        status: "PASS",
        repeat: { index: index + 1, total: repeat },
        auth: { mode: authMode, environmentDependent: live },
        providerEvidence: {
          authMode,
          available: true,
          environmentDependent: live,
          requestCount: 1,
          ...(live ? { models: [{ value: MODEL, count: 1 }] } : {}),
          source: live ? "openclaw-timeline" : "mock-provider-log",
        },
      })),
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
            scenario: { id: `scenario-${pair}` },
            state: { id: `state-${pair}` },
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

it("rejects collapsed repeat coverage", () => {
  const { laneReport, validate } = fixture();
  laneReport.records.pop();

  expect(validate).toThrow("lane report collapsed scenario-b/state-b coverage to 1/2 repeats");
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

it.each([
  [{ source: "mock-provider-log" }, "provider source was mock-provider-log"],
  [{ models: [{ value: "gpt-5.5", count: 1 }] }, "provider model did not match gpt-5.6"],
  [
    {
      requestCount: 2,
      models: [
        { value: MODEL, count: 1 },
        { value: "gpt-5.5", count: 1 },
      ],
    },
    "provider model evidence was not exact",
  ],
  [{ models: [{ value: MODEL, count: 2 }] }, "provider model count did not match request count"],
])("rejects live evidence %j: %s", (evidence, reason) => {
  const { laneReport, validate } = fixture("live");
  Object.assign(laneReport.records[0]!.providerEvidence, evidence);
  expect(validate).toThrow(`live record scenario-a/state-a ${reason}`);
});

it("rejects malformed JSON through the CLI", () => {
  const root = tempRoots.make("openclaw-kova-evidence-");
  const planPath = join(root, "plan.json");
  const reportPath = join(root, "report.json");
  writeFileSync(planPath, "{not-json");
  writeFileSync(reportPath, "{}");
  const result = spawnSync(
    process.execPath,
    [
      "scripts/lib/kova-workflow-evidence.mts",
      "--plan",
      planPath,
      "--report",
      reportPath,
      ..."--profile p --target t --repeat 1 --include s --model m --auth mock".split(" "),
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--plan is not valid JSON");
});
