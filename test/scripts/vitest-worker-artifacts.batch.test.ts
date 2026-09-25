import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { isProcessAlive } from "../helpers/process-wait.js";
import { fixturePreloadEnv } from "./fixtures/ci-fixture-runtime.cjs";
import {
  createControlledWorkerCompiler,
  createWorkerArtifactTest,
  workerBorrowingProbe,
  writeFixture,
} from "./vitest-worker-artifacts.test-support.js";

const it = createWorkerArtifactTest();
const root = process.cwd();

it.runIf(process.platform !== "win32").for([0, 1])(
  "owns compiled worker artifacts through batch completion (exit %s)",
  (expectedCode, { workerArtifacts }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const { node } = workerArtifacts.createFixtureCommands();
      const directory = workerArtifacts.fixtureDirectory();
      const { config } = workerBorrowingProbe(directory);
      const observed = path.join(directory, "generations.jsonl");
      const completed = path.join(directory, "completed.json");
      if (expectedCode !== 0) {
        fs.appendFileSync(
          path.join(directory, "child.test.ts"),
          "\nit('reports the fixture failure', () => expect.fail('deliberate batch failure'));\n",
        );
      }
      const entry = writeFixture(
        directory,
        "batch.mts",
        `import fs from 'node:fs';
import {runVitestBatch} from ${JSON.stringify(path.join(root, "scripts/lib/vitest-batch-runner.mts"))};
process.exitCode = await runVitestBatch({
  config: ${JSON.stringify(config)}, args: ['--maxWorkers=1', '--cache=false'], targets: [], env: process.env,
  onComplete(outcome) {
    const generations = fs.existsSync(${JSON.stringify(observed)})
      ? fs.readFileSync(${JSON.stringify(observed)}, 'utf8').trim().split('\\n').map(line => JSON.parse(line)) : [];
    fs.writeFileSync(${JSON.stringify(completed)}, JSON.stringify({
      ...outcome, generationPresent: generations.some(url => fs.existsSync(new URL('../../', url))),
    }));
  },
});`,
      );
      const compiler = createControlledWorkerCompiler(directory, process.env);
      const result = await node(
        ["--import", path.join(root, "scripts/tsx.mjs"), entry],
        root,
        compiler.env,
      );
      expect(result.code, result.stdout + result.stderr).toBe(expectedCode);
      expect(fs.existsSync(observed)).toBe(true);
      expect(JSON.parse(fs.readFileSync(completed, "utf8"))).toEqual({
        code: expectedCode,
        signal: null,
        generationPresent: false,
      });
      const generations: string[] = fs
        .readFileSync(observed, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(generations).toHaveLength(2);
      expect(new Set(generations).size).toBe(1);
      expect(compiler.read()).toHaveLength(1);
      for (const generation of generations) {
        expect(generation.endsWith("/dist/infra/sqlite-readonly-location.worker.js")).toBe(true);
        expect(fs.existsSync(fileURLToPath(new URL("../../", generation)))).toBe(false);
      }
      expect((result.stdout + result.stderr).match(/\[vitest-workers\] prepared/g)).toHaveLength(1);
    }),
);

const coreWorker = "src/infra/sqlite-worker-operation-attachment.test.ts";
const infraConfig = "test/vitest/vitest.infra.config.ts";

it.for([
  { name: "worker", args: [coreWorker], prepare: true },
  { name: "absolute worker", args: [path.resolve(coreWorker)], prepare: true },
  { name: "line selection", args: [`${coreWorker}:12`], prepare: true },
  { name: "ordinary infra", args: ["src/infra/node-sqlite.test.ts"], prepare: false },
  { name: "excluded worker", args: [coreWorker, "--exclude", coreWorker], prepare: false },
  { name: "excluded glob", args: [coreWorker, "--exclude=src/infra/**"], prepare: false },
  { name: "empty include", args: [], include: [], prepare: false },
  { name: "worker include", args: [], include: [coreWorker], prepare: true },
  { name: "nonmatching include", args: [coreWorker], include: ["test/**"], prepare: false },
  { name: "root config", config: "vitest.config.ts", args: [coreWorker], prepare: true },
  { name: "custom config", config: "custom.config.ts", args: [coreWorker], prepare: false },
])(
  "selects eager worker preparation for $name",
  async ({ config = infraConfig, args, include, prepare }) => {
    const { shouldPrepareVitestCoreWorkers } =
      await import("../../scripts/lib/vitest-runtime-selection.mts");
    expect(shouldPrepareVitestCoreWorkers(config, ["run", ...args], {}, include)).toBe(prepare);
  },
);

it.runIf(process.platform !== "win32").for(
  ["direct", "projects"].flatMap((route) =>
    [
      "ready",
      "failure",
      "cancel",
      "excluded",
      "watch",
      "metadata",
      "custom-root",
      "custom-project",
      ...(route === "direct" ? ["include-worker", "include-excluded"] : []),
    ].map((mode) => ({
      route,
      mode,
    })),
  ),
)(
  "$route runner owns pre-spawn worker preparation through $mode",
  ({ route, mode }, { workerArtifacts }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const { node } = workerArtifacts.createFixtureCommands();
      const directory = workerArtifacts.fixtureDirectory();
      const compiled = path.join(directory, "compiled.jsonl");
      const launched = path.join(directory, "launched.json");
      const compilerReceipt = path.join(directory, "compiler.json");
      const canceled = path.join(directory, "canceled");
      const input = writeFixture(directory, "input.mjs", "export const fixture = true;");
      const compiler = writeFixture(
        directory,
        "compiler.mjs",
        `
import fs from 'node:fs';
import {runWorkerFixtureCompiler} from ${JSON.stringify(new URL("./fixtures/vitest-worker-compiler.mjs", import.meta.url).href)};
const generation=process.argv[2];
fs.writeFileSync(${JSON.stringify(compilerReceipt)},JSON.stringify({pid:process.pid,generation}));
if (${JSON.stringify(mode)}==='failure') process.exit(7);
if (${JSON.stringify(mode)}==='cancel') {
  const watcher=fs.watch(${JSON.stringify(directory)},()=>{});
  process.once('SIGTERM',()=>{
    fs.writeFileSync(${JSON.stringify(canceled)},'joined');
    watcher.close();
    process.exit(0);
  });
  process.kill(process.ppid,'SIGTERM');
  await new Promise(()=>{});
}
await runWorkerFixtureCompiler(generation,${JSON.stringify(input)},${JSON.stringify(compiled)});
`,
      );
      const leaf = writeFixture(
        directory,
        "leaf.mjs",
        `
import {requestVitestWorkerArtifacts} from ${JSON.stringify(new URL("../../scripts/lib/vitest-worker-artifacts.mts", import.meta.url).href)};
if (process.connected) {
  await requestVitestWorkerArtifacts();
  process.disconnect();
}
`,
      );
      const preload = writeFixture(
        directory,
        "preload.mjs",
        `
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {syncFixtureBuiltinExports} from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
const spawn=cp.spawn;
cp.spawn=(bin,args,options)=>{
  if(args[0]===${JSON.stringify(path.join(root, "scripts/lib/vitest-worker-compiler.mts"))}) {
    return spawn(bin,[${JSON.stringify(compiler)},args[1]],options);
  }
  if(args.some(arg=>path.basename(arg)==='vitest.mjs')) {
    const bootstrap=args.indexOf(${JSON.stringify(path.join(root, "scripts/lib/vitest-worker-bootstrap.mts"))});
    const generation=bootstrap<0?undefined:args[bootstrap+1];
    fs.writeFileSync(${JSON.stringify(launched)},JSON.stringify({
      prepared: Boolean(generation && fs.existsSync(path.join(generation,'manifest.json'))),
    }));
    return spawn(bin,[${JSON.stringify(leaf)}],options);
  }
  return spawn(bin,args,options);
};
syncFixtureBuiltinExports();
`,
      );
      const controls =
        mode === "excluded"
          ? ["--exclude", coreWorker]
          : mode === "watch"
            ? ["--watch"]
            : mode === "metadata"
              ? ["--help"]
              : mode === "custom-root"
                ? ["--root", "."]
                : mode === "custom-project"
                  ? ["--project", "infra"]
                  : [];
      // Source-mode fixtures never request artifacts. Finite lazy selections still may.
      if (["excluded", "custom-root", "custom-project", "include-excluded"].includes(mode)) {
        fs.writeFileSync(leaf, "if(process.connected) process.disconnect();\n");
      }
      const args =
        route === "direct"
          ? ["scripts/run-vitest.mjs", "run", "--config", infraConfig, coreWorker, ...controls]
          : [
              "--import",
              "./scripts/tsx.mjs",
              "scripts/test-projects.mts",
              coreWorker,
              "--",
              ...controls,
            ];
      const includeFile = mode.startsWith("include-")
        ? writeFixture(
            directory,
            "include.json",
            JSON.stringify(mode === "include-worker" ? [coreWorker] : ["test/scripts/*.test.ts"]),
          )
        : "";
      const result = await node(args, root, {
        ...process.env,
        // Each nested invocation owns its selection, independently of the outer tooling shard.
        OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
        ...fixturePreloadEnv(preload, "node"),
      });
      expect(result.code, result.stdout + result.stderr).toBe(
        mode === "cancel" ? 143 : mode === "failure" ? 1 : 0,
      );
      const ready = mode === "ready" || mode === "include-worker";
      const prepared = ready || mode === "failure" || mode === "cancel";
      expect(fs.existsSync(compilerReceipt)).toBe(prepared);
      if (mode === "failure" || mode === "cancel") {
        expect(fs.existsSync(launched)).toBe(false);
      } else {
        expect(JSON.parse(fs.readFileSync(launched, "utf8"))).toEqual({
          prepared: ready,
        });
      }
      if (prepared) {
        const receipt = JSON.parse(fs.readFileSync(compilerReceipt, "utf8"));
        expect(isProcessAlive(receipt.pid)).toBe(false);
        expect(fs.existsSync(receipt.generation)).toBe(false);
        if (ready) {
          expect(fs.readFileSync(compiled, "utf8").trim().split("\n")).toHaveLength(1);
        }
      }
      expect(fs.existsSync(canceled)).toBe(mode === "cancel");
    }),
);
