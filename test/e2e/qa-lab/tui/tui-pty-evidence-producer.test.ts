import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  validateQaEvidenceSummaryJson,
  type QaSeedScenarioWithSource,
} from "../../../../extensions/qa-lab/test-api.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  parseTuiPtyProducerOptions,
  runTuiPtyEvidenceProducer,
  validateTuiPtyScenario,
  verifyTuiPtyVitestReport,
  type TuiPtyCase,
} from "./tui-pty-evidence-producer.js";

const SOURCE_PATH = "test/e2e/qa-lab/tui/tui-pty-evidence-producer.ts";
const HARNESS_FILE = "src/tui/tui-pty-harness.e2e.test.ts";
const LOCAL_FILE = "src/tui/tui-pty-local.e2e.test.ts";
const RESET_FILE = "src/tui/tui-reset-transition-pty.e2e.test.ts";
const COVERAGE_ID = "tui.message-composition";
const TEST_SUITE = "TUI PTY harness";
const TEST_TITLE = "drives the real TUI terminal loop";
const TEST_NAME = `${TEST_SUITE} > ${TEST_TITLE}`;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function makeScenario({
  cases = [makeCase()],
  primary = [],
  executionKind = "script",
  executionPath = SOURCE_PATH,
  ...config
}: {
  cases?: unknown[];
  primary?: string[];
  executionKind?: "script" | "vitest";
  executionPath?: string;
  requireBuiltCli?: unknown;
} = {}): QaSeedScenarioWithSource {
  return {
    id: "tui-pty-evidence-producer-contract",
    title: "TUI PTY producer test",
    surface: "tui",
    objective: "Prove the TUI PTY evidence producer contract.",
    successCriteria: ["The configured PTY assertion passes."],
    sourcePath: "qa/scenarios/ui/tui-pty-producer-test.yaml",
    coverage: { primary, secondary: [COVERAGE_ID] },
    execution: {
      kind: executionKind,
      path: executionPath,
      config: { tuiPtyCases: cases, ...config },
    },
  };
}

function caseOverride(overrides: Record<string, unknown>) {
  return { cases: [{ ...makeCase(), ...overrides }] };
}

function makeCase(overrides: Partial<TuiPtyCase> = {}): TuiPtyCase {
  return {
    coverageId: COVERAGE_ID,
    testFile: HARNESS_FILE,
    testNamePattern: `^${TEST_NAME}$`,
    ...overrides,
  };
}

async function writeFiles(repoRoot: string, files: string[]) {
  for (const file of files) {
    const absolutePath = path.join(repoRoot, file);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "// fixture\n", "utf8");
  }
}

function makeReport(testFile = HARNESS_FILE, title = TEST_TITLE) {
  const assertion = { ancestorTitles: [TEST_SUITE], status: "passed", title };
  return {
    numFailedTests: 0,
    numPassedTests: 1,
    success: true,
    testResults: [{ name: testFile, assertionResults: [assertion] }],
  };
}

async function writeReport(command: { args: string[] }, testFile = HARNESS_FILE) {
  const reportPath =
    command.args
      .find((arg) => arg.startsWith("--outputFile.json="))
      ?.slice("--outputFile.json=".length) ?? "";
  await fs.writeFile(reportPath, `${JSON.stringify(makeReport(testFile))}\n`, "utf8");
  return reportPath;
}

async function makeProducer(built = false) {
  const scenario = makeScenario({
    requireBuiltCli: built,
    cases: [makeCase({ testFile: built ? LOCAL_FILE : HARNESS_FILE })],
  });
  const repoRoot = tempDirs.make("openclaw-tui-pty-producer-");
  await writeFiles(repoRoot, [HARNESS_FILE, LOCAL_FILE, RESET_FILE]);
  const artifactBase = path.join(repoRoot, ".artifacts");
  return {
    repoRoot,
    artifactBase,
    readArtifact: async (name: string): Promise<unknown> =>
      JSON.parse(await fs.readFile(path.join(artifactBase, name), "utf8")),
    run: (dependencies: Parameters<typeof runTuiPtyEvidenceProducer>[1]) =>
      runTuiPtyEvidenceProducer(
        { artifactBase, repoRoot, scenarioId: scenario.id },
        { loadScenario: () => scenario, ...dependencies },
      ),
  };
}

function expectFailure(
  evidence: Awaited<ReturnType<typeof runTuiPtyEvidenceProducer>>,
  reason: string,
) {
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
  invalid(
    ["--artifact-base", "out", "--extra", "value"],
    "unsupported TUI PTY evidence producer argument",
  );
  invalid(
    ["--artifact-base", "one", "--artifact-base", "two", "--scenario-id", "id"],
    "--artifact-base was provided more than once",
  );
});

it.each<[Parameters<typeof makeScenario>[0], string]>([
  [caseOverride({ testFile: "../outside.test.ts" }), "testFile is not allowlisted"],
  [caseOverride({ testFile: "src/tui/other.e2e.test.ts" }), "testFile is not allowlisted"],
  [caseOverride({ extra: true }), "contains unsupported key extra"],
  [caseOverride({ testNamePattern: "[" }), "testNamePattern is invalid"],
  [caseOverride({ coverageId: "tui.output-safety" }), "coverage ID not owned by scenario"],
  [
    { primary: [COVERAGE_ID, "tui.output-safety"] },
    "primary coverage IDs without TUI PTY cases: tui.output-safety",
  ],
  [{ cases: [makeCase(), makeCase()] }, "duplicate TUI PTY case"],
  [{ executionKind: "vitest" }, "execution.kind=script"],
  [{ executionPath: "test/other.ts" }, `must execute ${SOURCE_PATH}`],
  [{ requireBuiltCli: "built" }, "execution.config.requireBuiltCli must be a boolean"],
  [{ requireBuiltCli: null }, "execution.config.requireBuiltCli must be a boolean"],
  [{ requireBuiltCli: true }, `every testFile to be exactly ${LOCAL_FILE}`],
  [
    { requireBuiltCli: true, cases: [makeCase({ testFile: LOCAL_FILE }), makeCase()] },
    `every testFile to be exactly ${LOCAL_FILE}`,
  ],
])("rejects scenario %j: %s", (params, message) => {
  expect(() => validateTuiPtyScenario(makeScenario(params))).toThrow(message);
});

it("rejects wrong-file and unmatched-pattern reports", async () => {
  const { repoRoot } = await makeProducer();
  const verify = (report: ReturnType<typeof makeReport>) =>
    verifyTuiPtyVitestReport({ cases: [makeCase()], repoRoot, report });
  await expect(verify(makeReport(RESET_FILE))).rejects.toThrow(
    `no result for configured test file ${HARNESS_FILE}`,
  );
  await expect(verify(makeReport(HARNESS_FILE, "another assertion"))).rejects.toThrow(
    "no passed assertion",
  );
});

it.each([
  ["missing", "did not write vitest-report.json"],
  ["stale", "report is stale"],
])("fails for a %s report", async (kind, reason) => {
  const producer = await makeProducer();
  const evidence = await producer.run({
    now: () => 10_000,
    runCommand: async (command) => {
      if (kind === "stale") {
        await fs.utimes(await writeReport(command), new Date(0), new Date(0));
      }
      return { exitCode: 0, signal: null };
    },
  });
  expectFailure(evidence, reason);
});

it.each(["openclaw.mjs", "dist"])(
  "fails built preflight without %s before spawning",
  async (missing) => {
    const producer = await makeProducer(true);
    await writeFiles(producer.repoRoot, ["openclaw.mjs", "dist/entry.js"]);
    await fs.rm(path.join(producer.repoRoot, missing), { recursive: true });
    const runCommand = vi.fn(async () => ({ exitCode: 0, signal: null }));
    const evidence = await producer.run({ runCommand });

    expect(runCommand).not.toHaveBeenCalled();
    expect(evidence.entries[0]?.execution?.artifacts).toMatchObject([
      { kind: "log", path: "tui-pty-evidence-producer.log" },
      { kind: "proof-matrix", path: "proof-matrix.json" },
    ]);
    expectFailure(
      evidence,
      "cliMode=built requires readable openclaw.mjs and at least one readable dist/entry.js or dist/entry.mjs",
    );
  },
);

it.each([null, "entry.js", "entry.mjs"] as const)(
  "writes sanitized evidence (%s)",
  async (entry) => {
    vi.stubEnv("OPENCLAW_TUI_PTY_INCLUDE_LOCAL", "inherited");
    vi.stubEnv("OPENCLAW_TUI_PTY_USE_BUILT_CLI", "inherited");
    vi.stubEnv("OPENCLAW_VITEST_FS_MODULE_CACHE_PATH", "/shared/vitest-cache");
    const built = entry !== null;
    const testFile = built ? LOCAL_FILE : HARNESS_FILE;
    const { repoRoot, artifactBase, run, readArtifact } = await makeProducer(built);
    if (entry) {
      await writeFiles(repoRoot, ["openclaw.mjs", `dist/${entry}`]);
    }
    const evidence = await run({
      runCommand: async (command) => {
        expect(command.args).toEqual(
          expect.arrayContaining([
            "scripts/run-vitest.mjs",
            "run",
            "--config",
            "test/vitest/vitest.tui-pty.config.ts",
            testFile,
            "--reporter=json",
            `--outputFile.json=${path.join(artifactBase, "vitest-report.json")}`,
          ]),
        );
        expect([
          command.env.OPENCLAW_BEHAVIOR_EVIDENCE,
          command.env.OPENCLAW_TUI_PTY_INCLUDE_LOCAL,
          command.env.OPENCLAW_TUI_PTY_USE_BUILT_CLI,
          command.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH,
        ]).toEqual([
          "1",
          built ? "1" : undefined,
          built ? "1" : undefined,
          path.join(artifactBase, "vitest-fs-module-cache"),
        ]);
        await writeReport(command, built ? testFile : path.join(repoRoot, testFile));
        return { exitCode: 0, signal: null };
      },
    });
    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.entries[0]).toMatchObject({
      coverage: [{ id: COVERAGE_ID, role: "secondary" }],
      result: { status: "pass" },
    });
    expect(await readArtifact("proof-matrix.json")).toMatchObject({
      cliMode: built ? "built" : "source",
      cases: [{ coverageId: COVERAGE_ID, matchedAssertions: [TEST_NAME] }],
    });
    const reportText = await fs.readFile(path.join(artifactBase, "vitest-report.json"), "utf8");
    expect(reportText).toContain(`"name": "${testFile}"`);
    expect(reportText).not.toContain(repoRoot);
    await fs.access(path.join(artifactBase, "latest-run.json"));
    await fs.access(path.join(artifactBase, "qa-evidence.json"));
  },
);
