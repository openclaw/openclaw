/* @vitest-environment node */
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createVitestWorkerRun } from "../scripts/lib/vitest-worker-run.mts";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { runVitestShutdownCommand } from "./helpers/vitest-shutdown-command.ts";
import { withRunnerFixture } from "./non-isolated-runner.fixture-support.ts";
import { responsesProducerFixtureFiles } from "./non-isolated-runner.responses-fixtures.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
it("settles a real Responses producer before the next non-isolated file loads", (context) => {
  const run = withRunnerFixture("non-isolated-runner-responses", async ({ root, args, env }) => {
    const files = responsesProducerFixtureFiles(repoRoot);
    files["vitest.config.ts"] =
      `import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test", "vitest", "vitest.shared.config.ts"))};
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
class AlphabeticalSequencer extends BaseSequencer {
  override async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}
export default defineConfig({
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  plugins: sharedVitestConfig.plugins,
  resolve: sharedVitestConfig.resolve,
  test: {
    testTimeout: sharedVitestConfig.test.testTimeout,
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { sequencer: AlphabeticalSequencer },
    runner: ${JSON.stringify(path.join(repoRoot, "test", "non-isolated-runner.ts"))},
  },
});
`;
    for (const [name, contents] of Object.entries(files)) {
      await fs.writeFile(path.join(root, name), contents, "utf8");
    }
    let child!: ChildProcess;
    const workers = createVitestWorkerRun(env);
    let result: Awaited<ReturnType<typeof runVitestShutdownCommand>>;
    try {
      result = await runVitestShutdownCommand({
        bin: resolveTestNodeExecPath(),
        args,
        cwd: repoRoot,
        env,
        workerRun: workers,
        maxBytes: 4 * 1024 * 1024,
        signal: context.signal,
        onReady(owned) {
          child = owned;
        },
      });
    } finally {
      await workers.dispose();
    }
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code, output).toBe(0);
    expect(child, output).toMatchObject({ exitCode: 0, signalCode: null });
    expect(output).toContain("5 passed");
  });
  context.onTestFinished(() => run);
  return run;
});
