import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPILER_ROW_IDENTITIES,
  COMPILER_ROW_LIMITS,
  COMPILER_ROW_POLICY,
  COMPILER_ROW_WORKLOAD,
  assertCompilerRowCgroup,
  auditCompilerRowReceipt,
  auditCompilerRows,
  compilerRowOverlay,
  compilerRowPlan,
  runCompilerRowPairs,
  verifyCompilerRowWorkload,
  type CompilerRow,
  type CompilerRowReceipt,
  type RowCgroupSnapshot,
  type RowCompiler,
} from "../../scripts/lib/compiler-comparison-rows.mts";
import { resolveRepoToolBinPath } from "../../scripts/lib/local-check-runtime.mts";
import { networkFixture } from "./compiler-comparison-network.fixtures.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const libraries = ["lib.es2022.d.ts"];
const generated = [
  "inputs.sha256",
  "openclaw-agent-db.generated.ts",
  "openclaw-state-db.generated.ts",
].map((name) => ({ path: ".artifacts/kysely/" + name, bytes: 100, sha256: "c".repeat(64) }));
const readonlyPaths = [
  "/work",
  "/upload-evidence",
  "/work/.artifacts/kysely",
  "/row-runtime",
  "/row-control",
  "/experiment/compiler",
  "/work/node_modules",
];
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
const snapshot = (): RowCgroupSnapshot => ({
  identity: { containerId: "a".repeat(64), pid: 100, device: 1, inode: 100, startTicks: "1000" },
  frozen: true,
  supervisorOnly: true,
  hierarchical: true,
  childCgroups: 0,
  memoryBytes: COMPILER_ROW_LIMITS.memoryBytes,
  swapBytes: 0,
  cpuSet: "0-3",
  oomGroup: 0,
  events: { oom: 0, oom_kill: 0, oom_group_kill: 0 },
});

function receipt(row: CompilerRow, compiler: RowCompiler = "pinned"): CompilerRowReceipt {
  const metrics = row.graphs.map((graph, index) => {
    const text = JSON.stringify({
      schemaVersion: 1,
      lockfileSha256: COMPILER_ROW_IDENTITIES.lockfile,
      nodeVersion: "v24.16.0",
      command: {
        bin: "/experiment/compiler/tsc",
        args: [
          "-p",
          graph.config,
          "--incremental",
          ...(["core", "ui", "extensions", "extensions-test", "scripts"].includes(graph.name)
            ? ["--tsBuildInfoFile", graph.cache]
            : []),
          "--declaration",
          "false",
          "--singleThreaded",
          "--checkers",
          "1",
          "--pretty",
          "false",
        ],
        cwd: "/work",
        timeoutMs: null,
      },
      outcome: { exitCode: 0, exitSignal: null, forwardedSignal: null, errorCode: null },
      resources: {
        policy: {
          OPENCLAW_LOCAL_CHECK_MODE: null,
          GOMAXPROCS: "2",
          GOGC: "30",
          GOMEMLIMIT: "3GiB",
        },
      },
    });
    return {
      path: `.artifacts/row-metrics/tsgo-00000000-0000-4000-8000-${String(index).padStart(12, "0")}.json`,
      text,
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
    };
  });
  const cache = row.graphs.map((graph) => ({
    path: graph.cache,
    bytes: 100,
    sha256: "a".repeat(64),
    fileNames: ["lib.es2022.d.ts", "../../src/input.ts"],
  }));
  const mount = { device: 2, inode: 300 };
  const state = snapshot();
  state.identity.containerId = hash(row.name + "/" + compiler);
  return {
    row: row.name,
    compiler,
    processExitCode: 0,
    processSignal: null,
    cleanupVerified: true,
    preCleanupState: {
      available: true,
      Status: "exited",
      Running: false,
      OOMKilled: false,
      ExitCode: 0,
    },
    stdout: row.graphs
      .map(
        (graph, index) =>
          `[ci-static:tsgo:leaf] ${JSON.stringify({ version: 1, id: `invocation:${index}`, config: graph.config, exitCode: 0, stdout: "", stderr: "" })}\n`,
      )
      .join(""),
    stderr: "",
    observation: {
      scratch: { uid: 1000, gid: 1000, mode: 0o700 },
      before: structuredClone(state),
      after: structuredClone(state),
      beforeFiles: { mount, generated, cache: [], metrics: [], totalBytes: 0 },
      files: {
        mount,
        generated,
        cache,
        metrics,
        totalBytes: [...metrics, ...cache].reduce((total, entry) => total + entry.bytes, 0),
      },
      finish: {
        code: 0,
        signal: null,
        exitCode: 0,
        startedAt: "2026-10-20T00:00:00.000Z",
        finishedAt: "2026-10-20T00:00:01.000Z",
      },
    },
  };
}

function artifact() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-row-audit-"));
  temporary.push(directory);
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  const plan = compilerRowPlan();
  const receipts = plan.flatMap((row) =>
    (["pinned", "candidate"] as const).map((compiler) => receipt(row, compiler)),
  );
  const smokeNames = [
    "isolation",
    "runtime",
    "joined",
    "ordinary-collect",
    "ordinary-static",
    "oom",
    "explicit-137",
    "deadline",
    "descendant",
  ];
  const smokes = smokeNames.map((name) => {
    const result = receipt({ ...plan[0]!, name, graphs: [] });
    const exit =
      name === "ordinary-collect"
        ? 1
        : name === "ordinary-static"
          ? 2
          : ["oom", "explicit-137"].includes(name)
            ? 137
            : 0;
    result.processExitCode = exit;
    result.preCleanupState = {
      available: true,
      Status: "exited",
      Running: false,
      OOMKilled: name === "oom",
      ExitCode: exit,
    };
    result.observation.finish!.code = exit;
    result.observation.finish!.exitCode = exit;
    if (name.startsWith("ordinary-")) result.stdout = "continued\n";
    if (name === "oom" || name === "explicit-137") {
      result.observation.before!.memoryBytes = 128 * 1024 ** 2;
      result.observation.after!.memoryBytes = 128 * 1024 ** 2;
    }
    if (name === "oom") {
      result.observation.after!.events = { oom: 1, oom_kill: 1, oom_group_kill: 0 };
      result.observation.finish!.code = null;
      result.observation.finish!.signal = "SIGKILL";
      result.stdout = "child-oom-score=1000\n";
    }
    if (name === "deadline" || name === "descendant") {
      delete result.observation.after;
      delete result.observation.finish;
      result.processSignal = "SIGKILL";
      result.processExitCode = null;
      result.infrastructureError =
        name === "descendant" ? "Frozen row descendants remain" : "deadline";
    }
    if (name === "isolation") {
      result.isolation = {
        network: networkFixture(),
        readonlyPaths,
        hostAbsent: true,
        writable: [
          {
            path: "/tmp",
            bytes: COMPILER_ROW_LIMITS.temporaryBytes,
            type: 0x01021994,
            write: "verified",
          },
          {
            path: "/work/.artifacts",
            bytes: COMPILER_ROW_LIMITS.artifactBytes,
            type: 0x01021994,
            write: "verified",
          },
        ],
      };
    }
    return result;
  });
  // Read the pinned dependency's real library inventory; no compiler is executed.
  const libraryRoot = path.dirname(resolveRepoToolBinPath("tsgo"));
  const libraryManifest = fs
    .readdirSync(libraryRoot)
    .filter((name) => name.startsWith("lib.") && name.endsWith(".d.ts"))
    .toSorted()
    .map((name) => ({ name, sha256: hash(fs.readFileSync(path.join(libraryRoot, name))) }));
  const runtimeFiles = [
    "bin/node",
    "bin/pnpm",
    "bin/ps",
    "ps-bin",
    "ps-libs/ld-linux-x86-64.so.2",
    "pnpm/bin/pnpm.mjs",
    "pnpm/node_modules/@pnpm/exe.linux-x64/package.json",
  ].map((name) => ({ name, sha256: "d".repeat(64) }));
  const metadata = {
    sourceHead: "b".repeat(40),
    workloadHead: COMPILER_ROW_WORKLOAD,
    wrapperAdmission: {
      policy: COMPILER_ROW_POLICY,
      performanceEligible: false,
      checkingCalls: 76,
      rowArms: 14,
    },
    binarySha256: {
      pinned: COMPILER_ROW_IDENTITIES.pinned,
      candidate: COMPILER_ROW_IDENTITIES.candidate,
    },
    libraryManifest,
    generated,
    readonlyMounts: readonlyPaths,
    overlay: {
      beforeSha256: COMPILER_ROW_IDENTITIES.wrapper,
      afterSha256: COMPILER_ROW_IDENTITIES.overlay,
    },
    lockfileSha256: COMPILER_ROW_IDENTITIES.lockfile,
    runtime: {
      nodeVersion: "v24.16.0",
      pnpmVersion: "12.11.1",
      user: { uid: 1000, gid: 1000 },
      files: runtimeFiles,
      manifestSha256: hash(JSON.stringify(runtimeFiles)),
    },
    limits: { ...COMPILER_ROW_LIMITS, cpuSet: "0-3" },
    cpus: 4,
    extraCompilerCalls: { versions: 2, discovery: 0, api: 0, declarations: 0 },
    recordedChecking: 76,
  };
  write("metadata.json", metadata);
  write("row-plan.json", plan);
  write("row-smokes.json", smokes);
  write("row-receipts.json", receipts);
  return { directory, write, metadata, receipts, smokes };
}

describe("canonical wrapper admission", () => {
  it("retains all seven CI rows and checks the frozen cache and overlay contracts", () => {
    const rows = compilerRowPlan();
    expect(rows.map((row) => row.graphs.length)).toEqual([3, 2, 6, 7, 7, 7, 6]);
    expect(new Set(rows.flatMap((row) => row.graphs.map((graph) => graph.config))).size).toBe(38);
    expect(rows.slice(3).map((row) => row.command.at(-1))).toEqual(
      [1, 2, 3, 4].map((index) => expect.stringContaining(`--root-stripe ${index}/4`)),
    );
    verifyCompilerRowWorkload(process.cwd());
    const source = fs.readFileSync("scripts/run-tsgo.mts", "utf8");
    expect(hash(compilerRowOverlay(source))).toBe(COMPILER_ROW_IDENTITIES.overlay);
    expect(() => compilerRowOverlay(`${source}\n`)).toThrow("Unexpected workload wrapper");
  });

  it("requires every metric and canonical leaf even when the row shell exits zero", () => {
    const row = compilerRowPlan()[0]!;
    const good = receipt(row);
    expect(auditCompilerRowReceipt(row, good, "0-3", libraries, generated)).toHaveLength(3);
    const missing = structuredClone(good);
    missing.observation.files!.metrics.pop();
    expect(() => auditCompilerRowReceipt(row, missing, "0-3", libraries, generated)).toThrow(
      "Missing or extra checking invocation",
    );
    const lostLeaf = structuredClone(good);
    lostLeaf.stdout = lostLeaf.stdout.split("\n").slice(1).join("\n");
    expect(() => auditCompilerRowReceipt(row, lostLeaf, "0-3", libraries, generated)).toThrow(
      "canonical leaf",
    );
    const forged = structuredClone(good);
    forged.observation.files!.metrics[0]!.text += " ";
    expect(() => auditCompilerRowReceipt(row, forged, "0-3", libraries, generated)).toThrow();
  });

  it("audits all fourteen arms and seventy-six leaves without running a compiler", () => {
    const fixture = artifact();
    expect(auditCompilerRows(fixture.directory)).toMatchObject({
      qualificationPassed: true,
      wrapperAdmissionPassed: true,
      attemptedRowArms: 14,
      recordedChecking: 76,
      completedChecking: 76,
      missing: [],
      rejected: [],
      performanceEligible: false,
    });
  });

  it.each([1, 2])(
    "rejects a parent exit%d with clean matching leaves and stops later rows",
    async (exitCode) => {
      const fixture = artifact();
      fixture.receipts.splice(2);
      const failed = fixture.receipts[1]!;
      failed.processExitCode = exitCode;
      failed.preCleanupState = {
        available: true,
        Status: "exited",
        Running: false,
        OOMKilled: false,
        ExitCode: exitCode,
      };
      failed.observation.finish!.code = exitCode;
      failed.observation.finish!.exitCode = exitCode;
      fixture.metadata.recordedChecking = 6;
      fixture.write("metadata.json", fixture.metadata);
      fixture.write("row-receipts.json", fixture.receipts);
      const verdict = auditCompilerRows(fixture.directory);
      expect(verdict).toMatchObject({
        qualificationPassed: false,
        attemptedRowArms: 2,
        recordedChecking: 6,
      });
      expect(verdict.missing).toHaveLength(12);
      expect(verdict.rejected[0]?.reason).toContain("Canonical row shell failed");
      const started: string[] = [];
      await expect(
        runCompilerRowPairs({
          cpuSet: "0-3",
          libraryNames: libraries,
          generated,
          async run(row, compiler) {
            started.push(row.name + "/" + compiler);
            return compiler === "pinned" ? fixture.receipts[0]! : failed;
          },
          retain() {},
        }),
      ).rejects.toThrow("Canonical row shell failed");
      expect(started).toEqual(["prod-types/pinned", "prod-types/candidate"]);
    },
  );

  it.each([
    "docker",
    "pid",
    "generated",
    "missing-isolation",
    "forged-isolation",
    "missing-scratch",
    "scratch-uid",
    "scratch-gid",
    "scratch-mode",
  ])("rejects altered %s proof", (kind) => {
    const fixture = artifact();
    if (kind === "docker")
      fixture.receipts[0]!.observation.after!.identity.containerId = "0".repeat(64);
    if (kind === "pid") fixture.receipts[0]!.observation.after!.identity.pid += 1;
    if (kind === "generated")
      fixture.receipts[0]!.observation.files!.generated = [
        { ...generated[0]!, sha256: "0".repeat(64) },
        ...generated.slice(1),
      ];
    if (kind === "missing-isolation") delete fixture.smokes[0]!.isolation;
    if (kind === "forged-isolation") fixture.smokes[0]!.isolation!.writable[0]!.bytes *= 2;
    if (kind === "missing-scratch") delete fixture.receipts[0]!.observation.scratch;
    if (kind === "scratch-uid") fixture.receipts[0]!.observation.scratch!.uid += 1;
    if (kind === "scratch-gid") fixture.receipts[0]!.observation.scratch!.gid += 1;
    if (kind === "scratch-mode") fixture.receipts[0]!.observation.scratch!.mode = 0o777;
    fixture.write("row-receipts.json", fixture.receipts);
    fixture.write("row-smokes.json", fixture.smokes);
    expect(() => auditCompilerRows(fixture.directory)).toThrow();
  });

  it.each([
    { row: "oom", OOMKilled: false },
    { row: "explicit-137", OOMKilled: true },
  ])("rejects $row with OOMKilled=$OOMKilled", ({ row, OOMKilled }) => {
    const fixture = artifact();
    const smoke = fixture.smokes.find((entry) => entry.row === row)!;
    smoke.preCleanupState = { ...(smoke.preCleanupState as Record<string, unknown>), OOMKilled };
    fixture.write("row-smokes.json", fixture.smokes);
    expect(() => auditCompilerRows(fixture.directory)).toThrow();
  });

  it("retains a candidate diagnostic mismatch and never starts the next row", async () => {
    const row = compilerRowPlan()[0]!;
    const candidate = receipt(row, "candidate");
    const diagnostic = "src/input.ts(1,1): error TS2322: incompatible type.\n";
    const metric = candidate.observation.files!.metrics[0]!;
    const parsed = JSON.parse(metric.text) as { outcome: { exitCode: number } };
    parsed.outcome.exitCode = 2;
    metric.text = JSON.stringify(parsed);
    metric.sha256 = hash(metric.text);
    metric.bytes = Buffer.byteLength(metric.text);
    const lines = candidate.stdout.trimEnd().split("\n");
    const leaf = JSON.parse(lines[0]!.slice("[ci-static:tsgo:leaf] ".length)) as {
      exitCode: number;
      stdout: string;
    };
    leaf.exitCode = 2;
    leaf.stdout = diagnostic;
    lines[0] = "[ci-static:tsgo:leaf] " + JSON.stringify(leaf);
    candidate.stdout = lines.join("\n") + "\n";
    candidate.observation.files!.totalBytes = [
      ...candidate.observation.files!.metrics,
      ...candidate.observation.files!.cache,
    ].reduce((total, file) => total + file.bytes, 0);
    const retained: CompilerRowReceipt[] = [];
    await expect(
      runCompilerRowPairs({
        cpuSet: "0-3",
        libraryNames: libraries,
        generated,
        async run(next, compiler) {
          expect(next.name).toBe(row.name);
          return compiler === "pinned" ? receipt(row) : candidate;
        },
        retain(result) {
          retained.push(result);
        },
      }),
    ).rejects.toThrow("Compiler outcomes or input sets differ");
    expect(retained.map((result) => result.compiler)).toEqual(["pinned", "candidate"]);
  });

  it.each([
    { frozen: false },
    { supervisorOnly: false },
    { hierarchical: false },
    { childCgroups: 1 },
    { events: { oom: 1, oom_kill: 1, oom_group_kill: 0 } },
    { events: { oom: 0, oom_kill: -1, oom_group_kill: 0 } },
    { identity: { ...snapshot().identity, inode: 101 } },
    { identity: { ...snapshot().identity, pid: 101 } },
    { identity: { ...snapshot().identity, containerId: "b".repeat(64) } },
  ])("rejects incomplete or unsafe cgroup proof: %j", (change) => {
    const after = Object.assign(snapshot(), change);
    expect(() =>
      assertCompilerRowCgroup(snapshot(), after, COMPILER_ROW_LIMITS.memoryBytes, "0-3"),
    ).toThrow();
  });

  it("distinguishes the positive child OOM control from a bare exit137", () => {
    const before = { ...snapshot(), memoryBytes: 128 * 1024 ** 2 };
    const after = structuredClone(before);
    expect(() => assertCompilerRowCgroup(before, after, before.memoryBytes, "0-3", true)).toThrow(
      "did not kill a child",
    );
    after.events = { oom: 1, oom_kill: 1, oom_group_kill: 0 };
    expect(() =>
      assertCompilerRowCgroup(before, after, before.memoryBytes, "0-3", true),
    ).not.toThrow();
    expect(() => assertCompilerRowCgroup(before, after, before.memoryBytes, "0-3")).toThrow(
      "observed an OOM",
    );
  });

  it.each(["terminal", "cleanup", "child-oom"])(
    "retains rejected %s evidence and never starts the next arm or row",
    async (failure) => {
      const started: string[] = [];
      const retained: CompilerRowReceipt[] = [];
      await expect(
        runCompilerRowPairs({
          cpuSet: "0-3",
          libraryNames: libraries,
          generated,
          async run(row, compiler) {
            started.push(`${row.name}/${compiler}`);
            const result = receipt(row, compiler);
            if (failure === "terminal") {
              result.preCleanupState = { available: false };
            } else if (failure === "cleanup") {
              result.cleanupVerified = false;
            } else {
              result.observation.after!.events = { oom: 1, oom_kill: 1, oom_group_kill: 0 };
            }
            return result;
          },
          retain(value) {
            retained.push(value);
          },
        }),
      ).rejects.toThrow();
      expect(started).toEqual(["prod-types/pinned"]);
      expect(retained).toHaveLength(1);
    },
  );
});

describe("frozen descriptor reads", () => {
  it.skipIf(process.platform === "win32")(
    "rejects symlink ancestors and FIFO leaves without following or blocking",
    () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-row-files-"));
      temporary.push(directory);
      fs.mkdirSync(path.join(directory, "inside"));
      fs.mkdirSync(path.join(directory, "outside"));
      fs.writeFileSync(path.join(directory, "outside/secret"), "not evidence");
      fs.symlinkSync(path.join(directory, "outside"), path.join(directory, "inside/link"));
      expect(spawnSync("mkfifo", [path.join(directory, "inside/fifo")]).status).toBe(0);
      const helper = new URL("../../scripts/lib/compiler-comparison-row-files.py", import.meta.url)
        .pathname;
      const script = `import importlib.util,os,sys
spec=importlib.util.spec_from_file_location("reader",sys.argv[1]); reader=importlib.util.module_from_spec(spec); spec.loader.exec_module(reader)
root=os.open(sys.argv[2],reader.DIRECTORY)
rejected=0
for name in ("link/secret","fifo"):
 try:
  fd=reader.open_beneath(root,name)
  try: reader.read_fd(fd,1024)
  finally: os.close(fd)
 except (OSError,ValueError): rejected+=1
os.close(root)
assert rejected==2
print("rejected ancestor and FIFO")`;
      const result = spawnSync("python3", ["-c", script, helper, path.join(directory, "inside")], {
        encoding: "utf8",
        timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("rejected ancestor and FIFO\n");
    },
  );
});
