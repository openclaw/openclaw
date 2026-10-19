/* @vitest-environment node */
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";
import { createVitestWorkerRun } from "../scripts/lib/vitest-worker-run.mts";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { runVitestShutdownCommand } from "./helpers/vitest-shutdown-command.ts";
import { responsesProducerFixtureFiles } from "./non-isolated-runner.responses-fixtures.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("VITEST") &&
        !key.startsWith("OPENCLAW_VITEST") &&
        key !== "GITHUB_ACTIONS",
    ),
  );
}

async function verifyResponsesProducerSettlement(signal: AbortSignal): Promise<void> {
  const fixtureRoots = path.join(repoRoot, ".artifacts", "non-isolated-runner-responses");
  await fs.mkdir(fixtureRoots, { recursive: true });
  // openclaw-temp-dir: allow retains failed child-runner fixtures for diagnosis.
  const root = await fs.mkdtemp(path.join(fixtureRoots, "run-"));
  try {
    const vitestPackageDir = path.dirname(require.resolve("vitest/package.json"));
    await fs.symlink(path.dirname(vitestPackageDir), path.join(root, "node_modules"), "junction");
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
    const workers = createVitestWorkerRun(childEnv());
    let result: Awaited<ReturnType<typeof runVitestShutdownCommand>>;
    try {
      result = await runVitestShutdownCommand({
        bin: resolveTestNodeExecPath(),
        args: [
          path.join(vitestPackageDir, "vitest.mjs"),
          "run",
          "--root",
          root,
          "--config",
          path.join(root, "vitest.config.ts"),
          "--configLoader",
          "runner",
          "--reporter=verbose",
        ],
        cwd: repoRoot,
        env: childEnv(),
        workerRun: workers,
        maxBytes: 4 * 1024 * 1024,
        signal,
        onReady(owned) {
          child = owned;
        },
      });
    } finally {
      await workers.dispose();
    }
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code, output).toBe(0);
    expect(child.exitCode, output).toBe(0);
    expect(child.signalCode, output).toBeNull();
    expect(output).toContain("5 passed");
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error) {
      error.message += `; retained fixture ${root}`;
    }
    throw error;
  }
}

it("settles a real Responses producer before the next non-isolated file loads", (context) => {
  const run = verifyResponsesProducerSettlement(context.signal);
  context.onTestFinished(() => run);
  return run;
});
