import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RESOURCE_MARKER } from "../../scripts/lib/extension-import-profile.mts";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
} from "../../scripts/lib/managed-child-process.mts";
import { parseArgs, runCase } from "../../scripts/profile-extension-memory.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = path.resolve("scripts/profile-extension-memory.mts");
const TSX_PRELOAD = pathToFileURL(path.resolve("scripts/tsx.mjs")).href;
const SOURCE_TSCONFIG_PATH = path.resolve("tsconfig.json");
const testNodeExecPath = resolveTestNodeExecPath();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const successCounts = { totalEntries: 1, ok: 1, fail: 0, timeout: 0 };
function profileFixture(files: Record<string, string>, reportName = "report.json") {
  const root = tempDirs.make("openclaw-extension-memory #test-");
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
  }
  const reportPath = path.join(root, reportName);
  const run = (ids: string[], combined = false, code = 0) => {
    const result = runProfileExtensionMemory(
      [
        ...ids.flatMap((id) => ["--extension", id]),
        ...(combined ? [] : ["--skip-combined"]),
        "--concurrency",
        "1",
        "--json",
        reportPath,
      ],
      root,
    );
    expect(result.status, result.stderr).toBe(code);
    return { result, report: readJson(reportPath) };
  };
  return { root, reportPath, run };
}

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function readDescendantPid(file: string): number {
  const pid = Number(readFileSync(file, "utf8"));
  expect(Number.isInteger(pid) && pid > 0, `invalid descendant PID in ${file}`).toBe(true);
  return pid;
}

// Foreign descendants have no ChildProcess handle; their parent can exit before reaping them.
async function waitForProcessCleanup(
  predicate: () => boolean,
  description: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    while (!predicate()) {
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(description, { cause });
  }
}

function runProfileExtensionMemory(args: string[], cwd = process.cwd()) {
  return spawnSync(testNodeExecPath, ["--import", TSX_PRELOAD, SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
    // Fixture cwd controls artifacts; source imports still need the repository's aliases.
    env: { ...process.env, TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH },
  });
}

function fixtureCase(options: Partial<Parameters<typeof runCase>[0]> & { name: string }) {
  return runCase({
    completionKind: "imports",
    body: "",
    env: process.env,
    hookPath: "unused-hook.mjs",
    repoRoot: process.cwd(),
    timeoutMs: 30_000,
    ...options,
  });
}

function fakeChild(
  options: Partial<{
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => boolean;
  }> = {},
) {
  return Object.assign(new EventEmitter(), {
    pid: 2_147_483_647,
    exitCode: options.exitCode ?? null,
    signalCode: options.signalCode ?? null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    ...options,
  });
}

function writeExtension(root: string, id: string, body = "export {};\n") {
  const dir = path.join(root, "dist", "extensions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.js"), body, "utf8");
}

function descendantSource(pidPath: string, ready: string, extra = "") {
  return [
    "import { renameSync, writeFileSync } from 'node:fs';",
    extra,
    "setInterval(() => {}, 1000);",
    `const pidPath = ${JSON.stringify(pidPath)};`,
    "writeFileSync(pidPath + '.tmp', String(process.pid));",
    "renameSync(pidPath + '.tmp', pidPath);",
    ready,
  ].join("\n");
}

function extractReportPath(stdout: string) {
  const match = stdout.match(/^\[extension-memory\] report: (.+)$/mu);
  const reportPath = match?.[1];
  if (!reportPath) {
    throw new Error(`missing report path in stdout:\n${stdout}`);
  }
  return reportPath;
}

async function cleanupProfileFixture(
  root: string,
  child: ReturnType<typeof spawn>,
  closed: Promise<unknown>,
  descendantPidPath: string,
  signal: AbortSignal,
  detached = true,
): Promise<void> {
  let childClosed = false;
  let stopFailed = false;
  let descendantPid: number | undefined;
  await runQaGatewayFixture(
    async () => {
      if (!child.pid || (!detached && (child.exitCode !== null || child.signalCode !== null))) {
        return;
      }
      try {
        // The non-detached runner owns its case groups: let its SIGTERM handler
        // stop them before exit instead of orphaning them with SIGKILL.
        process.kill(detached ? -child.pid : child.pid, detached ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          stopFailed = true;
          throw error;
        }
      }
    },
    () => {
      if (detached) {
        killPidIfAlive(child.pid);
      }
    },
    async () => {
      // A denied runner stop cannot promise a future close. Preserve that failure,
      // rescue known descendants, and retain inputs rather than blocking later cleanup.
      if (!detached && stopFailed && child.exitCode === null && child.signalCode === null) {
        throw new Error(`profile child did not close; retained fixture: ${root}`);
      }
      await closed;
      childClosed = true;
    },
    async () => {
      if (!existsSync(descendantPidPath)) {
        return;
      }
      descendantPid = readDescendantPid(descendantPidPath);
      killPidIfAlive(descendantPid);
    },
    async () => {
      // A failed signal is not proof of exit. Retain PID files until the owned
      // processes and the child's output are verified stopped.
      await runQaGatewayFixture(
        async () => {
          if (descendantPid) {
            const pid = descendantPid;
            await waitForProcessCleanup(
              () => !isProcessAlive(pid),
              `process still alive: ${pid}; retained fixture: ${root}`,
              signal,
            );
          }
        },
        async () => {
          if (!detached || !child.pid) {
            return;
          }
          await waitForProcessCleanup(
            () => inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }) === "dead",
            `profile group still alive; retained fixture: ${root}`,
            signal,
          );
        },
      );
      if (childClosed) {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

describe("scripts/profile-extension-memory", () => {
  it("stops parsing options after the argument terminator", () => {
    expect(parseArgs(["--extension", "discord", "--", "--extension", "telegram"])).toMatchObject({
      extensions: ["discord"],
    });
  });

  it("accepts package-manager argument separators before script options", () => {
    expect(parseArgs(["--", "--extension", "discord", "--skip-combined"])).toMatchObject({
      extensions: ["discord"],
      skipCombined: true,
    });
  });

  it.each([
    {
      flags: [
        ["--concurrency", "2abc"],
        ["--timeout-ms", "1e3"],
        ["--combined-timeout-ms", "90000ms"],
        ["--top", "0x10"],
      ],
      error: "must be a positive integer",
    },
    {
      flags: [
        ["--extension", "-h"],
        ["--json", "-h"],
      ],
      error: "requires a value",
    },
  ] as const)(
    "rejects invalid flag values before artifact discovery: $error",
    ({ flags, error }) => {
      for (const [flag, value] of flags) {
        expect(() => parseArgs([flag, value])).toThrow(`${flag} ${error}`);
      }
      const args = flags[0];
      const result = runProfileExtensionMemory([...args]);
      expect(result).toMatchObject({ status: 1, stdout: "" });
      expect(result.stderr).toContain(`[extension-memory] ${args[0]} ${error}`);
      expect(result.stderr).not.toContain("dist/extensions");
      expect(result.stderr).not.toContain("at ");
    },
  );

  it("profiles package-local output without a root dist tree", () => {
    const relativeFile = "extensions/external/dist/index.js";
    const f = profileFixture({
      [relativeFile]: "export {};\n",
      ...Object.fromEntries(
        ["external", "internal", "source-only"].map((id) => [
          `extensions/${id}/index.ts`,
          'throw new Error("source imported");\n',
        ]),
      ),
    });
    const { result, report } = f.run(["external"], true);
    expect(result.stderr).not.toContain("cliStartup");
    expect(report).toMatchObject({
      repoRoot: f.root,
      selectedExtensions: ["external"],
      scope: "cold-import",
      qualification: { qualified: false, temporaryHomeRemoved: true },
      combined: { status: "ok", maxRssMb: expect.any(Number) },
    });
    expect(report.results).toEqual([
      expect.objectContaining({
        dir: "external",
        file: path.join(f.root, relativeFile),
        relativeFile,
        status: "ok",
        maxRssMb: expect.any(Number),
      }),
    ]);
    expect(report.qualification.gaps).toContain("canonical build identity unavailable");
    for (const row of [report.combined, ...report.results]) {
      expect(row).toMatchObject({ completion: "imports", cleanup: { childClosed: true } });
      expect(row.resources.totalCpuUs).toBe(row.resources.userCpuUs + row.resources.systemCpuUs);
      expect(row.cpuDeltaFromBaseline.totalCpuUs).toBe(
        row.resources.totalCpuUs - report.baseline.resources.totalCpuUs,
      );
    }
    expect(report.counts).toEqual(successCounts);
  });

  it("bounds noisy child output without losing RSS samples", () => {
    const f = profileFixture({
      "dist/extensions/noisy/index.js": [
        `const fs = require("node:fs");`,
        `fs.writeSync(2, "old stderr " + "x".repeat(160000) + "\\n");`,
        `fs.writeSync(1, "old stdout " + "y".repeat(160000) + "\\n");`,
        `process.on("exit", () => fs.writeSync(2, "exit tail\\n"));`,
      ].join("\n"),
    });
    const { report } = f.run(["noisy"]);
    expect(report.results).toHaveLength(1);
    const row = report.results[0];
    expect(row).toMatchObject({ status: "ok", maxRssMb: expect.any(Number) });
    for (const text of ["[output truncated", "[stderr preview truncated", "exit tail"]) {
      expect(row.stderrPreview).toContain(text);
    }
    expect(row.stderrPreview).not.toContain("old stderr");
    expect(row.stderrPreview.length).toBeLessThan(9_000);
  });

  it("preserves split UTF-8 output and rejects later descendant resource samples", async () => {
    const { root } = profileFixture({ "hook.mjs": "" });
    const hookPath = path.join(root, "hook.mjs");
    const stdout = "stdout: café 🦞";
    const stderr = "stderr: 東京\n__OPENCLAW_MAX_RSS_KB__=2048\nfin: é";
    const observed = {
      maxRssKb: 2048,
      userCpuUs: 10,
      systemCpuUs: 2,
      runtime: {
        node: process.version,
        v8: process.versions.v8,
        abi: process.versions.modules,
        platform: process.platform,
        arch: process.arch,
      },
    };
    let leaderPid: number | undefined;
    const splitBytes = () =>
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          for (const byte of chunk) {
            this.push(Buffer.from([byte]));
          }
          callback();
        },
      });
    const result = await fixtureCase({
      repoRoot: root,
      hookPath,
      name: "utf8-output",
      body: `
          process.stdout.write(${JSON.stringify(stdout)});
          process.stderr.write(${JSON.stringify(stderr)} + "\\n");
          const sample = { ...${JSON.stringify(observed)}, pid: process.pid };
          process.stderr.write(${JSON.stringify(RESOURCE_MARKER)} + JSON.stringify(sample) + "\\n");
          process.stderr.write(${JSON.stringify(RESOURCE_MARKER)} + JSON.stringify({ ...sample, pid: process.pid + 1, maxRssKb: 999999, userCpuUs: 999999 }) + "\\n");
          process.stderr.write("__OPENCLAW_MAX_RSS_KB__=999999\\n");
        `,
      spawnImpl(command, args, options) {
        const child = spawn(command, args, options);
        leaderPid = child.pid;
        // Preserve actual pipe bytes while forcing character boundaries apart.
        child.stdout = child.stdout.pipe(splitBytes());
        child.stderr = child.stderr.pipe(splitBytes());
        return child;
      },
    });

    expect(result).toEqual({
      name: "utf8-output",
      code: 0,
      signal: null,
      timedOut: false,
      error: null,
      stdout,
      stderr: expect.stringContaining(stderr),
      maxRssMb: 2,
      resources: { ...observed, pid: leaderPid, totalCpuUs: 12 },
      completion: "imports",
      cleanup: {
        childClosed: true,
        processGroup: process.platform === "win32" ? "unavailable" : "verified",
      },
    });
  });

  it("creates parent directories for nested JSON report paths", () => {
    const f = profileFixture(
      { "dist/extensions/simple/index.js": "export default {};\n" },
      ".artifacts/memory/report.json",
    );
    expect(f.run(["simple"]).report.counts).toMatchObject(successCounts);
  });

  it("uses distinct default JSON report paths for separate runs", () => {
    const { root } = profileFixture({ "dist/extensions/simple/index.js": "export default {};\n" });
    const reportPaths: string[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const result = runProfileExtensionMemory(
          ["--extension", "simple", "--skip-combined", "--concurrency", "1"],
          root,
        );
        expect(result.status, result.stderr).toBe(0);
        const reportPath = extractReportPath(result.stdout);
        reportPaths.push(reportPath);
        expect(path.dirname(reportPath)).toBe(tmpdir());
        expect(path.basename(reportPath)).toMatch(
          /^openclaw-extension-memory-\d+-\d+-[0-9a-f-]+\.json$/u,
        );
        expect(readJson(reportPath).counts).toMatchObject(successCounts);
      }
      expect(reportPaths[0]).not.toBe(reportPaths[1]);
    } finally {
      for (const reportPath of reportPaths) {
        rmSync(reportPath, { force: true });
      }
    }
  });

  it.each([
    { body: 'throw new Error("broken plugin import");', code: 1 },
    { body: "process.exit(0);", code: 0 },
  ])(
    "rejects incomplete imports and skips later combined entries: code $code",
    ({ body, code }) => {
      const f = profileFixture({ "dist/extensions/broken/index.js": body });
      const laterRuns = path.join(f.root, "later-runs.txt");
      writeExtension(
        f.root,
        "later",
        `require("node:fs").appendFileSync(${JSON.stringify(laterRuns)}, "later\\n");`,
      );
      const { result, report } = f.run(["broken", "later"], true, 1);
      expect(result.stderr).toContain("[extension-memory] broken import fail");
      expect(report).toMatchObject({
        counts: { fail: 1, ok: 1, timeout: 0 },
        results: [
          { dir: "broken", status: "fail", code, completion: null },
          { completion: "imports" },
        ],
        combined: { status: "fail", code, completion: null },
        baseline: { completion: "baseline" },
        qualification: { qualified: false },
      });
      expect(readFileSync(laterRuns, "utf8")).toBe("later\n");
      expect(report.qualification.gaps).toContain("awaited sequence completion unavailable");
    },
  );

  it("resolves spawn errors without waiting for the timeout", async () => {
    const startedAt = Date.now();
    const result = await fixtureCase({
      hookPath: "missing-hook.mjs",
      name: "spawn-error",
      spawnImpl: (() => {
        const child = new EventEmitter() as EventEmitter & {
          kill: () => boolean;
          stderr: PassThrough;
          stdout: PassThrough;
        };
        child.stderr = new PassThrough();
        child.stdout = new PassThrough();
        child.kill = () => true;
        queueMicrotask(() => child.emit("error", new Error("spawn denied")));
        return child;
      }) as unknown as typeof spawn,
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result).toMatchObject({
      code: null,
      error: "spawn-error: code=null, signal=null, timedOut=false; spawn denied",
      name: "spawn-error",
      signal: null,
      timedOut: false,
    });
  });

  it.runIf(process.platform !== "win32").each([
    ...[
      "mapper failure",
      "unverified group",
      "parent signal",
      "home deletion failure",
      "environment isolation",
      "report home deletion failure",
      "delayed parent close",
      "linux cleanup deadline",
      "linux parent deadline",
    ].map((scenario) => ({
      scenario,
      signalFailureCase: null,
    })),
    ...["baseline", "combined", "a-held"].map((signalFailureCase) => ({
      scenario: "settled signal failure",
      signalFailureCase,
    })),
  ])("handles $scenario ($signalFailureCase)", ({ scenario, signalFailureCase }) => {
    const unverifiedGroup = scenario === "unverified group";
    const delayedParentClose = scenario === "delayed parent close";
    const linuxDeadline = scenario.startsWith("linux ");
    const parentSignal =
      scenario === "parent signal" || delayedParentClose || scenario === "linux parent deadline";
    const reportHomeFailure = scenario === "report home deletion failure";
    const homeDeletionFailure = scenario === "home deletion failure" || reportHomeFailure;
    const signalFailure = scenario === "settled signal failure";
    const environmentIsolation = scenario === "environment isolation";
    const includeCombined = signalFailureCase === "combined" || environmentIsolation;
    const completeImports = signalFailure || reportHomeFailure || environmentIsolation;
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-mappers-"));
    const journalPath = path.join(root, "journal.json");
    const preloadPath = path.join(root, "spawn-fixture.mjs");
    const reportPath = path.join(root, "report.json");
    let home: string | undefined;
    try {
      for (const id of ["a-held", "b-error", "c-unused"]) {
        writeExtension(root, id);
      }
      writeFileSync(
        preloadPath,
        [
          "import assert from 'node:assert/strict';",
          "import cp from 'node:child_process';",
          "import { EventEmitter } from 'node:events';",
          "import fs, { existsSync, writeFileSync } from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          "import path from 'node:path';",
          "import { PassThrough } from 'node:stream';",
          "import { fileURLToPath } from 'node:url';",
          "let home, finishHeld, homeDuringClose, failedPid;",
          "const started = [], closed = [], signals = [], live = new Map();",
          "let now = 1_000;",
          "const probes = [], signalTimes = [];",
          `if (${linuxDeadline}) {`,
          "  Object.defineProperty(process, 'platform', { value: 'linux' });",
          "  Date.now = () => now;",
          "  cp.spawnSync = (bin, args, options) => {",
          "    if (bin !== 'ps' || !args.includes('-L') || !(options.timeout > 0))",
          "      throw new Error('expected a positive, thread-aware snapshot budget');",
          "    probes.push({ at: now, timeout: options.timeout });",
          "    now += options.timeout;",
          "    return { pid: 12346, output: [], status: null, signal: 'SIGKILL',",
          "      stdout: '', stderr: '', error: Object.assign(new Error('snapshot timed out'), { code: 'ETIMEDOUT' }) };",
          "  };",
          "}",
          "const remove = fs.rmSync;",
          "fs.rmSync = (target, options) => {",
          `  if (${homeDeletionFailure} && target === home)`,
          "    throw Object.assign(new Error('home cleanup denied'), { code: 'EACCES' });",
          "  return remove(target, options);",
          "};",
          "process.on('exit', () => writeFileSync(" + JSON.stringify(journalPath) + ",",
          "  JSON.stringify({ home, pending: live.size > 0, started, closed, signals, signalTimes, probes, elapsed: now - 1_000, homeDuringClose, homeExists: existsSync(home) })));",
          "process.kill = (pid, signal) => {",
          `  if (${signalFailure} && pid === -failedPid && live.has(-pid)) {`,
          "    if (signal === 0) return true;",
          "    signals.push([pid, signal]); live.delete(-pid);",
          "    throw Object.assign(new Error('group signal failed after exit'), { code: 'EIO' });",
          "  }",
          `  if (${parentSignal} && live.has(-pid)) {`,
          "    if (signal === 0) return true;",
          "    signals.push([pid, signal]);",
          "    signalTimes.push({ pid, signal, at: now });",
          `    if (!${linuxDeadline} && pid === -2147483646 && signal === 'SIGTERM')`,
          "      throw Object.assign(new Error('group signal failed'), { code: 'EIO' });",
          "    const finish = live.get(-pid);",
          `    if (${delayedParentClose || linuxDeadline}) finish(signal); else queueMicrotask(() => finish(signal));`,
          "    return true;",
          "  }",
          `  if (${linuxDeadline} && live.has(-pid)) {`,
          "    if (signal !== 0) {",
          "      signals.push([pid, signal]); signalTimes.push({ pid, signal, at: now });",
          "    }",
          "    return true;",
          "  }",
          `  if (${unverifiedGroup} && pid === -2147483646)`,
          "    throw Object.assign(new Error('inspection denied'), { code: 'EPERM' });",
          "  throw Object.assign(new Error('missing group'), { code: 'ESRCH' });",
          "};",
          "cp.spawn = (_command, args, options) => {",
          "  home = options.env.HOME;",
          `  if (${environmentIsolation}) {`,
          "    const expectedHome = path.dirname(fileURLToPath(args[1]));",
          "    assert.equal(options.env.HOME, expectedHome);",
          "    assert.equal(options.env.USERPROFILE, expectedHome);",
          "    assert.equal(options.env.OPENCLAW_HOME, expectedHome);",
          "    assert.equal(options.env.OPENCLAW_STATE_DIR, path.join(expectedHome, '.openclaw'));",
          "    assert.equal(options.env.OPENCLAW_CONFIG_PATH, path.join(expectedHome, '.openclaw', 'openclaw.json'));",
          "    assert.equal(options.env.XDG_CONFIG_HOME, path.join(expectedHome, '.config'));",
          "    assert.equal(options.env.XDG_CACHE_HOME, path.join(expectedHome, '.cache'));",
          "    assert.equal(options.env.XDG_DATA_HOME, path.join(expectedHome, '.local', 'share'));",
          "    assert.equal(options.env.XDG_STATE_HOME, path.join(expectedHome, '.local', 'state'));",
          "    assert.equal(options.env.XDG_RUNTIME_DIR, path.join(expectedHome, '.run'));",
          "    assert.equal(options.env.NODE_DISABLE_COMPILE_CACHE, '1');",
          "    assert.equal(options.env.OPENCLAW_NO_RESPAWN, '1');",
          "  }",
          "  const body = args.at(-1);",
          "  const completion = body.match(/__OPENCLAW_IMPORT_COMPLETE__=[a-f0-9-]+/)?.[0];",
          "  const name = body.includes('IMPORTED_ALL') ? 'combined' :",
          "    body.match(/\\/(a-held|b-error|c-unused)\\//)?.[1] ?? 'baseline';",
          "  started.push(name);",
          `  if (name === 'b-error' && !${parentSignal} && !${completeImports}) {`,
          "    setImmediate(() => finishHeld());",
          "    throw new Error('mapper spawn failed');",
          "  }",
          "  const child = Object.assign(new EventEmitter(), {",
          "    pid: { 'a-held': 2147483646, 'b-error': 2147483645, 'c-unused': 2147483644,",
          "      baseline: 2147483643, combined: 2147483642 }[name],",
          "    exitCode: null, signalCode: null,",
          "    stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,",
          "  });",
          `  if (name === ${JSON.stringify(signalFailureCase)}) failedPid = child.pid;`,
          "  let finished = false;",
          "  const finish = (signal = null) => {",
          "    if (finished) return;",
          "    finished = true;",
          `    if (child.pid !== failedPid && !(${linuxDeadline} && name === 'a-held')) live.delete(child.pid);`,
          "    child.exitCode = signal ? null : 0; child.signalCode = signal;",
          "    child.emit('exit', child.exitCode, signal);",
          "    const close = () => {",
          "      if (name === 'a-held') homeDuringClose = existsSync(home);",
          "      child.stderr.write('\\n' + completion + '\\n');",
          "      const runtime = { node: process.version, v8: process.versions.v8, abi: process.versions.modules, platform: process.platform, arch: process.arch };",
          `      child.stderr.end('primary stderr for ' + name + '\\n' + ${JSON.stringify(RESOURCE_MARKER)} + JSON.stringify({ pid: child.pid, maxRssKb: 2048, userCpuUs: 10, systemCpuUs: 2, runtime }) + '\\n');`,
          "      child.stdout.end(); closed.push(name);",
          "      child.emit('close', child.exitCode, signal);",
          "    };",
          // Separate group disappearance from pipe closure without timing-based sleeps.
          `    if (${delayedParentClose} && name !== 'baseline') setImmediate(close);`,
          "    else close();",
          "  };",
          "  live.set(child.pid, finish);",
          `  if (name === 'a-held' && !${completeImports}) finishHeld = finish;`,
          `  else if (${parentSignal} && name === 'b-error') queueMicrotask(() => process.emit('SIGTERM'));`,
          "  else queueMicrotask(finish);",
          "  return child;",
          "};",
          "syncBuiltinESMExports();",
        ].join("\n"),
      );
      const result = spawnSync(
        testNodeExecPath,
        [
          "--import",
          TSX_PRELOAD,
          "--import",
          preloadPath,
          SCRIPT_PATH,
          ...(includeCombined ? [] : ["--skip-combined"]),
          "--concurrency",
          "2",
          "--json",
          reportPath,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            ...(environmentIsolation
              ? Object.fromEntries(
                  [
                    "HOME",
                    "USERPROFILE",
                    "OPENCLAW_HOME",
                    "OPENCLAW_STATE_DIR",
                    "OPENCLAW_CONFIG_PATH",
                    "XDG_CONFIG_HOME",
                    "XDG_CACHE_HOME",
                    "XDG_DATA_HOME",
                    "XDG_STATE_HOME",
                    "XDG_RUNTIME_DIR",
                  ].map((key) => [key, path.join(root, `inherited-${key}`)]),
                )
              : {}),
            TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH,
          },
          encoding: "utf8",
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      home = journal.home;
      expect(result.status, result.stderr).toBe(environmentIsolation ? 0 : parentSignal ? 143 : 1);
      expect(journal.pending).toBe(linuxDeadline);
      expect(journal.started).toEqual([
        "baseline",
        ...(includeCombined ? ["combined"] : []),
        "a-held",
        "b-error",
        ...(completeImports ? ["c-unused"] : []),
      ]);
      if (environmentIsolation) {
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        expect(report.counts.fail).toBe(0);
        expect(journal.closed).toEqual(expect.arrayContaining(journal.started));
        expect(journal.homeExists).toBe(false);
      } else if (parentSignal) {
        if (!linuxDeadline) {
          expect(result.stderr).toContain("group signal failed");
        }
        expect(journal.signals).toContainEqual([-2147483645, "SIGTERM"]);
        expect(journal.signals).toContainEqual([-2147483646, "SIGKILL"]);
        if (delayedParentClose) {
          expect(journal.closed).toEqual(expect.arrayContaining(journal.started));
          expect(result.stderr).toContain("primary stderr for a-held");
        }
      } else if (reportHomeFailure) {
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        expect(report).toMatchObject({
          counts: { fail: 0 },
          qualification: { qualified: false, temporaryHomeRemoved: false },
        });
        expect(report.qualification.gaps).toContain("temporary-home cleanup incomplete");
        expect(report.qualification.gaps).not.toContain("resource counters unavailable");
        expect(result.stderr).toContain("home cleanup denied");
        expect(journal.homeExists).toBe(true);
      } else if (signalFailure) {
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        const failed =
          signalFailureCase === "baseline"
            ? report.baseline
            : signalFailureCase === "combined"
              ? report.combined
              : report.results.find((entry: { dir: string }) => entry.dir === "a-held");
        expect(failed).toMatchObject({
          status: "fail",
          code: 0,
          signal: null,
          error: expect.stringContaining("group signal failed after exit"),
          stderrPreview: expect.stringContaining(`primary stderr for ${signalFailureCase}`),
        });
        expect(report.qualification.qualified).toBe(false);
        expect(report.qualification.gaps).toContain("import did not complete successfully");
        expect(result.stderr).toContain("group signal failed after exit");
        expect(result.stderr).toContain(`primary stderr for ${signalFailureCase}`);
        expect(journal.homeExists).toBe(false);
      } else {
        expect(result.stderr).toContain("mapper spawn failed");
        expect(journal.homeExists).toBe(unverifiedGroup || homeDeletionFailure || linuxDeadline);
        if (unverifiedGroup) {
          expect(result.stderr).toMatch(/cleanup/i);
        }
        if (homeDeletionFailure) {
          expect(result.stderr).toContain("mapper spawn failed; home cleanup denied");
        }
      }
      if (linuxDeadline) {
        expect(result.stderr).toMatch(/cleanup/i);
        expect(journal.homeExists).toBe(true);
        expect(journal.elapsed).toBeLessThanOrEqual(parentSignal ? 2_000 : 1_000);
        expect(journal.probes.length).toBeGreaterThan(0);
        expect(
          journal.probes.every(
            (probe: { timeout: number }) => probe.timeout > 0 && probe.timeout <= 1_000,
          ),
        ).toBe(true);
        if (parentSignal) {
          const forced = journal.signalTimes.find(
            (entry: { pid: number; signal: string }) =>
              entry.pid === -2147483646 && entry.signal === "SIGKILL",
          );
          expect(forced?.at).toBeLessThanOrEqual(2_000);
        }
      }
      expect(journal.homeDuringClose).toBe(true);
    } finally {
      // These CLI fixtures model children in memory; no native descendant owns the home.
      if (home) {
        rmSync(home, { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32").each(["alive", "EPERM"] as const)(
    "rejects when the owned group is %s after SIGKILL",
    async (groupState) => {
      const child = fakeChild();
      const signal = vi.spyOn(process, "kill").mockImplementation((pid, requestedSignal) => {
        expect(pid).toBe(-child.pid);
        if (requestedSignal === 0) {
          if (groupState !== "alive") {
            throw Object.assign(new Error(`group inspection failed: ${groupState}`), {
              code: groupState,
            });
          }
          return true;
        }
        expect(requestedSignal).toBe("SIGKILL");
        queueMicrotask(() => {
          child.signalCode = "SIGKILL";
          child.stdout.end();
          child.stderr.end();
          child.emit("close", null, "SIGKILL");
        });
        return true;
      });
      try {
        await expect(
          fixtureCase({
            name: "unverified-cleanup",
            shutdownGraceMs: 0,
            timeoutMs: 5,
            spawnImpl: (() => child) as unknown as typeof spawn,
          }),
        ).rejects.toThrow(/cleanup/i);
      } finally {
        signal.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves EPERM group-signal and primary failures with unverified cleanup",
    async () => {
      const errorCode = "EPERM";
      const primary = new Error("case failed");
      const groupSignalError = Object.assign(new Error("group signal failed"), { code: errorCode });
      const child = fakeChild({
        exitCode: 1,
        kill: vi.fn(() => {
          throw new Error("leader fallback must not replace the group error");
        }),
      });
      const signal = vi.spyOn(process, "kill").mockImplementation((pid, requestedSignal) => {
        expect(pid).toBe(-child.pid);
        if (requestedSignal === 0) {
          throw Object.assign(new Error("inspection failed"), { code: errorCode });
        }
        expect(requestedSignal).toBe("SIGKILL");
        throw groupSignalError;
      });
      try {
        const result = fixtureCase({
          name: "failed-group-signal",
          shutdownGraceMs: 0,
          spawnImpl: (() => {
            queueMicrotask(() => {
              child.emit("error", primary);
              child.stdout.end();
              child.stderr.end();
              child.emit("close", 1, null);
            });
            return child;
          }) as unknown as typeof spawn,
        });
        await expect(result).rejects.toMatchObject({
          errors: [
            expect.objectContaining({ errors: [primary, groupSignalError] }),
            expect.objectContaining({ code: "EPROCESSGROUP_CLEANUP_FAILED" }),
          ],
        });
        expect(child.kill).not.toHaveBeenCalled();
      } finally {
        signal.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves SIGTERM evidence without an error event",
    async () => {
      const child = fakeChild({ signalCode: "SIGTERM" });
      const signal = vi.spyOn(process, "kill").mockImplementation((pid, requestedSignal) => {
        expect(pid).toBe(-child.pid);
        expect([0, "SIGKILL"]).toContain(requestedSignal);
        return true;
      });
      try {
        const failure: unknown = await fixtureCase({
          name: "terminal-without-error-event",
          shutdownGraceMs: 0,
          spawnImpl: (() => {
            queueMicrotask(() => {
              child.stderr.end(`${"x".repeat(160_000)}\nprimary import diagnostic\n`);
              child.stdout.end();
              child.emit("exit", null, "SIGTERM");
              child.emit("close", null, "SIGTERM");
            });
            return child;
          }) as unknown as typeof spawn,
        }).then(
          () => {
            throw new Error("unverified cleanup resolved unexpectedly");
          },
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) {
          throw new Error("missing cleanup failure");
        }
        expect(hasUnjoinedWork(failure)).toBe(true);
        expect(failure.message).toMatch(/SIGTERM/u);
        expect(failure.message).toContain("primary import diagnostic");
        expect(failure.message).toMatch(/cleanup/i);
        expect(failure.message.length).toBeLessThan(10_000);
      } finally {
        signal.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32").for(["exit", "timeout", "parent signal"] as const)(
    "cleans native descendants on %s before settlement",
    async (mode, { signal, onTestFinished }) => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-descendant-"));
      const hookPath = path.join(root, "rss-hook.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      let cleanup = async () => rmSync(root, { recursive: true, force: true });
      let cleanupPromise: Promise<void> | undefined;
      const joinCleanup = () => (cleanupPromise ??= cleanup());
      onTestFinished(joinCleanup);
      const own = (child: ReturnType<typeof spawn>, detached = true) => {
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
          },
        );
        cleanup = () =>
          cleanupProfileFixture(root, child, closed, descendantPidPath, signal, detached);
        return closed;
      };
      await runQaGatewayFixture(async () => {
        writeFileSync(hookPath, "", "utf8");
        const parentSignal = mode === "parent signal";
        const descendantScript = descendantSource(
          descendantPidPath,
          parentSignal
            ? `sendReceipt(${JSON.stringify(descendantPidPath)}, 'ready');`
            : "process.send(process.pid);",
          [
            ...(parentSignal ? [fixtureReceiptClientSource(receipts.endpoint)] : []),
            ...(mode === "exit" ? [] : ["process.on('SIGTERM', () => {});"]),
          ].join("\n"),
        );
        const body = [
          "const childProcess = await import('node:child_process');",
          `const descendant = childProcess.spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(descendantScript)}],`,
          `  { stdio: ${parentSignal ? "'ignore'" : "['ignore', 'ignore', 'ignore', 'ipc']"} });`,
          ...(mode === "exit"
            ? [
                "await new Promise((resolve) => descendant.once('message', resolve));",
                "descendant.disconnect(); descendant.unref();",
              ]
            : [
                ...(parentSignal
                  ? []
                  : [
                      "descendant.once('message', (pid) => process.stdout.write('descendant-ready ' + pid + '\\n'));",
                      "descendant.once('error', (error) => { throw error; });",
                    ]),
                "setInterval(() => {}, 1000);",
                "await new Promise(() => {});",
              ]),
        ].join("\n");
        if (mode === "exit") {
          const result = await withinTest(
            fixtureCase({
              body,
              hookPath,
              name: "ordinary-exit-descendant",
              repoRoot: root,
              shutdownGraceMs: 1_000,
              timeoutMs: 5_000,
              spawnImpl: (command, args, options) => {
                const child = spawn(command, args, options);
                own(child);
                return child;
              },
            }),
            signal,
          );
          expect(result).toMatchObject({ code: 0, error: null, signal: null, timedOut: false });
          expect(isProcessAlive(readDescendantPid(descendantPidPath))).toBe(false);
          return;
        }
        if (parentSignal) {
          const runnerPath = path.join(root, "parent-signal-runner.mjs");
          writeFileSync(
            runnerPath,
            [
              `const { runCase } = await import(${JSON.stringify(pathToFileURL(SCRIPT_PATH).href)});`,
              `void runCase({ ...${JSON.stringify({
                completionKind: "imports",
                body,
                hookPath,
                name: "parent-signal-descendant",
                repoRoot: root,
                shutdownGraceMs: 100,
                timeoutMs: 30_000,
              })}, env: process.env });`,
            ].join("\n"),
            "utf8",
          );
          const runner = spawn(testNodeExecPath, ["--import", TSX_PRELOAD, runnerPath], {
            stdio: "ignore",
          });
          const runnerClosed = own(runner, false);
          await withinTest(once(runner, "spawn"), signal);
          await withinTest(
            Promise.race([
              receipts.waitFor(descendantPidPath, "ready"),
              runnerClosed.then(() => {
                // Receipt delivery and exit race; the descendant writes its PID first.
                if (!existsSync(descendantPidPath)) {
                  throw new Error(`timeout waiting for pid in ${descendantPidPath}`);
                }
                readDescendantPid(descendantPidPath);
              }),
            ]),
            signal,
          );
          expect(isProcessAlive(readDescendantPid(descendantPidPath))).toBe(true);
          process.kill(runner.pid!, "SIGTERM");
          await expect(withinTest(runnerClosed, signal)).resolves.toEqual({
            code: 143,
            signal: null,
          });
        } else {
          const child = spawn(
            testNodeExecPath,
            ["--import", hookPath, "--input-type=module", "--eval", body],
            { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
          );
          const childClosed = own(child);
          const ready = createDeferred<number>();
          let output = "";
          const readReady = (chunk: string) => {
            output += chunk;
            const match = /^descendant-ready (\d+)\n/mu.exec(output);
            if (match) {
              child.stdout.off("data", readReady);
              ready.resolve(Number(match[1]));
            }
          };
          child.stdout.setEncoding("utf8").on("data", readReady);
          await withinTest(once(child, "spawn"), signal);
          const pid = await withinTest(
            awaitGateBeforeSettlement(
              ready.promise,
              childClosed,
              `timeout waiting for pid in ${descendantPidPath}`,
            ),
            signal,
          );
          expect(Number.isInteger(pid)).toBe(true);
          expect(isProcessAlive(pid)).toBe(true);
          // Admission starts the timer only after native readiness, independent of host load.
          await expect(
            withinTest(
              fixtureCase({
                body,
                hookPath,
                name: "timeout-descendant",
                repoRoot: root,
                shutdownGraceMs: 100,
                timeoutMs: 250,
                spawnImpl: () => child,
              }),
              signal,
            ),
          ).resolves.toMatchObject({
            name: "timeout-descendant",
            signal: "SIGKILL",
            timedOut: true,
          });
        }
        const descendantPid = readDescendantPid(descendantPidPath);
        await waitForProcessCleanup(
          () => !isProcessAlive(descendantPid),
          `process still alive: ${descendantPid}`,
          signal,
        );
      }, joinCleanup);
    },
  );
});
