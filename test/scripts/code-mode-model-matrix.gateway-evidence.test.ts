import {
  execFileSync,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import {
  getEffectiveQaEvidenceEntries,
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
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function initializeGitFixture(root: string) {
  const env = createNestedGitEnv();
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  git(["init", "--quiet"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=QA Fixture",
    "-c",
    "user.email=qa@example.test",
    "commit",
    "--no-gpg-sign",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return { env, git, head: git(["rev-parse", "HEAD"]) };
}

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
  const stamp = JSON.parse(await fs.readFile(stampPath, "utf8"));
  expect(stamp).toMatchObject({ head, inputsClean: false });
  await fs.writeFile(input, "export {};\n");
  expect(git(["status", "--porcelain"])).toBe("");

  const buildCliArtifacts = vi.fn(async () => {});
  const readBuildSha256 = vi.fn(async () => "fixture-build");
  const runCell = vi.fn(async (): Promise<CodeModeMatrixCellResult> => {
    throw new Error("unverified frozen runtime reached the cell boundary");
  });
  for (const inputsClean of [false, null, undefined]) {
    await fs.writeFile(stampPath, JSON.stringify({ ...stamp, inputsClean }));
    await expect(
      runCodeModeModelMatrix(
        {
          allowFailures: false,
          dryRun: false,
          keepState: false,
          models: ["fixture/model"],
          modes: ["code"],
          tasks: ["read"],
          repetitions: 1,
          repoRoot: root,
          runtimeDir: root,
          outputDir: "artifacts",
          thinking: "off",
          timeoutSeconds: 10,
        },
        { buildCliArtifacts, readBuildSha256, runCell },
      ),
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
    for (const root of [repoRoot, runtimeDir]) {
      await fs.mkdir(path.join(root, "dist"));
      await fs.writeFile(
        path.join(root, "dist", "entry.js"),
        root === repoRoot ? "harness" : "runtime",
      );
    }
    for (const stamp of [".buildstamp", ".runtime-postbuildstamp"]) {
      await fs.writeFile(
        path.join(runtimeDir, "dist", stamp),
        JSON.stringify({ head: runtimeSha, inputsClean: true }),
      );
    }
    const buildSha256 = createHash("sha256").update("runtime").digest("hex");
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
    let calls = 0;
    const previousSigintListeners = process.rawListeners("SIGINT");
    const previousSigtermListeners = process.rawListeners("SIGTERM");
    const run = runCodeModeModelMatrix(
      {
        allowFailures: false,
        dryRun: false,
        keepState: false,
        models: [model],
        gatewayExecutor: executor,
        modes: ["code"],
        tasks: [task],
        repetitions: 3,
        repoRoot,
        runtimeDir,
        baselineResults,
        outputDir: "artifacts",
        thinking: "off",
        timeoutSeconds: 10,
      },
      {
        readSourceIdentity: async (root) => {
          expect(root).toBe(runtimeDir);
          return { gitSha: runtimeSha, sourceDirty: false, sourcePatchSha256: null };
        },
        readBuildSha256: async (root) => {
          expect(root).toBe(runtimeDir);
          return createHash("sha256")
            .update(await fs.readFile(path.join(root, "dist", "entry.js")))
            .digest("hex");
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
          const before = validateQaEvidenceSummaryJson(
            JSON.parse(await fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")),
          );
          expect(
            projectQaEvidenceScenarioOutcomes(before).map((outcome) => outcome.status),
          ).toEqual(
            calls === 1
              ? [null, null, null]
              : calls === 2
                ? ["pass", null, null]
                : ["pass", "fail", null],
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
            gitSha: runtimeSha,
            sourceDirty: false,
            sourcePatchSha256: null,
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
      const comparison = JSON.parse(
        await fs.readFile(path.join(outputDir, "comparison.json"), "utf8"),
      );
      expect(comparison).toMatchObject({ total: 3, baselinePassed: 3, candidatePassed: 2 });
      expect(comparison.cells.map((cell: { candidateSha: string }) => cell.candidateSha)).toEqual([
        runtimeSha,
        runtimeSha,
        runtimeSha,
      ]);
    }
    expect(process.rawListeners("SIGINT")).toEqual(previousSigintListeners);
    expect(process.rawListeners("SIGTERM")).toEqual(previousSigtermListeners);
    expect(calls).toBe(interrupted ? 2 : 3);
    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      gitSha: runtimeSha,
      buildSha256,
      harness: { gitSha: harnessSha },
      gatewayExecutor: executor,
    });
    const rows: CodeModeMatrixCellResult[] = (
      await fs.readFile(path.join(outputDir, "results.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")),
    );
    if (evidence.schemaVersion !== 3) {
      throw new Error("expected canonical invocation evidence after comparison");
    }
    expect(projectQaEvidenceScenarioOutcomes(evidence).map((outcome) => outcome.status)).toEqual([
      "pass",
      "fail",
      interrupted ? null : "pass",
    ]);
    expect(getEffectiveQaEvidenceEntries(evidence)).toHaveLength(calls);
    expect(evidence.occurrences).toHaveLength(3 + calls);
    expect(new Set(rows.map((row) => row.evidenceOccurrenceId)).size).toBe(calls);
    for (const row of rows) {
      expect(row.executor).toBe(executor);
      expect(row.workload).toEqual(baselineRows[row.repetition - 1]?.workload);
      const occurrence = evidence.occurrences.find((item) => item.id === row.evidenceOccurrenceId);
      expect(occurrence).toMatchObject({
        retryOf: null,
        launch: {
          source: { ref: runtimeSha },
          package: null,
          protocol: null,
          accountRef: null,
          proofClass: null,
        },
      });
      expect(occurrence?.receipts).toHaveLength(1);
      const receipt = occurrence?.receipts[0];
      if (!receipt) {
        throw new Error("expected a prepared observation receipt");
      }
      expect(receipt.phase).toBe("prepared");
      const bytes = await fs.readFile(path.join(outputDir, receipt.artifact.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.artifact.sha256);
      expect(JSON.parse(bytes.toString()).result).toEqual(row);
    }
  },
);
