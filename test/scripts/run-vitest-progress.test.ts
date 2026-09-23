import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it, vi } from "vitest";
import * as managedChild from "../../scripts/lib/managed-child-process.mts";
import { resolveVitestCliEntry } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { resolveVitestSpawnParams, spawnWatchedVitestProcess } from "../../scripts/run-vitest.mts";
import { forceKillVitestProcessGroup } from "../../scripts/vitest-process-group.mts";
import { isProcessAlive } from "../helpers/process-wait.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createControlledWorkerCompiler } from "./vitest-worker-artifacts.test-support.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixDescribe = process.platform === "win32" ? describe.skip : describe.concurrent;
const posixSerialDescribe = process.platform === "win32" ? describe.skip : describe;
const ioTimeoutMs = 15_000;
const silenceMs = 1_000;

async function waitForRealIo(ready: () => boolean, description: string) {
  const deadline = Date.now() + ioTimeoutMs;
  while (!ready()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await delay(5);
  }
}

posixDescribe.each([false, true])(
  "keeps real case progress alive across watchdog windows, then stall=%s",
  (stall) => {
    const tempDirs = useAutoCleanupTempDirTracker(afterEach);
    it("reports the expected outcome and stops its process group", async ({ expect }) => {
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
const index = ${index};
it("real progress " + index, async () => {
  const ready = ${JSON.stringify(root)} + "/ready-" + index;
  fs.writeFileSync(ready + ".tmp", String(process.pid));
  fs.renameSync(ready + ".tmp", ready);
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
      watched.child.stdout!.on("data", (chunk: string) => {
        output += chunk;
      });
      watched.child.stderr!.on("data", (chunk: string) => {
        output += chunk;
      });
      const casePassed = (index: number) =>
        output
          .split("\n")
          .some((line) => line.includes("✓") && line.includes(` > real progress ${index} `));
      let workerPid: number | undefined;
      try {
        for (let index = 0; index < 4; index++) {
          const readyPath = path.join(root, `ready-${index}`);
          await waitForRealIo(() => fs.existsSync(readyPath), `case ${index} readiness\n${output}`);
          workerPid = Number(fs.readFileSync(readyPath, "utf8"));
          clock.tick(600);
          expect(onNoOutputTimeout, output).not.toHaveBeenCalled();
          fs.writeFileSync(path.join(root, `release-${index}`), "");
          // File barriers never enter the watched pipes. Only Vitest's completed
          // case output can reset the watchdog before the next 600ms advance.
          await waitForRealIo(
            () => casePassed(index),
            `Vitest completion for case ${index}\n${output}`,
          );
        }
        await waitForRealIo(
          () => fs.existsSync(path.join(root, "ready-4")),
          "final case readiness",
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
        const result = await watched.completion;
        // Vitest's logger handles SIGTERM and exits with 128 + 15, rather than
        // leaving Node to report a signal-only exit (as a bare silent child does).
        expect(result, output).toEqual({ code: stall ? 143 : 0, signal: null, groupJoined: true });
        expect(casePassed(4)).toBe(!stall);
        expect(isProcessAlive(watched.child.pid!)).toBe(false);
        expect(isProcessAlive(workerPid!)).toBe(false);
      } finally {
        watched.teardown();
        forceKillVitestProcessGroup(watched.child);
        await withTestTimeout(watched.completion, ioTimeoutMs, "owned Vitest group did not stop");
      }
    });
  },
);

posixSerialDescribe("compiled subprocess preparation progress", { concurrent: false }, () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.for(["valid", "tampered"] as const)(
    "counts accepted and verified work without hiding a later stall (%s)",
    async (verification, { expect }) => {
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
        let ready = false;
        let duplicates = 0;
        const replies: unknown[] = [];
        let output = "";
        handle.child.on("message", (message: unknown) => {
          if (!message || typeof message !== "object" || !("event" in message)) {
            return;
          }
          if (message.event === "ready") {
            ready = true;
          }
          if (message.event === "duplicate") {
            duplicates += 1;
          }
          if (message.event === "reply") {
            replies.push(message);
          }
        });
        handle.child.stdout!.on("data", (chunk: string) => {
          output += chunk;
        });
        handle.child.stderr!.on("data", (chunk: string) => {
          output += chunk;
        });
        const duplicate = async () => {
          const expected = duplicates + 1;
          handle.child.send("duplicate");
          await waitForRealIo(() => duplicates === expected, "duplicate borrower IPC delivery");
        };
        await waitForRealIo(() => ready, "native borrower readiness");
        clock.tick(100_000);
        handle.child.send("request");
        await withTestTimeout(compilerStarted.promise, ioTimeoutMs, "compiler admission");
        clock.tick(100_000);
        // No watched pipe output exists: only accepted owner work can keep
        // this real borrower alive past its original 120-second deadline.
        expect(output).toBe("");
        expect(onNoOutputTimeout).not.toHaveBeenCalled();
        expect(isProcessAlive(handle.child.pid!)).toBe(true);
        await duplicate();
        releaseCompiler.resolve();
        await withTestTimeout(verificationStarted.promise, ioTimeoutMs, "artifact verification");
        expect(controlled.read()).toHaveLength(1);
        clock.tick(10_000);
        expect(onNoOutputTimeout).not.toHaveBeenCalled();
        if (verification === "tampered") {
          fs.appendFileSync(heldOutput, "\nchanged after compilation\n");
        }
        releaseVerification.resolve();
        await waitForRealIo(() => replies.length === 1, "verified borrower reply");
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
        const result = await withTestTimeout(
          handle.completion,
          ioTimeoutMs,
          "timed-out borrower join",
        );
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
            await withTestTimeout(watched.completion, ioTimeoutMs, "borrower cleanup");
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
    },
  );
});
