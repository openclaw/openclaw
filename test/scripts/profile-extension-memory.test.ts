// Profile Extension Memory tests cover profile extension memory script behavior.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";
import { parseArgs, runCase } from "../../scripts/profile-extension-memory.mts";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import { isProcessAlive, waitForDead, waitForPidFile } from "../helpers/process-wait.js";
import { withTestTimeout } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

const SCRIPT_PATH = path.resolve("scripts/profile-extension-memory.mts");
const TSX_PRELOAD = path.resolve("scripts/tsx.mjs");
const SOURCE_TSCONFIG_PATH = path.resolve("tsconfig.json");

function runProfileExtensionMemory(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, ["--import", TSX_PRELOAD, SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
    // Fixture cwd controls artifacts; source imports still need the repository's aliases.
    env: { ...process.env, TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH },
  });
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
  detached = true,
): Promise<void> {
  let childClosed = false;
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
      await withTestTimeout(
        closed,
        5_000,
        `profile child did not close; retained fixture: ${root}`,
      );
      childClosed = true;
    },
    async () => {
      if (!existsSync(descendantPidPath)) {
        return;
      }
      descendantPid = await waitForPidFile(descendantPidPath, 5_000);
      killPidIfAlive(descendantPid);
    },
    async () => {
      // A failed signal is not proof of exit. Retain PID files until the owned
      // processes and the child's output are verified stopped.
      await runQaGatewayFixture(
        async () => {
          if (descendantPid) {
            await waitForDead(descendantPid, 5_000);
          }
        },
        async () => {
          if (!detached || !child.pid) {
            return;
          }
          await waitForManagedProcessGroupExit(child, 5_000, { errorPolicy: "indeterminate" });
          expect(
            inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }),
            `retained fixture: ${root}`,
          ).toBe("dead");
        },
      );
      if (childClosed) {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

describe("scripts/profile-extension-memory", () => {
  it("prints help without requiring built plugin artifacts", () => {
    const result = runProfileExtensionMemory(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/profile-extension-memory.mts",
    );
  });

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

  it("rejects loose numeric flags before scanning built plugin artifacts", () => {
    const cases = [
      ["--concurrency", "2abc"],
      ["--timeout-ms", "1e3"],
      ["--combined-timeout-ms", "90000ms"],
      ["--top", "0x10"],
    ] as const;

    for (const [flag, value] of cases) {
      expect(() => parseArgs([flag, value])).toThrow(`${flag} must be a positive integer`);
    }

    const result = runProfileExtensionMemory([...cases[0]]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`[extension-memory] ${cases[0][0]} must be a positive integer`);
    expect(result.stderr).not.toContain("dist/extensions");
    expect(result.stderr).not.toContain("at ");
  });

  it("rejects option-looking string flag values before scanning built plugin artifacts", () => {
    const cases = [
      ["--extension", "-h"],
      ["--json", "-h"],
    ] as const;
    for (const [flag, value] of cases) {
      expect(() => parseArgs([flag, value])).toThrow(`${flag} requires a value`);
    }

    const result = runProfileExtensionMemory([...cases[0]]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`[extension-memory] ${cases[0][0]} requires a value`);
    expect(result.stderr).not.toContain("dist/extensions");
    expect(result.stderr).not.toContain("at ");
  });

  it.each([
    {
      name: "package-local output without a root dist tree",
      files: ["extensions/external/dist/index.js"],
      selected: ["external"],
      expected: [{ dir: "external", file: "extensions/external/dist/index.js" }],
    },
    {
      name: "nested output in the root plugin tree",
      files: ["dist/extensions/external/dist/index.js"],
      selected: ["external"],
      expected: [{ dir: "external", file: "dist/extensions/external/dist/index.js" }],
    },
    ...[true, false].map((selected) => ({
      name: `mixed internal and external output (${selected ? "selected" : "default"})`,
      files: ["dist/extensions/internal/index.js", "extensions/external/dist/index.js"],
      selected: selected ? ["internal", "external"] : [],
      expected: [
        { dir: "external", file: "extensions/external/dist/index.js" },
        { dir: "internal", file: "dist/extensions/internal/index.js" },
      ],
    })),
    ...["index.js", "dist/index.js"].map((rootEntry) => ({
      name: `one canonical root ${rootEntry} when both builds exist`,
      files: [`dist/extensions/external/${rootEntry}`, "extensions/external/dist/index.js"],
      selected: ["external", "external"],
      expected: [{ dir: "external", file: `dist/extensions/external/${rootEntry}` }],
    })),
    {
      name: "source-only plugins excluded from default enumeration",
      files: ["dist/extensions/internal/index.js"],
      selected: [],
      expected: [{ dir: "internal", file: "dist/extensions/internal/index.js" }],
    },
  ])("profiles $name", ({ files, selected, expected }) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-")));
    try {
      for (const relativeFile of [
        ...files,
        "extensions/external/index.ts",
        "extensions/internal/index.ts",
        "extensions/source-only/index.ts",
      ]) {
        const file = path.join(root, relativeFile);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
          file,
          file.endsWith(".ts") ? 'throw new Error("source imported");\n' : "export {};\n",
          "utf8",
        );
      }
      const reportPath = path.join(root, "report.json");
      const result = runProfileExtensionMemory(
        [
          ...selected.flatMap((id) => ["--extension", id]),
          "--concurrency",
          "1",
          "--json",
          reportPath,
        ],
        root,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("cliStartup");
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.selectedExtensions).toEqual(expected.map(({ dir }) => dir));
      expect(report.results).toEqual(
        expected.map(({ dir, file }) =>
          expect.objectContaining({
            dir,
            file: path.join(root, file),
            status: "ok",
            maxRssMb: expect.any(Number),
          }),
        ),
      );
      expect(report.combined).toMatchObject({ status: "ok", maxRssMb: expect.any(Number) });
      expect(report.counts).toEqual({
        totalEntries: expected.length,
        ok: expected.length,
        fail: 0,
        timeout: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds noisy child output without losing RSS samples", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-"));
    try {
      const extensionDir = path.join(root, "dist", "extensions", "noisy");
      const reportPath = path.join(root, "report.json");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "index.js"),
        [
          `const fs = require("node:fs");`,
          `fs.writeSync(2, "old stderr " + "x".repeat(160000) + "\\n");`,
          `fs.writeSync(1, "old stdout " + "y".repeat(160000) + "\\n");`,
          `process.on("exit", () => fs.writeSync(2, "exit tail\\n"));`,
        ].join("\n"),
        "utf8",
      );

      const result = runProfileExtensionMemory(
        ["--extension", "noisy", "--skip-combined", "--concurrency", "1", "--json", reportPath],
        root,
      );

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.results).toHaveLength(1);
      expect(report.results[0].status).toBe("ok");
      expect(report.results[0].maxRssMb).toEqual(expect.any(Number));
      expect(report.results[0].stderrPreview).toContain("[output truncated");
      expect(report.results[0].stderrPreview).toContain("[stderr preview truncated");
      expect(report.results[0].stderrPreview).toContain("exit tail");
      expect(report.results[0].stderrPreview).not.toContain("old stderr");
      expect(report.results[0].stderrPreview.length).toBeLessThan(9_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves split UTF-8 child output through EOF and RSS accounting", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-utf8-"));
    const hookPath = path.join(root, "hook.mjs");
    const stdout = "stdout: café 🦞";
    const stderr = "stderr: 東京\n__OPENCLAW_MAX_RSS_KB__=2048\nfin: é";
    const splitBytes = () =>
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          for (const byte of chunk) {
            this.push(Buffer.from([byte]));
          }
          callback();
        },
      });
    try {
      writeFileSync(hookPath, "", "utf8");
      const result = await runCase({
        repoRoot: root,
        env: process.env,
        hookPath,
        name: "utf8-output",
        body: `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`,
        timeoutMs: 30_000,
        spawnImpl(command, args, options) {
          const child = spawn(command, args, options);
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
        stderr,
        maxRssMb: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates parent directories for nested JSON report paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-"));
    try {
      const extensionDir = path.join(root, "dist", "extensions", "simple");
      const reportPath = path.join(root, ".artifacts", "memory", "report.json");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(path.join(extensionDir, "index.js"), `export default {};\n`, "utf8");

      const result = runProfileExtensionMemory(
        ["--extension", "simple", "--skip-combined", "--concurrency", "1", "--json", reportPath],
        root,
      );

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.counts).toMatchObject({ totalEntries: 1, ok: 1, fail: 0, timeout: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses distinct default JSON report paths for separate runs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-"));
    const reportPaths: string[] = [];
    try {
      const extensionDir = path.join(root, "dist", "extensions", "simple");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(path.join(extensionDir, "index.js"), `export default {};\n`, "utf8");

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
        expect(JSON.parse(readFileSync(reportPath, "utf8")).counts).toMatchObject({
          totalEntries: 1,
          ok: 1,
          fail: 0,
          timeout: 0,
        });
      }

      expect(reportPaths[0]).not.toBe(reportPaths[1]);
    } finally {
      for (const reportPath of reportPaths) {
        rmSync(reportPath, { force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when a profiled plugin import fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-"));
    try {
      const extensionDir = path.join(root, "dist", "extensions", "broken");
      const reportPath = path.join(root, "report.json");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "index.js"),
        `throw new Error("broken plugin import");\n`,
        "utf8",
      );

      const result = runProfileExtensionMemory(
        ["--extension", "broken", "--skip-combined", "--concurrency", "1", "--json", reportPath],
        root,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[extension-memory] broken import fail");
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.counts).toMatchObject({ fail: 1, ok: 0, timeout: 0 });
      expect(report.results[0]).toMatchObject({ dir: "broken", status: "fail" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves spawn errors without waiting for the timeout", async () => {
    const startedAt = Date.now();
    const result = await runCase({
      repoRoot: process.cwd(),
      env: process.env,
      hookPath: "missing-hook.mjs",
      name: "spawn-error",
      body: "",
      timeoutMs: 30_000,
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
    ...["mapper failure", "unverified group", "parent signal", "home deletion failure"].map(
      (scenario) => ({
        name: `settles admitted mappers and stops admission on ${scenario}`,
        scenario,
        signalFailureCase: null as string | null,
      }),
    ),
    {
      name: "parent shutdown joins delayed case closure before exit",
      scenario: "delayed parent close",
      signalFailureCase: null,
    },
    {
      name: "bounds Linux snapshots across initial and final case cleanup probes",
      scenario: "linux cleanup deadline",
      signalFailureCase: null,
    },
    {
      name: "bounds Linux snapshots by parent escalation and final drainage",
      scenario: "linux parent deadline",
      signalFailureCase: null,
    },
    ...["baseline", "combined", "a-held"].map((signalFailureCase) => ({
      name: `reports signal failure after verified cleanup for ${signalFailureCase}`,
      scenario: "settled signal failure",
      signalFailureCase,
    })),
  ])("$name", ({ scenario, signalFailureCase }) => {
    const unverifiedGroup = scenario === "unverified group";
    const delayedParentClose = scenario === "delayed parent close";
    const linuxDeadline = scenario.startsWith("linux ");
    const parentSignal =
      scenario === "parent signal" || delayedParentClose || scenario === "linux parent deadline";
    const homeDeletionFailure = scenario === "home deletion failure";
    const signalFailure = scenario === "settled signal failure";
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-mappers-"));
    const journalPath = path.join(root, "journal.json");
    const preloadPath = path.join(root, "spawn-fixture.mjs");
    const reportPath = path.join(root, "report.json");
    let home: string | undefined;
    try {
      for (const id of ["a-held", "b-error", "c-unused"]) {
        const dir = path.join(root, "dist", "extensions", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "index.js"), "export {};\n");
      }
      writeFileSync(
        preloadPath,
        [
          "import cp from 'node:child_process';",
          "import { EventEmitter } from 'node:events';",
          "import fs, { existsSync, writeFileSync } from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          "import { PassThrough } from 'node:stream';",
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
          "  const body = args.at(-1);",
          "  const name = body.includes('IMPORTED_ALL') ? 'combined' :",
          "    body.match(/\\/(a-held|b-error|c-unused)\\//)?.[1] ?? 'baseline';",
          "  started.push(name);",
          `  if (name === 'b-error' && !${parentSignal} && !${signalFailure}) {`,
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
          "      child.stderr.end('primary stderr for ' + name + '\\n__OPENCLAW_MAX_RSS_KB__=2048\\n');",
          "      child.stdout.end(); closed.push(name);",
          "      child.emit('close', child.exitCode, signal);",
          "    };",
          // Separate group disappearance from pipe closure without timing-based sleeps.
          `    if (${delayedParentClose} && name !== 'baseline') setImmediate(close);`,
          "    else close();",
          "  };",
          "  live.set(child.pid, finish);",
          `  if (name === 'a-held' && !${signalFailure}) finishHeld = finish;`,
          `  else if (${parentSignal} && name === 'b-error') queueMicrotask(() => process.emit('SIGTERM'));`,
          "  else queueMicrotask(finish);",
          "  return child;",
          "};",
          "syncBuiltinESMExports();",
        ].join("\n"),
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          TSX_PRELOAD,
          "--import",
          preloadPath,
          SCRIPT_PATH,
          ...(signalFailureCase === "combined" ? [] : ["--skip-combined"]),
          "--concurrency",
          "2",
          "--json",
          reportPath,
        ],
        {
          cwd: root,
          env: { ...process.env, TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH },
          encoding: "utf8",
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      home = journal.home;
      expect(result.status, result.stderr).toBe(parentSignal ? 143 : 1);
      expect(journal.pending).toBe(linuxDeadline);
      expect(journal.started).toEqual([
        "baseline",
        ...(signalFailureCase === "combined" ? ["combined"] : []),
        "a-held",
        "b-error",
        ...(signalFailure ? ["c-unused"] : []),
      ]);
      if (parentSignal) {
        if (!linuxDeadline) {
          expect(result.stderr).toContain("group signal failed");
        }
        expect(journal.signals).toContainEqual([-2147483645, "SIGTERM"]);
        expect(journal.signals).toContainEqual([-2147483646, "SIGKILL"]);
        if (delayedParentClose) {
          expect(journal.closed).toEqual(expect.arrayContaining(journal.started));
          expect(result.stderr).toContain("primary stderr for a-held");
        }
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

  it.runIf(process.platform !== "win32")(
    "cleans descendants after an ordinary leader exit before resolving the case",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-exit-"));
      const hookPath = path.join(root, "rss-hook.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      let cleanup = async () => rmSync(root, { recursive: true, force: true });
      await runQaGatewayFixture(
        async () => {
          writeFileSync(hookPath, "", "utf8");
          const descendantScript = [
            "import { writeFileSync } from 'node:fs';",
            "setInterval(() => {}, 1000);",
            `writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
            "process.send('ready');",
          ].join("\n");
          const body = [
            "import { spawn } from 'node:child_process';",
            `const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(descendantScript)}],`,
            "  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
            "child.once('message', () => { child.disconnect(); child.unref(); });",
          ].join("\n");
          const result = await runCase({
            body,
            env: process.env,
            hookPath,
            name: "ordinary-exit-descendant",
            repoRoot: root,
            shutdownGraceMs: 1_000,
            timeoutMs: 5_000,
            spawnImpl: (command, args, options) => {
              const child = spawn(command, args, options);
              const closed = new Promise<void>((resolve) => {
                child.once("close", () => resolve());
              });
              cleanup = () => cleanupProfileFixture(root, child, closed, descendantPidPath);
              return child;
            },
          });
          const descendantPid = await waitForPidFile(descendantPidPath, 5_000);
          expect(result).toMatchObject({ code: 0, error: null, signal: null, timedOut: false });
          expect(isProcessAlive(descendantPid)).toBe(false);
        },
        () => cleanup(),
      );
    },
  );

  describe.runIf(process.platform !== "win32")("unverified timeout cleanup", () => {
    it.each(["alive", "EPERM", "EIO"] as const)(
      "rejects when the owned group is %s after SIGKILL",
      async (groupState) => {
        const child = Object.assign(new EventEmitter(), {
          pid: 2_147_483_647,
          exitCode: null,
          signalCode: null as NodeJS.Signals | null,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: vi.fn(() => true),
        });
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
            runCase({
              body: "",
              env: process.env,
              hookPath: "unused-hook.mjs",
              name: "unverified-cleanup",
              repoRoot: process.cwd(),
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
  });

  it.runIf(process.platform !== "win32").each(["EIO", "EPERM"])(
    "preserves %s group-signal and primary failures alongside unverified cleanup",
    async (errorCode) => {
      const primary = new Error("case failed");
      const groupSignalError = Object.assign(new Error("group signal failed"), { code: errorCode });
      const child = Object.assign(new EventEmitter(), {
        pid: 2_147_483_647,
        exitCode: 1,
        signalCode: null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
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
        const result = runCase({
          body: "",
          env: process.env,
          hookPath: "unused-hook.mjs",
          name: "failed-group-signal",
          repoRoot: process.cwd(),
          shutdownGraceMs: 0,
          timeoutMs: 30_000,
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

  it.runIf(process.platform !== "win32").each([
    { label: "nonzero exit", code: 23, signal: null },
    { label: "signal exit", code: null, signal: "SIGTERM" as const },
  ])("cleanup preserves terminal evidence without an error event: $label", async (outcome) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 2_147_483_647,
      exitCode: outcome.code,
      signalCode: outcome.signal,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const signal = vi.spyOn(process, "kill").mockImplementation((pid, requestedSignal) => {
      expect(pid).toBe(-child.pid);
      expect([0, "SIGKILL"]).toContain(requestedSignal);
      return true;
    });
    try {
      const failure: unknown = await runCase({
        body: "",
        env: process.env,
        hookPath: "unused-hook.mjs",
        name: "terminal-without-error-event",
        repoRoot: process.cwd(),
        shutdownGraceMs: 0,
        timeoutMs: 30_000,
        spawnImpl: (() => {
          queueMicrotask(() => {
            child.stderr.end(`${"x".repeat(160_000)}\nprimary import diagnostic\n`);
            child.stdout.end();
            child.emit("exit", outcome.code, outcome.signal);
            child.emit("close", outcome.code, outcome.signal);
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
      expect(failure.message).toMatch(outcome.signal ? /SIGTERM/u : /\b23\b/u);
      expect(failure.message).toContain("primary import diagnostic");
      expect(failure.message).toMatch(/cleanup/i);
      expect(failure.message.length).toBeLessThan(10_000);
    } finally {
      signal.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "cleans timeout descendants before resolving the case",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-timeout-"));
      const hookPath = path.join(root, "rss-hook.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      let cleanup = async () => rmSync(root, { recursive: true, force: true });
      await runQaGatewayFixture(
        async () => {
          writeFileSync(hookPath, "", "utf8");
          const descendantScript = [
            "import { writeFileSync } from 'node:fs';",
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
            `writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
          ].join("");
          const body = [
            "const childProcess = await import('node:child_process');",
            "childProcess.spawn(process.execPath, [",
            "  '--input-type=module',",
            `  '--eval', ${JSON.stringify(descendantScript)},`,
            "], { stdio: 'ignore' });",
            "setInterval(() => {}, 1000);",
          ].join("\n");
          const child = spawn(
            process.execPath,
            ["--import", hookPath, "--input-type=module", "--eval", body],
            { cwd: root, detached: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
          );
          const childClosed = new Promise<void>((resolve) => {
            child.once("close", () => resolve());
          });
          cleanup = () => cleanupProfileFixture(root, child, childClosed, descendantPidPath);
          await once(child, "spawn");
          const descendantPid = await waitForPidFile(descendantPidPath, 5_000);
          expect(Number.isInteger(descendantPid)).toBe(true);
          expect(isProcessAlive(descendantPid)).toBe(true);

          // Start the timeout only once a real descendant exists, independent of host startup load.
          const resultPromise = runCase({
            body,
            env: process.env,
            hookPath,
            name: "timeout-descendant",
            repoRoot: root,
            shutdownGraceMs: 100,
            timeoutMs: 250,
            spawnImpl: () => child,
          });
          await expect(resultPromise).resolves.toMatchObject({
            name: "timeout-descendant",
            signal: "SIGKILL",
            timedOut: true,
          });
          await waitForDead(descendantPid, 5_000);
        },
        () => cleanup(),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans active case descendants on parent signal",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-parent-signal-"));
      const hookPath = path.join(root, "rss-hook.mjs");
      const runnerPath = path.join(root, "parent-signal-runner.mjs");
      const descendantPidPath = path.join(root, "descendant.pid");
      let cleanup = async () => rmSync(root, { recursive: true, force: true });
      await runQaGatewayFixture(
        async () => {
          writeFileSync(hookPath, "", "utf8");
          const descendantScript = [
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
          ].join("");
          const body = [
            "const childProcess = await import('node:child_process');",
            "const fs = await import('node:fs');",
            "const descendant = childProcess.spawn(process.execPath, [",
            "  '--input-type=module',",
            `  '--eval', ${JSON.stringify(descendantScript)},`,
            "], { stdio: 'ignore' });",
            `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
            "setInterval(() => {}, 1000);",
          ].join("\n");
          writeFileSync(
            runnerPath,
            [
              `const { runCase } = await import(${JSON.stringify(
                pathToFileURL(path.resolve("scripts/profile-extension-memory.mts")).href,
              )});`,
              "void runCase({",
              `  body: ${JSON.stringify(body)},`,
              "  env: process.env,",
              `  hookPath: ${JSON.stringify(hookPath)},`,
              "  name: 'parent-signal-descendant',",
              `  repoRoot: ${JSON.stringify(root)},`,
              "  shutdownGraceMs: 100,",
              "  timeoutMs: 30000,",
              "});",
            ].join("\n"),
            "utf8",
          );
          const runner = spawn(process.execPath, ["--import", TSX_PRELOAD, runnerPath], {
            stdio: "ignore",
          });

          const runnerClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve) => {
              runner.once("close", (code, signal) => resolve({ code, signal }));
            },
          );
          cleanup = () =>
            cleanupProfileFixture(root, runner, runnerClosed, descendantPidPath, false);
          await once(runner, "spawn");
          const descendantPid = await waitForPidFile(descendantPidPath, 5_000);
          expect(isProcessAlive(descendantPid)).toBe(true);

          process.kill(runner.pid!, "SIGTERM");
          await expect(
            withTestTimeout(runnerClosed, 8_000, "profile runner did not close"),
          ).resolves.toEqual({ code: 143, signal: null });
          await waitForDead(descendantPid, 5_000);
        },
        () => cleanup(),
      );
    },
  );
});
