import fs from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { shouldUseDetachedVitestProcessGroup } from "../../scripts/vitest-process-group.mts";
import { readCiWorkflow, type WorkflowStep } from "./ci-workflow.test-support.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";
import { createWorkerArtifactTest, writeFixture } from "./vitest-worker-artifacts.test-support.js";

const it = createWorkerArtifactTest();
const root = process.cwd();
const checkout = Object.values(readCiWorkflow().jobs)
  .flatMap((job) => (job as { steps?: WorkflowStep[] }).steps ?? [])
  .find((step: WorkflowStep) => step.name === "Checkout trusted Node shard runner");
const sparseFiles = String(checkout?.with?.["sparse-checkout"]).trim().split(/\s+/u);
expect(sparseFiles[0]).toBe("scripts/ci-run-node-test-shard.mts");

it.for(["frozen", "modern-missing", "modern-corrupt", "modern-unshared", "frozen-with-own-runner"])(
  "preserves the explicit workflow-owned runner boundary (%s)",
  (mode, { workerArtifacts }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const { node } = workerArtifacts.createFixtureCommands();
      const directory = workerArtifacts.fixtureDirectory();
      const write = (file: string, source: string) =>
        writeFixture(directory, `scripts/${file}`, source);
      const copiedRoot = mode.startsWith("frozen") ? join(directory, ".ci-workflow") : directory;
      for (const file of sparseFiles) {
        const target = join(copiedRoot, file);
        fs.mkdirSync(dirname(target), { recursive: true });
        fs.copyFileSync(join(root, file), target);
      }
      expect(fs.existsSync(join(copiedRoot, "scripts/lib/vitest-worker-run.mts"))).toBe(false);
      write(
        "test-projects.mjs",
        "console.log('legacy transport ' + JSON.stringify(process.argv.slice(2)));\n",
      );
      if (mode === "frozen-with-own-runner") {
        write("ci-run-node-test-shard.mts", "export {};\n");
      }
      if (mode === "modern-corrupt" || mode === "modern-unshared") {
        write("lib/vitest-worker-run.mts", "throw new Error('fixture damaged worker owner');\n");
        // Damage only the worker owner; retain real lifecycle exports.
        for (const file of [
          "lib/vitest-process.mts",
          "lib/vitest-process-env.mts",
          "vitest-process-group.mts",
        ]) {
          const source = JSON.stringify(pathToFileURL(join(root, "scripts", file)).href);
          write(
            file,
            `export * from ${source};\n${
              mode === "modern-unshared" && file === "vitest-process-group.mts"
                ? "export const shouldUseDetachedVitestProcessGroup = () => false;\n"
                : ""
            }`,
          );
        }
      }
      const result = await node(
        ["--import", "tsx", join(copiedRoot, sparseFiles[0]!)],
        directory,
        testRunnerFixtureEnv({
          // Exercise historical Node transport without inheriting host dist preparation.
          OPENCLAW_CI_TEST_RUNTIME_POLICY: "node",
          OPENCLAW_E2E_USE_PREBUILT_DIST: "",
          OPENCLAW_NODE_TEST_ENV_JSON: "{}",
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
            { configs: ["old.config.ts"], shard_name: "frozen-proof" },
          ]),
          OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: "",
          OPENCLAW_NODE_TEST_TARGETS_JSON: "[]",
          OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: "[]",
          OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
        }),
      );
      const unshared =
        mode === "modern-unshared" ||
        (mode === "modern-corrupt" && !shouldUseDetachedVitestProcessGroup());
      if (mode === "frozen" || unshared) {
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('legacy transport ["old.config.ts"]');
        expect(result.stdout).toContain("[shard:frozen-proof] end (exit 0)");
      } else {
        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain("legacy transport");
        if (mode === "modern-corrupt") {
          expect(result.stderr).toContain("fixture damaged worker owner");
        }
      }
      expect(result.stdout + result.stderr).not.toContain("[vitest-workers] prepared");
      expect(fs.existsSync(join(copiedRoot, ".artifacts/vitest-workers"))).toBe(false);
    }),
);
