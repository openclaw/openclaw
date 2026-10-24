import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditCompilerComparison } from "../../scripts/audit-compiler-comparison.mts";
import {
  COMPILER_CACHE_EVIDENCE_LIMIT,
  COMPILER_CACHE_FILE_LIMIT,
  COMPILER_CACHE_POLICY,
  compilerCacheFixture,
  compilerCachePlan,
  copyCompilerCacheFile,
  readCompilerCacheFile,
  readCompilerCacheOutput,
} from "../../scripts/lib/compiler-comparison-cache.mts";
import { networkFixture } from "./compiler-comparison-network.fixtures.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function temp() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-cache-"));
  temporary.push(directory);
  return directory;
}

describe("bounded build-info transport", () => {
  it("copies exact regular bytes, refuses overwrite and rejects oversized input", () => {
    const directory = temp();
    const source = path.join(directory, "seed");
    const target = path.join(directory, "output");
    fs.writeFileSync(source, '{"version":"7.0.2"}');
    expect(copyCompilerCacheFile(source, target)).toEqual({
      bytes: 19,
      sha256: hash('{"version":"7.0.2"}'),
    });
    expect(fs.readFileSync(target)).toEqual(fs.readFileSync(source));
    expect(() => copyCompilerCacheFile(source, target)).toThrow();
    fs.truncateSync(source, COMPILER_CACHE_FILE_LIMIT + 1);
    expect(() => copyCompilerCacheFile(source, path.join(directory, "oversized"))).toThrow("4 MiB");
    expect(fs.existsSync(path.join(directory, "oversized"))).toBe(false);
    fs.truncateSync(source, 0);
    expect(() => readCompilerCacheFile(source)).toThrow("must not be empty");
  });

  it.skipIf(process.platform === "win32")("rejects symlinks and FIFOs without blocking", () => {
    const directory = temp();
    const fifo = path.join(directory, "fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const module = new URL("../../scripts/lib/compiler-comparison-cache.mts", import.meta.url);
    const result = spawnSync(
      process.execPath,
      [module.pathname, "copy", fifo, path.join(directory, "output")],
      { encoding: "utf8", timeout: 2000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(77);
    expect(result.stderr).toContain("[compiler-cache] FAILED (exit 77)");
    expect(fs.existsSync(path.join(directory, "output"))).toBe(false);
    fs.symlinkSync(fifo, path.join(directory, "link"));
    expect(() => readCompilerCacheFile(path.join(directory, "link"))).toThrow();
  });
});

describe("cache producer admission", () => {
  it.each([
    { available: false },
    { available: true, Status: "running", Running: true, OOMKilled: false, ExitCode: 0 },
    { available: true, Status: "exited", Running: false, OOMKilled: true, ExitCode: 0 },
    { available: true, Status: "exited", Running: false, OOMKilled: false, ExitCode: 137 },
  ])("rejects invalid terminal evidence before the seed reader runs: %j", (preCleanupState) => {
    const receipt = {
      processExitCode: 0,
      processSignal: null,
      cleanupVerified: true,
      preCleanupState,
    };
    // There is deliberately no output file. Producer admission must fail first,
    // before a caller can read or hand this invocation's cache to a dependent phase.
    expect(() =>
      readCompilerCacheOutput(path.join(temp(), "unadmitted-output"), receipt, 0),
    ).toThrow("Cache producer is not a verified terminal invocation");
  });
});

function fixture(fileNames = ["lib.es2022.d.ts", "../case/input.ts"]) {
  const directory = temp();
  fs.mkdirSync(path.join(directory, "cache"));
  fs.mkdirSync(path.join(directory, "metrics"));
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  const read = <T>(name: string): T =>
    JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as T;
  const plan = compilerCachePlan();
  const execution = (exitCode: number) => ({
    processExitCode: exitCode,
    processSignal: null,
    cleanupVerified: true,
    preCleanupState: {
      available: true,
      Status: "exited",
      Running: false,
      OOMKilled: false,
      ExitCode: exitCode,
    },
  });
  const graph = { name: "cache-contract", config: "/case/tsconfig.json" };
  write("network-isolation.json", networkFixture());
  write("inventory.json", { inventory: [graph], graphs: [graph], group: 0, groups: 1 });
  write("metadata.json", {
    sourceHead: "a".repeat(40),
    repeats: 1,
    group: 0,
    groups: 1,
    binarySha256: { pinned: "a".repeat(64), candidate: "b".repeat(64), reference: "c".repeat(64) },
    libraryManifest: [{ name: "lib.es2022.d.ts", sha256: "d".repeat(64) }],
    expectedSamples: plan.map((phase) => phase.id),
    cpus: 4,
    limits: { memoryBytes: 12 * 1024 ** 3, swapBytes: 0 },
    ciPolicy: { args: [], env: { GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" } },
    cacheWrapperSmoke: {
      exits: [0, 1, 2, 137].map((exitCode) => ({
        ...execution(exitCode),
        cacheSha256: hash("{}"),
        admitted: exitCode !== 137,
      })),
      exportFailure: execution(77),
      deadline: {
        ...execution(0),
        processExitCode: null,
        processSignal: "SIGKILL",
        preCleanupState: {
          available: true,
          Status: "running",
          Running: true,
          OOMKilled: false,
          ExitCode: 0,
        },
      },
    },
    cacheCorrectness: {
      policy: COMPILER_CACHE_POLICY,
      compilerPath: "/compiler/tsc",
      libraryPath: "/compiler",
      fixturePath: "/case",
      nodeVersion: "v24.16.0",
      nodeBinarySha256: "e".repeat(64),
      fileLimit: COMPILER_CACHE_FILE_LIMIT,
      scratchLimit: 3 * COMPILER_CACHE_FILE_LIMIT,
      evidenceLimit: COMPILER_CACHE_EVIDENCE_LIMIT,
      performanceEligible: false,
      seedAcceptance: "A seed is offered; compiler cache acceptance is not inferred.",
    },
  });
  const outputs = new Map<string, { file: string; bytes: number; sha256: string }>();
  let evidenceBytes = 0;
  const retain = (file: string, bytes: Buffer) => {
    fs.writeFileSync(path.join(directory, "cache", file), bytes);
    evidenceBytes += bytes.length;
    return { file, bytes: bytes.length, sha256: hash(bytes) };
  };
  const phases = [];
  const rows = [];
  for (const phase of plan) {
    const input = compilerCacheFixture(phase.state);
    let seedCache = phase.seed ? outputs.get(phase.seed)! : null;
    if (phase.truncate) {
      const bytes = fs.readFileSync(path.join(directory, "cache", seedCache!.file));
      seedCache = retain(
        `seed-${phase.id}.tsbuildinfo`,
        bytes.subarray(0, Math.floor(bytes.length / 2)),
      );
    }
    const outputCache = retain(
      phase.id + ".tsbuildinfo",
      Buffer.from(
        JSON.stringify({
          fileNames,
          version: "7.0.2",
          fixture: phase.id,
        }),
      ),
    );
    outputs.set(phase.id, outputCache);
    phases.push({
      ...phase,
      input,
      inputSha256: hash(JSON.stringify(input)),
      seedCache,
      outputCache,
    });
    const exitCode = phase.state === "clean" ? 0 : phase.compiler === "reference" ? 1 : 2;
    const stdout =
      phase.state === "clean"
        ? ""
        : phase.state === "missing"
          ? "../case/input.ts(1,23): error TS2307: Cannot find module './dep.js'.\n"
          : "../case/input.ts(2,14): error TS2322: Type mismatch.\n";
    fs.writeFileSync(path.join(directory, phase.id + ".stdout"), stdout);
    fs.writeFileSync(path.join(directory, phase.id + ".stderr"), "");
    const metrics = { exitCode, wallSeconds: 1, userSeconds: 1, sysSeconds: 0, peakRssKiB: 1024 };
    write(`metrics/${phase.id}.json`, {
      ...metrics,
      processExitCode: exitCode,
      processSignal: null,
      cleanupVerified: true,
      preCleanupState: {
        available: true,
        Status: "exited",
        Running: false,
        OOMKilled: false,
        ExitCode: exitCode,
      },
    });
    rows.push({
      id: phase.id,
      compiler: phase.compiler,
      graph: graph.name,
      config: graph.config,
      mode: "incremental-cold",
      iteration: 1,
      flags: [
        "-p",
        "/case/tsconfig.json",
        "--noEmit",
        "--declaration",
        "false",
        "--pretty",
        "false",
        "--incremental",
        "true",
        "--tsBuildInfoFile",
        "/cache/project.tsbuildinfo",
        "--singleThreaded",
        "--checkers",
        "1",
      ],
      ...metrics,
      diagnosticSha256: hash(stdout),
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
    });
  }
  write("measurements.json", rows);
  write("cache-contract.json", { policy: COMPILER_CACHE_POLICY, phases, evidenceBytes });
  return { directory, write, read, rows, phases };
}

describe("synthetic cache artifact admission", () => {
  it.each([
    ["lib.es2022.d.ts", "../case/input.ts"],
    ["../compiler/lib.es2022.d.ts", "../case/input.ts"],
    ["/compiler/lib.es2022.d.ts", "/case/input.ts"],
  ])("accepts exact manifest and fixture source identities: %j", (...fileNames) => {
    expect(auditCompilerComparison(fixture(fileNames).directory).qualificationPassed).toBe(true);
  });

  it.each([
    "lib.unknown.d.ts",
    "../compiler/lib.unknown.d.ts",
    "../case/unplanned.ts",
    "../case/nested/input.ts",
    "../../etc/passwd",
    "/private/input.ts",
    "nested/../../compiler/lib.es2022.d.ts",
  ])("rejects a source outside the exact input manifests: %s", (name) => {
    expect(() => auditCompilerComparison(fixture([name]).directory)).toThrow(
      "Unexpected cache source path",
    );
  });

  it("accounts for all 56 calls and keeps the four handoff seeds immutable across edits", () => {
    const artifact = fixture();
    const result = auditCompilerComparison(artifact.directory);
    expect(result).toMatchObject({
      qualificationPassed: true,
      cacheCorrectnessPassed: true,
      plannedCalls: 56,
      completedCalls: 56,
      performanceEligible: false,
    });
    const handoffs = artifact.phases.filter(
      (phase) => phase.id.includes("-to-") && phase.id.endsWith("-edited"),
    );
    expect(handoffs).toHaveLength(4);
    for (const phase of handoffs) {
      expect(phase.seed).toBe(phase.id.replace(/-edited$/u, "-seed"));
    }
    const dependency = artifact.phases.find((phase) => phase.id === "candidate-dependency")!;
    expect(dependency.input["dep.d.ts"]).toBe("export declare const value: string;\n");
    expect(fs.readdirSync(path.join(artifact.directory, "cache"))).toHaveLength(59);
  });

  it("rejects missing calls even when their numeric receipts exist", () => {
    const artifact = fixture();
    artifact.write("measurements.json", artifact.rows.slice(1));
    expect(() => auditCompilerComparison(artifact.directory)).toThrow("Missing cache measurement");
  });

  it("rejects a process 137 receipt whose GNU time exit was zero", () => {
    const artifact = fixture();
    const name = "metrics/pinned-cold.json";
    const metric = artifact.read<Record<string, unknown>>(name);
    artifact.write(name, { ...metric, processExitCode: 137 });
    expect(() => auditCompilerComparison(artifact.directory)).toThrow(
      "Container/time exit mismatch",
    );
  });

  it("rejects an edited handoff that receives the receiver's rewritten cache", () => {
    const artifact = fixture();
    const edited = artifact.phases.find((phase) => phase.id === "pinned-to-candidate-edited")!;
    const rewritten = artifact.phases.find(
      (phase) => phase.id === "pinned-to-candidate-unchanged",
    )!;
    edited.seedCache = rewritten.outputCache;
    const contract = artifact.read<Record<string, unknown>>("cache-contract.json");
    artifact.write("cache-contract.json", { ...contract, phases: artifact.phases });
    expect(() => auditCompilerComparison(artifact.directory)).toThrow("immutable producer cache");
  });

  it("rejects an unjoined invocation even when compiler diagnostics match", () => {
    const artifact = fixture();
    const name = "metrics/pinned-cold.json";
    artifact.write(name, {
      ...artifact.read<Record<string, unknown>>(name),
      cleanupVerified: false,
    });
    expect(() => auditCompilerComparison(artifact.directory)).toThrow();
  });

  it("rejects raw cache changes and unplanned cache files", () => {
    const artifact = fixture();
    const file = path.join(artifact.directory, "cache/pinned-cold.tsbuildinfo");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, "{}");
    expect(() => auditCompilerComparison(artifact.directory)).toThrow();
    fs.writeFileSync(file, original);
    fs.writeFileSync(path.join(artifact.directory, "cache/unplanned"), "{}");
    expect(() => auditCompilerComparison(artifact.directory)).toThrow("Unexpected cache inventory");
  });

  it("does not accept stale success after a diagnostic-changing handoff", () => {
    const artifact = fixture();
    const id = "pinned-to-candidate-edited";
    const row = artifact.rows.find((entry) => entry.id === id)!;
    Object.assign(row, { exitCode: 0, diagnosticSha256: hash(""), stdoutBytes: 0 });
    artifact.write("measurements.json", artifact.rows);
    fs.writeFileSync(path.join(artifact.directory, id + ".stdout"), "");
    const metric = artifact.read<Record<string, unknown>>(`metrics/${id}.json`);
    artifact.write(`metrics/${id}.json`, {
      ...metric,
      exitCode: 0,
      processExitCode: 0,
      preCleanupState: {
        available: true,
        Status: "exited",
        Running: false,
        OOMKilled: false,
        ExitCode: 0,
      },
    });
    expect(auditCompilerComparison(artifact.directory)).toMatchObject({
      qualificationPassed: false,
      cacheCorrectnessPassed: false,
      status: "divergent",
    });
  });
});
