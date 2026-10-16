import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import * as ioBudget from "./update-candidate-io.js";
import { prepareUpdateCandidateStateSnapshot } from "./update-candidate-snapshot.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await fs.realpath(directories.make("snapshot-io-progress-"));
  const stateDir = path.join(root, "state");
  const candidateRoot = path.join(root, "candidate");
  const plugin = path.join(stateDir, "extensions", "demo");
  await fs.mkdir(plugin, { recursive: true });
  await fs.mkdir(candidateRoot);
  await fs.writeFile(path.join(candidateRoot, "package.json"), '{"name":"openclaw"}');
  await materializeUpdateCandidateStateWorker(candidateRoot);
  await fs.writeFile(
    path.join(plugin, "package.json"),
    JSON.stringify({ name: "demo", type: "module", openclaw: { extensions: ["./index.js"] } }),
  );
  await fs.writeFile(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({ id: "demo", configSchema: { type: "object" } }),
  );
  await fs.writeFile(path.join(plugin, "index.js"), 'export default { id: "demo" };');
  return {
    root,
    stateDir,
    candidateRoot,
    config: { plugins: { load: { paths: [plugin] } } },
    env: {
      ...process.env,
      HOME: root,
      TMPDIR: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  };
}

it("feeds actual inventory and copying receipts to the reported-progress watchdog", async () => {
  const f = await fixture();
  const reports: Array<ReturnType<typeof vi.fn>> = [];
  const budget = vi
    .spyOn(ioBudget, "withUpdateCandidateIoBudget")
    .mockImplementation(async (params, run) => {
      expect(params.progress).toBe("reported");
      const report = vi.fn();
      reports.push(report);
      return run(params.signal ?? new AbortController().signal, report);
    });
  const snapshot = await prepareUpdateCandidateStateSnapshot({
    ...f,
    workerEnv: (directory) => ({ ...f.env, ...buildUpdateRehearsalPathEnv(directory) }),
  });
  try {
    expect(budget).toHaveBeenCalledTimes(2);
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      // This fixture has no SQLite database: only completed plugin I/O can advance it.
      expect(report).toHaveBeenCalled();
    }
  } finally {
    for (const directory of snapshot.cleanupDirectories) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

it.each([false, true])(
  "emits entry receipts only for a parent that opts in (enabled=%s)",
  async (enabled) => {
    const f = await fixture();
    const targetStateDir = path.join(f.root, "private");
    const result = await runUtf8CommandWithTimeout(
      [
        process.execPath,
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
        ),
      ],
      {
        input: JSON.stringify({
          mode: "inventory",
          stateDir: f.stateDir,
          candidateRoot: f.candidateRoot,
          targetStateDir,
          config: f.config,
          env: f.env,
          streamProgress: true,
          ...(enabled ? { streamEntryProgress: true } : {}),
        }),
        baseEnv: { ...f.env, ...buildUpdateRehearsalPathEnv(targetStateDir) },
        timeoutMs: 30_000,
        maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr.includes('"completedIo"')).toBe(enabled);
    expect(JSON.parse(result.stdout)).toHaveProperty("pluginPlan");
  },
);
