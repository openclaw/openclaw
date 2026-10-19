import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const TEST_PATTERN = `^${TEST_NAME}$`;
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

function expectInvalidScenario(params: Parameters<typeof makeScenario>[0], message: string) {
  expect(() => validateTuiPtyScenario(makeScenario(params))).toThrow(message);
}

function expectInvalidCase(overrides: Record<string, unknown>, message: string) {
  expectInvalidScenario({ cases: [{ ...makeCase(), ...overrides }] }, message);
}

function makeCase(overrides: Partial<TuiPtyCase> = {}): TuiPtyCase {
  return {
    coverageId: COVERAGE_ID,
    testFile: HARNESS_FILE,
    testNamePattern: TEST_PATTERN,
    ...overrides,
  };
}

async function makeTempRepo() {
  const repoRoot = tempDirs.make("openclaw-tui-pty-producer-");
  for (const testFile of [HARNESS_FILE, LOCAL_FILE, RESET_FILE]) {
    const absolutePath = path.join(repoRoot, testFile);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "// fixture\n", "utf8");
  }
  return repoRoot;
}

async function writeBuiltCliArtifacts(repoRoot: string, entry: "entry.js" | "entry.mjs") {
  await fs.writeFile(path.join(repoRoot, "openclaw.mjs"), "// launcher\n", "utf8");
  await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "dist", entry), "// entry\n", "utf8");
}

function makeReport(testFile = HARNESS_FILE, title = TEST_TITLE) {
  const assertion = {
    ancestorTitles: [TEST_SUITE],
    fullName: `${TEST_SUITE} ${title}`,
    status: "passed",
    title,
  };
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
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(makeReport(testFile))}\n`, "utf8");
  return reportPath;
}

async function makeProducer(params?: Parameters<typeof makeScenario>[0]) {
  const scenario = makeScenario(params);
  const repoRoot = await makeTempRepo();
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

function expectCommandEnv(env: NodeJS.ProcessEnv, artifactBase: string, built: boolean) {
  expect(env.OPENCLAW_BEHAVIOR_EVIDENCE).toBe("1");
  expect(env.OPENCLAW_TUI_PTY_INCLUDE_LOCAL).toBe(built ? "1" : undefined);
  expect(env.OPENCLAW_TUI_PTY_USE_BUILT_CLI).toBe(built ? "1" : undefined);
  expect(env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBe(
    path.join(artifactBase, "vitest-fs-module-cache"),
  );
}

function stubInheritedPtyEnv() {
  vi.stubEnv("OPENCLAW_TUI_PTY_INCLUDE_LOCAL", "inherited");
  vi.stubEnv("OPENCLAW_TUI_PTY_USE_BUILT_CLI", "inherited");
  vi.stubEnv("OPENCLAW_VITEST_FS_MODULE_CACHE_PATH", "/shared/vitest-cache");
}

describe("TUI PTY evidence producer", () => {
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

  it("rejects arbitrary paths, traversal, malformed cases, and invalid patterns", () => {
    expectInvalidCase({ testFile: "../outside.test.ts" }, "testFile is not allowlisted");
    expectInvalidCase({ testFile: "src/tui/other.e2e.test.ts" }, "testFile is not allowlisted");
    expectInvalidCase({ extra: true }, "contains unsupported key extra");
    expectInvalidCase({ testNamePattern: "[" }, "testNamePattern is invalid");
  });

  it("requires declared coverage, every primary ID, unique cases, and the producer path", () => {
    expectInvalidCase({ coverageId: "tui.output-safety" }, "coverage ID not owned by scenario");
    expectInvalidScenario(
      { primary: [COVERAGE_ID, "tui.output-safety"] },
      "primary coverage IDs without TUI PTY cases: tui.output-safety",
    );
    expectInvalidScenario({ cases: [makeCase(), makeCase()] }, "duplicate TUI PTY case");
    expectInvalidScenario({ executionKind: "vitest" }, "execution.kind=script");
    expectInvalidScenario({ executionPath: "test/other.ts" }, `must execute ${SOURCE_PATH}`);
  });

  it.each(["built", null])("rejects non-boolean requireBuiltCli %j", (requireBuiltCli) => {
    expectInvalidScenario(
      { requireBuiltCli },
      "execution.config.requireBuiltCli must be a boolean",
    );
  });

  it("rejects harness-only and mixed cases in built mode", () => {
    expectInvalidScenario({ requireBuiltCli: true }, `every testFile to be exactly ${LOCAL_FILE}`);
    expectInvalidScenario(
      { requireBuiltCli: true, cases: [makeCase({ testFile: LOCAL_FILE }), makeCase()] },
      `every testFile to be exactly ${LOCAL_FILE}`,
    );
  });

  it("rejects wrong-file and unmatched-pattern reports", async () => {
    const repoRoot = await makeTempRepo();
    const verify = (report: ReturnType<typeof makeReport>) =>
      verifyTuiPtyVitestReport({ cases: [makeCase()], repoRoot, report });
    await expect(verify(makeReport(RESET_FILE))).rejects.toThrow(
      `no result for configured test file ${HARNESS_FILE}`,
    );
    await expect(verify(makeReport(HARNESS_FILE, "another assertion"))).rejects.toThrow(
      "no passed assertion",
    );
  });

  it("fails when the child writes no fresh report or writes a stale report", async () => {
    const producer = await makeProducer();
    const missing = await producer.run({
      runCommand: async () => ({ exitCode: 0, signal: null }),
    });
    expectFailure(missing, "did not write vitest-report.json");

    const stale = await producer.run({
      now: () => 10_000,
      runCommand: async (command) => {
        const reportPath = await writeReport(command);
        await fs.utimes(reportPath, new Date(0), new Date(0));
        return { exitCode: 0, signal: null };
      },
    });
    expectFailure(stale, "report is stale");
  });

  it("fails built preflight for a missing launcher or dist entry without spawning", async () => {
    for (const missing of ["openclaw.mjs", "dist"] as const) {
      const producer = await makeProducer({
        cases: [makeCase({ testFile: LOCAL_FILE })],
        requireBuiltCli: true,
      });
      await writeBuiltCliArtifacts(producer.repoRoot, "entry.js");
      await fs.rm(path.join(producer.repoRoot, missing), { recursive: true });
      const runCommand = vi.fn(async () => ({ exitCode: 0, signal: null }));
      const evidence = await producer.run({ runCommand });

      expect(runCommand).not.toHaveBeenCalled();
      expect(evidence.entries[0]?.execution.artifacts).toMatchObject([
        { kind: "log", path: "tui-pty-evidence-producer.log" },
        { kind: "proof-matrix", path: "proof-matrix.json" },
      ]);
      expectFailure(
        evidence,
        "cliMode=built requires readable openclaw.mjs and at least one readable dist/entry.js or dist/entry.mjs",
      );
    }
  });

  it.each([null, "entry.js", "entry.mjs"] as const)(
    "writes sanitized passing evidence using CLI entry %s (null = source)",
    async (entry) => {
      stubInheritedPtyEnv();
      const built = entry !== null;
      const testFile = built ? LOCAL_FILE : HARNESS_FILE;
      const { repoRoot, artifactBase, run, readArtifact } = await makeProducer({
        cases: [makeCase({ testFile })],
        requireBuiltCli: built,
      });
      if (entry) {
        await writeBuiltCliArtifacts(repoRoot, entry);
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
          expectCommandEnv(command.env, artifactBase, built);
          await writeReport(command, built ? testFile : path.join(repoRoot, testFile));
          return { exitCode: 0, signal: null };
        },
      });
      expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
      expect(evidence.entries[0]).toMatchObject({
        coverage: [{ id: COVERAGE_ID, role: "secondary" }],
        result: { status: "pass" },
      });
      expect(await readArtifact("proof-matrix.json")).toEqual(
        expect.objectContaining({
          cliMode: built ? "built" : "source",
          cases: [
            expect.objectContaining({ coverageId: COVERAGE_ID, matchedAssertions: [TEST_NAME] }),
          ],
        }),
      );
      const reportText = await fs.readFile(path.join(artifactBase, "vitest-report.json"), "utf8");
      expect(reportText).toContain(`"name": "${testFile}"`);
      expect(reportText).not.toContain(repoRoot);
      await fs.access(path.join(artifactBase, "latest-run.json"));
      await fs.access(path.join(artifactBase, "qa-evidence.json"));
    },
  );
});
