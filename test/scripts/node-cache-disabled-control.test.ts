import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import { NODE_CACHE_DISABLED_INPUTS } from "../../scripts/lib/node-cache-disabled-control.mts";
import {
  hashPreparedPnpmExecutable,
  validateWorkloadDefinition,
} from "../../scripts/lib/node-cache-workload-inputs.mts";
import { sha256 } from "../../scripts/lib/vitest-pair-benchmark-contract.mts";
import { runOwnedCommand } from "../../scripts/lib/vitest-pair-benchmark.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const uncertainRoots = new Set<string>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    if (uncertainRoots.size) {
      throw new Error("Retaining fixtures with uncertain child settlement");
    }
    cleanup();
  }),
);
const files = [
  "case.test.ts",
  "vitest.config.ts",
  "scripts/run-vitest.mjs",
  "package.json",
  "pnpm-lock.yaml",
];
function definition() {
  return {
    version: 1,
    kind: "node-cache-workload-definition",
    workloadSha: "a".repeat(40),
    workloadTree: "b".repeat(40),
    lane: { id: "fixture", critical: true, config: files[1], files: [files[0]] },
    expected: Array.from({ length: 20 }, (_, i) => ({
      file: files[0],
      fullName: `fixture case ${i}`,
      line: i + 1,
      column: 1,
      status: "passed",
    })),
    runtime: {
      node: "v24.22.1",
      v8: "fixture",
      platform: "linux",
      architecture: "x64",
      executableSha256: "c".repeat(64),
    },
    pnpmVersion: "12.15.0",
    sourceIdentities: files.map((file) => ({ path: file, sha256: "d".repeat(64) })),
  };
}

describe("disabled control admission", () => {
  it("requires the fixed unique oracle, source identities and pnpm version without retaining private metadata", () => {
    expect(
      validateWorkloadDefinition({ ...definition(), privateNote: "private" }),
    ).not.toHaveProperty("privateNote");
    const duplicate = definition();
    duplicate.expected[1] = { ...duplicate.expected[0]! };
    expect(() => validateWorkloadDefinition(duplicate)).toThrow("unique cases");
    const missing = definition();
    missing.expected.pop();
    expect(() => validateWorkloadDefinition(missing)).toThrow("20 cases");
    const sources = definition();
    sources.sourceIdentities[1] = sources.sourceIdentities[0]!;
    expect(() => validateWorkloadDefinition(sources)).toThrow("duplicate inputs");
    expect(() => validateWorkloadDefinition({ ...definition(), pnpmVersion: "12.14.0" })).toThrow();
    for (const critical of [false, undefined, 1, "true", null]) {
      expect(() =>
        validateWorkloadDefinition({
          ...definition(),
          lane: { ...definition().lane, critical },
        }),
      ).toThrow("unique cases and complete source identities");
    }
  });
  it("binds executable native bytes and rejects script wrappers and other architectures", () => {
    const file = path.join(realpathSync(tempDirs.make("native-pnpm-")), "pnpm");
    // Header-only data tests the input guard; it is never executed.
    const bytes = Buffer.alloc(64);
    Buffer.from("7f454c46020101", "hex").copy(bytes);
    bytes.writeUInt16LE(62, 18);
    writeFileSync(file, bytes);
    chmodSync(file, 0o755);
    const before = hashPreparedPnpmExecutable(file);
    bytes[63] = 1;
    writeFileSync(file, bytes);
    expect(hashPreparedPnpmExecutable(file)).not.toBe(before);
    bytes.writeUInt16LE(183, 18);
    writeFileSync(file, bytes);
    expect(() => hashPreparedPnpmExecutable(file)).toThrow("x86_64");
    writeFileSync(file, "#!/bin/sh\necho 12.15.0\n");
    expect(() => hashPreparedPnpmExecutable(file)).toThrow("ELF64");
  });
});

type FixtureMode =
  | "success"
  | "flush"
  | "unknown-diagnostic"
  | "mutation"
  | "wrong-oracle"
  | "cache-activity"
  | "exit"
  | "controls-success"
  | "controls-empty-failure"
  | "controls-report-directory"
  | "controls-seed-tamper"
  | "controls-seeded-rejection"
  | "controls-deadline";

function fixture(mode: FixtureMode) {
  const corepack = process.env.COREPACK_HOME;
  if (!corepack || !path.isAbsolute(corepack)) {
    throw new Error(
      "Fixture requires preprovisioned setup-pnpm-store-cache COREPACK_HOME; no install attempted",
    );
  }
  const pnpm = path.join(corepack, "v1/pnpm/12.15.0/node_modules/@pnpm/exe.linux-x64/pnpm");
  if (!existsSync(pnpm)) {
    throw new Error("Preprovisioned Linux native pnpm 12.15.0 is missing; no install attempted");
  }
  hashPreparedPnpmExecutable(pnpm);
  const root = realpathSync(tempDirs.make("disabled-control-"));
  const harness = path.join(root, "harness");
  const workload = path.join(root, "workload");
  mkdirSync(harness);
  mkdirSync(path.join(workload, "scripts"), { recursive: true });
  for (const file of NODE_CACHE_DISABLED_INPUTS) {
    const destination = path.join(harness, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.resolve(file), destination);
  }
  const raw = definition();
  const script = [
    'import assert from "node:assert/strict"; import {chmodSync,lstatSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from "node:fs"; import {flushCompileCache} from "node:module"; import path from "node:path";',
    'assert.ok(process.argv.includes("--no-cache")); assert.ok(process.argv.includes("--no-fsModuleCache"));',
    'for(const [k,v] of Object.entries({OPENCLAW_VITEST_RUNTIME:"node",OPENCLAW_VITEST_FS_MODULE_CACHE:"0",OPENCLAW_VITEST_WORKER_CACHE:"0",COREPACK_ENABLE_NETWORK:"0",npm_config_offline:"true",pnpm_config_manage_package_manager_versions:"false",pnpm_config_pm_on_fail:"error"})) assert.equal(process.env[k],v);',
    'const control=path.basename(path.dirname(process.env.NODE_COMPILE_CACHE)); assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE,control==="disabled"?"1":undefined);',
    'assert.equal(process.env.NODE_OPTIONS,undefined); console.log("control pid="+process.pid);',
    ...(mode === "flush" || mode === "controls-success"
      ? ['if(control==="disabled") flushCompileCache();']
      : []),
    ...(mode === "unknown-diagnostic"
      ? ['console.error("[compile cache] unexpected activity.");']
      : []),
    ...(mode === "controls-deadline"
      ? ['if(control==="empty") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);']
      : []),
    ...(mode === "exit" ? ["process.exit(7);"] : []),
    `const expected=${JSON.stringify(raw.expected)};`,
    ...(mode === "wrong-oracle" || mode === "mutation" ? ["expected[1]={...expected[0]};"] : []),
    ...(mode === "controls-empty-failure"
      ? ['if(control==="empty") expected[1]={...expected[0]};']
      : []),
    "const assertionResults=expected.map(({fullName,line,column,status})=>({fullName,status,location:{line,column}}));",
    'const reportFile=process.argv[process.argv.indexOf("--outputFile")+1];',
    ...(mode === "controls-report-directory"
      ? ['if(control==="empty") mkdirSync(reportFile); else']
      : []),
    'writeFileSync(reportFile,JSON.stringify({success:true,numTotalTests:20,numPassedTests:20,numFailedTests:0,numPendingTests:0,numTodoTests:0,numTotalTestSuites:1,numPassedTestSuites:1,numFailedTestSuites:0,numPendingTestSuites:0,testResults:[{name:path.resolve("case.test.ts"),status:"passed",assertionResults}]}));',
    ...(mode === "mutation"
      ? ['mkdirSync(".ignored");writeFileSync(".ignored/generated","changed");']
      : []),
    ...(mode === "controls-seed-tamper"
      ? [
          'if(control==="seeded") chmodSync(path.join(path.dirname(process.argv[process.argv.indexOf("--outputFile")+1]),"seed"),0o700);',
        ]
      : []),
    ...(mode === "controls-seeded-rejection"
      ? [
          'if(control==="empty") { flushCompileCache(); const root=process.env.NODE_COMPILE_CACHE; const files=readdirSync(root,{recursive:true}).map(file=>path.join(root,file)).filter(file=>lstatSync(file).isFile()); assert.equal(files.length,1); const bytes=readFileSync(files[0]); bytes[0]^=0xff; writeFileSync(files[0],bytes); }',
        ]
      : []),
    ...(mode === "cache-activity"
      ? ['writeFileSync(path.join(process.env.NODE_COMPILE_CACHE,"unexpected"),"cache");']
      : []),
  ].join("\n");
  const sources = {
    "case.test.ts": "// synthetic report fixture",
    "vitest.config.ts": "// fixture",
    "scripts/run-vitest.mjs": script,
    "package.json": '{"type":"module"}',
    "pnpm-lock.yaml": "fixture",
  };
  for (const [file, bytes] of Object.entries(sources)) {
    writeFileSync(path.join(workload, file), bytes);
  }
  writeFileSync(path.join(workload, ".gitignore"), ".ignored/\n");
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  for (const cwd of [harness, workload]) {
    git(cwd, ["init", "-q"]);
    git(cwd, ["add", "."]);
    git(cwd, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "fixture",
    ]);
  }
  raw.workloadSha = git(workload, ["rev-parse", "HEAD"]);
  raw.workloadTree = git(workload, ["rev-parse", "HEAD^{tree}"]);
  raw.runtime = {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    architecture: process.arch,
    executableSha256: sha256(readFileSync(process.execPath)),
  };
  raw.sourceIdentities = Object.entries(sources).map(([file, bytes]) => ({
    path: file,
    sha256: sha256(bytes),
  }));
  const definitionPath = path.join(root, "definition.json");
  writeFileSync(definitionPath, JSON.stringify(raw));
  return {
    root,
    harness,
    workload,
    definitionPath,
    pnpm,
    harnessSha: git(harness, ["rev-parse", "HEAD"]),
  };
}

async function runFixture(mode: FixtureMode, full = false, timeoutMs = 30_000) {
  const f = fixture(mode);
  const output = path.join(f.root, "output");
  const scratch = path.join(f.root, "scratch");
  uncertainRoots.add(f.root);
  const result = await runOwnedCommand({
    bin: process.execPath,
    args: [
      path.join(f.harness, "scripts/vitest-pair-benchmark.mts"),
      ...Object.entries({
        mode: full ? "node-cache-workload-qualification" : "node-cache-disabled-control",
        workload: f.workload,
        definition: f.definitionPath,
        output,
        scratch,
        "pnpm-bin": f.pnpm,
        "harness-sha": f.harnessSha,
        "timeout-ms": String(timeoutMs),
        "run-attempt": "1",
      }).flatMap(([name, value]) => [`--${name}`, value]),
    ],
    cwd: f.root,
    env: { PATH: process.env.PATH, HOME: f.root },
    logPath: path.join(f.root, "cli.log"),
    timeoutMs: timeoutMs + 10_000,
  });
  const record = JSON.parse(
    readFileSync(path.join(output, full ? "qualification.json" : "disabled.json"), "utf8"),
  );
  if (record.processTreeSettled) {
    uncertainRoots.delete(f.root);
  }
  return { f, output, scratch, result, record };
}

// Synthetic reports qualify the real CLI/ownership boundary, not full-W behavior.
it
  .runIf(
    process.platform === "linux" &&
      process.arch === "x64" &&
      process.version === "v24.22.1" &&
      !process.versions.bun,
  )
  .each([
    ["success", null],
    ["flush", null],
    ["mutation", "expected passed inventory"],
    ["wrong-oracle", "expected passed inventory"],
    ["cache-activity", "generated cache activity"],
    ["unknown-diagnostic", "generated cache activity"],
    ["exit", "exited with status 7"],
  ] as const)(
  "retains %s disabled-control evidence",
  async (mode, expectedError) => {
    const { f, output, scratch, result, record } = await runFixture(mode);
    expect(record).toMatchObject({
      scope: "disabled-only",
      timingAdmission: false,
      controlAttempted: true,
      processTreeSettled: true,
    });
    expect(existsSync(scratch)).toBe(false);
    expect(record.logSha256).toBe(sha256(readFileSync(path.join(output, "disabled.log"))));
    expect(record.reportSha256).toBe(
      mode === "exit" ? null : sha256(readFileSync(path.join(output, "disabled.vitest.json"))),
    );
    expect(record.pnpmExecutable).toBe(f.pnpm);
    const terminal = JSON.parse(readFileSync(path.join(output, "terminal-manifest.json"), "utf8"));
    expect(terminal.status).toBe(record.status);
    if (expectedError) {
      expect(result.exitCode).not.toBe(0);
      expect(record.status).toBe("failure");
      expect(record.error).toContain(expectedError);
      if (mode === "mutation") {
        expect(record.inventory.added).toEqual([
          expect.objectContaining({ path: ".ignored/generated" }),
        ]);
        expect(record.inventoryError).toContain("Prepared workload changed");
        expect(record.checks.inventory.status).toBe("failed");
      }
      if (mode === "wrong-oracle" || mode === "mutation") {
        expect(record.checks.oracle.status).toBe("failed");
      }
      if (mode === "cache-activity" || mode === "unknown-diagnostic") {
        expect(record.checks.diagnostic.status).toBe("failed");
      }
      if (mode === "exit") {
        expect(record.checks.oracle).toEqual({
          status: "unavailable",
          reason: expect.stringContaining("exited with status 7"),
        });
      }
    } else {
      expect(result.exitCode, readFileSync(path.join(f.root, "cli.log"), "utf8")).toBe(0);
      expect(record.status).toBe("success");
      expect(record.execution.assertionCount).toBe(20);
      if (mode === "flush") {
        const trace = readFileSync(path.join(output, "disabled.log"), "utf8");
        expect(trace).toContain("[compile cache] module.flushCompileCache() requested.");
        expect(trace).toContain("[compile cache] module.flushCompileCache() finished.");
      }
      expect(record.checks).toEqual({
        oracle: { status: "passed" },
        diagnostic: { status: "passed" },
        inventory: { status: "passed" },
      });
    }
    expect(existsSync(path.join(output, "analysis.json"))).toBe(false);
  },
  50_000,
);

// These run real native ESM cache reads/writes while retaining the fixed synthetic
// twenty-case oracle. They do not qualify the full prepared workload.
it
  .runIf(
    process.platform === "linux" &&
      process.arch === "x64" &&
      process.version === "v24.22.1" &&
      !process.versions.bun,
  )
  .each([
    ["controls-success", null, "seeded"],
    ["controls-empty-failure", "expected passed inventory", "empty"],
    ["controls-report-directory", "EISDIR", "empty"],
    ["controls-seed-tamper", "Sealed seed directory mode changed", "seeded"],
    ["controls-seeded-rejection", "lacks required launcher cache evidence", "seeded"],
    ["controls-deadline", "deadline", "empty"],
  ] as const)(
  "retains ordered %s workload-control evidence",
  async (mode, error, last) => {
    const { f, output, scratch, result, record } = await runFixture(
      mode,
      true,
      mode === "controls-deadline" ? 5_000 : 30_000,
    );
    const read = (name: string) =>
      JSON.parse(readFileSync(path.join(output, `${name}.json`), "utf8"));
    const deadline = mode === "controls-deadline";
    if (deadline) {
      // The owner conservatively retains scratch on abort. This single-process
      // fixture can independently prove its known group dead before test cleanup.
      const pid = Number(
        /control pid=(\d+)/u.exec(readFileSync(path.join(output, "empty.log"), "utf8"))?.[1],
      );
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(
        inspectManagedProcessGroup(
          { pid, exitCode: null, signalCode: null },
          { errorPolicy: "indeterminate" },
        ),
      ).toBe("dead");
      uncertainRoots.delete(f.root);
    }
    try {
      expect(record).toMatchObject({
        scope: "disabled-empty-seeded",
        timingAdmission: false,
        processTreeSettled: !deadline,
      });
      expect(record.controls.map(({ kind }: { kind: string }) => kind)).toEqual(
        last === "empty" ? ["disabled", "empty"] : ["disabled", "empty", "seeded"],
      );
      expect(read("disabled").status).toBe("success");
      expect(existsSync(path.join(output, "seeded.json"))).toBe(last === "seeded");
      expect(existsSync(scratch)).toBe(deadline);
      expect(existsSync(path.join(output, "analysis.json"))).toBe(false);
      const final = read(last);
      expect(final.logSha256).toBe(sha256(readFileSync(path.join(output, `${last}.log`))));
      expect(final.processTreeSettled).toBe(!deadline);
      expect(read("terminal-manifest").status).toBe(record.status);
      if (error) {
        expect(result.exitCode).not.toBe(0);
        expect(record.status).toBe("failure");
        expect(record.error.toLowerCase()).toContain(error.toLowerCase());
        expect(final.status).toBe("failure");
        if (mode === "controls-deadline") {
          expect(final.checks.oracle.status).toBe("unavailable");
          expect(final.checks.inventory.status).toBe("unavailable");
        } else if (mode === "controls-report-directory") {
          expect(final.checks.oracle.status).toBe("failed");
          expect(final.reportSha256).toBeNull();
          expect(final.reportHashError).toBe("report artifact is not a regular file");
          expect(final.error).toBe(record.error);
        } else if (mode === "controls-seed-tamper") {
          expect(final.checks.oracle.status).toBe("passed");
          expect(final.checks.diagnostic.status).toBe("passed");
          expect(final.checks.inventory.status).toBe("failed");
        } else if (mode === "controls-seeded-rejection") {
          expect(final.checks.oracle.status).toBe("passed");
          expect(final.checks.diagnostic.status).toBe("failed");
        }
      } else {
        expect(result.exitCode, readFileSync(path.join(f.root, "cli.log"), "utf8")).toBe(0);
        expect(record.status).toBe("success");
        expect(read("empty").diagnostic).toMatchObject({
          read: "missing",
          state: "not initialized",
        });
        expect(final.diagnostic).toMatchObject({ read: "hit", state: "accepted" });
        expect(record.seed.files).toContainEqual(
          expect.objectContaining({ path: final.diagnostic.cacheFile }),
        );
        expect(lstatSync(path.join(output, "seed")).mode & 0o777).toBe(0o500);
        for (const kind of ["disabled", "empty", "seeded"]) {
          const control = read(kind);
          expect(control.execution.assertionCount).toBe(20);
          expect(Object.values(control.checks)).toEqual([
            { status: "passed" },
            { status: "passed" },
            { status: "passed" },
          ]);
        }
      }
    } finally {
      // Retained sealed proof is intentional; make only this fixture writable for cleanup.
      const seed = path.join(output, "seed");
      const writable = (dir: string) => {
        chmodSync(dir, 0o700);
        for (const name of readdirSync(dir)) {
          const file = path.join(dir, name);
          if (lstatSync(file).isDirectory()) {
            writable(file);
          } else {
            chmodSync(file, 0o600);
          }
        }
      };
      if (record.processTreeSettled && existsSync(seed)) {
        writable(seed);
      }
    }
  },
  50_000,
);
