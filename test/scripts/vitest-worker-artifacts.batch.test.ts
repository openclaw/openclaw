import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { isProcessAlive } from "../helpers/process-wait.js";
import { agentVitestProjectOwners } from "../vitest/vitest.agents-paths.mjs";
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
const packageContract = "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts";
const contractsConfig = "test/vitest/vitest.contracts-plugin.config.ts";
const channelsConfig = "test/vitest/vitest.channels.config.ts";
const codeModeWorker = "src/agents/code-mode.import-boundary.test.ts";
const agentsCoreConfig = agentVitestProjectOwners.core.config;
const discordCapture = "test/e2e/gateway-transcripts-discord-capture.e2e.test.ts";
const e2eConfig = "test/vitest/vitest.e2e.config.ts";

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
  { name: "full channels", config: channelsConfig, args: [], prepare: true },
  {
    name: "focused channels",
    config: channelsConfig,
    args: ["src/channels/chat-type.test.ts"],
    prepare: false,
  },
  { name: "empty channels", config: channelsConfig, args: [], include: [], prepare: false },
  ...[agentVitestProjectOwners.core, agentVitestProjectOwners.all].map((owner) => ({
    name: `code-mode ${owner.name}`,
    config: owner.config,
    args: [codeModeWorker],
    prepare: true,
  })),
  {
    name: "code-mode full agentic config",
    config: "test/vitest/vitest.full-agentic.config.ts",
    args: [codeModeWorker],
    prepare: true,
  },
  {
    name: "code-mode excluded from its scoped project",
    config: agentsCoreConfig,
    args: [codeModeWorker, "--exclude", path.basename(codeModeWorker)],
    prepare: false,
  },
  {
    name: "code-mode include",
    config: agentsCoreConfig,
    args: [],
    include: [codeModeWorker],
    prepare: true,
  },
  {
    name: "code-mode omitted by include",
    config: agentsCoreConfig,
    args: [codeModeWorker],
    include: ["src/agents/code-mode.test.ts"],
    prepare: false,
  },
  {
    name: "code-mode non-owning config",
    config: infraConfig,
    args: [codeModeWorker],
    prepare: false,
  },
  {
    name: "code-mode selection leaves unrelated agents lazy",
    config: agentsCoreConfig,
    args: ["src/agents/code-mode-runtime.test.ts"],
    prepare: false,
  },
])(
  "selects eager worker preparation for $name",
  async ({ config = infraConfig, args, include, prepare }) => {
    const { shouldPrepareVitestCoreWorkers } =
      await import("../../scripts/lib/vitest-runtime-selection.mts");
    expect(shouldPrepareVitestCoreWorkers(config, ["run", ...args], {}, include)).toBe(prepare);
  },
);

it.runIf(process.platform !== "win32").for([
  ...["direct", "projects", "contracts-direct", "contracts-projects"].flatMap((route) =>
    (route.startsWith("contracts-")
      ? ["ready", "excluded"]
      : [
          "ready",
          "code-mode",
          "capture",
          "failure",
          "cancel",
          "excluded",
          "watch",
          "metadata",
          "custom-root",
          "custom-project",
          ...(route === "direct" ? ["include-worker", "include-excluded", "channels"] : []),
        ]
    ).map((mode) => ({
      route,
      mode,
      phase: "pre-spawn",
    })),
  ),
  { route: "batch", mode: "ready", phase: "lazy" },
])(
  "$route runner owns $phase worker preparation through $mode",
  ({ route, mode }, { workerArtifacts }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const selectedFile = route.startsWith("contracts-")
        ? packageContract
        : mode === "code-mode"
          ? codeModeWorker
          : mode === "capture"
            ? discordCapture
            : coreWorker;
      const selectedConfig = route.startsWith("contracts-")
        ? contractsConfig
        : mode === "code-mode"
          ? agentsCoreConfig
          : mode === "capture"
            ? e2eConfig
            : infraConfig;
      const { node } = workerArtifacts.createFixtureCommands();
      const directory = workerArtifacts.fixtureDirectory();
      const compiled = path.join(directory, "compiled.jsonl");
      const launched = path.join(directory, "launched.json");
      const compilerReceipt = path.join(directory, "compiler.json");
      const childCacheReceipt = path.join(directory, "child-cache.json");
      const nodeCompileCache = path.join(directory, "node-compile-cache");
      const expectedCache = { path: nodeCompileCache, portable: "1", disabled: null };
      const canceled = path.join(directory, "canceled");
      const input = writeFixture(directory, "input.mjs", "export const fixture = true;");
      const compiler = writeFixture(
        directory,
        "compiler.mjs",
        `
import fs from 'node:fs';
import {runWorkerFixtureCompiler} from ${JSON.stringify(new URL("./fixtures/vitest-worker-compiler.mjs", import.meta.url).href)};
const generation=process.argv[2];
fs.writeFileSync(${JSON.stringify(compilerReceipt)},JSON.stringify({
  pid:process.pid,generation,
  ...(${JSON.stringify(route === "batch")} ? {
    runtime: process.versions.bun ? 'bun' : 'node',
    cache: {
      path: process.env.NODE_COMPILE_CACHE,
      portable: process.env.NODE_COMPILE_CACHE_PORTABLE,
      disabled: process.env.NODE_DISABLE_COMPILE_CACHE ?? null,
    },
  } : {}),
}));
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
const probeCache=${JSON.stringify(route === "batch")};
const cacheEnvironment=()=>({
  path: process.env.NODE_COMPILE_CACHE,
  portable: process.env.NODE_COMPILE_CACHE_PORTABLE,
  disabled: process.env.NODE_DISABLE_COMPILE_CACHE ?? null,
});
if(probeCache && process.argv[1]===${JSON.stringify(leaf)}) {
  fs.writeFileSync(${JSON.stringify(childCacheReceipt)},JSON.stringify(cacheEnvironment()));
}
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
      ...(probeCache ? {
        command: bin,
        orchestratorRuntime: process.versions.bun ? 'bun' : 'node',
        orchestratorCache: cacheEnvironment(),
      } : {}),
    }));
    // Keep the selected environment; this fixture proves delivery without requiring Bun.
    return spawn(probeCache ? process.execPath : bin,[${JSON.stringify(leaf)}],options);
  }
  return spawn(bin,args,options);
};
syncFixtureBuiltinExports();
`,
      );
      const controls =
        mode === "excluded"
          ? ["--exclude", selectedFile]
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
        route === "batch"
          ? [
              "--import",
              "./scripts/tsx.mjs",
              writeFixture(
                directory,
                "batch.mts",
                `import {runVitestBatch} from ${JSON.stringify(path.join(root, "scripts/lib/vitest-batch-runner.mts"))};
process.exitCode = await runVitestBatch({config:${JSON.stringify(infraConfig)},args:[${JSON.stringify(coreWorker)}],targets:[],env:process.env});`,
              ),
            ]
          : route === "direct" || route === "contracts-direct"
            ? [
                "scripts/run-vitest.mjs",
                "run",
                "--config",
                ...(mode === "channels" ? [channelsConfig] : [selectedConfig, selectedFile]),
                ...controls,
              ]
            : [
                "--import",
                "./scripts/tsx.mjs",
                "scripts/test-projects.mts",
                selectedFile,
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
        OPENCLAW_E2E_USE_PREBUILT_DIST: "1",
        ...fixturePreloadEnv(preload, "node"),
        ...(route === "batch"
          ? {
              OPENCLAW_VITEST_RUNTIME: "bun",
              NODE_COMPILE_CACHE: nodeCompileCache,
              NODE_COMPILE_CACHE_PORTABLE: "1",
              NODE_DISABLE_COMPILE_CACHE: undefined,
            }
          : {}),
      });
      expect(result.code, result.stdout + result.stderr).toBe(
        mode === "cancel" ? 143 : mode === "failure" ? 1 : 0,
      );
      const ready =
        mode === "ready" ||
        mode === "include-worker" ||
        mode === "channels" ||
        mode === "code-mode" ||
        mode === "capture";
      const prepared = ready || mode === "failure" || mode === "cancel";
      expect(fs.existsSync(compilerReceipt)).toBe(prepared);
      if (mode === "failure" || mode === "cancel") {
        expect(fs.existsSync(launched)).toBe(false);
      } else {
        expect(JSON.parse(fs.readFileSync(launched, "utf8"))).toEqual({
          prepared: ready && route !== "batch",
          ...(route === "batch"
            ? {
                command: "bun",
                orchestratorRuntime: "node",
                orchestratorCache: expectedCache,
              }
            : {}),
        });
      }
      if (route === "batch") {
        expect(JSON.parse(fs.readFileSync(childCacheReceipt, "utf8"))).toEqual({
          ...expectedCache,
          disabled: "1",
        });
      }
      if (prepared) {
        const receipt = JSON.parse(fs.readFileSync(compilerReceipt, "utf8"));
        expect(isProcessAlive(receipt.pid)).toBe(false);
        expect(fs.existsSync(receipt.generation)).toBe(false);
        if (route === "batch") {
          expect(receipt.runtime).toBe("node");
          expect(receipt.cache).toEqual(expectedCache);
        }
        if (ready) {
          expect(fs.readFileSync(compiled, "utf8").trim().split("\n")).toHaveLength(1);
        }
      }
      expect(fs.existsSync(canceled)).toBe(mode === "cancel");
    }),
);
