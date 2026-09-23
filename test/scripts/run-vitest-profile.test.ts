// Run Vitest Profile tests cover run vitest profile script behavior.
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
import { decodeUtf8Tail } from "../helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { waitForFixtureFile } from "../helpers/process-wait.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { createScriptTestHarness } from "./test-helpers.js";

describe("scripts/run-vitest-profile", () => {
  const { trackTempDir } = createScriptTestHarness();
  const lifetime = createFixtureLifetime();
  const { createTempDir } = lifetime;
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  afterEach(() => lifetime.cleanup());

  async function runProfileProcess(
    args: string[],
    root: string,
    signal: AbortSignal,
    env?: NodeJS.ProcessEnv,
    diagnostics?: {
      mode: string;
      flags: string[];
      ordering: string;
      profiles: string;
      stages: string;
    },
  ) {
    let inspectChild: (() => unknown) | undefined;
    let reported = false;
    const reportFailure = () => {
      if (!diagnostics || reported) {
        return;
      }
      reported = true;
      try {
        let hashOrder: string;
        try {
          const fd = fs.openSync(diagnostics.ordering, "r");
          try {
            const bytes = Buffer.alloc(4096);
            hashOrder = bytes.subarray(0, fs.readSync(fd, bytes)).toString("utf8");
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          hashOrder = "unavailable";
        }
        let profileStages: string;
        try {
          const fd = fs.openSync(diagnostics.stages, "r");
          try {
            const bytes = Buffer.alloc(4096);
            profileStages = bytes.subarray(0, fs.readSync(fd, bytes)).toString("utf8");
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          profileStages = "unavailable";
        }
        let cpuProfiles: number | "unavailable";
        try {
          cpuProfiles = fs
            .readdirSync(diagnostics.profiles)
            .filter((name) => name.endsWith(".cpuprofile")).length;
        } catch {
          cpuProfiles = "unavailable";
        }
        console.error(
          "[run-vitest-profile failure]",
          JSON.stringify(
            {
              mode: diagnostics.mode,
              flags: diagnostics.flags,
              aborted: signal.aborted,
              child: inspectChild?.() ?? "not observed",
              hashOrder,
              profileStages,
              cpuProfiles,
            },
            (_key, value: unknown) =>
              typeof value === "string"
                ? value.replaceAll(root, "<fixture>").replaceAll(repoRoot, "<repo>")
                : value,
          ),
        );
      } catch {
        // Diagnostics must never interrupt the existing cancellation or cleanup owner.
        console.error("[run-vitest-profile failure] diagnostic capture failed");
      }
    };
    // Register before the managed command so timeout evidence precedes its stop/cleanup.
    signal.addEventListener("abort", reportFailure, { once: true });
    try {
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
              inspectChild = () => {
                const output = readOutput();
                return {
                  pid: child.pid,
                  exitCode: child.exitCode,
                  signalCode: child.signalCode,
                  killed: child.killed,
                  stdoutEnded: child.stdout?.readableEnded,
                  stderrEnded: child.stderr?.readableEnded,
                  stdout: decodeUtf8Tail(Buffer.from(output.stdout).subarray(-8192)),
                  stderr: decodeUtf8Tail(Buffer.from(output.stderr).subarray(-8192)),
                };
              };
            },
          },
        ),
      );
      const output = result.stdout + result.stderr;
      if (result.error || result.status !== 0) {
        reportFailure();
      }
      if (result.error) {
        throw new Error(`${formatErrorMessage(result.error)}\n${output}`, { cause: result.error });
      }
      return { code: result.status, output };
    } finally {
      signal.removeEventListener("abort", reportFailure);
    }
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

  it.each(["main", "runner"])(
    "launches %s without shell parsing and preserves Vitest arguments",
    (mode) => {
      const outputDir = path.join(os.tmpdir(), "profile with spaces");
      const forwarded = [
        "--config",
        "custom config.ts",
        "--pool",
        "threads",
        "--isolate",
        "--reporter",
        "json",
      ];
      const plan = buildVitestProfileCommandWithArgs({ mode, outputDir, vitestArgs: forwarded });
      expect(plan.command).toBe(process.execPath);
      expect(plan.args.slice(1, 3)).toEqual([mode, outputDir]);
      expect(plan.args.slice(-forwarded.length)).toEqual(forwarded);
    },
  );

  it.for([
    { pool: "forks", isolate: true, custom: false, failRun: false },
    { pool: "threads", isolate: true, custom: false, failRun: true },
    { pool: "forks", isolate: false, custom: false, failRun: true },
    { pool: "threads", isolate: false, custom: false, failRun: false },
    { pool: "forks", isolate: true, custom: true, failRun: true },
    { pool: "threads", isolate: true, custom: true, failRun: false },
    { pool: "forks", isolate: true, custom: true, failRun: false, projects: true },
    { pool: "forks", isolate: false, custom: false, failRun: false, failProfile: true },
    { pool: "threads", isolate: false, custom: false, failRun: true, failProfile: true },
    ...["ignore", "filter"].flatMap((errorPolicy) =>
      [false, true].map((failProfile) => ({
        pool: errorPolicy === "ignore" ? "forks" : "threads",
        isolate: false,
        custom: false,
        failRun: false,
        failProfile,
        unhandled: true,
        errorPolicy,
      })),
    ),
    { pool: "forks", isolate: false, custom: false, failRun: false, unhandled: true },
  ])(
    "profiles selected runner %j",
    (
      {
        pool,
        isolate,
        custom,
        failRun,
        projects = false,
        failProfile = false,
        unhandled = false,
        errorPolicy = "default",
      }: {
        pool: string;
        isolate: boolean;
        custom: boolean;
        failRun: boolean;
        projects?: boolean;
        failProfile?: boolean;
        unhandled?: boolean;
        errorPolicy?: string;
      },
      { signal },
    ) =>
      lifetime.run(async () => {
        const root = createTempDir("oc-profile-sibling-");
        fs.writeFileSync(path.join(root, "package.json"), '{"private":true,"type":"module"}');
        fs.symlinkSync(
          path.join(repoRoot, "node_modules"),
          path.join(root, "node_modules"),
          "junction",
        );
        const environment = custom && pool === "threads" ? "jsdom" : "node";
        const outputDir = path.join(root, "profiles with spaces");
        const configPath = path.join(root, "custom.config.ts");
        const configLoads = path.join(root, "config-loads");
        fs.writeFileSync(
          configPath,
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
          fs.writeFileSync(
            path.join(root, name + ".test.ts"),
            'throw new Error("excluded files must not run");',
          );
        }
        fs.writeFileSync(
          path.join(root, "custom-setup.ts"),
          `export function setup(project) {
  project.provide("customSetupCount", (project.getProvidedContext().customSetupCount ?? 0) + 1);
}`,
        );
        const customRunner = path.join(root, "custom-runner.ts");
        fs.writeFileSync(
          customRunner,
          `import { TestRunner } from "vitest";
export default class extends TestRunner {
  onCollectStart(file) { super.onCollectStart(file); globalThis.profileCustomRunner = true; }
}`,
        );
        for (const name of ["first", "second"]) {
          fs.writeFileSync(
            path.join(root, `${name}.test.ts`),
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
        const reportPath = path.join(root, "report.json");
        const reportText = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "";
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
        expect(report.numTotalTests).toBe(2);
        expect(report.numFailedTests).toBe(failRun ? 1 : 0);
        if (failProfile) {
          expect(result.output).toContain("Failed to write Vitest profiles.");
          expect(result.output).toContain("ENOENT");
          expect(fs.existsSync(outputDir)).toBe(false);
          return;
        }
        const profiles = fs.readdirSync(outputDir);
        for (const name of ["first", "second"]) {
          const { pid, threadId } = JSON.parse(
            fs.readFileSync(path.join(root, name + ".json"), "utf8"),
          );
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
      const root = createTempDir("oc-profile-cancellation-");
      const ready = path.join(root, "ready");
      const release = path.join(root, "release");
      const config = path.join(root, "vitest.config.mjs");
      fs.writeFileSync(path.join(root, "package.json"), '{"private":true,"type":"module"}');
      fs.symlinkSync(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
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
  fs.writeFileSync(${JSON.stringify(ready)}, "ready");
  while (!fs.existsSync(${JSON.stringify(release)})) await tick(5);
});`,
      );
      const controller = new AbortController();
      const completion = runProfileProcess(
        [
          path.join(repoRoot, "scripts/run-vitest-profile.mts"),
          "runner",
          "--output-dir",
          path.join(root, "profiles"),
          "--",
          "--config",
          config,
          "--configLoader",
          "native",
        ],
        root,
        AbortSignal.any([signal, controller.signal]),
      );
      try {
        await waitForFixtureFile(ready, completion, "ready");
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

  it.for([
    { mode: "main", flags: ["--help", "--unknown-profile-test-option"] },
    { mode: "runner", flags: ["-h", "--pool"] },
    { mode: "main", flags: ["--help", "--help"] },
    { mode: "runner", flags: ["--help", "--help"] },
  ])("prints $mode help for $flags without starting a test server", ({ mode, flags }, { signal }) =>
    lifetime.run(async () => {
      const root = createTempDir("oc-profile-help-");
      const ordering = path.join(root, "hash-order.jsonl");
      const drained = path.join(root, "event-loop-drained");
      const stages = path.join(root, "profile-stages.jsonl");
      const profiles = path.join(root, "profiles");
      const preload = path.join(root, "observe-hash-order.mjs");
      fs.writeFileSync(
        preload,
        `import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import inspector from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const childEntry = ${JSON.stringify(path.join(repoRoot, "scripts/run-vitest-profile-child.mts"))};
const role = process.argv[1] === childEntry ? "inner"
  : process.argv[1] === ${JSON.stringify(path.join(repoRoot, "scripts/run-vitest-profile.mts"))} ? "outer" : undefined;
const recordedStages = new Set();
function recordStage(stage, code = null, signal = null) {
  if (!role || recordedStages.has(stage) || recordedStages.size >= 16) return;
  recordedStages.add(stage);
  try {
    fs.appendFileSync(${JSON.stringify(stages)}, JSON.stringify({
      role, stage,
      code: Number.isSafeInteger(code) ? code : null,
      signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE", "SIGHUP", "SIGQUIT", "SIGPIPE", "SIGTRAP", "SIGUSR1", "SIGUSR2", "SIGXCPU", "SIGXFSZ", "SIGSYS"].includes(signal) ? signal : null,
    }) + "\\n");
  } catch {
    // Observation must not change finalization, exit, or the original error.
  }
}
recordStage("preload");
if (role === "inner") {
  process.once("beforeExit", () => fs.writeFileSync(${JSON.stringify(drained)}, "drained"));
}
if (role === "inner") process.once("exit", code => recordStage("exit-event", code));
const spawn = childProcess.spawn;
childProcess.spawn = function(...args) {
  const child = Reflect.apply(spawn, this, args);
  if (role === "outer" && args[0] === process.execPath && args[1]?.[0] === childEntry) {
    child.once("exit", (code, signal) => recordStage("child-exit", code, signal));
    child.once("close", (code, signal) => recordStage("child-close", code, signal));
  }
  return child;
};
const writeFile = fsPromises.writeFile;
fsPromises.writeFile = function(...args) {
  const target = args[0];
  const observe = role === "inner" && typeof target === "string"
    && path.dirname(target) === ${JSON.stringify(profiles)}
    && path.basename(target).startsWith("CPU.") && target.endsWith(".cpuprofile");
  if (observe) recordStage("write-requested");
  const result = Reflect.apply(writeFile, this, args);
  if (observe) result.then(
    () => recordStage("write-resolved"),
    () => recordStage("write-rejected"),
  );
  return result;
};
let profiling = false;
inspector.Session = class extends inspector.Session {
  async post(method, ...params) {
    if (method === "Profiler.stop") recordStage("stop-requested");
    try {
      const result = await super.post(method, ...params);
      if (method === "Profiler.start") profiling = true;
      if (method === "Profiler.stop") recordStage("stop-resolved");
      return result;
    } catch (error) {
      if (method === "Profiler.stop") recordStage("stop-rejected");
      throw error;
    }
  }
  disconnect(...args) {
    recordStage("disconnect-entered");
    const result = super.disconnect(...args);
    recordStage("disconnect-returned");
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
      const args = [
        path.join(repoRoot, "scripts/run-vitest-profile.mts"),
        mode,
        "--output-dir",
        path.join(root, "profiles"),
        "--",
        ...flags,
      ];
      const result = await runProfileProcess(
        args,
        root,
        signal,
        { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
        { mode, flags, ordering, profiles, stages },
      );
      expect(
        fs
          .readFileSync(ordering, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        result.output,
      ).toEqual([{ tlsLoaded: false, profiling: mode === "main" }]);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("Usage:");
      expect(fs.existsSync(drained), result.output).toBe(true);
      expect(fs.readdirSync(profiles)).toHaveLength(mode === "main" ? 1 : 0);
    }),
  );

  it.for(
    ["main", "runner"].flatMap((mode) => [
      { mode, flag: "--unknown-profile-test-option", error: "Unknown option" },
      { mode, flag: "--runner=custom-runner.ts", error: "Unknown option" },
      { mode, flag: "--pool", error: "value is missing" },
    ]),
  )("rejects $mode $flag before evaluating config", ({ mode, flag, error }, { signal }) =>
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
      const args = [
        path.join(repoRoot, "scripts/run-vitest-profile.mts"),
        mode,
        "--output-dir",
        path.join(root, "profiles"),
        "--",
        "--config",
        config,
        "--configLoader",
        "native",
        flag,
      ];
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

  it("keeps the public parser's unknown-option opt-in separate from value validation", async () => {
    const { parseCLI } = await import("vitest/node");
    const args = ["vitest", "run", "--unknown-profile-test-option"];
    expect(() => parseCLI([...args], { allowUnknownOptions: false })).toThrow("Unknown option");
    expect(parseCLI([...args], { allowUnknownOptions: true }).options).toMatchObject({
      unknownProfileTestOption: true,
    });
    expect(() => parseCLI(["vitest", "run", "--pool"], { allowUnknownOptions: true })).toThrow(
      "value is missing",
    );
    expect(() => parseCLI(["vitest", "init"])).toThrow("missing required args");
  });

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

  it("parses mode and explicit output dir", () => {
    expect(parseArgs(["runner", "--output-dir", "/tmp/out"])).toEqual({
      mode: "runner",
      outputDir: "/tmp/out",
      vitestArgs: [],
    });
  });

  it("rejects missing profile output directories", () => {
    expect(() => parseArgs(["runner", "--output-dir"])).toThrow("Expected --output-dir <dir>.");
    expect(() => parseArgs(["runner", "--output-dir", "-h"])).toThrow(
      "Expected --output-dir <dir>.",
    );
    expect(() => parseArgs(["runner", "--output-dir", "--", "--config", "custom.ts"])).toThrow(
      "Expected --output-dir <dir>.",
    );
  });

  it("passes vitest args after a separator", () => {
    expect(parseArgs(["main", "--output-dir", "/tmp/out", "--", "--config", "custom.ts"])).toEqual({
      mode: "main",
      outputDir: "/tmp/out",
      vitestArgs: ["--config", "custom.ts"],
    });
    expect(
      buildVitestProfileCommandWithArgs({
        mode: "runner",
        outputDir: "/tmp/profile-runner",
        vitestArgs: ["src/example.test.ts"],
      }).args,
    ).toContain("src/example.test.ts");
  });

  it("allows a package-script separator before script flags", () => {
    expect(parseArgs(["main", "--", "--output-dir", "/tmp/out"])).toEqual({
      mode: "main",
      outputDir: "/tmp/out",
      vitestArgs: [],
    });
  });
});
