import {
  execFileSync,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import {
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
} from "../../extensions/qa-lab/api.js";
import {
  modelCellPrefix,
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
} from "../../scripts/code-mode-model-matrix.js";
import { createGatewayMatrixWorkload } from "../../scripts/lib/code-mode-matrix-gateway.js";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "../../scripts/lib/local-build-metadata.mts";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { toolingTsEntrypoints } from "./tooling-ts-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const readJsonLines = async (file: string) =>
  (await fs.readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const readEvidence = async (root: string) =>
  validateQaEvidenceSummaryJson(await readJson(path.join(root, "qa-evidence.json")));
async function frozenRuntime(root: string, head: string, entry: string) {
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "entry.js"), entry);
  for (const stamp of [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE]) {
    await writeJson(path.join(root, "dist", stamp), { head, inputsClean: true });
  }
}
function matrixOptions(repoRoot: string, runtimeDir = repoRoot) {
  return {
    allowFailures: false,
    dryRun: false,
    keepState: false,
    models: ["fixture/model"],
    modes: ["code" as const],
    tasks: ["read" as const],
    repetitions: 1,
    repoRoot,
    runtimeDir,
    outputDir: "artifacts",
    thinking: "off" as const,
    timeoutSeconds: 10,
  };
}
function outcomes(evidence: Parameters<typeof projectQaEvidenceScenarioOutcomes>[0]) {
  return projectQaEvidenceScenarioOutcomes(evidence).map((outcome) => outcome.status);
}

function initializeGitFixture(root: string, env = createNestedGitEnv()) {
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
      cwd: root,
      env,
      encoding: "utf8",
    }).trim();
  git(["init", "--quiet"]);
  git(["add", "."]);
  const author = ["-c", "user.name=QA Fixture", "-c", "user.email=qa@example.test"];
  git([...author, "commit", "--no-gpg-sign", "--allow-empty", "--quiet", "-m", "fixture"]);
  return { env, git, head: git(["rev-parse", "HEAD"]) };
}

it("runs the actual Gateway matrix CLI without a provider or import cycle", async ({ signal }) => {
  const root = tempDirs.make("openclaw-matrix-cli-");
  await Promise.all(
    ["node_modules", "packages", "home", "tmp"].map((directory) =>
      fs.mkdir(path.join(root, directory)),
    ),
  );
  await fs.writeFile(
    path.join(root, ".gitignore"),
    "/dist/\n/node_modules/\n/packages/\n/home/\n/tmp/\n/artifacts/\n",
  );
  await writeJson(path.join(root, "package.json"), { type: "module" });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    OPENCLAW_HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    // The synthetic cwd must retain the source checkout's SDK path mapping.
    TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "0",
    GIT_CONFIG_KEY_1: "gc.auto",
    GIT_CONFIG_VALUE_1: "0",
  };
  const { head } = initializeGitFixture(root, env);
  await frozenRuntime(root, head, 'throw new Error("Unexpected synthetic runtime launch");\n');
  const run = await runNodeScript(
    (workerArgv) => [
      ...workerArgv(resolveRuntimeWorkerUrl(toolingTsEntrypoints.codeModeModelMatrix)),
      "--runtime-dir",
      root,
      ..."--model openai/fixture --mode code --task javascript-contracts --repetitions 1 --output-dir artifacts".split(
        " ",
      ),
    ],
    env,
    30_000,
    { cwd: root, signal, maxBuffer: 1024 * 1024 },
  );
  expect(run.error, run.stdout + run.stderr).toBeUndefined();
  expect(run.status, run.stderr).toBe(1);
  const rows = await readJsonLines(path.join(root, "artifacts/results.jsonl")).catch(
    (cause: unknown) => {
      throw new Error(
        `Real CLI produced no result.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        { cause },
      );
    },
  );
  expect(rows).toMatchObject([
    { task: "javascript-contracts", failureCategory: "provider_auth", passed: false },
  ]);
  expect(run.stdout).toContain("FAIL provider_auth");
  const resultPrefix = "[code-mode-matrix-result] ";
  const streamedResult = run.stdout.split("\n").find((line) => line.startsWith(resultPrefix));
  expect(streamedResult).toBeDefined();
  expect(JSON.parse(streamedResult?.slice(resultPrefix.length) ?? "null")).toEqual(rows[0]);
  const summary = await readJson(path.join(root, "artifacts", "summary.json"));
  expect(summary.counts).toEqual({ total: 1, passed: 0, failed: 1 });
});

it.each([
  { stamp: BUILD_STAMP_FILE, input: "src/entry.ts", write: writeBuildStamp },
  {
    stamp: RUNTIME_POSTBUILD_STAMP_FILE,
    input: "scripts/runtime-postbuild.mts",
    write: writeRuntimePostBuildStamp,
  },
])("rejects a dirty-built frozen $stamp after its source returns clean", async (testCase) => {
  const root = tempDirs.make("openclaw-matrix-producer-provenance-");
  const input = path.join(root, testCase.input);
  await fs.mkdir(path.dirname(input), { recursive: true });
  await fs.writeFile(input, "export {};\n");
  await fs.writeFile(path.join(root, ".gitignore"), "/dist/\n/artifacts/\n");
  const { env, git, head } = initializeGitFixture(root);
  const producer = {
    cwd: root,
    spawnSync: (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) =>
      spawnSync(command, args, { ...options, env }),
  };
  writeBuildStamp(producer);
  writeRuntimePostBuildStamp(producer);
  await fs.writeFile(input, "export const changed = true;\n");
  testCase.write(producer);
  const stampPath = path.join(root, "dist", testCase.stamp);
  const stamp = await readJson(stampPath);
  expect(stamp).toMatchObject({ head, inputsClean: false });
  await fs.writeFile(input, "export {};\n");
  expect(git(["status", "--porcelain"])).toBe("");

  const buildCliArtifacts = vi.fn(async () => {});
  const readBuildSha256 = vi.fn(async () => "fixture-build");
  const runCell = vi.fn(async (): Promise<CodeModeMatrixCellResult> => {
    throw new Error("unverified frozen runtime reached the cell boundary");
  });
  for (const inputsClean of [false, null, undefined]) {
    await writeJson(stampPath, { ...stamp, inputsClean });
    await expect(
      runCodeModeModelMatrix(matrixOptions(root), { buildCliArtifacts, readBuildSha256, runCell }),
    ).rejects.toThrow(`Frozen runtime ${testCase.stamp}`);
    expect(buildCliArtifacts).not.toHaveBeenCalled();
    expect(readBuildSha256).not.toHaveBeenCalled();
    expect(runCell).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it.each([
  { interrupted: false, executor: "node" },
  { interrupted: true, executor: "quickjs" },
] as const)(
  "retains frozen-runtime $executor Gateway workloads and independent evidence (interrupted=$interrupted)",
  async ({ interrupted, executor }) => {
    const repoRoot = tempDirs.make("openclaw-matrix-gateway-evidence-");
    const runtimeDir = tempDirs.make("openclaw-matrix-frozen-runtime-");
    const { head: harnessSha } = initializeGitFixture(repoRoot);
    const runtimeSha = "a".repeat(40);
    const source = { gitSha: runtimeSha, sourceDirty: false, sourcePatchSha256: null };
    await frozenRuntime(repoRoot, harnessSha, "harness");
    await frozenRuntime(runtimeDir, runtimeSha, "runtime");
    const buildSha256 = sha256("runtime");
    const model = "openai/fixture";
    const task = "inventory-join";
    const baselineResults = path.join(repoRoot, "baseline.jsonl");
    const baselineRows = [1, 2, 3].map((repetition) => ({
      id: `${modelCellPrefix(model)}-code-${task}-${repetition}`,
      model,
      mode: "code",
      task,
      repetition,
      passed: true,
      gitSha: "baseline",
      elapsedMs: 10,
      workload: createGatewayMatrixWorkload(task, repetition, "off", 10, executor),
    }));
    await fs.writeFile(baselineResults, baselineRows.map((row) => JSON.stringify(row)).join("\n"));
    const outputDir = path.join(repoRoot, "artifacts");
    const artifact = (name: string) => path.join(outputDir, name);
    let calls = 0;
    const previousSigintListeners = process.rawListeners("SIGINT");
    const previousSigtermListeners = process.rawListeners("SIGTERM");
    const run = runCodeModeModelMatrix(
      {
        ...matrixOptions(repoRoot, runtimeDir),
        models: [model],
        gatewayExecutor: executor,
        tasks: [task],
        repetitions: 3,
        baselineResults,
      },
      {
        readSourceIdentity: async (root) => {
          expect(root).toBe(runtimeDir);
          return source;
        },
        readBuildSha256: async (root) => {
          expect(root).toBe(runtimeDir);
          return sha256(await fs.readFile(path.join(root, "dist", "entry.js")));
        },
        buildCliArtifacts: async () => {
          throw new Error("must not rebuild a frozen runtime");
        },
        // Synthetic cell responses exercise the real matrix publication boundary,
        // not a live Gateway, model, or target-runtime attestation.
        runCell: async (params): Promise<CodeModeMatrixCellResult> => {
          calls += 1;
          expect(params).toMatchObject({
            repoRoot: runtimeDir,
            gitSha: runtimeSha,
            buildSha256,
            executor,
          });
          expect(outcomes(await readEvidence(outputDir))).toEqual(
            [
              [null, null, null],
              ["pass", null, null],
              ["pass", "fail", null],
            ][calls - 1],
          );
          if (calls === 2) {
            if (interrupted) {
              // Invoke only the matrix's registered once-wrapper; broadcasting
              // SIGINT also shuts down the surrounding Vitest worker.
              const handlers = process
                .rawListeners("SIGINT")
                .filter((handler) => !previousSigintListeners.includes(handler));
              expect(handlers).toHaveLength(1);
              for (const handler of handlers) {
                handler("SIGINT");
              }
              expect(process.rawListeners("SIGINT")).toEqual(previousSigintListeners);
              expect(params.abortSignal?.aborted).toBe(true);
            }
            throw new Error("synthetic Gateway cell failed");
          }
          return {
            ...params.cell,
            buildSha256,
            ...source,
            timestamp: new Date().toISOString(),
            elapsedMs: 10,
            expected: "fixture",
            final: "fixture",
            status: "ok",
            passed: true,
            failureCategory: null,
            codeModeEngaged: true,
            observedModel: "fixture",
            observedProvider: "openai",
            oracle: {
              answer: true,
              effect: true,
              engagement: true,
              identity: true,
              toolExecution: true,
            },
          };
        },
      },
    );
    if (interrupted) {
      await expect(run).rejects.toThrow("Code Mode matrix interrupted");
    } else {
      expect((await run).exitCode).toBe(1);
      const comparison = await readJson(artifact("comparison.json"));
      expect(comparison).toMatchObject({ total: 3, baselinePassed: 3, candidatePassed: 2 });
      expect(comparison.cells.map((cell: { candidateSha: string }) => cell.candidateSha)).toEqual(
        Array(3).fill(runtimeSha),
      );
    }
    expect(process.rawListeners("SIGINT")).toEqual(previousSigintListeners);
    expect(process.rawListeners("SIGTERM")).toEqual(previousSigtermListeners);
    expect(calls).toBe(interrupted ? 2 : 3);
    expect(await readJson(artifact("manifest.json"))).toMatchObject({
      gitSha: runtimeSha,
      buildSha256,
      harness: { gitSha: harnessSha },
      gatewayExecutor: executor,
    });
    const evidence = await readEvidence(outputDir);
    expect(outcomes(evidence)).toEqual(["pass", "fail", interrupted ? null : "pass"]);
    const rows: CodeModeMatrixCellResult[] = await readJsonLines(artifact("results.jsonl"));
    expect(rows.map(({ executor: selected, workload }) => [selected, workload])).toEqual(
      baselineRows.slice(0, calls).map(({ workload }) => [executor, workload]),
    );
  },
);
