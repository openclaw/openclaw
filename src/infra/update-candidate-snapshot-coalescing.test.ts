import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commands from "../process/exec.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { prepareUpdateCandidateStateSnapshot } from "./update-candidate-snapshot.js";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("coalesces snapshot progress while its receipt is settling", async () => {
  const root = await fs.realpath(tempDirs.make("snapshot-progress-"));
  const worker = path.join(
    root,
    "dist",
    runtimeProcessEntrypoints.updateCandidateState.distWorkerPath,
  );
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(
    worker,
    `
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    for (let i = 0; i < 256; i++) {
      await new Promise((resolve, reject) => {
        process.stderr.write("State schema progress: " + JSON.stringify({phase: "copy-" + i, snapshot: {status: "copying", copiedPages: i + 1, totalPages: 256, elapsedMs: i + 1}}) + "\\n", (error) => error ? reject(error) : resolve());
      });
    }
    process.stdout.write(JSON.stringify(request.mode === "inventory"
      ? {databases: [], pluginBytes: 0, pluginPlan: "plugin-copy-plan.json"}
      : {versions: [], pluginPaths: {}}));
  `,
  );
  const receipt = createDeferred();
  const entered = createDeferred();
  const workerExited = createDeferred();
  const execute = commands.runUtf8CommandWithTimeout;
  vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(async (...args) => {
    try {
      return await execute(...args);
    } finally {
      workerExited.resolve();
    }
  });
  const observed: string[] = [];
  const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "source"), TMPDIR: root };
  const operation = prepareUpdateCandidateStateSnapshot({
    candidateRoot: root,
    stateDir: env.OPENCLAW_STATE_DIR,
    config: {},
    env,
    workerEnv: () => env,
    onProgress: async (step) => {
      observed.push(step.detail ?? "");
      if (observed.length === 1) {
        entered.resolve();
        await receipt.promise;
      }
    },
  });
  try {
    await entered.promise;
    await workerExited.promise;
    expect(observed).toHaveLength(1);
  } finally {
    receipt.resolve();
    const snapshot = await operation;
    for (const directory of snapshot.cleanupDirectories) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  expect(observed.some((detail) => detail.includes("copy-255"))).toBe(true);
});
