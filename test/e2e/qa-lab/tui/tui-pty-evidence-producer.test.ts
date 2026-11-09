import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
  type QaSeedScenarioWithSource,
} from "../../../../extensions/qa-lab/test-api.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  parseTuiPtyProducerOptions,
  runTuiPtyEvidenceProducer,
  validateTuiPtyScenario,
} from "./tui-pty-evidence-producer.js";

const SOURCE_PATH = "test/e2e/qa-lab/tui/tui-pty-evidence-producer.ts";
const HARNESS_FILE = "src/tui/tui-pty-harness.e2e.test.ts";
const LOCAL_FILE = "src/tui/tui-pty-local.e2e.test.ts";
const RESET_FILE = "src/tui/tui-reset-transition-pty.e2e.test.ts";
const COVERAGE_ID = "tui.message-composition";
const TEST_SUITE = "TUI PTY harness";
const TEST_TITLE = "drives the real TUI terminal loop";
const TEST_NAME = `${TEST_SUITE} > ${TEST_TITLE}`;
const CASE = { coverageId: COVERAGE_ID, testFile: HARNESS_FILE, testNamePattern: `^${TEST_NAME}$` };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function makeScenario(
  config: Record<string, unknown> = {},
  overrides: Partial<QaSeedScenarioWithSource> = {},
): QaSeedScenarioWithSource {
  return {
    id: "tui-pty-evidence-producer-contract",
    title: "TUI PTY producer test",
    surface: "tui",
    objective: "Prove the TUI PTY evidence producer contract.",
    successCriteria: ["The configured PTY assertion passes."],
    sourcePath: "qa/scenarios/ui/tui-pty-producer-test.yaml",
    coverage: { primary: [], secondary: [COVERAGE_ID] },
    execution: {
      kind: "script",
      path: SOURCE_PATH,
      config: { tuiPtyCases: [CASE], ...config },
    },
    ...overrides,
  };
}

function caseOverride(overrides: Record<string, unknown>) {
  return { tuiPtyCases: [{ ...CASE, ...overrides }] };
}

async function writeFiles(repoRoot: string, files: string[]) {
  for (const file of files) {
    const absolutePath = path.join(repoRoot, file);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "// fixture\n", "utf8");
  }
}

async function writeReport(testFile = HARNESS_FILE, title = TEST_TITLE) {
  const assertion = { ancestorTitles: [TEST_SUITE], status: "passed", title };
  const report = {
    numFailedTests: 0,
    numPassedTests: 1,
    success: true,
    testResults: [{ name: testFile, assertionResults: [assertion] }],
  };
  const reportPath = artifactPath("vitest-report.json");
  await fs.writeFile(reportPath, JSON.stringify(report));
  return reportPath;
}

let repoRoot: string;
const artifactPath = (name: string) => path.join(repoRoot, ".artifacts", name);
const readArtifact = (name: string) => fs.readFile(artifactPath(name), "utf8");
beforeEach(async () => {
  repoRoot = tempDirs.make("openclaw-tui-pty-producer-");
  await writeFiles(repoRoot, [HARNESS_FILE, LOCAL_FILE, RESET_FILE]);
});
function run(built: boolean, dependencies: Parameters<typeof runTuiPtyEvidenceProducer>[1]) {
  const scenario = makeScenario({
    requireBuiltCli: built,
    ...caseOverride({ testFile: built ? LOCAL_FILE : HARNESS_FILE }),
  });
  return runTuiPtyEvidenceProducer(
    { artifactBase: artifactPath(""), repoRoot, scenarioId: scenario.id },
    { loadScenario: () => scenario, ...dependencies },
  );
}

function expectFailure(evidence: QaEvidenceSummaryJson, reason: string) {
  expect(evidence.entries[0]?.result).toMatchObject({
    status: "fail",
    failure: { reason: expect.stringContaining(reason) },
  });
}

it("accepts only the two required CLI arguments exactly once", () => {
  const parse = (args: string[]) => parseTuiPtyProducerOptions(args, "/repo");
  const invalid = (args: string[], message: string) => expect(() => parse(args)).toThrow(message);
  expect(parse(["--artifact-base", ".artifacts/pty", "--scenario-id", "scenario-id"])).toEqual({
    artifactBase: path.resolve("/repo/.artifacts/pty"),
    repoRoot: path.resolve("/repo"),
    scenarioId: "scenario-id",
  });
  invalid([], "--artifact-base is required");
  invalid(["--artifact-base", "out", "--extra", "value"], "unsupported");
  invalid(["--artifact-base", "one", "--artifact-base", "two"], "provided more than once");
});

it.each<[Record<string, unknown>, string, Partial<QaSeedScenarioWithSource>?]>([
  [caseOverride({ testFile: "../outside.test.ts" }), "testFile is not allowlisted"],
  [caseOverride({ testFile: "src/tui/other.e2e.test.ts" }), "testFile is not allowlisted"],
  [caseOverride({ extra: true }), "contains unsupported key extra"],
  [caseOverride({ testNamePattern: "[" }), "testNamePattern is invalid"],
  [caseOverride({ coverageId: "tui.output-safety" }), "coverage ID not owned by scenario"],
  [{}, "without TUI PTY cases", { coverage: { primary: [COVERAGE_ID, "tui.output-safety"] } }],
  [{ tuiPtyCases: [CASE, CASE] }, "duplicate TUI PTY case"],
  [{}, "execution.kind=script", { execution: { kind: "vitest", path: SOURCE_PATH } }],
  [{}, "must execute", { execution: { kind: "script", path: "test/other.ts" } }],
  [{ requireBuiltCli: null }, "must be a boolean"],
  [
    { requireBuiltCli: true, tuiPtyCases: [{ ...CASE, testFile: LOCAL_FILE }, CASE] },
    "every testFile to be exactly",
  ],
])("rejects scenario %j: %s", (config, message, overrides) => {
  expect(() => validateTuiPtyScenario(makeScenario(config, overrides))).toThrow(message);
});

it.each([
  ["missing", "did not write vitest-report.json"],
  ["stale", "report is stale"],
  ["wrong-file", "no result for configured test file"],
  ["unmatched", "no passed assertion"],
])("fails for a %s report", async (kind, reason) => {
  const evidence = await run(false, {
    now: () => 10_000,
    runCommand: async () => {
      if (kind !== "missing") {
        const file = kind === "wrong-file" ? RESET_FILE : HARNESS_FILE;
        const title = kind === "unmatched" ? "another assertion" : TEST_TITLE;
        const report = await writeReport(file, title);
        if (kind === "stale") {
          await fs.utimes(report, new Date(0), new Date(0));
        }
      }
      return { exitCode: 0, signal: null };
    },
  });
  expectFailure(evidence, reason);
});

it.each(["openclaw.mjs", "dist"])("rejects missing built artifact %s", async (missing) => {
  await writeFiles(repoRoot, ["openclaw.mjs", "dist/entry.js"]);
  await fs.rm(path.join(repoRoot, missing), { recursive: true });
  const runCommand = vi.fn(async () => ({ exitCode: 0, signal: null }));
  const evidence = await run(true, { runCommand });

  expect(runCommand).not.toHaveBeenCalled();
  expect(evidence.entries[0]?.execution?.artifacts).toMatchObject([
    { kind: "log", path: "tui-pty-evidence-producer.log" },
    { kind: "proof-matrix", path: "proof-matrix.json" },
  ]);
  expectFailure(evidence, "cliMode=built requires readable");
});

it.each([null, "entry.js", "entry.mjs"] as const)("sanitizes evidence (%s)", async (entry) => {
  vi.stubEnv("OPENCLAW_TUI_PTY_INCLUDE_LOCAL", "inherited");
  vi.stubEnv("OPENCLAW_TUI_PTY_USE_BUILT_CLI", "inherited");
  vi.stubEnv("OPENCLAW_VITEST_FS_MODULE_CACHE_PATH", "/shared/vitest-cache");
  const built = entry !== null;
  const testFile = built ? LOCAL_FILE : HARNESS_FILE;
  if (entry) {
    await writeFiles(repoRoot, ["openclaw.mjs", `dist/${entry}`]);
  }
  const evidence = await run(built, {
    runCommand: async (command) => {
      expect(command.args).toContain(testFile);
      expect(command.args).toContain(`--outputFile.json=${artifactPath("vitest-report.json")}`);
      const expectedEnv = {
        OPENCLAW_BEHAVIOR_EVIDENCE: "1",
        OPENCLAW_TUI_PTY_INCLUDE_LOCAL: built ? "1" : undefined,
        OPENCLAW_TUI_PTY_USE_BUILT_CLI: built ? "1" : undefined,
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: artifactPath("vitest-fs-module-cache"),
      };
      const actualEnv = Object.keys(expectedEnv).map((key) => command.env[key]);
      expect(actualEnv).toEqual(Object.values(expectedEnv));
      await writeReport(built ? testFile : path.join(repoRoot, testFile));
      return { exitCode: 0, signal: null };
    },
  });
  expect(validateQaEvidenceSummaryJson(evidence).entries[0]).toMatchObject({
    coverage: [{ id: COVERAGE_ID, role: "secondary" }],
    result: { status: "pass" },
  });
  expect(JSON.parse(await readArtifact("proof-matrix.json"))).toMatchObject({
    cliMode: built ? "built" : "source",
    cases: [{ coverageId: COVERAGE_ID, matchedAssertions: [TEST_NAME] }],
  });
  const reportText = await readArtifact("vitest-report.json");
  expect(reportText).toContain(`"name": "${testFile}"`);
  expect(reportText).not.toContain(repoRoot);
  await fs.access(artifactPath("latest-run.json"));
  await fs.access(artifactPath("qa-evidence.json"));
});
