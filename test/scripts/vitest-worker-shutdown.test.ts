import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, vi } from "vitest";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import type { VitestWorkerManifest } from "../../scripts/lib/vitest-worker-artifacts.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createVitestProcessCompletion } from "../../scripts/vitest-process-group.mts";
import { isProcessAlive, waitForDead, waitForFixtureFile } from "../helpers/process-wait.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { fixturePreloadEnv } from "./fixtures/ci-fixture-runtime.cjs";
import {
  createWorkerArtifactTest,
  preparationClient,
  writeFixture,
} from "./vitest-worker-artifacts.test-support.js";

const it = createWorkerArtifactTest();
const repoRoot = path.resolve(import.meta.dirname, "../..");
type OwnerReceipt = { owner: number; borrower: number; generation: string };

const shutdownCases = [
  { route: "direct", phase: "disposal" },
  { route: "serial", phase: "disposal" },
  { route: "direct", phase: "admission" },
  { route: "direct", phase: "compilation" },
  { route: "serial", phase: "compilation" },
  { route: "ci", phase: "compilation" },
  { route: "ci-shared", phase: "compilation" },
  { route: "ci", phase: "admission" },
  { route: "ci", phase: "disposal" },
  { route: "ci-disconnect", phase: "disposal" },
  { route: "ci", phase: "deletion" },
  { route: "direct", phase: "deletion" },
  { route: "serial", phase: "deletion" },
] as const;

it
  .runIf(process.platform !== "win32")
  .for(
    shutdownCases.flatMap(({ route, phase }) =>
      (route === "ci-disconnect" ? (["SIGTERM"] as const) : (["SIGINT", "SIGTERM"] as const)).map(
        (shutdownSignal) => ({ route, phase, shutdownSignal }),
      ),
    ),
  )(
  "$route wrapper joins $phase work before honoring $shutdownSignal",
  ({ route, phase, shutdownSignal }, { workerArtifacts, signal, onTestFinished }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const expectedExitCode =
        route.startsWith("ci") && phase !== "deletion"
          ? 1
          : shutdownSignal === "SIGINT"
            ? 130
            : 143;
      const root = workerArtifacts.fixtureDirectory();
      const input = writeFixture(root, "input", "owned verification input");
      const released = path.join(root, "release");
      const ownerFile = path.join(root, "owner.json");
      const heldOwnerFile = path.join(root, "held-owner.json");
      const compilerFile = path.join(root, "compiler.json");
      const compilerBudget = path.join(root, "compiler-budget.json");
      const compiling = path.join(root, "compiler-ready");
      const compilerCanceled = path.join(root, "compiler-canceled");
      const admitted = path.join(root, "verification-ready");
      const borrowerClosed = path.join(root, "borrower-closed");
      const borrowerExit = path.join(root, "borrower-exit");
      const ownerIdle = path.join(root, "owner-idle");
      const loopRequest = path.join(root, "loop-request");
      const responsive = path.join(root, "loop-responsive");
      const disconnectRequested = path.join(root, "disconnect-requested");
      const abort = new AbortController();
      const release = () => fs.writeFileSync(released, "release");
      const compiler = writeFixture(
        root,
        "compiler.mjs",
        `
import fs from 'node:fs';
import path from 'node:path';
import {writeWorkerFixtureManifest} from ${JSON.stringify(new URL("./fixtures/vitest-worker-compiler.mjs", import.meta.url).href)};
const directory=process.argv[2];
fs.writeFileSync(${JSON.stringify(compilerBudget)},JSON.stringify([process.env.RAYON_NUM_THREADS,process.env.TOKIO_WORKER_THREADS]));
if(${JSON.stringify(phase)}==='compilation') {
  const canceled=await new Promise(resolve=>{
    const finish=canceled=>{
      if(canceled) fs.writeFileSync(${JSON.stringify(compilerCanceled)},'canceled');
      clearInterval(keepAlive);process.off('SIGTERM',stop);resolve(canceled);
    };
    const stop=()=>finish(true);
    const keepAlive=setInterval(()=>{
      if(${route === "ci-shared"} && fs.existsSync(${JSON.stringify(released)})) finish(false);
    },50);
    process.once('SIGTERM',stop);
    fs.writeFileSync(${JSON.stringify(compiling)},'ready');
  });
  if(canceled) process.exit(0);
}
writeWorkerFixtureManifest(directory, { [${JSON.stringify(input)}]: fs.readFileSync(${JSON.stringify(input)}) }, {
  'worker.js': 'export const fixture = true;',
});
`,
      );
      const borrower = writeFixture(
        root,
        "borrower.mjs",
        `
import fs from 'node:fs';
import {requestVitestWorkerArtifacts} from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/lib/vitest-worker-artifacts.mts")).href)};
const exitFile=${JSON.stringify(borrowerExit)};
const exitCheck=()=>{if(fs.existsSync(exitFile)) process.exit(1);};
let exitPoll;
if(${JSON.stringify(phase)}==='admission') {
  exitPoll=setInterval(exitCheck,50);
  exitCheck();
}
try {
  await requestVitestWorkerArtifacts();
  console.log('fixture borrower completed');
} catch(error) {
  console.error(error);process.exitCode=1;
} finally {clearInterval(exitPoll);process.disconnect();}
`,
      );
      const preload = writeFixture(
        root,
        "preload.mjs",
        `
import cp from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {syncFixtureBuiltinExports} from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
const root=${JSON.stringify(root)}, input=${JSON.stringify(input)};
// CI workspaces need not provide native directory notifications. Control-file
// readiness must remain observable without that optional filesystem facility.
const nativeWatch=fs.watch;
fs.watch=(directory,...args)=>{
  if(directory===root) throw new Error('Native fixture notifications unavailable');
  return nativeWatch(directory,...args);
};
const publish=(name,value)=>{
  const filename=path.join(root,name);
  fs.writeFileSync(filename+'.tmp',JSON.stringify(value));
  fs.renameSync(filename+'.tmp',filename);
};
const spawn=cp.spawn;
const phase=${JSON.stringify(phase)};
const ciRoot=process.argv[1]?.endsWith('ci-run-node-test-shard.mts');
let borrowerClosed=false, held=false, generation;
cp.spawn=(bin,args,options)=>{
  if(args[0]===${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-worker-compiler.mts"))}) {
    const child=spawn(bin,[${JSON.stringify(compiler)},args[1]],options);
    publish('compiler.json',{pid:child.pid});
    return child;
  }
  const bootstrap=args.indexOf(${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-worker-bootstrap.mts"))});
  if(bootstrap<0) return spawn(bin,args,options);
  // CI's intermediate project parent must remain real; replace only the Vitest leaf.
  if(path.basename(args[bootstrap+2])!=='vitest.mjs') {
    generation=args[bootstrap+1];
    if(phase==='deletion') publish('ci-owner.json',{pid:process.pid});
    return spawn(bin,args,options);
  }
  const child=spawn(bin,[${JSON.stringify(borrower)}],options);
  child.once('close',(code,signal)=>{borrowerClosed=true;publish('borrower-closed',{pid:child.pid,code,signal});});
  generation=args[bootstrap+1];
  const owner=${route === "ci" && phase === "deletion"} ? JSON.parse(fs.readFileSync(path.join(root,'ci-owner.json'),'utf8')).pid : process.pid;
  publish(process.env.OPENCLAW_VITEST_SHARD_NAME==='ci-held'?'held-owner.json':'owner.json',{owner,borrower:child.pid,generation});
  return child;
};
// Node can cache process.emit before a preload replaces it. Probe held I/O
// directly; adding a signal listener could rescue a broken wrapper instead.
const waitForRelease=()=>new Promise(resolve=>{
  let idle=false, responsive=false;
  const check=()=>{
    if(${route === "ci-disconnect"} && fs.existsSync(${JSON.stringify(disconnectRequested)})) {
      fs.unlinkSync(${JSON.stringify(disconnectRequested)});
      process.disconnect();
      // Observe a later loop turn, after the real owner-loss handler runs.
      return;
    }
    if(borrowerClosed && !idle) {idle=true;publish('owner-idle',{owner:process.pid});}
    if(!responsive && fs.existsSync(${JSON.stringify(loopRequest)})) {
      responsive=true;publish('loop-responsive',{owner:process.pid});
    }
    if(fs.existsSync(${JSON.stringify(released)})) {
      clearInterval(poll);
      resolve();
    }
  };
  // Poll state: watchFile's first successful stat can consume a control without notifying.
  const poll=setInterval(check,50);
  check();
});
const readFile=fsp.readFile;
fsp.readFile=async(filename,...args)=>{
  if(filename===input && !held && (!ciRoot || phase!=='admission') && (phase==='admission' || (phase==='disposal' && borrowerClosed))) {
    held=true;
    publish('verification-ready',{owner:process.pid});
    await waitForRelease();
  }
  return readFile(filename,...args);
};
// The same delayed deletion blocks synchronous callers but lets async callers
// process signals. Neither path may finish until the external fixture releases it.
const rm=fsp.rm, rmSync=fs.rmSync;
fsp.rm=async(filename,...args)=>{
  if(phase==='deletion' && filename===generation) {
    publish('verification-ready',{owner:process.pid});
    await waitForRelease();
  }
  return rm(filename,...args);
};
fs.rmSync=(filename,...args)=>{
  if(phase==='deletion' && filename===generation) {
    publish('verification-ready',{owner:process.pid});
    const wait=new Int32Array(new SharedArrayBuffer(4));
    while(!fs.existsSync(${JSON.stringify(released)})) Atomics.wait(wait,0,0,10);
  }
  return rmSync(filename,...args);
};
syncFixtureBuiltinExports(["node:child_process", "node:fs", "node:fs/promises"]);
`,
      );
      const config = writeFixture(root, "vitest.config.mjs", "export default {};\n");
      const args =
        route === "direct"
          ? ["scripts/run-vitest.mjs", "run", "--config", config]
          : route.startsWith("ci")
            ? ["--import", "./scripts/tsx.mjs", "scripts/ci-run-node-test-shard.mts"]
            : [
                "--import",
                "./scripts/tsx.mjs",
                "scripts/test-projects-serial.mts",
                "test/scripts/vitest-worker-shutdown.test.ts",
              ];
      // Keep the wrappers, IPC and process owners real; only expensive child
      // executables and one verification read or deletion are controlled by the fixture.
      const command = workerArtifacts.fixtureLifetime.track(
        runNodeScript(
          args,
          {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            TMPDIR: root,
            TMP: root,
            TEMP: root,
            ...(route.startsWith("ci")
              ? {
                  OPENCLAW_VITEST_MAX_WORKERS: "3",
                  RAYON_NUM_THREADS: "",
                  TOKIO_WORKER_THREADS: "",
                  OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
                    ["ci-shutdown", ...(route === "ci-shared" ? ["ci-held"] : [])].map(
                      (shard_name) => ({
                        configs: ["test/vitest/vitest.tooling.config.ts"],
                        includePatterns: ["test/scripts/vitest-worker-shutdown.test.ts"],
                        shard_name,
                        env: { OPENCLAW_VITEST_MAX_WORKERS: shard_name === "ci-held" ? "1" : "2" },
                      }),
                    ),
                  ),
                  OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: "",
                  OPENCLAW_NODE_TEST_TARGETS_JSON: "[]",
                  OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: "[]",
                  OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: route === "ci-shared" ? "2" : "1",
                }
              : {}),
            // runNodeScript owns every wrapper route, so its fixture preload is always a Node import.
            ...fixturePreloadEnv(preload, "node"),
          },
          20_000,
          {
            cwd: repoRoot,
            signal: AbortSignal.any([signal, abort.signal]),
            maxBuffer: 2 * 1024 * 1024,
            requireProcessTreeExit: true,
          },
        ),
      );
      onTestFinished(async () => {
        release();
        abort.abort();
        await command;
      });
      const waitForReceipt = (filename: string) =>
        withTestTimeout(
          waitForFixtureFile(filename, command),
          10_000,
          `Missing shutdown receipt: ${filename}`,
        );
      let owner: OwnerReceipt | undefined;
      let heldOwner: OwnerReceipt | undefined;
      try {
        // Child readiness can beat the parent's PID receipts. Join every required
        // receipt within the command's existing startup deadline before reading them.
        const ready = phase === "compilation" ? compiling : admitted;
        await Promise.all(
          [ready, ownerFile, compilerFile, ...(route === "ci-shared" ? [heldOwnerFile] : [])].map(
            (filename) => waitForFixtureFile(filename, command),
          ),
        );
        owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as OwnerReceipt;
        heldOwner =
          route === "ci-shared"
            ? (JSON.parse(fs.readFileSync(heldOwnerFile, "utf8")) as OwnerReceipt)
            : undefined;
        const compilerPid = (JSON.parse(fs.readFileSync(compilerFile, "utf8")) as { pid: number })
          .pid;
        if (route.startsWith("ci")) {
          const budget = route === "ci-shared" ? "1" : "2";
          expect(JSON.parse(fs.readFileSync(compilerBudget, "utf8"))).toEqual([budget, budget]);
        }
        if (phase === "compilation") {
          expect(isProcessAlive(compilerPid)).toBe(true);
          expect(fs.existsSync(path.join(owner.generation, "manifest.json"))).toBe(false);
          // Only the borrower dies. Its completion must let the invocation cancel
          // the compiler, rather than waiting for that compiler before disposal.
          process.kill(owner.borrower, shutdownSignal);
          if (heldOwner) {
            await waitForDead(owner.owner, 5_000);
            expect(isProcessAlive(compilerPid)).toBe(true);
            expect(isProcessAlive(heldOwner.borrower)).toBe(true);
            expect(fs.existsSync(compilerCanceled)).toBe(false);
            expect(heldOwner.generation).toBe(owner.generation);
            release();
          } else {
            await waitForReceipt(compilerCanceled);
            expect(fs.readFileSync(compilerCanceled, "utf8")).toBe("canceled");
            expect(fs.existsSync(released)).toBe(false);
          }
        } else {
          expect(JSON.parse(fs.readFileSync(admitted, "utf8"))).toEqual({ owner: owner.owner });
          if (phase === "admission") {
            // An ordinary borrower failure cannot supply the owner's signal status.
            // Observe a loop turn after close before interrupting the retained owner.
            fs.writeFileSync(borrowerExit, "exit");
            await waitForReceipt(borrowerClosed);
            expect(JSON.parse(fs.readFileSync(borrowerClosed, "utf8"))).toMatchObject({
              code: 1,
              signal: null,
            });
            await waitForReceipt(ownerIdle);
          }
          expect(isProcessAlive(owner.borrower)).toBe(false);
          expect(isProcessAlive(compilerPid)).toBe(false);
          expect(fs.existsSync(path.join(owner.generation, "manifest.json"))).toBe(true);

          if (route === "ci-disconnect") {
            fs.writeFileSync(disconnectRequested, "disconnect");
          } else {
            process.kill(owner.owner, shutdownSignal);
          }
          fs.writeFileSync(loopRequest, "probe");
          await waitForReceipt(responsive);
          expect(JSON.parse(fs.readFileSync(responsive, "utf8"))).toEqual({ owner: owner.owner });
          expect(isProcessAlive(owner.owner)).toBe(true);
          expect(fs.existsSync(owner.generation)).toBe(true);
          expect(fs.existsSync(released)).toBe(false);
          release();
        }
        const result = await command;
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(expectedExitCode);
        expect(result.stdout.includes("fixture borrower completed")).toBe(
          phase === "disposal" || phase === "deletion" || route === "ci-shared",
        );
        if (route.startsWith("ci")) {
          if (route === "ci-disconnect") {
            expect(result.stdout).toContain("owner disconnected before group completion");
          }
          expect(result.stdout).toContain(
            phase === "deletion"
              ? "[shard:ci-shutdown] end (exit 0)"
              : `[shard:ci-shutdown] [test] FAILED (exit ${shutdownSignal === "SIGINT" ? 130 : 143})`,
          );
        } else {
          const trailer = `[test] FAILED (exit ${expectedExitCode})`;
          expect(result.stderr.match(/^\[.*\] FAILED \(exit \d+\)$/gmu)).toEqual([trailer]);
          expect(result.stderr.trim().split("\n").at(-1)).toBe(trailer);
        }
        expect(fs.existsSync(owner.generation)).toBe(false);
      } finally {
        release();
        abort.abort();
        const result = await command;
        if (result.error) {
          console.error(result.error, result.stderr);
        }
        owner ??= fs.existsSync(ownerFile)
          ? (JSON.parse(fs.readFileSync(ownerFile, "utf8")) as OwnerReceipt)
          : undefined;
        if (owner) {
          const compilerPid = fs.existsSync(compilerFile)
            ? (JSON.parse(fs.readFileSync(compilerFile, "utf8")) as { pid: number }).pid
            : undefined;
          heldOwner ??= fs.existsSync(heldOwnerFile)
            ? (JSON.parse(fs.readFileSync(heldOwnerFile, "utf8")) as OwnerReceipt)
            : undefined;
          for (const pid of [
            owner.owner,
            owner.borrower,
            compilerPid,
            heldOwner?.owner,
            heldOwner?.borrower,
          ]) {
            if (pid === undefined) {
              continue;
            }
            await waitForDead(pid, 5_000);
            await expect
              .poll(() =>
                inspectManagedProcessGroup(
                  { pid, exitCode: expectedExitCode },
                  { errorPolicy: "indeterminate" },
                ),
              )
              .toBe("dead");
          }
          fs.rmSync(owner.generation, { recursive: true, force: true });
        }
      }
    }),
);

it("rejects a live borrower when its owner closes during verification", ({
  workerArtifacts,
  signal,
}) =>
  workerArtifacts.fixtureLifetime.run(async () => {
    const { observeChild } = workerArtifacts.createFixtureCommands();
    const owner = createVitestWorkerRun();
    const directory = owner.descriptor.directory;
    const manifestFile = path.join(directory, "manifest.json");
    const started = createDeferred();
    const release = createDeferred();
    const readFile = fs.promises.readFile.bind(fs.promises);
    let held = false;
    const reader = vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
      const filename = args[0];
      if (
        !held &&
        typeof filename === "string" &&
        filename !== manifestFile &&
        fs.existsSync(manifestFile)
      ) {
        const manifest: VitestWorkerManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        if (Object.hasOwn(manifest.inputs, filename)) {
          held = true;
          started.resolve();
          await release.promise;
        }
      }
      return readFile(...args);
    });
    const stop = () => {
      release.resolve();
      // Disposal must also start when a broken fixture times out before admission.
      void owner.dispose().catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", preparationClient], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const completion = observeChild(
        child,
        owner.borrow(
          child,
          createVitestProcessCompletion({
            child,
            detached: process.platform !== "win32",
          }),
        ),
      );
      void workerArtifacts.fixtureLifetime.verifyCleanup(async () => {
        await completion;
      });
      await Promise.race([
        started.promise,
        completion.then(() => {
          throw new Error("Borrower exited before verification was held");
        }),
      ]);
      let disposed = false;
      const disposal = workerArtifacts.fixtureLifetime.track(
        owner.dispose().then(() => {
          disposed = true;
        }),
      );
      await nextTurn();
      expect(disposed).toBe(false);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(fs.existsSync(directory)).toBe(true);
      release.resolve();
      expect(await completion, stderr).toEqual({ code: 1, signal: null });
      expect(stderr).toContain("owner is closing");
      await disposal;
      expect(fs.existsSync(directory)).toBe(false);
    } finally {
      signal.removeEventListener("abort", stop);
      release.resolve();
      try {
        await owner.dispose();
      } finally {
        reader.mockRestore();
      }
    }
  }));
