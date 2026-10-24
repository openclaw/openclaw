import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatErrorMessage } from "../../scripts/lib/error-format.mts";
import {
  buildVitestProfileCommandWithArgs,
  parseArgs,
  resolveVitestProfileDir,
} from "../../scripts/run-vitest-profile.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createDeferred } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { repoRoot, scriptFiles, waitAtGate } from "./run-vitest.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

describe("scripts/run-vitest-profile", () => {
  const { trackTempDir } = createScriptTestHarness();
  const lifetime = createFixtureLifetime();
  const { createTempDir } = lifetime;
  afterEach(() => lifetime.cleanup());

  function createProject(prefix: string) {
    const root = createTempDir(prefix);
    const files = scriptFiles(root);
    files.write("package.json", '{"private":true,"type":"module"}');
    files.linkModules();
    return root;
  }

  function profileArgs(root: string, mode: string, ...args: string[]) {
    return [
      path.join(repoRoot, "scripts/run-vitest-profile.mts"),
      mode,
      "--output-dir",
      path.join(root, "profiles"),
      "--",
      ...args,
    ];
  }

  async function runProfileProcess(
    args: string[],
    root: string,
    signal: AbortSignal,
    env?: NodeJS.ProcessEnv,
    observeOutput?: (stdout: string) => void,
  ) {
    const result = await lifetime.track(
      runNodeScript(
        args,
        { PATH: process.env.PATH, HOME: root, USERPROFILE: root, CI: "1", ...env },
        undefined,
        {
          cwd: root,
          signal,
          maxBuffer: 1024 * 1024,
          requireProcessTreeExit: process.platform !== "win32",
          onReady(child, readOutput) {
            if (observeOutput) {
              child.stdout?.on("data", () => observeOutput(readOutput().stdout));
            }
          },
        },
      ),
    );
    const output = result.stdout + result.stderr;
    if (result.error) {
      throw new Error(`${formatErrorMessage(result.error)}\n${output}`, { cause: result.error });
    }
    return { code: result.status, output };
  }

  it("defaults profile output outside the repo", () => {
    const outputDir = trackTempDir(resolveVitestProfileDir({ mode: "main", outputDir: "" }));

    expect(outputDir.startsWith(os.tmpdir())).toBe(true);
    expect(outputDir.startsWith(process.cwd())).toBe(false);
  });

  it("keeps explicit output directories", () => {
    expect(
      resolveVitestProfileDir({ mode: "runner", outputDir: ".artifacts/custom-profile" }),
    ).toBe(path.resolve(".artifacts/custom-profile"));
  });

  it.for([
    { pool: "forks", failRun: true },
    { pool: "threads", isolate: true, custom: true },
    { pool: "forks", isolate: true, custom: true, projects: true },
    { pool: "threads", failRun: true, failProfile: true },
    {
      pool: "forks",
      failProfile: true,
      unhandled: true,
      errorPolicy: "ignore",
    },
    {
      pool: "threads",
      failProfile: true,
      unhandled: true,
      errorPolicy: "filter",
    },
  ])(
    "profiles selected runner %j",
    (
      {
        pool,
        isolate = false,
        custom = false,
        failRun = false,
        projects = false,
        failProfile = false,
        unhandled = false,
        errorPolicy = "default",
      },
      { signal },
    ) =>
      lifetime.run(async () => {
        const root = createProject("oc-profile-sibling-");
        const files = scriptFiles(root);
        const environment = custom && pool === "threads" ? "jsdom" : "node";
        const outputDir = path.join(root, "profiles with spaces");
        const configPath = path.join(root, "custom.config.ts");
        const configLoads = path.join(root, "config-loads");
        files.write(
          "custom.config.ts",
          `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(configLoads)}, "loaded\\n");
export default { test: {
  include: ["*.test.ts"], exclude: ["config-excluded.test.ts"], reporters: ["default", "json"], outputFile: "report.json",
  globalSetup: "./custom-setup.ts",
  ${custom && !projects ? 'runner: "./custom-runner.ts",' : ""}
  dangerouslyIgnoreUnhandledErrors: ${errorPolicy === "ignore"},
  ${errorPolicy === "filter" ? 'onUnhandledError(error) { console.error("filtered workload error:", error.message); return false; },' : ""}
  ${projects ? `projects: ["first", "second"].map(name => ({ extends: false, test: { name, include: [name + ".test.ts"], exclude: ["config-excluded.test.ts"], runner: ${JSON.stringify(path.join(root, "custom-runner.ts"))} } })),` : ""}
} };`,
        );
        for (const name of ["config-excluded", "cli-excluded"]) {
          files.write(name + ".test.ts", 'throw new Error("excluded files must not run");');
        }
        files.write(
          "custom-setup.ts",
          `export function setup(project) {
  project.provide("customSetupCount", (project.getProvidedContext().customSetupCount ?? 0) + 1);
}`,
        );
        files.write(
          "custom-runner.ts",
          `import { TestRunner } from "vitest";
export default class extends TestRunner {
  onCollectStart(file) { super.onCollectStart(file); globalThis.profileCustomRunner = true; }
}`,
        );
        for (const name of ["first", "second"]) {
          files.write(
            `${name}.test.ts`,
            `import fs from "node:fs";
import process from "node:process";
import { isMainThread, threadId } from "node:worker_threads";
import { expect, inject, it, vi } from "vitest";
function retain_${name}_heap_workload() {
  const blocks = [];
  for (let index = 0; index < 64; index++) blocks.push(new Array(65_536).fill(index));
  return blocks;
}
it("retains the selected execution context", async () => {
  // Keep a real named allocation alive through the sampler's final GC and stop.
  process[Symbol.for("openclaw.test.heap-workload.${name}")] = retain_${name}_heap_workload();
  vi.resetModules();
  expect(inject("customSetupCount")).toBe(1);
  expect(isMainThread).toBe(${pool === "forks"});
  expect(globalThis.profileCustomRunner === true).toBe(${custom});
  expect(typeof document).toBe(${JSON.stringify(environment === "jsdom" ? "object" : "undefined")});
  ${
    environment === "jsdom" && name === "first"
      ? `const unrelatedModule = ${JSON.stringify(path.join(repoRoot, "scripts/lib/error-format.mts"))};
  await expect(import(unrelatedModule)).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });`
      : ""
  }
  fs.writeFileSync(${JSON.stringify(path.join(root, name + ".json"))}, JSON.stringify({ pid: process.pid, threadId }));
  ${failProfile && name === "second" ? `fs.rmdirSync(${JSON.stringify(outputDir)});` : ""}
  ${unhandled && name === "second" ? 'process.emit("unhandledRejection", new Error("intentional unhandled profiling workload"), Promise.resolve());' : ""}
  ${failRun && name === "second" ? 'expect.fail("intentional profiling sibling failure");' : ""}
});`,
          );
        }
        const args = [
          path.join(repoRoot, "scripts/run-vitest-profile.mts"),
          "runner",
          "--output-dir",
          outputDir,
          "--",
          "--config",
          configPath,
          "--configLoader",
          "native",
          "--pool",
          pool,
          `--isolate=${isolate}`,
          "--maxWorkers",
          "1",
          "--environment",
          environment,
          "--exclude",
          "cli-excluded.test.ts",
        ];
        if (projects) {
          args.push("--reporter", "dot", "--reporter", "json");
        }
        const result = await runProfileProcess(args, root, signal);
        const reportText = fs.existsSync(files.path("report.json"))
          ? files.read("report.json")
          : "";
        const shouldFail = failRun || failProfile || (unhandled && errorPolicy === "default");
        expect(result.code, `${result.output}\n${reportText}`).toBe(shouldFail ? 1 : 0);
        expect(fs.readFileSync(configLoads, "utf8")).toBe("loaded\n");
        if (shouldFail) {
          expect(result.output.trimEnd()).toMatch(/\[run-vitest-profile\] FAILED \(exit 1\)$/u);
        }
        if (failRun) {
          expect(result.output).toContain("intentional profiling sibling failure");
        }
        if (unhandled) {
          expect(result.output).toContain("intentional unhandled profiling workload");
        }
        const report = JSON.parse(reportText);
        expect(report).toMatchObject({ numTotalTests: 2, numFailedTests: failRun ? 1 : 0 });
        if (failProfile) {
          expect(result.output).toContain("Failed to write Vitest profiles.");
          expect(result.output).toContain("ENOENT");
          expect(fs.existsSync(outputDir)).toBe(false);
          return;
        }
        const profiles = fs.readdirSync(outputDir);
        for (const name of ["first", "second"]) {
          const { pid, threadId } = files.json(name + ".json");
          const cpuFiles = profiles.filter((file) => file.startsWith(`CPU.${pid}.${threadId}.`));
          const heapFiles = profiles.filter((file) => file.startsWith(`Heap.${pid}.${threadId}.`));
          // Repeated files share one sampler unless Vitest actually creates another worker.
          expect(cpuFiles, result.output).toHaveLength(1);
          expect(heapFiles, result.output).toHaveLength(1);
          const cpu = JSON.parse(fs.readFileSync(path.join(outputDir, cpuFiles[0]!), "utf8"));
          const heap = JSON.parse(
            fs.readFileSync(path.join(outputDir, heapFiles[0]!), "utf8"),
          ) as HeapProfiler.SamplingHeapProfile;
          expect(cpu.nodes.length).toBeGreaterThan(0);
          expect(cpu.samples.length).toBeGreaterThan(0);
          expect(cpu.endTime).toBeGreaterThan(cpu.startTime);
          expect(heap.head.children.length).toBeGreaterThan(0);
          const nodes = [heap.head];
          for (const node of nodes) {
            nodes.push(...node.children);
          }
          const workload = nodes.find(
            (node) => node.callFrame.functionName === `retain_${name}_heap_workload`,
          );
          expect(workload?.selfSize).toBeGreaterThan(0);
        }
      }),
  );

  it("cancels an admitted profiling workload before releasing its inputs", ({ signal }) =>
    lifetime.run(async () => {
      const root = createProject("oc-profile-cancellation-");
      const ready = createDeferred();
      const release = path.join(root, "release");
      const config = path.join(root, "vitest.config.mjs");
      fs.writeFileSync(
        config,
        'export default { test: { include: ["workload.test.ts"], pool: "threads", maxWorkers: 1 } };',
      );
      fs.writeFileSync(
        path.join(root, "workload.test.ts"),
        `import fs from "node:fs";
import { setTimeout as tick } from "node:timers/promises";
import { it } from "vitest";
it("holds admitted work until the caller releases it", async () => {
  console.log("profile-workload-ready");
  while (!fs.existsSync(${JSON.stringify(release)})) await tick(5);
});`,
      );
      const controller = new AbortController();
      const completion = runProfileProcess(
        profileArgs(root, "runner", "--config", config, "--configLoader", "native"),
        root,
        AbortSignal.any([signal, controller.signal]),
        undefined,
        (stdout) => {
          if (stdout.includes("profile-workload-ready")) {
            ready.resolve();
          }
        },
      );
      try {
        await waitAtGate(
          ready.promise,
          completion,
          signal,
          `Child exited before writing ${path.join(root, "ready")}`,
        );
        const aborted = expect(completion).rejects.toMatchObject({ cause: { code: "ABORT_ERR" } });
        controller.abort();
        fs.writeFileSync(release, "released");
        await aborted;
      } finally {
        controller.abort();
        fs.writeFileSync(release, "released");
        await completion.catch(() => {});
      }
    }));

  it("prints repeated main help without starting a test server", ({ signal }) =>
    lifetime.run(async () => {
      const root = createTempDir("oc-profile-help-");
      const ordering = path.join(root, "hash-order.jsonl");
      const drained = path.join(root, "event-loop-drained");
      const profiles = path.join(root, "profiles");
      const preload = path.join(root, "observe-hash-order.mjs");
      fs.writeFileSync(
        preload,
        `import crypto from "node:crypto";
import fs from "node:fs";
import inspector from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
if (process.argv[1] === ${JSON.stringify(path.join(repoRoot, "scripts/run-vitest-profile-child.mts"))}) {
  process.once("beforeExit", () => fs.writeFileSync(${JSON.stringify(drained)}, "drained"));
}
let profiling = false;
inspector.Session = class extends inspector.Session {
  async post(method, ...params) {
    const result = await super.post(method, ...params);
    if (method === "Profiler.start") profiling = true;
    return result;
  }
};
const getHashes = crypto.getHashes;
let recorded = false;
crypto.getHashes = function() {
  if (!recorded) {
    recorded = true;
    const tlsLoaded = process.moduleLoadList.includes("NativeModule tls");
    fs.appendFileSync(${JSON.stringify(ordering)}, JSON.stringify({ tlsLoaded, profiling }) + "\\n");
    // Fail before entering the native lock race, rather than waiting for it to hang.
    if (tlsLoaded) throw new Error("TLS initialized before hash enumeration");
  }
  return getHashes();
};
syncBuiltinESMExports();`,
      );
      const args = profileArgs(root, "main", "--help", "--help");
      const result = await runProfileProcess(args, root, signal, {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      });
      expect(scriptFiles(root).jsonLines("hash-order.jsonl"), result.output).toEqual([
        { tlsLoaded: false, profiling: true },
      ]);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("Usage:");
      expect(fs.existsSync(drained), result.output).toBe(true);
      expect(fs.readdirSync(profiles)).toHaveLength(1);
    }));

  it.for([
    { mode: "main", flag: "--unknown-profile-test-option", error: "Unknown option" },
    { mode: "runner", flag: "--pool", error: "value is missing" },
  ])("rejects $mode $flag before evaluating config", ({ mode, flag, error }, { signal }) =>
    lifetime.run(async () => {
      const root = createTempDir("oc-profile-validation-");
      const config = path.join(root, "probe.config.mjs");
      const marker = path.join(root, "config-loaded");
      const uncaught = path.join(root, "uncaught-error");
      const preload = path.join(root, "observe-uncaught.mjs");
      fs.writeFileSync(
        preload,
        `import fs from "node:fs";
process.on("uncaughtExceptionMonitor", () => fs.writeFileSync(${JSON.stringify(uncaught)}, "uncaught"));`,
      );
      fs.writeFileSync(
        config,
        `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker)}, "loaded");
throw new Error("Invalid CLI options reached config loading");`,
      );
      const args = profileArgs(root, mode, "--config", config, "--configLoader", "native", flag);
      const result = await runProfileProcess(args, root, signal, {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(error);
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(uncaught), result.output).toBe(false);
      expect(fs.readdirSync(path.join(root, "profiles"))).toHaveLength(mode === "main" ? 1 : 0);
      expect(result.output.trimEnd()).toMatch(/\[run-vitest-profile\] FAILED \(exit 1\)$/u);
    }),
  );

  it("retains the CLI startup error when profile output cannot be written", ({ signal }) =>
    lifetime.run(async () => {
      const root = createTempDir("oc-profile-errors-");
      const plan = buildVitestProfileCommandWithArgs({
        mode: "main",
        outputDir: path.join(root, "missing"),
        vitestArgs: ["--config", "first.config.ts", "--config", "second.config.ts"],
      });
      const result = await runProfileProcess(plan.args, root, signal);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain("Expected a single value");
      expect(result.output).toContain("ENOENT");
    }));

  it.each([
    ["runner", ["--output-dir", "/tmp/out"], []],
    [
      "main",
      ["--output-dir", "/tmp/out", "--", "--config", "custom.ts"],
      ["--config", "custom.ts"],
    ],
    ["main", ["--", "--output-dir", "/tmp/out"], []],
  ] as const)("parses %s flags %j", (mode, flags, vitestArgs) => {
    expect(parseArgs([mode, ...flags])).toEqual({ mode, outputDir: "/tmp/out", vitestArgs });
  });

  it.each([[], ["-h"], ["--", "--config", "custom.ts"]])(
    "rejects missing profile directory before %j",
    (...args) => {
      expect(() => parseArgs(["runner", "--output-dir", ...args])).toThrow(
        "Expected --output-dir <dir>.",
      );
    },
  );

  it("passes Vitest targets into the runner command", () => {
    expect(
      buildVitestProfileCommandWithArgs({
        mode: "runner",
        outputDir: "/tmp/profile-runner",
        vitestArgs: ["src/example.test.ts"],
      }).args,
    ).toContain("src/example.test.ts");
  });
});
