import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, it, vi, type TestContext } from "vitest";
import * as managedChild from "../../scripts/lib/managed-child-process.mts";
import { resolveVitestCliEntry } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { resolveVitestSpawnParams, spawnWatchedVitestProcess } from "../../scripts/run-vitest.mts";
import { forceKillVitestProcessGroup } from "../../scripts/vitest-process-group.mts";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createControlledWorkerCompiler } from "./vitest-worker-artifacts.test-support.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixDescribe = process.platform === "win32" ? describe.skip : describe.concurrent;
const posixSerialDescribe = process.platform === "win32" ? describe.skip : describe;
const silenceMs = 1_000;
let receipts: FixtureReceiptChannel;
const progressBodies = new WeakMap<TestContext, Promise<void>>();

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

function joinedProgressTest(body: (context: TestContext) => Promise<void>) {
  return (context: TestContext) => {
    // Timeout aborts the wait; the finish hook also owns the asynchronous finally.
    const run = Promise.resolve().then(() => {
      context.signal.throwIfAborted();
      return body(context);
    });
    progressBodies.set(context, run);
    context.onTestFinished(() => run);
    return run;
  };
}

function cleanupAfterProgressBody(cleanup: () => void) {
  afterEach(async (context) => {
    // Vitest runs afterEach before onTestFinished; retained writers must join first.
    await Promise.allSettled([progressBodies.get(context)]);
    cleanup();
  });
}

function fixtureReadyBeforeSettlement(
  readyPath: string,
  operation: PromiseLike<unknown>,
  description: string,
) {
  // The worker publishes its PID before reporting readiness. Receipt delivery
  // can trail completion on the independently owned output pipes.
  const settled = Promise.resolve(operation).then(
    () => {
      if (!fs.existsSync(readyPath)) {
        throw new Error(`Timed out waiting for ${description}`);
      }
    },
    (error: unknown) => {
      if (!fs.existsSync(readyPath)) {
        throw error;
      }
    },
  );
  return Promise.race([receipts.waitFor(readyPath, "ready"), settled]);
}

posixDescribe.each([false, true])(
  "keeps real case progress alive across watchdog windows, then stall=%s",
  (stall) => {
    const tempDirs = useAutoCleanupTempDirTracker(cleanupAfterProgressBody);
    const testProgress = joinedProgressTest(async ({ expect, signal }) => {
      const root = tempDirs.make("oc-vt-progress-");
      fs.symlinkSync(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      const configPath = path.join(root, "vitest.config.mjs");
      // Vitest can batch a case result until later task activity. A file boundary
      // explicitly flushes updates, so waiting for its case line cannot deadlock
      // against the next case's release barrier.
      for (let index = 0; index < 5; index++) {
        fs.writeFileSync(
          path.join(root, `progress-${index}.test.ts`),
          `import fs from "node:fs";
import { expect, it } from "vitest";
import { waitForFile } from ${JSON.stringify(path.join(repoRoot, "test/helpers/process-wait.ts"))};
${fixtureReceiptClientSource(receipts.endpoint)}
const index = ${index};
it("real progress " + index, async () => {
  const ready = ${JSON.stringify(root)} + "/ready-" + index;
  fs.writeFileSync(ready + ".tmp", String(process.pid));
  fs.renameSync(ready + ".tmp", ready);
  sendReceipt(ready, "ready");
  await waitForFile(${JSON.stringify(root)} + "/release-" + index, 15000);
  expect(index).toBeLessThan(5);
});
`,
        );
      }
      fs.writeFileSync(
        configPath,
        `import tooling from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.tooling.config.ts"))};
import { BaseSequencer } from "vitest/node";
class OrderedFixtures extends BaseSequencer {
  async sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
export default {
  ...tooling,
  root: ${JSON.stringify(root)},
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  test: {
    ...tooling.test, dir: ${JSON.stringify(root)}, include: ["progress-*.test.ts"], maxWorkers: 1,
    // Pure Vitest fixtures need no OpenClaw environment setup or shared-state runner.
    setupFiles: [], runner: undefined,
    reporters: ["verbose", ${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-resource-reporter.mts"))}],
    sequence: { ...tooling.test.sequence, sequencer: OrderedFixtures },
  },
};
`,
      );
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("VITEST") || key.startsWith("OPENCLAW_")) {
          delete env[key];
        }
      }
      Object.assign(env, {
        AI_AGENT: "vitest-progress-test",
        GITHUB_ACTIONS: "false",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "module-cache"),
        OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: String(silenceMs),
        OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "400",
        OPENCLAW_UI_E2E_DIAGNOSTIC_DIR: path.join(root, "diagnostics"),
      });

      // Register and uninstall without awaiting so each watchdog captures its
      // own Sinon clock. Transport, readiness, diagnostics and process-group
      // joins must use real timers while the watchdog retains its fake clock.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { clock } = setTimeout as typeof setTimeout & { clock: { tick(ms: number): void } };
      const onNoOutputTimeout = vi.fn();
      let watched: ReturnType<typeof spawnWatchedVitestProcess>;
      try {
        watched = spawnWatchedVitestProcess({
          pnpmArgs: [
            "exec",
            "node",
            ...resolveVitestNodeArgs(env),
            resolveVitestCliEntry(),
            "run",
            "--config",
            configPath,
          ],
          spawnParams: { cwd: repoRoot, ...resolveVitestSpawnParams(env) },
          env,
          onNoOutputTimeout,
        });
      } finally {
        vi.useRealTimers();
      }
      let output = "";
      const caseCompletions = Array.from({ length: 5 }, () => createDeferred());
      const casePassed = (index: number) =>
        output
          .split("\n")
          .some((line) => line.includes("✓") && line.includes(` > real progress ${index} `));
      const observeOutput = (chunk: string) => {
        output += chunk;
        for (const [index, completion] of caseCompletions.entries()) {
          if (casePassed(index)) {
            completion.resolve();
          }
        }
      };
      watched.child.stdout!.on("data", observeOutput);
      watched.child.stderr!.on("data", observeOutput);
      let workerPid: number | undefined;
      try {
        for (let index = 0; index < 4; index++) {
          const readyPath = path.join(root, `ready-${index}`);
          await withinTest(
            fixtureReadyBeforeSettlement(
              readyPath,
              watched.completion,
              `case ${index} readiness\n${output}`,
            ),
            signal,
          );
          workerPid = Number(fs.readFileSync(readyPath, "utf8"));
          clock.tick(600);
          expect(onNoOutputTimeout, output).not.toHaveBeenCalled();
          fs.writeFileSync(path.join(root, `release-${index}`), "");
          // File barriers never enter the watched pipes. Only Vitest's completed
          // case output can reset the watchdog before the next 600ms advance.
          await withinTest(
            awaitGateBeforeSettlement(
              caseCompletions[index]!.promise,
              watched.completion,
              `Timed out waiting for Vitest completion for case ${index}\n${output}`,
            ),
            signal,
          );
        }
        await withinTest(
          fixtureReadyBeforeSettlement(
            path.join(root, "ready-4"),
            watched.completion,
            "final case readiness",
          ),
          signal,
        );
        expect(isProcessAlive(watched.child.pid!)).toBe(true);
        expect(onNoOutputTimeout).not.toHaveBeenCalled();
        if (stall) {
          clock.tick(silenceMs - 1);
          expect(onNoOutputTimeout).not.toHaveBeenCalled();
          clock.tick(1);
          expect(onNoOutputTimeout).toHaveBeenCalledOnce();
        } else {
          fs.writeFileSync(path.join(root, "release-4"), "");
        }
        const result = await withinTest(watched.completion, signal);
        // Vitest's logger handles SIGTERM and exits with 128 + 15, rather than
        // leaving Node to report a signal-only exit (as a bare silent child does).
        expect(result, output).toEqual({ code: stall ? 143 : 0, signal: null, groupJoined: true });
        expect(casePassed(4)).toBe(!stall);
        expect(isProcessAlive(watched.child.pid!)).toBe(false);
        expect(isProcessAlive(workerPid!)).toBe(false);
        const reports = fs.readdirSync(path.join(root, "diagnostics"));
        expect(reports).toHaveLength(1);
        const diagnostic = JSON.parse(
          fs.readFileSync(
            path.join(root, "diagnostics", reports[0]!, "failure.public.json"),
            "utf8",
          ),
        );
        expect(diagnostic.kind).toBe("vitest-progress");
        if (stall) {
          expect(diagnostic.active).toEqual([
            expect.objectContaining({
              file: "progress-4.test.ts",
              project: "tooling",
              pool: "threads",
            }),
          ]);
        } else {
          expect(diagnostic).toMatchObject({ reason: "passed", active: [] });
        }
      } finally {
        watched.teardown();
        forceKillVitestProcessGroup(watched.child);
        await watched.completion;
      }
    });
    it("reports the expected outcome and stops its process group", testProgress);
  },
);

posixSerialDescribe("compiled subprocess preparation progress", { concurrent: false }, () => {
  const tempDirs = useAutoCleanupTempDirTracker(cleanupAfterProgressBody);

  const testPreparation = (verification: "valid" | "tampered") =>
    joinedProgressTest(async ({ expect, signal }) => {
      const directory = tempDirs.make("oc-vt-preparation-progress-");
      const env = {
        ...process.env,
        OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "120000",
        OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
      };
      const controlled = createControlledWorkerCompiler(directory, env);
      const owner = createVitestWorkerRun(env);
      const generation = owner.descriptor.directory;
      const heldOutput = path.join(generation, "dist/infra/runtime-process-entrypoints.js");
      const compilerStarted = createDeferred();
      const releaseCompiler = createDeferred();
      const verificationStarted = createDeferred();
      const releaseVerification = createDeferred();
      const runManaged = managedChild.runManagedCommand;
      const compilerLaunch = vi
        .spyOn(managedChild, "runManagedCommand")
        .mockImplementation(async (options) => {
          if (
            options.args?.[0] !== path.join(repoRoot, "scripts/lib/vitest-worker-compiler.mts") ||
            options.args[1] !== generation
          ) {
            return runManaged(options);
          }
          compilerStarted.resolve();
          await releaseCompiler.promise;
          return runManaged({ ...options, args: controlled.args(generation) });
        });
      const readFile = fs.promises.readFile.bind(fs.promises);
      const verificationRead = vi
        .spyOn(fs.promises, "readFile")
        .mockImplementation(async (...args) => {
          if (args[0] === heldOutput) {
            verificationStarted.resolve();
            await releaseVerification.promise;
          }
          return readFile(...args);
        });
      const borrower = path.join(directory, "vitest.mjs");
      fs.writeFileSync(
        borrower,
        `import {requestVitestWorkerArtifacts,VITEST_WORKER_PREPARE_REQUEST} from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/lib/vitest-worker-artifacts.mts")).href)};
setInterval(() => {}, 1000);
process.once("SIGTERM", () => process.exit(0));
process.on("message", (message) => {
  if (message === "request") {
    void requestVitestWorkerArtifacts().then(
      () => process.send({event:"reply",ok:true}),
      (error) => process.send({event:"reply",ok:false,error:error.message}),
    );
  } else if (message === "duplicate") {
    process.send(VITEST_WORKER_PREPARE_REQUEST, () => process.send({event:"duplicate"}));
  }
});
process.send({event:"ready"});
`,
      );
      const onNoOutputTimeout = vi.fn();
      let watched: ReturnType<typeof spawnWatchedVitestProcess> | undefined;
      let disposalFailure: unknown;
      try {
        // Capture only this watchdog's clock. Native IPC, compiler exit, artifact
        // verification, diagnostics and process joins keep their real timers.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const { clock } = setTimeout as typeof setTimeout & { clock: { tick(ms: number): void } };
        try {
          watched = spawnWatchedVitestProcess({
            workerRun: owner,
            homeMode: "tooling",
            pnpmArgs: ["exec", "node", borrower],
            spawnParams: {
              cwd: repoRoot,
              env,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            },
            env,
            onNoOutputTimeout,
          });
        } finally {
          vi.useRealTimers();
        }
        const handle = watched;
        const ready = createDeferred();
        let duplicateAcknowledged = createDeferred();
        let duplicates = 0;
        const replied = createDeferred();
        const replies: unknown[] = [];
        let output = "";
        handle.child.on("message", (message: unknown) => {
          if (!message || typeof message !== "object" || !("event" in message)) {
            return;
          }
          if (message.event === "ready") {
            ready.resolve();
          }
          if (message.event === "duplicate") {
            duplicates += 1;
            duplicateAcknowledged.resolve();
          }
          if (message.event === "reply") {
            replies.push(message);
            replied.resolve();
          }
        });
        handle.child.stdout!.on("data", (chunk: string) => {
          output += chunk;
        });
        handle.child.stderr!.on("data", (chunk: string) => {
          output += chunk;
        });
        const waitForBorrower = (gate: PromiseLike<unknown>, description: string) =>
          withinTest(
            awaitGateBeforeSettlement(
              gate,
              handle.completion,
              `Timed out waiting for ${description}`,
            ),
            signal,
          );
        const duplicate = async () => {
          const expected = duplicates + 1;
          duplicateAcknowledged = createDeferred();
          handle.child.send("duplicate");
          await waitForBorrower(duplicateAcknowledged.promise, "duplicate borrower IPC delivery");
          expect(duplicates).toBe(expected);
        };
        await waitForBorrower(ready.promise, "native borrower readiness");
        clock.tick(100_000);
        handle.child.send("request");
        await waitForBorrower(compilerStarted.promise, "compiler admission");
        clock.tick(100_000);
        // No watched pipe output exists: only accepted owner work can keep
        // this real borrower alive past its original 120-second deadline.
        expect(output).toBe("");
        expect(onNoOutputTimeout).not.toHaveBeenCalled();
        expect(isProcessAlive(handle.child.pid!)).toBe(true);
        await duplicate();
        releaseCompiler.resolve();
        await waitForBorrower(verificationStarted.promise, "artifact verification");
        expect(controlled.read()).toHaveLength(1);
        clock.tick(10_000);
        expect(onNoOutputTimeout).not.toHaveBeenCalled();
        if (verification === "tampered") {
          fs.appendFileSync(heldOutput, "\nchanged after compilation\n");
        }
        releaseVerification.resolve();
        await waitForBorrower(replied.promise, "verified borrower reply");
        expect(replies).toHaveLength(1);
        expect(output).toBe("");
        if (verification === "valid") {
          expect(replies[0]).toEqual({ event: "reply", ok: true });
          clock.tick(60_000);
          await duplicate();
          clock.tick(59_999);
        } else {
          expect(replies[0]).toMatchObject({
            event: "reply",
            ok: false,
            error: expect.stringContaining("Compiled subprocess artifact changed"),
          });
          clock.tick(9_999);
        }
        expect(onNoOutputTimeout).not.toHaveBeenCalled();
        expect(fs.existsSync(generation)).toBe(true);
        clock.tick(1);
        expect(onNoOutputTimeout).toHaveBeenCalledOnce();
        const result = await withinTest(handle.completion, signal);
        expect(handle.child.exitCode).toBe(0);
        expect(result).toEqual({ code: 1, signal: null, groupJoined: true });
        expect(isProcessAlive(handle.child.pid!)).toBe(false);
      } finally {
        releaseCompiler.resolve();
        releaseVerification.resolve();
        try {
          if (watched) {
            watched.teardown();
            forceKillVitestProcessGroup(watched.child);
            await watched.completion;
          }
        } finally {
          try {
            await owner.dispose();
          } catch (error) {
            disposalFailure = error;
          } finally {
            verificationRead.mockRestore();
            compilerLaunch.mockRestore();
          }
        }
      }
      if (verification === "tampered") {
        expect(disposalFailure).toMatchObject({
          message: expect.stringContaining("Compiled subprocess artifact changed"),
        });
      } else {
        expect(disposalFailure).toBeUndefined();
      }
      expect(fs.existsSync(generation)).toBe(false);
    });
  it.for(["valid", "tampered"] as const)(
    "counts accepted and verified work without hiding a later stall (%s)",
    (verification, context) => testPreparation(verification)(context),
  );
});
