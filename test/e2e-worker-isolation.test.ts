import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { createVitestWorkerRun } from "../scripts/lib/vitest-worker-run.mts";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { runVitestShutdownCommand } from "./helpers/vitest-shutdown-command.ts";
import { withRunnerFixture } from "./non-isolated-runner.fixture-support.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

it("starts the next E2E file after an abandoned Gateway metadata close", (context) => {
  const run = withRunnerFixture("e2e-worker-isolation", async ({ root, args, env }) => {
    const source = (file: string) => JSON.stringify(path.join(repoRoot, "src", file));
    const imports = `import { expect, it } from "vitest";
import { retainGatewayPluginMetadata } from ${source("plugins/plugin-metadata-lifecycle.ts")};
import { createTestGatewayScheduler } from ${source("test-utils/gateway-scheduler-clock.ts")};
`;
    await fs.writeFile(
      path.join(root, "a-abandoned-close.test.ts"),
      `${imports}
it("leaves metadata closing as an abandoned test would", async () => {
  let entered!: () => void;
  const closing = new Promise<void>((resolve) => { entered = resolve; });
  const owner = retainGatewayPluginMetadata(createTestGatewayScheduler(), async () => {
    entered();
    await new Promise<void>(() => {});
  });
  void owner.close();
  await closing;
  expect(() => retainGatewayPluginMetadata(createTestGatewayScheduler())).toThrow(
    "Gateway plugin metadata is shutting down",
  );
});
`,
    );
    await fs.writeFile(
      path.join(root, "b-next-gateway.test.ts"),
      `${imports}
it("starts and closes the next Gateway metadata owner", async () => {
  const scheduler = createTestGatewayScheduler();
  const owner = retainGatewayPluginMetadata(scheduler);
  expect((await owner.close()).failures).toEqual([]);
  await scheduler.stop();
});
`,
    );
    await fs.writeFile(
      path.join(root, "vitest.config.ts"),
      `import e2e from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.e2e.config.ts"))};
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
class Ordered extends BaseSequencer {
  async sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
export default defineConfig({
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  plugins: e2e.plugins,
  resolve: e2e.resolve,
  test: {
    pool: e2e.test.pool,
    isolate: e2e.test.isolate,
    runner: e2e.test.runner,
    execArgv: e2e.test.execArgv,
    // Reuse one worker on the base so the producer must precede the observer.
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { sequencer: Ordered },
    include: ["a-abandoned-close.test.ts", "b-next-gateway.test.ts"],
  },
});
`,
    );
    const reportPath = path.join(root, "report.json");
    const workers = createVitestWorkerRun(env);
    try {
      const result = await runVitestShutdownCommand({
        bin: resolveTestNodeExecPath(),
        args: [...args, "--reporter=json", `--outputFile.json=${reportPath}`],
        cwd: repoRoot,
        env,
        workerRun: workers,
        maxBytes: 4 * 1024 * 1024,
        signal: context.signal,
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const report: JsonTestResults = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(report).toMatchObject({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0 });
    } finally {
      await workers.dispose();
    }
  });
  context.onTestFinished(() => run);
  return run;
});
