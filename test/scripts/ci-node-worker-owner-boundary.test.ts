import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { shouldUseDetachedVitestProcessGroup } from "../../scripts/vitest-process-group.mts";
import { createWorkerArtifactTest, writeFixture } from "./vitest-worker-artifacts.test-support.js";

const it = createWorkerArtifactTest();
const root = process.cwd();
// ci.yml's trusted frozen-target checkout is intentionally this lightweight closure.
const sparseFiles = [
  "scripts/ci-run-node-test-shard.mts",
  "scripts/lib/ci-node-test-groups-codec.mts",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/local-check-runtime.mts",
  "scripts/lib/numeric-options.mjs",
];

it.for([
  "frozen",
  "foreign",
  "modern-missing",
  "modern-corrupt",
  "modern-unshared",
  "frozen-with-own-runner",
])("preserves the explicit workflow-owned runner boundary (%s)", (mode, { workerArtifacts }) =>
  workerArtifacts.fixtureLifetime.run(async () => {
    const { node } = workerArtifacts.createFixtureCommands();
    const directory = workerArtifacts.fixtureDirectory();
    const copiedRoot = mode.startsWith("frozen")
      ? path.join(directory, ".ci-workflow")
      : mode === "foreign"
        ? path.join(directory, "foreign")
        : directory;
    for (const file of sparseFiles) {
      const target = path.join(copiedRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
    }
    writeFixture(
      directory,
      "scripts/test-projects.mjs",
      "console.log('legacy transport ' + JSON.stringify(process.argv.slice(2)));\n",
    );
    if (mode === "frozen-with-own-runner") {
      writeFixture(directory, "scripts/ci-run-node-test-shard.mts", "export {};\n");
    }
    if (mode === "modern-corrupt" || mode === "modern-unshared") {
      writeFixture(
        directory,
        "scripts/lib/vitest-worker-run.mts",
        "throw new Error('fixture damaged worker owner');\n",
      );
      // Only the shared worker owner is damaged. The unshared row overrides
      // group capability while retaining the real lifecycle exports.
      for (const file of [
        "scripts/lib/vitest-process.mts",
        "scripts/lib/vitest-process-env.mts",
        "scripts/vitest-process-group.mts",
      ]) {
        writeFixture(
          directory,
          file,
          `export * from ${JSON.stringify(pathToFileURL(path.join(root, file)).href)};\n${
            mode === "modern-unshared" && file === "scripts/vitest-process-group.mts"
              ? "export const shouldUseDetachedVitestProcessGroup = () => false;\n"
              : ""
          }`,
        );
      }
    }
    const result = await node(
      ["--import", "tsx", path.join(copiedRoot, sparseFiles[0]!)],
      directory,
      {
        ...process.env,
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
          { configs: ["old.config.ts"], shard_name: "frozen-proof" },
        ]),
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: "",
        OPENCLAW_NODE_TEST_TARGETS_JSON: "[]",
        OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: "[]",
        OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
      },
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
    expect(fs.existsSync(path.join(copiedRoot, ".artifacts/vitest-workers"))).toBe(false);
  }),
);
