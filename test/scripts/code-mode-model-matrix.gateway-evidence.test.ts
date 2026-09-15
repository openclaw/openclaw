import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
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
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "retains frozen-runtime Gateway workloads and independent evidence (interrupted=%s)",
  async (interrupted) => {
    const repoRoot = tempDirs.make("openclaw-matrix-gateway-evidence-");
    const runtimeDir = tempDirs.make("openclaw-matrix-frozen-runtime-");
    const gitOptions = { cwd: repoRoot, env: createNestedGitEnv(), encoding: "utf8" as const };
    execFileSync("git", ["init", "--quiet"], gitOptions);
    execFileSync(
      "git",
      [
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
      ],
      gitOptions,
    );
    const harnessSha = execFileSync("git", ["rev-parse", "HEAD"], gitOptions).trim();
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
        JSON.stringify({ head: runtimeSha }),
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
      workload: createGatewayMatrixWorkload(task, repetition, "off", 10),
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
          expect(params).toMatchObject({ repoRoot: runtimeDir, gitSha: runtimeSha, buildSha256 });
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
