import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let base: string;
let root: string;

beforeAll(async () => {
  base = tempDirs.make("openclaw-retained-runtime-exit-");
  root = path.join(base, "openclaw");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
  await fs.writeFile(path.join(root, "dist/updater.mjs"), "export {};\n");
});

afterEach(async () => {
  for (const name of await fs.readdir(base)) {
    if (name.startsWith("openclaw-update-runtime-")) {
      await fs.rm(path.join(base, name), { recursive: true, force: true });
    }
  }
});

// Each case must exit a real process: in-process signal/exit mocks cannot prove
// that the owner retires its projection before the operating system ends it.
it.skipIf(process.platform === "win32").each([
  { exit: "SIGTERM", code: 143 },
  { exit: "SIGINT", code: 130 },
  { exit: "failure-report", code: 1 },
  { exit: "stalled-close-success", code: 0 },
  { exit: "stalled-close-failure", code: 7 },
  { exit: "stalled-close-late", code: 7 },
  { exit: "stalled-close-pending", code: 0 },
  { exit: "stalled-close-nonzero-pending", code: 7, recordedCode: 0, pendingCode: 7 },
  { exit: "stalled-close-failed-mutation", code: 1, recordedCode: 0, failure: "mutation" },
  { exit: "stalled-close-failed-recovery", code: 1, recordedCode: 0, failure: "recovery" },
  { exit: "stalled-close-failed-recovery-nonzero", code: 7, failure: "recovery" },
  { exit: "stalled-close-failed-recovery-pending", code: 1, recordedCode: 0, failure: "recovery" },
  { exit: "removal-in-flight", code: 0 },
  { exit: "removal-in-flight-error", code: 0 },
])(
  "settles or preserves the retained runtime before $exit exits",
  async ({ exit, code, recordedCode = code, pendingCode = recordedCode, failure }) => {
    const result = spawnNodeEvalSync(
      `import fs from "node:fs/promises";
     import path from "node:path";
     import assert from "node:assert/strict";
     import { mock } from "node:test";
     import { pathToFileURL } from "node:url";
     import { MessageChannel } from "node:worker_threads";
     import { withRetainedUpdateRuntime } from ${JSON.stringify(new URL("./update-retained-runtime.ts", import.meta.url).href)};
     import { installCliSignalExitHandlers, registerSignalExitGate, registerSignalExitBarrier, exitAfterSignalExitBarriers } from ${JSON.stringify(new URL("../cli/signal-exit-barrier.ts", import.meta.url).href)};
     import { exitCliAfterOutput, runCliWithExitFinalization, watchCliExitAfterOutput } from ${JSON.stringify(new URL("../cli/one-shot-exit.ts", import.meta.url).href)};
     import { defaultRuntime } from ${JSON.stringify(new URL("../runtime.ts", import.meta.url).href)};
     import { captureRuntimeWorkerSource } from ${JSON.stringify(new URL("./runtime-worker-generation.ts", import.meta.url).href)};
     const root = ${JSON.stringify(root)};
     const outcome = ${JSON.stringify(exit)};
     const failure = ${JSON.stringify(failure ?? null)};
     installCliSignalExitHandlers();
     await runCliWithExitFinalization({
       run: () => withRetainedUpdateRuntime(pathToFileURL(path.join(root, "dist/updater.mjs")).href, async (retain) => {
         await retain({ mutationRoots: [root], timeoutMs: 30000, assertCurrent() {} });
         const retained = (await fs.readdir(path.dirname(root))).filter(name => name.startsWith("openclaw-update-runtime-"));
         process.stdout.write(JSON.stringify({ retained }) + "\\n");
         if (outcome.startsWith("removal-in-flight")) {
           const directory = path.join(path.dirname(root), retained[0]);
           const first = path.join(directory, "first-to-remove");
           await fs.writeFile(first, "synthetic partial-removal marker");
           const remove = fs.rm.bind(fs);
           mock.method(fs, "rm", async (target, options) => {
             if (target !== directory) return await remove(target, options);
             await remove(first);
             mock.timers.enable({ apis: ["setTimeout"] });
             watchCliExitAfterOutput(${JSON.stringify(recordedCode)}, () => {});
             mock.timers.tick(10000);
             await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
             if (outcome.endsWith("-error")) {
               process.stdout.write("REMOVAL_SETTLED_WITH_ERROR\\n");
               throw new Error("Synthetic removal failure");
             }
             await remove(target, options);
             process.stdout.write("REMOVAL_COMPLETED\\n");
           });
           return;
         }
         if (outcome.startsWith("stalled-close")) {
           const directory = path.join(path.dirname(root), retained[0]);
           let releaseBarrier;
           const late = outcome === "stalled-close-late";
           if (late) registerSignalExitBarrier(() => new Promise(resolve => { releaseBarrier = resolve; }));
           let rejectOwner;
           if (failure === "mutation") {
             registerSignalExitGate(new Promise((_, reject) => { rejectOwner = reject; }));
           } else if (failure === "recovery") {
             registerSignalExitBarrier(() => new Promise((_, reject) => { rejectOwner = reject; }));
           }
           const { runtimeGeneration } = captureRuntimeWorkerSource(pathToFileURL(path.join(root, "dist/updater.mjs")));
           assert(runtimeGeneration);
           runtimeGeneration.retain({}, () => new Promise(resolve => {
             mock.timers.enable({ apis: ["setTimeout"] });
             let stalled = false;
             process.exitCode = 91; // unrelated cleanup status cannot replace the recorded outcome
             if (outcome.endsWith("-pending")) exitAfterSignalExitBarriers(${JSON.stringify(pendingCode)});
             watchCliExitAfterOutput(${JSON.stringify(recordedCode)}, () => { stalled = true; });
             mock.timers.tick(9999);
             assert.equal(stalled, false);
             mock.timers.tick(1);
             assert.equal(stalled, true);
             setImmediate(async () => {
               if (failure) {
                 assert((await fs.stat(directory)).isDirectory());
                 assert(rejectOwner, "maintenance owner must still be awaited after the watchdog");
                 process.stderr.write("Synthetic maintenance failure\\n");
                 rejectOwner(new Error("Synthetic maintenance failure"));
               }
               if (late) {
                 assert((await fs.stat(directory)).isDirectory());
                 resolve();
                 await new Promise(done => setImmediate(done));
                 assert((await fs.stat(directory)).isDirectory(), "late settlement must not delete the retained runtime");
                 assert(releaseBarrier, "maintenance barrier must still be awaited");
                 releaseBarrier();
               }
               setImmediate(() => { process.stderr.write("WATCHDOG_DID_NOT_EXIT"); process.exit(99); });
             });
           }));
           return;
         }
         if (outcome === "failure-report") {
           defaultRuntime.error("Update failure reported");
           exitCliAfterOutput(defaultRuntime, 1);
         }
         const { port1 } = new MessageChannel();
         port1.on("message", () => {});
         process.kill(process.pid, outcome);
         await new Promise(() => {});
       }),
       onError(error) { process.stderr.write("Unexpected error: " + String(error)); process.exitCode = 2; },
     });`,
      {
        imports: [import.meta.resolve("tsx")],
        input: "",
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          HOME: base,
          TMPDIR: base,
          OPENCLAW_STATE_DIR: path.join(base, "state"),
          OPENCLAW_CONFIG_PATH: path.join(base, "state/openclaw.json"),
          XDG_CACHE_HOME: path.join(base, "cache"),
          OPENCLAW_LOG_LEVEL: exit === "removal-in-flight-error" ? "warn" : "silent",
        },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(code);
    expect(result.signal, result.stderr).toBeNull();
    if (failure) {
      expect(result.stderr).toContain("Synthetic maintenance failure");
    }
    expect(result.stdout).toMatch(/"retained":\["openclaw-update-runtime-[A-Za-z0-9]{6}"\]/u);
    if (exit === "failure-report") {
      expect(result.stderr).toContain("Update failure reported");
      expect(result.stderr).not.toContain("Unexpected error:");
    }
    const remaining = (await fs.readdir(base)).filter((name) =>
      name.startsWith("openclaw-update-runtime-"),
    );
    if (exit.startsWith("stalled-close")) {
      expect(remaining).toHaveLength(1);
      expect(result.stderr).toContain(`Runtime retained at ${path.join(base, remaining[0]!)}:`);
      expect(result.stderr).toContain("exit deadline");
    } else if (exit === "removal-in-flight-error") {
      expect(remaining).toHaveLength(1);
      expect(result.stdout).toContain("REMOVAL_SETTLED_WITH_ERROR");
      expect(result.stderr).toContain("cleanup failed: Synthetic removal failure");
      expect(result.stderr).not.toContain("exit deadline");
    } else {
      expect(remaining).toEqual([]);
      if (exit === "removal-in-flight") {
        expect(result.stdout).toContain("REMOVAL_COMPLETED");
        expect(result.stderr).not.toContain("exit deadline");
      }
    }
  },
);
