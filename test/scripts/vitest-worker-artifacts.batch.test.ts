import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { isProcessAlive } from "../helpers/process-wait.js";
import { agentVitestProjectOwners } from "../vitest/vitest.agents-paths.mjs";
import { fixturePreloadEnv } from "./fixtures/ci-fixture-runtime.cjs";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";
import {
  createWorkerArtifactTest,
  inWorkerArtifactFixture,
  readFixtureLines,
} from "./vitest-worker-artifacts.test-support.js";

const it = createWorkerArtifactTest();
const subprocess = it.runIf(process.platform !== "win32");
const root = process.cwd();
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const cacheProbe = `const cacheEnvironment=()=>({
  path: process.env.NODE_COMPILE_CACHE,
  portable: process.env.NODE_COMPILE_CACHE_PORTABLE,
  disabled: process.env.NODE_DISABLE_COMPILE_CACHE ?? null,
});`;

const coreWorker = "src/infra/sqlite-worker-operation-attachment.test.ts";
const infraConfig = "test/vitest/vitest.infra.config.ts";
const packageContract = "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts";
const contractsConfig = "test/vitest/vitest.contracts-plugin.config.ts";
const channelsConfig = "test/vitest/vitest.channels.config.ts";
const gatewayMethodsConfig = "test/vitest/vitest.gateway-methods.config.ts";
const codeModeWorker = "src/agents/code-mode.import-boundary.test.ts";
const agentsCoreConfig = agentVitestProjectOwners.core.config;
const discordCapture = "test/e2e/gateway-transcripts-discord-capture.e2e.test.ts";
const e2eConfig = "test/vitest/vitest.e2e.config.ts";

it.for([
  ["ordinary infra", infraConfig, ["src/infra/node-sqlite.test.ts"], false],
  ["root config", "vitest.config.ts", [coreWorker], true],
  ["custom config", "custom.config.ts", [coreWorker], false],
  ...[
    ["channels", channelsConfig, "src/channels/chat-type.test.ts"],
    ["gateway methods", gatewayMethodsConfig, "src/gateway/server-methods/health.test.ts"],
  ].flatMap(([name, config, file]): Array<[string, string, string[], boolean, string[]?]> => [
    [`focused ${name}`, config!, [file!], false],
    [`empty ${name}`, config!, [], false, []],
  ]),
  ["code-mode all agents", agentVitestProjectOwners.all.config, [codeModeWorker], true],
  [
    "code-mode full agentic config",
    "test/vitest/vitest.full-agentic.config.ts",
    [codeModeWorker],
    true,
  ],
  [
    "code-mode excluded",
    agentsCoreConfig,
    [codeModeWorker, "--exclude", path.basename(codeModeWorker)],
    false,
  ],
  [
    "code-mode omitted by include",
    agentsCoreConfig,
    [codeModeWorker],
    false,
    ["src/agents/code-mode.test.ts"],
  ],
  ["unrelated agents stay lazy", agentsCoreConfig, ["src/agents/code-mode-runtime.test.ts"], false],
] satisfies Array<[string, string, string[], boolean, string[]?]>)(
  "selects eager worker preparation for %s",
  async ([, config, args, prepare, include]) => {
    const { shouldPrepareVitestCoreWorkers } =
      await import("../../scripts/lib/vitest-runtime-selection.mts");
    expect(shouldPrepareVitestCoreWorkers(config, ["run", ...args], {}, include)).toBe(prepare);
  },
);

subprocess.for([
  ...["direct", "projects", "contracts-direct", "contracts-projects"].flatMap((route) =>
    (route.startsWith("contracts-")
      ? ["ready", "excluded"]
      : [
          "code-mode",
          "capture",
          "failure",
          "cancel",
          "excluded",
          "watch",
          "metadata",
          "custom-root",
          "custom-project",
          ...(route === "direct"
            ? ["include-worker", "include-excluded", "channels", "gateway-methods"]
            : []),
        ]
    ).map((mode) => ({ route, mode })),
  ),
  { route: "batch", mode: "ready" },
])(
  "$route runner owns worker preparation through $mode",
  ({ route, mode }, { workerArtifacts, signal, onTestFinished }) =>
    inWorkerArtifactFixture(
      { workerArtifacts, signal, onTestFinished },
      async ({ node, directory, write: fixture }) => {
        const [selectedFile, selectedConfig]: [string, string] = route.startsWith("contracts-")
          ? [packageContract, contractsConfig]
          : mode === "code-mode"
            ? [codeModeWorker, agentsCoreConfig]
            : mode === "capture"
              ? [discordCapture, e2eConfig]
              : [coreWorker, infraConfig];
        const compiled = path.join(directory, "compiled.jsonl");
        const launched = path.join(directory, "launched.json");
        const compilerReceipt = path.join(directory, "compiler.json");
        const childCacheReceipt = path.join(directory, "child-cache.json");
        const nodeCompileCache = path.join(directory, "node-compile-cache");
        const expectedCache = { path: nodeCompileCache, portable: "1", disabled: null };
        const canceled = path.join(directory, "canceled");
        const input = fixture("input.mjs", "export const fixture = true;");
        const compiler = fixture(
          "compiler.mjs",
          `
import fs from 'node:fs';
import {runWorkerFixtureCompiler} from ${JSON.stringify(new URL("./fixtures/vitest-worker-compiler.mjs", import.meta.url).href)};
const generation=process.argv[2];
${cacheProbe}
fs.writeFileSync(${JSON.stringify(compilerReceipt)},JSON.stringify({
  pid:process.pid,generation,
  ...(${JSON.stringify(route === "batch")} ? {
    runtime: process.versions.bun ? 'bun' : 'node',
    cache: cacheEnvironment(),
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
        const leaf = fixture(
          "leaf.mjs",
          `
import {requestVitestWorkerArtifacts} from ${JSON.stringify(new URL("../../scripts/lib/vitest-worker-artifacts.mts", import.meta.url).href)};
if (process.connected) {
  await requestVitestWorkerArtifacts();
  process.disconnect();
}
`,
        );
        const preload = fixture(
          "preload.mjs",
          `
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {syncFixtureBuiltinExports} from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
const probeCache=${JSON.stringify(route === "batch")};
${cacheProbe}
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
        const controls: Record<string, string[]> = {
          excluded: ["--exclude", selectedFile],
          watch: ["--watch"],
          metadata: ["--help"],
          "custom-root": ["--root", "."],
          "custom-project": ["--project", "infra"],
        };
        // Source-mode fixtures never request artifacts. Finite lazy selections still may.
        if (["excluded", "custom-root", "custom-project", "include-excluded"].includes(mode)) {
          fs.writeFileSync(leaf, "if(process.connected) process.disconnect();\n");
        }
        const selection =
          mode === "channels"
            ? [channelsConfig]
            : mode === "gateway-methods"
              ? [gatewayMethodsConfig]
              : [selectedConfig, selectedFile];
        const flags = controls[mode] ?? [];
        const args =
          route === "batch"
            ? [
                "--import",
                "./scripts/tsx.mjs",
                fixture(
                  "batch.mts",
                  `import {runVitestBatch} from ${JSON.stringify(path.join(root, "scripts/lib/vitest-batch-runner.mts"))};
process.exitCode = await runVitestBatch({config:${JSON.stringify(infraConfig)},args:[${JSON.stringify(coreWorker)}],targets:[],env:process.env});`,
                ),
              ]
            : route === "direct" || route === "contracts-direct"
              ? ["scripts/run-vitest.mjs", "run", "--config", ...selection, ...flags]
              : [
                  "--import",
                  "./scripts/tsx.mjs",
                  "scripts/test-projects.mts",
                  selectedFile,
                  "--",
                  ...flags,
                ];
        const includeFile = mode.startsWith("include-")
          ? fixture(
              "include.json",
              JSON.stringify(mode === "include-worker" ? [coreWorker] : ["test/scripts/*.test.ts"]),
            )
          : "";
        const result = await node(args, root, {
          ...testRunnerFixtureEnv(),
          // Each nested invocation owns its selection, independently of the outer tooling shard.
          OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
          OPENCLAW_E2E_USE_PREBUILT_DIST: "1",
          ...fixturePreloadEnv(preload, "node"),
          ...(route === "batch"
            ? {
                OPENCLAW_VITEST_RUNTIME: "bun",
                OPENCLAW_BUN_PATH: process.execPath,
                NODE_COMPILE_CACHE: nodeCompileCache,
                NODE_COMPILE_CACHE_PORTABLE: "1",
                NODE_DISABLE_COMPILE_CACHE: undefined,
              }
            : {}),
        });
        expect(result.code, result.stdout + result.stderr).toBe(
          mode === "cancel" ? 143 : mode === "failure" ? 2 : 0,
        );
        const ready = [
          "ready",
          "include-worker",
          "channels",
          "gateway-methods",
          "code-mode",
          "capture",
        ].includes(mode);
        const prepared = ready || mode === "failure" || mode === "cancel";
        expect(fs.existsSync(compilerReceipt)).toBe(prepared);
        if (mode === "failure" || mode === "cancel") {
          expect(fs.existsSync(launched)).toBe(false);
        } else {
          expect(readJson(launched)).toEqual({
            prepared: ready && route !== "batch",
            ...(route === "batch"
              ? {
                  command: process.execPath,
                  orchestratorRuntime: "node",
                  orchestratorCache: expectedCache,
                }
              : {}),
          });
        }
        if (route === "batch") {
          expect(readJson(childCacheReceipt)).toEqual({
            ...expectedCache,
            disabled: "1",
          });
        }
        if (prepared) {
          const receipt = readJson(compilerReceipt);
          expect(isProcessAlive(receipt.pid)).toBe(false);
          expect(fs.existsSync(receipt.generation)).toBe(false);
          if (route === "batch") {
            expect(receipt).toMatchObject({ runtime: "node", cache: expectedCache });
          }
          if (ready) {
            expect(readFixtureLines(compiled)).toHaveLength(1);
          }
        }
        expect(fs.existsSync(canceled)).toBe(mode === "cancel");
      },
    ),
);
