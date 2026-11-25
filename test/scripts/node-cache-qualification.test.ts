import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { NODE_CACHE_DISABLED_INPUTS } from "../../scripts/lib/node-cache-disabled-control.mts";
import type { WorkloadDefinition } from "../../scripts/lib/node-cache-workload-inputs.mts";
import {
  parseVitestExecutionReport,
  sha256,
} from "../../scripts/lib/vitest-pair-benchmark-contract.mts";
import {
  buildNodeCacheVitestArgs,
  runOwnedCommand,
} from "../../scripts/lib/vitest-pair-benchmark.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const uncertainRoots = new Set<string>();
const sealedPaths: string[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    if (uncertainRoots.size) {
      throw new Error("Retaining qualification fixtures with uncertain child settlement");
    }
    for (const file of sealedPaths.splice(0)) {
      chmodSync(file, lstatSync(file).isDirectory() ? 0o700 : 0o600);
    }
    cleanup();
  }),
);

// These synthetic producer-shaped receipts test admission, not execution of
// controls or the fixed workload. Git, file identities and the reader are real.
function fixture() {
  const root = realpathSync(tempDirs.make("cache-admission-"));
  const harness = path.join(root, "harness");
  const workload = path.join(root, "workload");
  const qualification = path.join(root, "qualification");
  for (const dir of [harness, workload, qualification]) {
    mkdirSync(dir);
  }
  for (const relative of NODE_CACHE_DISABLED_INPUTS) {
    const file = path.join(harness, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    copyFileSync(path.resolve(relative), file);
  }
  const sources = [
    "case.test.ts",
    "vitest.config.ts",
    "scripts/run-vitest.mjs",
    "package.json",
    "pnpm-lock.yaml",
  ];
  for (const relative of sources) {
    const file = path.join(workload, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, relative === "package.json" ? '{"type":"module"}' : "// fixture\n");
  }
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
  const harnessSha = git(harness, ["rev-parse", "HEAD"]);
  const definition: WorkloadDefinition = {
    version: 1,
    kind: "node-cache-workload-definition",
    workloadSha: git(workload, ["rev-parse", "HEAD"]),
    workloadTree: git(workload, ["rev-parse", "HEAD^{tree}"]),
    lane: { id: "fixture", critical: true, config: "vitest.config.ts", files: ["case.test.ts"] },
    expected: Array.from({ length: 20 }, (_, index) => ({
      file: "case.test.ts",
      fullName: `fixture ${index}`,
      line: index + 1,
      column: 1,
      status: "passed",
    })),
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      architecture: process.arch,
      executableSha256: sha256(readFileSync(process.execPath)),
    },
    pnpmVersion: "12.15.0",
    sourceIdentities: sources.map((relative) => ({
      path: relative,
      sha256: sha256(readFileSync(path.join(workload, relative))),
    })),
  };
  const definitionPath = path.join(root, "definition.json");
  const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
  writeJson(definitionPath, definition);
  // Header-only native identity is never executed by this reader fixture.
  const pnpmBin = path.join(root, "pnpm");
  const native = Buffer.alloc(64);
  Buffer.from("7f454c46020101", "hex").copy(native);
  native.writeUInt16LE(62, 18);
  writeFileSync(pnpmBin, native, { mode: 0o755 });
  writeFileSync(path.join(qualification, "pnpm-version.log"), "12.15.0\n");
  const prepared = sources.toSorted().map((relative) => {
    const file = path.join(workload, relative);
    const bytes = readFileSync(file);
    return {
      path: relative,
      kind: "file",
      bytes: bytes.length,
      sha256: sha256(bytes),
      mode: lstatSync(file).mode & 0o777,
    };
  });
  const preparedSha256 = sha256(JSON.stringify(prepared));
  writeJson(path.join(qualification, "prepared-inventory.json"), prepared);
  const cacheFile = "v24.22.1-x64-fixture/entry";
  const seedRoot = path.join(qualification, "seed");
  const seedDirectory = path.join(seedRoot, path.dirname(cacheFile));
  const seedFile = path.join(seedRoot, cacheFile);
  mkdirSync(seedDirectory, { recursive: true });
  writeFileSync(seedFile, "seed");
  const seedFiles = [{ path: cacheFile, bytes: 4, sha256: sha256("seed") }];
  const seed = {
    files: seedFiles,
    sha256: sha256(JSON.stringify(seedFiles)),
    fileMode: "0400",
    directoryMode: "0500",
  };
  chmodSync(seedFile, 0o400);
  chmodSync(seedDirectory, 0o500);
  chmodSync(seedRoot, 0o500);
  sealedPaths.push(seedRoot, seedDirectory, seedFile);
  const shared = {
    version: 1,
    scope: "disabled-empty-seeded",
    timingAdmission: false,
    controlScratchDir: path.join(root, "removed-scratch"),
    definition,
    definitionSha256: sha256(JSON.stringify(definition)),
    harnessSha,
    harnessInputs: NODE_CACHE_DISABLED_INPUTS.map((relative) => {
      const bytes = readFileSync(path.join(harness, relative));
      return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
    }),
    pnpmExecutable: pnpmBin,
    pnpmSha256: sha256(native),
    status: "success",
    error: null,
    processTreeSettled: true,
  };
  const summary = {
    ...shared,
    kind: "node-cache-workload-qualification",
    seed,
    cleanup: "removed-owned-scratch",
    controls: ["disabled", "empty", "seeded"].map((kind) => ({ kind, status: "success" })),
  };
  writeJson(path.join(qualification, "qualification.json"), summary);
  writeJson(path.join(qualification, "terminal-manifest.json"), {
    version: 1,
    status: "success",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:01:00Z",
  });
  const sourceUrl = pathToFileURL(path.join(workload, "scripts/run-vitest.mjs")).href;
  for (const kind of ["disabled", "empty", "seeded"] as const) {
    const reportFile = path.join(qualification, `${kind}.vitest.json`);
    writeJson(reportFile, {
      success: true,
      numTotalTests: 20,
      numPassedTests: 20,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      testResults: [
        {
          name: path.join(workload, "case.test.ts"),
          status: "passed",
          assertionResults: definition.expected.map(({ fullName, line, column, status }) => ({
            fullName,
            status,
            location: { line, column },
          })),
        },
      ],
    });
    const log =
      kind === "disabled"
        ? "[compile cache] Disabled by NODE_DISABLE_COMPILE_CACHE.\n[compile cache] module.flushCompileCache() requested.\n[compile cache] module.flushCompileCache() finished.\n"
        : `[compile cache] reading cache from ${path.join(root, "removed-scratch", kind, "node-cache", cacheFile)} for ESM ${sourceUrl}...${kind === "empty" ? " no such file or directory" : "[1 2 3 4 5]... success, size=4"}\n[compile cache] V8 code cache for ESM ${sourceUrl} was ${kind === "empty" ? "not initialized, initializing" : "accepted, keeping"} the in-memory entry\n`;
    writeFileSync(path.join(qualification, `${kind}.log`), log);
    writeJson(path.join(qualification, `${kind}.json`), {
      ...shared,
      kind: `node-cache-${kind}-control`,
      controlKind: kind,
      controlAttempted: true,
      exitCode: 0,
      checks: {
        oracle: { status: "passed" },
        diagnostic: { status: "passed" },
        inventory: { status: "passed" },
      },
      preparedSha256,
      inventory: {
        beforeSha256: preparedSha256,
        afterSha256: preparedSha256,
        counts: { before: 5, after: 5, added: 0, removed: 0, changed: 0 },
        added: [],
        removed: [],
        changed: [],
      },
      args: buildNodeCacheVitestArgs(definition.lane, reportFile),
      argsSha256: sha256(
        JSON.stringify(buildNodeCacheVitestArgs(definition.lane, "/report/vitest.json")),
      ),
      execution: parseVitestExecutionReport(
        reportFile,
        workload,
        definition.lane,
        definition.expected,
      ),
      logSha256: sha256(log),
      reportSha256: sha256(readFileSync(reportFile)),
      diagnostic:
        kind === "disabled"
          ? null
          : {
              sourceUrl,
              cacheFile,
              read: kind === "empty" ? "missing" : "hit",
              state: kind === "empty" ? "not initialized" : "accepted",
            },
      seedSha256: kind === "disabled" ? null : seed.sha256,
      ...(kind === "seeded" ? { seed } : {}),
    });
  }
  return {
    root,
    harness,
    workload,
    qualification,
    definitionPath,
    pnpmBin,
    harnessSha,
    summary,
    seedFile,
    preparedSha256,
    writeJson,
  };
}

it
  .runIf(
    process.platform === "linux" &&
      process.arch === "x64" &&
      process.version === "v24.22.1" &&
      !process.versions.bun,
  )
  .each([
    ["success", null],
    ["reordered", "ordered controls"],
    ["missing", "ENOENT"],
    ["hash", "empty log hash"],
    ["cache-path", "escapes the selected cache directory"],
    ["oracle", "expected passed inventory"],
    ["symlink", "regular physical file"],
    ["source", "clean workload"],
    ["seed", "Sealed seed bytes changed"],
    ["revalidate", null],
  ] as const)("admits only bound qualification evidence: %s", async (mode, error) => {
  const f = fixture();
  if (mode === "reordered") {
    f.summary.controls.reverse();
    f.writeJson(path.join(f.qualification, "qualification.json"), f.summary);
  } else if (mode === "missing") {
    unlinkSync(path.join(f.qualification, "empty.json"));
  } else if (mode === "hash") {
    appendFileSync(path.join(f.qualification, "empty.log"), "tamper\n");
  } else if (mode === "cache-path") {
    const logFile = path.join(f.qualification, "empty.log");
    const log = readFileSync(logFile, "utf8").replace("removed-scratch", "other-scratch");
    writeFileSync(logFile, log);
    const controlFile = path.join(f.qualification, "empty.json");
    const control = JSON.parse(readFileSync(controlFile, "utf8")) as { logSha256: string };
    control.logSha256 = sha256(log);
    f.writeJson(controlFile, control);
  } else if (mode === "oracle") {
    const reportFile = path.join(f.qualification, "empty.vitest.json");
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as {
      testResults: Array<{ assertionResults: Array<{ fullName: string }> }>;
    };
    report.testResults[0]!.assertionResults[0]!.fullName = "not in the fixed oracle";
    f.writeJson(reportFile, report);
    const controlFile = path.join(f.qualification, "empty.json");
    const control = JSON.parse(readFileSync(controlFile, "utf8")) as { reportSha256: string };
    control.reportSha256 = sha256(readFileSync(reportFile));
    f.writeJson(controlFile, control);
  } else if (mode === "symlink") {
    const file = path.join(f.qualification, "empty.json");
    const outside = path.join(f.root, "receipt.json");
    renameSync(file, outside);
    symlinkSync(outside, file);
  } else if (mode === "source") {
    appendFileSync(path.join(f.workload, "case.test.ts"), "changed\n");
  } else if (mode === "seed") {
    chmodSync(f.seedFile, 0o600);
    writeFileSync(f.seedFile, "different");
    chmodSync(f.seedFile, 0o400);
  }
  const output = path.join(f.root, "admission");
  const source = [
    'import assert from "node:assert/strict"; import {appendFileSync} from "node:fs";',
    `const {readNodeCacheQualification}=await import(${JSON.stringify(pathToFileURL(path.join(f.harness, "scripts/lib/node-cache-qualification.mts")).href)});`,
    `const options=${JSON.stringify({ qualificationDir: f.qualification, definitionPath: f.definitionPath, workloadDir: f.workload, harnessSha: f.harnessSha, pnpmBin: f.pnpmBin })};`,
    "const signal=new AbortController().signal; const deadlineAt=Date.now()+15000;",
    'const admission=readNodeCacheQualification({...options,deadline:{signal,deadlineAt,throwIfExpired(){assert.ok(Date.now()<deadlineAt,"fixture deadline");}}});',
    `appendFileSync(${JSON.stringify(path.join(f.qualification, "terminal-manifest.json"))}," ");`,
    "assert.throws(()=>admission.revalidate(),/admitted file changed/);",
  ].join("\n");
  const args =
    mode === "revalidate"
      ? ["--input-type=module", "-e", source]
      : [
          path.join(f.harness, "scripts/vitest-pair-benchmark.mts"),
          ...Object.entries({
            mode: "node-cache-qualification-admission",
            definition: f.definitionPath,
            workload: f.workload,
            qualification: f.qualification,
            output,
            "pnpm-bin": f.pnpmBin,
            "harness-sha": f.harnessSha,
            "timeout-ms": "15000",
            "run-attempt": "1",
          }).flatMap(([name, value]) => [`--${name}`, value]),
        ];
  uncertainRoots.add(f.root);
  const log = path.join(f.root, "reader.log");
  const result = await runOwnedCommand({
    bin: process.execPath,
    args,
    cwd: f.root,
    env: { PATH: process.env.PATH, HOME: f.root },
    logPath: log,
    timeoutMs: 20_000,
  });
  uncertainRoots.delete(f.root);
  const text = readFileSync(log, "utf8");
  if (mode === "revalidate") {
    expect(result.exitCode, text).toBe(0);
    return;
  }
  const terminal = JSON.parse(readFileSync(path.join(output, "terminal-manifest.json"), "utf8"));
  if (error) {
    expect(result.exitCode).not.toBe(0);
    expect(text).toContain(error);
    expect(terminal.status).toBe("failure");
    expect(terminal.error).toContain(error);
    expect(existsSync(path.join(output, "manifest.json"))).toBe(false);
  } else {
    expect(result.exitCode, text).toBe(0);
    expect(terminal.status).toBe("success");
    const manifest = JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      version: 2,
      mode: "node-compile-cache",
      workloadSha: f.summary.definition.workloadSha,
    });
    expect(manifest.expected).toHaveLength(20);
    expect(manifest.seed.files).toHaveLength(1);
    const provenance = JSON.parse(readFileSync(path.join(output, "qualification.json"), "utf8"));
    expect(provenance).toMatchObject({
      kind: "node-cache-qualification-admission",
      timingAdmission: false,
      harnessSha: f.harnessSha,
      preparedSha256: f.preparedSha256,
      manifestSha256: sha256(JSON.stringify(manifest)),
    });
  }
});
