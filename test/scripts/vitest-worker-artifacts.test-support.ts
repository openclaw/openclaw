import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertPathToPattern } from "tinyglobby";
import { expect, it, vi, type TestAPI, type TestContext } from "vitest";
import * as managedChild from "../../scripts/lib/managed-child-process.mts";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import type { VitestWorkerManifest } from "../../scripts/lib/vitest-worker-artifacts.mts";
import {
  createVitestWorkerRun,
  type VitestWorkerRun,
} from "../../scripts/lib/vitest-worker-run.mts";
import { resolveVitestSpawnParams, spawnWatchedVitestProcess } from "../../scripts/run-vitest.mts";
import { createVitestProcessCompletion } from "../../scripts/vitest-process-group.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { fixturePreloadEnv } from "./fixtures/ci-fixture-runtime.cjs";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

const root = process.cwd();
const artifacts = path.join(root, ".artifacts");
const artifactsModule = "scripts/lib/vitest-worker-artifacts.mts";
type CompilerEnv = (env: NodeJS.ProcessEnv, runtime: "node" | "bun") => NodeJS.ProcessEnv;
const currentRuntime = process.versions.bun ? "bun" : "node";
export function compilerFixtureEnv(
  preload: string,
  env: NodeJS.ProcessEnv,
  runtime: "node" | "bun",
) {
  const result = { ...env };
  for (const [key, value] of Object.entries(fixturePreloadEnv(preload, runtime))) {
    result[key] = `${env[key] ?? ""} ${value}`.trim();
  }
  return result;
}

export function readFixtureLines<T>(filename: string): T[] {
  const lines = fs.readFileSync(filename, "utf8").trim();
  return lines.split("\n").map((line) => JSON.parse(line));
}
export const preparationClient = `
  import {requestVitestWorkerArtifacts} from ${JSON.stringify(pathToFileURL(path.join(root, artifactsModule)).href)};
  try {await requestVitestWorkerArtifacts();}
  catch (error) {console.error(error);process.exitCode=1;}
  finally {process.disconnect();}
`;

function createWorkerArtifactFixtures(
  { signal, onTestFinished }: Pick<TestContext, "signal" | "onTestFinished">,
  compilerEnv: CompilerEnv,
) {
  const fixtureLifetime = createFixtureLifetime();
  function fixtureDirectory() {
    fs.mkdirSync(artifacts, { recursive: true });
    return fixtureLifetime.createTempDir("worker proof-", artifacts);
  }

  function createFixtureCommands() {
    const finished = new AbortController();
    const commandSignal = AbortSignal.any([signal, finished.signal]);
    const commands: Promise<unknown>[] = [];
    commandSignal.throwIfAborted();
    // All commands retain this body's authority, including native IPC borrowers.
    // Finishing stops child work; whole-body finally still owns generation disposal.
    onTestFinished(async () => {
      finished.abort();
      await Promise.allSettled(commands);
    });

    function observeChild<T>(child: ChildProcess, completion: Promise<T>): Promise<T> {
      const cancel = () => {
        child.kill("SIGTERM");
      };
      const joined = completion.finally(() => commandSignal.removeEventListener("abort", cancel));
      commands.push(joined);
      void joined.catch(() => {});
      commandSignal.addEventListener("abort", cancel, { once: true });
      if (commandSignal.aborted) {
        cancel();
      }
      return joined;
    }

    function run(
      args: Parameters<typeof runNodeScript>[0],
      cwd: string,
      env: NodeJS.ProcessEnv,
      runtime: "node" | "bun",
      executable?: string,
    ) {
      const completion = fixtureLifetime.track(
        runNodeScript(args, compilerEnv(env, runtime), undefined, {
          cwd,
          signal: commandSignal,
          maxBuffer: 2 * 1024 * 1024,
          requireProcessTreeExit: process.platform !== "win32",
          ...(executable ? { executable } : {}),
        }).then((result) => ({ ...result, code: result.status })),
      );
      commands.push(completion);
      return completion;
    }

    const node = (
      args: Parameters<typeof runNodeScript>[0],
      cwd = root,
      env = testRunnerFixtureEnv(),
    ) => run(args, cwd, env, "node");
    const runtime = (args: string[], cwd = root, env = testRunnerFixtureEnv()) =>
      run(args, cwd, env, currentRuntime, process.execPath);

    function startBorrower(owner: VitestWorkerRun, args: string[], nodeArgs: string[] = []) {
      commandSignal.throwIfAborted();
      const logs = fixtureDirectory();
      const stdout = path.join(logs, "stdout.log"),
        stderr = path.join(logs, "stderr.log");
      const out = fs.openSync(stdout, "w"),
        err = fs.openSync(stderr, "w");
      const env = testRunnerFixtureEnv();
      const handle = spawnWatchedVitestProcess({
        workerRun: owner,
        pnpmArgs: ["exec", "node", ...nodeArgs, "node_modules/vitest/vitest.mjs", ...args],
        spawnParams: { ...resolveVitestSpawnParams(env), stdio: ["ignore", out, err] },
        env,
      });
      fs.closeSync(out);
      fs.closeSync(err);
      const completion = observeChild(handle.child, handle.completion);
      void fixtureLifetime.verifyCleanup(() => completion.then(() => undefined));
      return {
        ...handle,
        completion,
        result: fixtureLifetime.track(
          completion.then((result) => ({
            ...result,
            stdout: fs.readFileSync(stdout, "utf8"),
            stderr: fs.readFileSync(stderr, "utf8"),
          })),
        ),
      };
    }

    function startPreparation(owner: VitestWorkerRun, env = testRunnerFixtureEnv()) {
      commandSignal.throwIfAborted();
      const child = spawn(process.execPath, ["--input-type=module", "--eval", preparationClient], {
        env,
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
      void fixtureLifetime.verifyCleanup(() => completion.then(() => undefined));
      return { child, completion, stderr: () => stderr };
    }

    async function prepareWorkers(owner: VitestWorkerRun): Promise<VitestWorkerManifest> {
      const pending = startPreparation(owner);
      const result = await pending.completion;
      expect(result.code, pending.stderr()).toBe(0);
      return JSON.parse(
        fs.readFileSync(path.join(owner.descriptor.directory, "manifest.json"), "utf8"),
      );
    }

    return { node, runtime, startBorrower, startPreparation, prepareWorkers, observeChild };
  }

  return {
    fixtureLifetime,
    fixtureDirectory,
    createFixtureCommands,
    createWorkerRun: () =>
      createVitestWorkerRun(compilerEnv(testRunnerFixtureEnv(), currentRuntime)),
  };
}

export function createWorkerArtifactTest(compilerEnv: CompilerEnv = (env) => env) {
  const test = it.extend<{ workerArtifacts: ReturnType<typeof createWorkerArtifactFixtures> }>({
    workerArtifacts: async ({ signal, onTestFinished }, use) => {
      await use(createWorkerArtifactFixtures({ signal, onTestFinished }, compilerEnv));
    },
  });
  // Resolve the case's lifetime before runTest so cleanup follows onTestFinished.
  // Ordinary fixture teardown runs earlier and can wait on children not yet aborted.
  test.aroundEach(async (runTest, { workerArtifacts }) => {
    try {
      await runTest();
    } finally {
      await workerArtifacts.fixtureLifetime.cleanup();
    }
  });
  test.beforeAll(() => {
    vi.setConfig({ maxConcurrency: 2 });
    return () => vi.resetConfig();
  });
  return test;
}

type WorkerArtifactContext =
  ReturnType<typeof createWorkerArtifactTest> extends TestAPI<infer Fixtures>
    ? Fixtures & TestContext
    : never;

type WorkerArtifactLifetime = Pick<
  WorkerArtifactContext,
  "workerArtifacts" | "signal" | "onTestFinished"
>;

function createWorkerArtifactFixture(context: WorkerArtifactLifetime) {
  const commands = context.workerArtifacts.createFixtureCommands();
  const directory = context.workerArtifacts.fixtureDirectory();
  return {
    workerArtifacts: context.workerArtifacts,
    signal: context.signal,
    onTestFinished: context.onTestFinished,
    ...commands,
    directory,
    write: (name: string, source: string) => writeFixture(directory, name, source),
    run: (config: string, ...args: string[]) =>
      commands.node(["scripts/run-vitest.mjs", "run", "--config", config, ...args]),
    borrow: (owner: VitestWorkerRun, config: string, ...args: string[]) =>
      commands.startBorrower(owner, ["run", "--config", config, ...args]),
  };
}

export function inWorkerArtifactFixture(
  context: WorkerArtifactLifetime,
  body: (fixture: ReturnType<typeof createWorkerArtifactFixture>) => Promise<void>,
) {
  return context.workerArtifacts.fixtureLifetime.run(() =>
    body(createWorkerArtifactFixture(context)),
  );
}

/** Reuse the shutdown fixture's executable boundary, keeping real owners and IPC. */
export function createControlledWorkerCompiler(
  directory: string,
  env: NodeJS.ProcessEnv,
  runtime: "node" | "bun" = "node",
) {
  const input = writeFixture(directory, "worker-input.mjs", "export const fixture = true;\n");
  const receipt = path.join(directory, "fixture-compilers.jsonl");
  const compiler = fileURLToPath(new URL("./fixtures/vitest-worker-compiler.mjs", import.meta.url));
  const preload = writeFixture(
    directory,
    "compiler-preload.mjs",
    `
    if (process.argv[1] === ${JSON.stringify(path.join(root, "scripts/lib/vitest-worker-compiler.mts"))}) {
      const {runWorkerFixtureCompiler} = await import(${JSON.stringify(pathToFileURL(compiler).href)});
      await runWorkerFixtureCompiler(process.argv[2], ${JSON.stringify(input)}, ${JSON.stringify(receipt)});
      process.exit(0);
    }
  `,
  );
  const args = (generation: string) => [compiler, generation, input, receipt];
  return {
    args,
    intercept(generation: string, onLaunch?: () => void) {
      const runManaged = managedChild.runManagedCommand;
      return vi.spyOn(managedChild, "runManagedCommand").mockImplementation((options) => {
        if (
          options.args?.[0] === path.join(root, "scripts/lib/vitest-worker-compiler.mts") &&
          options.args[1] === generation
        ) {
          onLaunch?.();
          return runManaged({ ...options, args: args(generation) });
        }
        return runManaged(options);
      });
    },
    env: compilerFixtureEnv(preload, env, runtime),
    read: () =>
      readFixtureLines<{
        pid: number;
        processStartTime: number;
        isMainThread: boolean;
        directory: string;
        inputs: number;
        outputs: number;
      }>(receipt),
  };
}

export function writeFixture(directory: string, name: string, source: string) {
  const filename = path.join(directory, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, source);
  return filename;
}

const ownerPath = "scripts/lib/vitest-worker-run.mts";
let ownerInputs: string[] | undefined;

/** Copy the real owner and its imports; each subprocess still gets isolated state. */
export function copyWorkerRunFixture(directory: string) {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  ownerInputs ??= collectRuntimeImportClosure(repoRoot, [ownerPath], {
    includeDynamicImports: true,
  });
  for (const file of new Set([...ownerInputs, "package.json", "tsconfig.json"])) {
    const destination = path.join(directory, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), destination);
  }
  fs.symlinkSync(
    fs.realpathSync(path.join(repoRoot, "node_modules")),
    path.join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return pathToFileURL(path.join(directory, ownerPath)).href;
}

// Fixture records precede receipts and child completion; separate pipes can deliver them out of order.
export function fixtureFileBeforeSettlement(
  receipts: FixtureReceiptChannel,
  filename: string,
  completion: PromiseLike<unknown>,
  expected?: string,
): Promise<void> {
  const matches = () => {
    if (!fs.existsSync(filename)) {
      return false;
    }
    const text = fs.readFileSync(filename, "utf8");
    return text.length > 0 && (expected === undefined || text === expected);
  };
  const settled = Promise.resolve(completion).then(
    () => {
      if (!matches()) {
        throw new Error(`Child exited before writing ${filename}`);
      }
    },
    (error: unknown) => {
      if (!matches()) {
        throw new Error(`Child failed before writing ${filename}`, { cause: error });
      }
    },
  );
  return Promise.race([receipts.waitFor(filename, expected ?? "written"), settled]);
}

function writeWorkerProbe(directory: string, source: string, provide = "") {
  writeFixture(directory, "value.ts", 'export const value: string = "first";');
  const test = writeFixture(directory, "child.test.ts", source);
  return {
    config: writeFixture(
      directory,
      "vitest.config.mts",
      `
    import {sharedVitestConfig as shared} from ${JSON.stringify(pathToFileURL(path.join(root, "test/vitest/vitest.shared.config.ts")).href)};
    const project = name => ({extends:false,plugins:shared.plugins,resolve:{...shared.resolve,alias:[{find:'#fixture-value',replacement:${JSON.stringify(path.join(directory, "value.ts"))}},...shared.resolve.alias]},test:{name,environment:shared.test.environment,include:[${JSON.stringify(convertPathToPattern(test))}],pool:'forks',maxWorkers:1,testTimeout:shared.test.testTimeout,provide:{launcherArgv:process.argv${provide}}}});
    export default async () => ({root:${JSON.stringify(root)},plugins:shared.plugins,test:{projects:[project('first'),project('second')]}});
  `,
    ),
  };
}

export function workerBorrowingProbe(
  directory: string,
  hold?: Pick<FixtureReceiptChannel, "endpoint">,
) {
  return writeWorkerProbe(
    directory,
    `
    ${hold ? fixtureReceiptClientSource(hold.endpoint) : ""}
    import fs from 'node:fs';
    import path from 'node:path';
    import {it,expect,inject} from 'vitest';
    import {value} from '#fixture-value';
    import {runtimeProcessEntrypoints} from ${JSON.stringify(path.join(root, "src/infra/runtime-process-entrypoints.ts"))};
    import {resolveRuntimeWorkerUrl} from ${JSON.stringify(path.join(root, "src/infra/runtime-worker-url.ts"))};
    const generation = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
    const preparedAtCollection = fs.existsSync(generation);
    it('borrows the compiled generation through its runtime declaration',()=>{
      const launcherArgv = inject('launcherArgv');
      expect(path.isAbsolute(launcherArgv[1])).toBe(true);
      expect(path.basename(launcherArgv[1])).toBe('vitest.mjs');
      expect(generation.pathname.endsWith('/dist/infra/sqlite-readonly-location.worker.js')).toBe(true);
      expect(preparedAtCollection).toBe(true);
      expect(value).toBe('first');
      fs.appendFileSync(${JSON.stringify(path.join(directory, "generations.jsonl"))},JSON.stringify(generation.href)+'\\n');
      ${hold ? `sendReceipt(${JSON.stringify(path.join(directory, "generations.jsonl"))},'written'); await awaitRelease(${JSON.stringify(path.join(directory, "generations.jsonl"))},'finish');` : ""}
    });
  `,
  );
}

export function workerProbe(
  directory: string,
  holdSecond = false,
  mode: "compiled" | "source" = "compiled",
  receiptEndpoint?: string,
) {
  return writeWorkerProbe(
    directory,
    `
    ${receiptEndpoint ? fixtureReceiptClientSource(receiptEndpoint) : ""}
    import * as cp from 'node:child_process';
    import fs from 'node:fs';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { Worker } from 'node:worker_threads';
    import { it, expect, vi, inject } from 'vitest';
    import {value} from '#fixture-value';
    import { runtimeProcessEntrypoints } from ${JSON.stringify(path.join(root, "src/infra/runtime-process-entrypoints.ts"))};
    import { scriptModuleEntrypoints } from ${JSON.stringify(path.join(root, "scripts/script-module-runtime.test-support.mjs"))};
    import { runtimeProcessBuildEntries, runtimeProcessBuildEntrypoints } from ${JSON.stringify(path.join(root, "scripts/lib/runtime-process-build-entries.mts"))};
    import { vitestWorkerBuildEntries } from ${JSON.stringify(path.join(root, "scripts/lib/vitest-worker-build-entries.mts"))};
    import { tuiPtyRuntimeEntrypoints } from ${JSON.stringify(path.join(root, "src/tui/tui-pty-runtime-test-support.ts"))};
    import { cliCompactionBackendEntrypoints } from ${JSON.stringify(path.join(root, "src/agents/command/cli-compaction-runtime.test-support.ts"))};
    import { pluginRuntimeRetentionEntrypoint } from ${JSON.stringify(path.join(root, "src/plugins/runtime-retention-entrypoint.test-support.ts"))};
    import { resolveForwardedNodeCompilerArgs } from ${JSON.stringify(path.join(root, "src/bootstrap/node-compiler-args.ts"))};
    import { resolveRuntimeWorkerUrl } from ${JSON.stringify(path.join(root, "src/infra/runtime-worker-url.ts"))};
    import { prepareSqliteReadOnlyLocation } from ${JSON.stringify(path.join(root, "src/infra/sqlite-snapshot-source.ts"))};
    import { openNodeSqliteDatabase } from ${JSON.stringify(path.join(root, "src/infra/node-sqlite.ts"))};
    import { runSqliteTranscriptArchivePublishWorker } from ${JSON.stringify(path.join(root, "src/config/sessions/session-accessor.sqlite-archive.ts"))};
    const tuiUrls = Object.values(tuiPtyRuntimeEntrypoints).map(entry => resolveRuntimeWorkerUrl(entry).href);
    const setupUrls = cliCompactionBackendEntrypoints.map(entry => resolveRuntimeWorkerUrl(entry).href);
    const retentionUrl = resolveRuntimeWorkerUrl(pluginRuntimeRetentionEntrypoint).href;
    const scriptUrl = resolveRuntimeWorkerUrl(scriptModuleEntrypoints.runWithEnv).href;
    // Import acquisition must finish during collection, before any fixture hook starts.
    const entriesPresentAtCollection = [...tuiUrls,...setupUrls,retentionUrl,scriptUrl].every(url => fs.existsSync(new URL(url)));
    vi.mock('node:child_process', async (original) => {
      const actual = await original();
      return {...actual, execFile: vi.fn(actual.execFile)};
    });
    vi.mock('node:worker_threads', async (original) => {
      const actual = await original();
      return {...actual, Worker: vi.fn(function(...args) { return new actual.Worker(...args); })};
    });
    it('runs current SQLite code in the expected execution mode', async () => {
      const launcherArgv = inject('launcherArgv');
      expect(path.isAbsolute(launcherArgv[1])).toBe(true);
      expect(path.basename(launcherArgv[1])).toBe('vitest.mjs');
      expect(Object.values(runtimeProcessBuildEntries)).toHaveLength(runtimeProcessBuildEntrypoints.length);
      for (const source of Object.values(runtimeProcessBuildEntries)) {
        expect(source).not.toContain('/dist/');
        expect(source).toMatch(/\\.m?[jt]s$/);
        expect(fs.existsSync(source)).toBe(true);
      }
      expect(entriesPresentAtCollection).toBe(true);
      for (const entry of [...Object.values(tuiPtyRuntimeEntrypoints),...cliCompactionBackendEntrypoints,pluginRuntimeRetentionEntrypoint]) {
        const source = vitestWorkerBuildEntries[entry.distWorkerPath.replace(/\\.js$/, '')];
        expect(source).not.toContain('/dist/');
        expect(source).toMatch(/\\.ts$/);
        expect(fs.existsSync(source)).toBe(true);
      }
      const dir = fs.mkdtempSync(${JSON.stringify(path.join(directory, "database-"))});
      const file = path.join(dir, 'probe.sqlite');
      const db = openNodeSqliteDatabase(file);
      db.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('current source');");
      db.close();
      try {
        const prepared = await prepareSqliteReadOnlyLocation(file);
        try {
          const snapshot = openNodeSqliteDatabase(prepared.location, {readOnly:true});
          expect(snapshot.prepare('SELECT value FROM probe').get()).toEqual({value:'current source'});
          snapshot.close();
          const args = cp.execFile.mock.calls[0][1];
          // The executable identifies the generation; its descriptor may live in a shared chunk.
          const generation = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly).href;
          const sourceMode = ${mode === "source"};
          await expect(runSqliteTranscriptArchivePublishWorker([])).resolves.toEqual([]);
          const [archiveUrl] = Worker.mock.calls.at(-1);
          expect(archiveUrl.href.endsWith(sourceMode ? '.ts' : '.js')).toBe(true);
          if (!sourceMode) expect(fileURLToPath(archiveUrl).startsWith(fileURLToPath(new URL('../', generation)))).toBe(true);
          expect(tuiUrls).toHaveLength(6);
          expect(setupUrls).toHaveLength(2);
          expect(scriptUrl.endsWith(sourceMode ? '.mts' : '.js')).toBe(true);
          for (const url of [...tuiUrls,...setupUrls,retentionUrl]) {
            expect(url.endsWith(sourceMode ? '.ts' : '.js')).toBe(true);
            if (!sourceMode) expect(fileURLToPath(url).startsWith(fileURLToPath(new URL('../', generation)))).toBe(true);
          }
          const sourceLoader = sourceMode && !process.versions.bun;
          expect(args.includes('--import')).toBe(sourceLoader);
          const forwardedCompilerArgs = resolveForwardedNodeCompilerArgs();
          if (sourceLoader) expect(args[forwardedCompilerArgs.length + 1].startsWith('file:')).toBe(true);
          const runtimeArgs = [...forwardedCompilerArgs, ...(sourceLoader ? ['--import', expect.stringMatching(/^file:/)] : process.versions.bun ? ['--no-install'] : [])];
          expect(args.slice(0, runtimeArgs.length + 1)).toEqual([...runtimeArgs, fileURLToPath(generation)]);
          expect(args[runtimeArgs.length]).toMatch(sourceMode ? /\\.ts$/ : /\\.js$/);
          fs.appendFileSync(${JSON.stringify(path.join(directory, "observations.jsonl"))}, JSON.stringify({args, tuiUrls, setupUrls, retentionUrl, value, configValue:inject('configValue'), knn:resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteVector).href})+'\\n');
          fs.appendFileSync(${JSON.stringify(path.join(directory, "generations.jsonl"))}, JSON.stringify(generation)+'\\n');
          ${receiptEndpoint ? `sendReceipt(${JSON.stringify(path.join(directory, "generations.jsonl"))}, 'written');` : ""}
          const release = inject('releaseFile');
          if (release) await new Promise(resolve => {
            const check = () => {if(fs.existsSync(release)){clearInterval(poll);resolve();}};
            const poll=setInterval(check,50);
            check();
          });
        } finally {prepared.cleanup();}
      } finally {fs.rmSync(dir,{recursive:true,force:true});}
    });
  `,
    `,configValue:'first',releaseFile:${holdSecond} && name==='second' ? ${JSON.stringify(path.join(directory, "release"))} : null`,
  );
}
