import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commands from "../process/exec.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import {
  prepareUpdateCandidateStateSnapshot,
  resolveUpdateCandidateAdmissionTimeoutMs,
} from "./update-candidate-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

async function fixture() {
  const root = await fs.realpath(tempDirs.make("snapshot-watchdog-"));
  const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "source"), TMPDIR: root };
  const dist = path.join(root, "dist");
  const worker = path.join(dist, runtimeProcessEntrypoints.updateCandidateState.distWorkerPath);
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  return { root, env, worker };
}

function observeWorker() {
  const exited = createDeferred();
  const execute = commands.runUtf8CommandWithTimeout;
  vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation((argv, options) =>
    execute(argv, options).finally(() => exited.resolve()),
  );
  return { exited };
}

it("coalesces snapshot progress while its receipt is settling", async () => {
  const { root, env, worker } = await fixture();
  await fs.writeFile(
    worker,
    `
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    // Buffer the burst so a full nonblocking stderr pipe cannot truncate it.
    for (let i = 0; i < 256; i++) {
      process.stderr.write("State schema progress: " + JSON.stringify({phase: "copy-" + i}) + "\\n");
    }
    process.stdout.write(JSON.stringify(request.mode === "inventory"
      ? {databases: [], pluginBytes: 0, pluginPlan: "plugin-copy-plan.json"}
      : {versions: [], pluginPaths: {}}));
  `,
  );
  const receipt = createDeferred();
  const entered = createDeferred();
  const { exited } = observeWorker();
  const observed: string[] = [];
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
    await exited.promise;
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

it("sizes candidate admission to measured state within the update step deadline", async () => {
  const stateDir = await fs.realpath(tempDirs.make("admission-budget-"));
  const database = path.join(stateDir, "state/openclaw.sqlite");
  const params = { config: {}, stateDir, env: { OPENCLAW_STATE_DIR: stateDir } };
  await fs.mkdir(path.dirname(database), { recursive: true });
  await fs.writeFile(database, "");
  await fs.truncate(database, 3 * 1024 ** 3);
  const budget = (stepTimeoutMs: number) =>
    resolveUpdateCandidateAdmissionTimeoutMs({ ...params, stepTimeoutMs });
  expect(await budget(Number.MAX_SAFE_INTEGER)).toBeGreaterThan(300_000);
  expect(await budget(1_800_000)).toBe(1_800_000);
});
