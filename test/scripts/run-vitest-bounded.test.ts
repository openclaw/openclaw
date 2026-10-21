import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";
import { createPreparedVitestCliFixture } from "./run-vitest-bounded-fixture.test-support.js";
import {
  captureOutput,
  childTermination,
  cleanRunnerEnv,
  repoRoot,
  scriptFiles,
} from "./run-vitest.test-support.js";

const posixDescribe = process.platform === "win32" ? describe.skip : describe;
const testNodeExecPath = resolveTestNodeExecPath();

function fixtureEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return cleanRunnerEnv({ CI: "1", ...overrides });
}

function runSync(args: string[], env: NodeJS.ProcessEnv, timeout = 15_000) {
  return spawnSync(testNodeExecPath, args, { cwd: repoRoot, env, encoding: "utf8", timeout });
}

function managedFixture(
  context: TestContext,
  prefix: string,
  body: (
    files: ReturnType<typeof scriptFiles>,
    run: (
      args: string[],
      env: NodeJS.ProcessEnv,
      timeout?: number,
      options?: Parameters<typeof runNodeScript>[3],
    ) => ReturnType<typeof runNodeScript>,
  ) => Promise<void>,
) {
  const lifetime = createFixtureLifetime();
  context.onTestFinished(() => lifetime.cleanup());
  return lifetime.run(() =>
    body(scriptFiles(lifetime.createTempDir(prefix)), (args, env, timeout, options) =>
      lifetime.track(
        runNodeScript(args, env, timeout ?? 10_000, {
          signal: context.signal,
          requireProcessTreeExit: process.platform !== "win32",
          ...options,
        }),
      ),
    ),
  );
}

const entrypoints = [
  { script: "run-vitest.mjs", direct: true, tool: "test" },
  { script: "run-vitest.mjs", direct: false, tool: "test" },
  { script: "run-vitest.mts", direct: true, tool: "vitest" },
  { script: "run-vitest.mts", direct: false, tool: "vitest" },
  ...["test-projects", "test-projects-serial", "test-projects-max", "test-projects-imports"].map(
    (name) => ({ script: `${name}.mts`, direct: false, tool: "test" }),
  ),
];
const preparedCli = createPreparedVitestCliFixture(
  repoRoot,
  entrypoints.map(({ script }) => script),
  { prepareWorkerArtifacts: true },
);
let fixtureReceipts: FixtureReceiptChannel;
beforeAll(async () => {
  await preparedCli.prepare();
  fixtureReceipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await fixtureReceipts.close();
  await preparedCli.cleanup();
});

const packageScripts = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
  .scripts as Record<string, string>;
const loaderEntries = [
  {
    name: "JavaScript launcher",
    args: [path.join(repoRoot, "scripts/run-vitest.mjs")],
  },
  ...[
    "test",
    "test:changed",
    "test:changed:max",
    "test:max",
    "test:serial",
    "test:perf:imports",
    "test:perf:imports:changed",
    "test:watch",
    "test:extensions:batch",
  ].map((name) => ({
    name,
    args: packageScripts[name]!.split(" ").slice(1),
  })),
];

describe("Vitest CLI final outcome ownership", () => {
  it.for([
    ...["missing", "broken"].flatMap((failure) =>
      loaderEntries.map(({ name, args }) => ({
        name,
        args,
        failure,
        code: 2,
        failedTrailers: name === "test:extensions:batch" ? [] : ["[test] FAILED (exit 2)"],
      })),
    ),
    ...[0, 1, 2].map((code) => ({
      name: "JavaScript implementation",
      args: [],
      failure: "settled",
      code,
      failedTrailers: code ? [`[test] FAILED (exit ${code})`] : [],
    })),
  ])(
    "classifies $failure exit $code at $name",
    ({ failure, args, failedTrailers, code }, context) =>
      managedFixture(context, "oc-vt-loader-", async (files, run) => {
        const settled = failure === "settled";
        const injection = settled
          ? `return {format: "module", shortCircuit: true, source: "process.exitCode = ${code};" };`
          : failure === "missing"
            ? 'throw Object.assign(new Error("owned missing loader dependency"), {code: "ERR_MODULE_NOT_FOUND"});'
            : `return {format: "module", shortCircuit: true, source: ${JSON.stringify('throw new Error("owned broken loader dependency");')}};`;
        files.write(
          "preload.mjs",
          `import {registerHooks} from "node:module";
registerHooks({load(url, context, nextLoad) {
  if (url.endsWith(${JSON.stringify(settled ? "/scripts/run-vitest-child.mts" : "/scripts/tsx.mjs")})) {
    ${injection}
  }
  return nextLoad(url, context);
}});`,
        );
        const result = await run(
          settled ? [path.join(preparedCli.root, "scripts/run-vitest.mjs")] : [...args, "--help"],
          {
            ...(settled ? preparedCli.env(testRunnerFixtureEnv()) : testRunnerFixtureEnv()),
            NODE_OPTIONS: `--import=${files.path("preload.mjs")}`,
          },
        );
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(code);
        if (!settled) {
          expect(result.stderr).toContain(`owned ${failure} loader dependency`);
        }
        expect(result.stderr.match(/^\[.*\] FAILED \(exit \d+\)$/gmu) ?? []).toEqual(
          failedTrailers,
        );
      }),
  );

  it.for(
    entrypoints.flatMap((entry) =>
      (entry.script.startsWith("test-projects-")
        ? ["failure"]
        : [
            "failure",
            "startup",
            "success",
            "help",
            ...(process.platform === "win32" ? [] : ["signal"]),
          ]
      ).map((outcome) => Object.assign({}, entry, { outcome })),
    ),
  )(
    "$script (direct=$direct) reports $outcome after its owners settle",
    ({ script, direct, tool, outcome }, context) =>
      managedFixture(context, "oc-vt-trailer-", async (files, run) => {
        const root = files.path();
        const target = "test/scripts/run-vitest.test.ts";
        fs.mkdirSync(files.path("test/scripts"), { recursive: true });
        fs.mkdirSync(files.path("test/vitest"));
        files.linkModules();
        files.write("package.json", '{"type":"module"}');
        files.write(
          target,
          `import { afterAll, expect, it } from "vitest";
afterAll(() => process.stderr.write("fixture cleanup finished\\n"));
it("trailer fixture", async () => {
  ${outcome === "failure" ? 'expect.fail("intentional trailer fixture failure");' : outcome === "signal" ? 'process.stderr.write("fixture signal ready\\n"); await new Promise(() => {});' : "expect(1).toBe(1);"}
});`,
        );
        const config = `import fs from "node:fs";
import os from "node:os";
import { getVitestWorkerDescriptor } from ${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-worker-descriptor.mts"))};
fs.writeFileSync(${JSON.stringify(files.path("receipt.json"))}, JSON.stringify({
  pid: process.pid, namespace: os.tmpdir(), generation: getVitestWorkerDescriptor()?.directory,
}));
export default { test: { include: [${JSON.stringify(target)}], maxWorkers: 1 } };`;
        for (const owner of ["tooling", "unit-fast"]) {
          files.write(`test/vitest/vitest.${owner}.config.ts`, config);
        }
        const args =
          outcome === "help"
            ? ["--help"]
            : direct
              ? ["run", "--config", "test/vitest/vitest.tooling.config.ts", target]
              : [target];
        if (outcome !== "help") {
          args.push(...(direct ? [] : ["--"]), "--configLoader=native");
          if (outcome === "startup") {
            args.push("--openclaw-trailer-repro");
          }
        }
        const env = fixtureEnv({
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
        });
        let output = { text: "" };
        let signaled = false;
        const preload = script.endsWith(".mts")
          ? ["--import", path.join(preparedCli.root, "scripts/tsx.mjs")]
          : [];
        const result = await run(
          [...preload, path.join(preparedCli.root, "scripts", script), ...args],
          preparedCli.env(env),
          45_000,
          {
            cwd: root,
            onReady(child) {
              output = captureOutput(child.stdout!, child.stderr!);
              child.stderr!.on("data", () => {
                if (
                  outcome === "signal" &&
                  !signaled &&
                  output.text.includes("fixture signal ready")
                ) {
                  signaled = true;
                  child.kill("SIGTERM");
                }
              });
            },
          },
        );
        const code =
          outcome === "signal" ? 143 : outcome === "failure" || outcome === "startup" ? 1 : 0;
        const failed = code !== 0;
        expect(result.error, output.text).toBeUndefined();
        expect(result.status, output.text).toBe(code);
        const trailer = `[${tool}] FAILED (exit ${code})`;
        expect(output.text.match(/^\[.*\] FAILED \(exit \d+\)$/gmu) ?? [], output.text).toEqual(
          failed ? [trailer] : [],
        );
        // The trailer belongs to stderr; arrivals on separate pipes have no shared order.
        if (failed) {
          expect(result.stderr.trim().split("\n").at(-1)).toBe(trailer);
        }
        if (outcome === "startup") {
          expect(output.text).toContain("Unknown option");
        }
        if (outcome === "help") {
          expect(output.text).toMatch(/Usage:|vitest\//);
        }
        if (["failure", "success", "signal"].includes(outcome)) {
          if (outcome === "signal") {
            expect(signaled).toBe(true);
          } else {
            expect(output.text).toContain("fixture cleanup finished");
          }
          if (outcome === "failure") {
            expect(output.text).toContain("intentional trailer fixture failure");
          }
          if (!direct && outcome !== "signal") {
            expect(output.text).toMatch(/\[test\] (?:failed|passed) 1 Vitest shard/);
          }
          const owned = files.json("receipt.json");
          expect(isProcessAlive(owned.pid)).toBe(false);
          expect(owned.generation).toEqual(expect.any(String));
          expect(fs.existsSync(owned.generation)).toBe(false);
          if (process.platform !== "win32") {
            expect(fs.existsSync(owned.namespace)).toBe(false);
          }
        }
      }),
  );
});

posixDescribe("bounded Vitest process ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["mjs", "mts"])(
    "loads the native UI asset inspector before direct %s readers",
    (extension) => {
      const root = tempDirs.make("oc-vt-ui-admission-");
      const preload = path.join(root, "preload.mjs");
      const metadataPath = path.join(repoRoot, "dist/build-info.json");
      fs.writeFileSync(
        preload,
        `import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawn;
cp.spawn = (bin, args, options) => {
  if (args.includes("scripts/prepare-vitest-runtime.mjs")) {
    return spawn(process.execPath, ["-e", ""], {
      ...options, env: { ...options.env, NODE_OPTIONS: "" },
    });
  }
  if (args.includes("scripts/ui.js") ||
      args.some(arg => arg === "vitest" || arg.endsWith("/vitest.mjs"))) {
    throw new Error("fixture reader or UI build admitted before runtime identity");
  }
  return spawn(bin, args, options);
};
const existsSync = fs.existsSync;
fs.existsSync = file => file === ${JSON.stringify(metadataPath)} || existsSync(file);
const readFileSync = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  if (file === ${JSON.stringify(metadataPath)}) {
    throw new Error("fixture runtime identity inspected");
  }
  return readFileSync(file, ...args);
};
syncBuiltinESMExports();
`,
      );
      const result = runSync(
        [
          path.join(repoRoot, `scripts/run-vitest.${extension}`),
          "run",
          "--config",
          "test/vitest/vitest.ui-e2e.config.ts",
          "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts",
        ],
        // This preload replaces only I/O; it does not install a TypeScript loader.
        fixtureEnv({ NODE_OPTIONS: `--import=${preload}` }),
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result, result.stderr).toMatchObject({ signal: null, status: 2 });
      expect(result.stderr).toContain("fixture runtime identity inspected");
      expect(result.stderr).not.toContain("fixture reader or UI build admitted");
    },
  );

  it.for([
    ["success", ["runtime", "ai", "ui"], 4, "1", ""],
    ["runtime-failure", ["runtime"], 0, "", ""],
    ["ai-failure", ["runtime", "ai"], 0, "", ""],
    ["prebuilt", ["ui"], 4, "1", ""],
    ["skip", [], 4, "", "1"],
    ["custom", [], 1, "", ""],
    ["cancel", ["runtime"], 0, "", ""],
  ] as const)(
    "prepares the direct E2E reader generation once: %s",
    { timeout: 60_000 },
    async ([outcome, expectedBuilds, readerCount, expectedPrebuilt, expectedSkip], { signal }) => {
      const root = tempDirs.make("oc-vt-preparation-");
      const files = scriptFiles(root);
      const receiptsPath = path.join(root, "events.jsonl");
      const pidPath = path.join(root, "builder.pid");
      const aiDeclarations = path.join(root, "ai-declarations");
      const uiRoot = path.join(root, "control-ui");
      const uiAssetsUrl = new URL("../../src/infra/control-ui-assets.ts", import.meta.url).href;
      files.write(
        "ui-assets.mjs",
        `export * from ${JSON.stringify(`${uiAssetsUrl}?fixture-original`)};
import { inspectControlUiRootAssets as inspect } from ${JSON.stringify(`${uiAssetsUrl}?fixture-original`)};
export function inspectControlUiRootAssets(_root, buildId) {
  return inspect(${JSON.stringify(uiRoot)}, buildId);
}`,
      );
      if (outcome === "prebuilt") {
        fs.writeFileSync(aiDeclarations, "");
      }
      files.write(
        "command.mjs",
        `import fs from "node:fs";
${fixtureReceiptClientSource(fixtureReceipts.endpoint)}
const kind = process.argv[2];
const record = (event) => fs.appendFileSync(${JSON.stringify(receiptsPath)}, JSON.stringify({
  kind, event, pid: process.pid, shard: process.argv[3],
  prebuilt: process.env.OPENCLAW_E2E_USE_PREBUILT_DIST ?? "",
  skip: process.env.OPENCLAW_E2E_SKIP_BUILD ?? "",
}) + "\\n");
record("start");
if (kind === "runtime" && ${JSON.stringify(outcome)} === "cancel") {
  fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
  sendReceipt(${JSON.stringify(pidPath)}, "ready");
  setInterval(() => {}, 1000);
} else {
  const failed = ${JSON.stringify(outcome)} === kind + "-failure";
  if (kind === "ai" && !failed) {
    fs.writeFileSync(${JSON.stringify(aiDeclarations)}, "");
  }
  if (kind === "ui" && !failed) {
    fs.mkdirSync(${JSON.stringify(uiRoot)});
    const buildId = process.env.OPENCLAW_CONTROL_UI_BUILD_ID ?? "fixture";
    fs.writeFileSync(${JSON.stringify(path.join(uiRoot, "index.html"))},
      '<html data-openclaw-control-ui-build-id="' + buildId + '-' + '0'.repeat(64) + '"></html>');
  }
  record("end");
  process.exit(failed ? 7 : 0);
}
`,
      );
      // Stub executables publish fixture artifacts; real admission and joins cannot build the checkout UI.
      files.write(
        "preload.mjs",
        `import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fixtureSourceFileFilter, registerFixtureSourceTransform } from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
registerFixtureSourceTransform({
  name: "direct-e2e-ui-assets",
  filter: fixtureSourceFileFilter([${JSON.stringify(uiAssetsUrl)}]),
  transform: () => fs.readFileSync(${JSON.stringify(files.path("ui-assets.mjs"))}, "utf8"),
});
const aiDist = ${JSON.stringify(path.join(repoRoot, "packages/ai/dist") + path.sep)};
const existsSync = fs.existsSync;
fs.existsSync = (entry) =>
  typeof entry === "string" && entry.startsWith(aiDist) && entry.endsWith(".d.mts")
    ? existsSync(${JSON.stringify(aiDeclarations)})
    : existsSync(entry);
const spawn = cp.spawn;
cp.spawn = (bin, args, options) => {
  const kind = args.includes("scripts/prepare-vitest-runtime.mjs") ? "runtime"
    : args.includes("scripts/tsdown-build.mts") ? "ai"
    : args.includes("scripts/ui.js") ? "ui"
    : args.some(arg => arg === "vitest" || arg.endsWith("/vitest.mjs")) ? "reader" : null;
  return kind ? spawn(process.execPath, [${JSON.stringify(files.path("command.mjs"))}, kind,
    args.find(arg => arg.startsWith("--shard=")) ?? "direct"], options) : spawn(bin, args, options);
};
syncBuiltinESMExports();
`,
      );
      const env = fixtureEnv();
      if (outcome === "prebuilt") {
        env.OPENCLAW_E2E_USE_PREBUILT_DIST = "1";
      }
      if (outcome === "skip") {
        env.OPENCLAW_E2E_SKIP_BUILD = "1";
      }
      const child = spawn(
        testNodeExecPath,
        [
          "--import",
          files.path("preload.mjs"),
          path.join(repoRoot, "scripts/run-vitest.mts"),
          "run",
          "--config",
          outcome === "custom"
            ? path.join(root, "custom.config.ts")
            : "test/vitest/vitest.e2e.config.ts",
        ],
        {
          cwd: repoRoot,
          env: preparedCli.env(env),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const output = captureOutput(child.stdout, child.stderr);
      const closed = childTermination(child);
      let builderPid: number | undefined;
      try {
        if (outcome === "cancel") {
          // A receipt can trail CLI settlement; the complete PID was written before it.
          await withinTest(
            Promise.race([
              fixtureReceipts.waitFor(pidPath, "ready"),
              closed.then(() => {
                if (!fs.existsSync(pidPath) || !fs.readFileSync(pidPath, "utf8").trim()) {
                  throw new Error(`timeout waiting for pid in ${pidPath}`);
                }
              }),
            ]),
            signal,
          );
          builderPid = Number.parseInt(fs.readFileSync(pidPath, "utf8"), 10);
          child.kill("SIGTERM");
        }
        const failed = outcome.endsWith("-failure") || outcome === "cancel";
        expect(await withinTest(closed, signal), output.text).toEqual({
          code: failed ? 2 : 0,
          signal: null,
        });
        const events: Array<{
          kind: string;
          event: string;
          pid: number;
          prebuilt: string;
          skip: string;
        }> = files.jsonLines("events.jsonl");
        const readers = events.filter(({ kind, event }) => kind === "reader" && event === "start");
        const builds = events.filter(({ kind, event }) => kind !== "reader" && event === "start");
        expect(builds.map(({ kind }) => kind)).toEqual(expectedBuilds);
        expect(readers.map(({ prebuilt, skip }) => [prebuilt, skip])).toEqual(
          Array.from({ length: readerCount }, () => [expectedPrebuilt, expectedSkip]),
        );
        if (outcome === "success") {
          expect(events.slice(0, 6).map(({ kind, event }) => `${kind}:${event}`)).toEqual([
            "runtime:start",
            "runtime:end",
            "ai:start",
            "ai:end",
            "ui:start",
            "ui:end",
          ]);
        }
        for (const workerPid of new Set(events.map(({ pid }) => pid))) {
          // CLI completion follows managed builder and reader child/group joins.
          expect(isProcessAlive(workerPid)).toBe(false);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
        await closed;
        builderPid ??= fs.existsSync(pidPath)
          ? Number.parseInt(fs.readFileSync(pidPath, "utf8"), 10)
          : undefined;
        if (builderPid) {
          expect(isProcessAlive(builderPid)).toBe(false);
        }
      }
    },
  );

  it.each(["test-failure", "cancel"])(
    "joins fresh children and preserves %s",
    { timeout: 60_000 },
    (outcome) => {
      const root = tempDirs.make("oc-vt-bounded-");
      const files = scriptFiles(root);
      files.linkModules();
      const configPath = path.join(root, "test/vitest/vitest.e2e.config.ts");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const receiptPath = path.join(root, "executed.jsonl");
      files.write(
        "test/vitest/vitest.e2e.config.ts",
        `export default {
  root: ${JSON.stringify(root)},
  test: {
    include: ["case-*.test.ts"], pool: "threads", isolate: false, maxWorkers: 1,
    env: { FIXTURE_SHARD: process.argv.find(arg => arg.startsWith("--shard=")) ?? "unsharded" },
  },
};`,
      );
      for (let index = 0; index < 4; index++) {
        files.write(
          `case-${index}.test.ts`,
          `import fs from "node:fs";
import { expect, it } from "vitest";
it("case ${index}", () => {
  fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ index: ${index}, pid: process.pid }) + "\\n");
  ${outcome === "cancel" ? 'process.kill(process.pid, "SIGTERM");' : 'expect(process.env.FIXTURE_SHARD).not.toBe("--shard=1/4");'}
});`,
        );
      }
      const result = runSync(
        [path.join(preparedCli.root, "scripts/run-vitest.mjs"), "run", "--config", configPath],
        preparedCli.env(fixtureEnv({ NO_COLOR: "1", FORCE_COLOR: "0" })),
        45_000,
      );
      expect(result.error, result.stderr).toBeUndefined();
      const trailer = `[test] FAILED (exit ${outcome === "cancel" ? 143 : 1})`;
      expect(result.stderr.match(/^\[.*\] FAILED \(exit \d+\)$/gmu)).toEqual([trailer]);
      expect(result.stderr.trim().split("\n").at(-1)).toBe(trailer);
      const receipts: Array<{ index: number; pid: number }> = files.jsonLines("executed.jsonl");
      if (outcome === "cancel") {
        expect(result.signal === "SIGTERM" || result.status === 143, result.stderr).toBe(true);
        expect(receipts).toHaveLength(1);
      } else {
        // The first shard fails, later shards pass: success must not erase that failure.
        expect(result.status, result.stderr).toBe(1);
        expect(receipts.map(({ index }) => index).toSorted((left, right) => left - right)).toEqual([
          0, 1, 2, 3,
        ]);
        expect(new Set(receipts.map(({ pid }) => pid)).size).toBe(4);
      }
      for (const { pid } of receipts) {
        expect(isProcessAlive(pid)).toBe(false);
      }
    },
  );
});
