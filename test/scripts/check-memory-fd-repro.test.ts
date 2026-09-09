// Check Memory Fd Repro tests cover check memory fd repro script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_READY_OUTPUT_MAX_CHARS,
  MEMORY_SEARCH_PROBE_QUERY,
  classifyMemorySearchInvokeResponse,
  invokeMemorySearch,
  parseArgs,
  updateGatewayReadyOutputState,
  waitForGatewayReady,
  writeConfig,
} from "../../scripts/check-memory-fd-repro.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { validateConfigObject } from "../../src/config/validation.js";
import { withEnv } from "../../src/test-utils/env.js";

const SCRIPT_PATH = path.resolve("scripts/check-memory-fd-repro.mts");
const TSX_PRELOAD = path.resolve("scripts/tsx.mjs");
const SOURCE_TSCONFIG_PATH = path.resolve("tsconfig.json");
const OWNED_PID = 2_147_483_646;
const FOREIGN_PID = 2_147_483_645;

type OwnershipScenario =
  | "owned-success"
  | "owned-success-inherited-root"
  | "foreign-ready"
  | "exited-ready"
  | "replaced-during"
  | "ignored-stop"
  | "primary-EACCES-cleanup-EIO"
  | "primary-EIO-cleanup-EACCES"
  | "completed-pass-cleanup"
  | "completed-threshold-cleanup"
  | "completed-threshold-cleanup-report-error";

type GatewaySummary = {
  passed: boolean;
  failure?: string;
  samples: unknown[];
  invoke: { ok: boolean };
  peakUniqueWorkspaceMarkdownRegFds: number;
};

function runGatewayOwnershipFixture(scenario: OwnershipScenario) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fd-owner-")));
  const preloadPath = path.join(root, "runtime.mjs");
  const journalPath = path.join(root, "journal.json");
  const outputDir = path.join(root, "output");
  try {
    // Synthetic unjoined Gateway lifetimes belong to this fixture, not the compiler generation.
    const owner = createVitestResourceOwner(root);
    fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n");
    fs.writeFileSync(
      preloadPath,
      [
        "import cp from 'node:child_process';",
        "import { EventEmitter } from 'node:events';",
        "import fs from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        "import net from 'node:net';",
        "import path from 'node:path';",
        "import { PassThrough } from 'node:stream';",
        `const scenario = ${JSON.stringify(scenario)};`,
        `const ownedPid = ${OWNED_PID}, foreignPid = ${FOREIGN_PID};`,
        "const samples = [], signals = [], events = [];",
        "let child, syntheticRoot, launch, attemptedSummary, closed = false, replaced = false;",
        "const write = fs.writeFileSync, remove = fs.rmSync;",
        "fs.writeFileSync = (target, ...args) => {",
        "  if (String(target).endsWith('/summary.json')) {",
        "    events.push('summary'); attemptedSummary = JSON.parse(String(args[0]));",
        "    if (scenario === 'completed-threshold-cleanup-report-error')",
        "      throw Object.assign(new Error('summary write failed EACCES'), { code: 'EACCES' });",
        "  }",
        "  return write(target, ...args);",
        "};",
        "fs.rmSync = (target, options) => {",
        "  if (target === syntheticRoot) {",
        "    events.push('cleanup');",
        "    if (scenario.startsWith('primary-') || scenario.startsWith('completed-')) {",
        "      const code = scenario.startsWith('primary-') ? scenario.split('-')[3] : 'EIO';",
        "      throw Object.assign(new Error('workspace removal failed ' + code), { code });",
        "    }",
        "  }",
        "  return remove(target, options);",
        "};",
        "net.createServer = () => Object.assign(new EventEmitter(), {",
        "  unref() {},",
        "  listen(_port, _host, callback) { queueMicrotask(callback); },",
        "  address: () => ({ port: 43791 }),",
        "  close(callback) { queueMicrotask(callback); },",
        "});",
        "const alive = () => child && child.exitCode === null && child.signalCode === null;",
        "const finish = (code, signal = null) => {",
        "  if (!alive()) return;",
        "  child.exitCode = code; child.signalCode = signal;",
        "  child.emit('exit', code, signal);",
        "  setImmediate(() => {",
        "    child.stdout.destroy(); child.stderr.destroy();",
        "    closed = true; events.push('close'); child.emit('close', code, signal);",
        "  });",
        "};",
        // Live groups have live leaders; terminal groups return ESRCH. These
        // cases do not model the Linux exited-leader/live-group ps branch.
        "process.kill = (pid, signal) => {",
        "  if (pid !== ownedPid && pid !== -ownedPid && pid !== foreignPid && pid !== -foreignPid)",
        "    throw new Error('fixture refused unexpected signal target');",
        "  if (signal === 0) {",
        "    if (alive()) return true;",
        "    throw Object.assign(new Error('owned process gone'), { code: 'ESRCH' });",
        "  }",
        "  signals.push([pid, signal]);",
        "  if (Math.abs(pid) === ownedPid && scenario !== 'ignored-stop') finish(null, signal);",
        "  return true;",
        "};",
        "cp.spawn = (_bin, args, options) => {",
        "  if (child) throw new Error('fixture permits exactly one Gateway launch');",
        "  syntheticRoot = path.dirname(options.env.HOME);",
        "  launch = { entry: args[0], noCompileCache: options.env.NODE_DISABLE_COMPILE_CACHE,",
        "    devSourceRoot: options.env.OPENCLAW_DEV_SOURCE_ROOT };",
        "  child = Object.assign(new EventEmitter(), {",
        "    pid: ownedPid, exitCode: null, signalCode: null,",
        "    stdout: new PassThrough(), stderr: new PassThrough(),",
        "    kill: (signal) => process.kill(ownedPid, signal),",
        "  });",
        "  queueMicrotask(() => {",
        "    child.stdout.write('[gateway] ready\\n');",
        "    if (scenario === 'exited-ready') finish(0);",
        "  });",
        "  return child;",
        "};",
        "const success = (stdout = '') => ({ status: 0, signal: null, stdout, stderr: '' });",
        "cp.spawnSync = (bin, args) => {",
        "  if (bin === process.execPath && args.includes('index')) return success();",
        "  if (bin !== 'lsof') throw new Error('fixture refused unexpected command ' + bin);",
        "  if (args.includes('-v')) return success();",
        "  if (args.some(arg => arg.startsWith('-iTCP:'))) {",
        "    const pid = scenario === 'foreign-ready' || scenario === 'exited-ready' || replaced",
        "      ? foreignPid : alive() ? ownedPid : null;",
        "    return { ...success(pid ? String(pid) + '\\n' : ''), status: pid ? 0 : 1 };",
        "  }",
        "  const pid = Number(args[args.indexOf('-p') + 1]);",
        "  samples.push({ pid, alive: Boolean(alive()) });",
        "  if (scenario.startsWith('primary-')) {",
        "    const code = scenario.split('-')[1];",
        "    return { ...success(), status: 1, stderr: 'measurement denied ' + code };",
        "  }",
        "  return success('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n');",
        "};",
        "globalThis.fetch = async () => {",
        "  if (scenario === 'replaced-during') { replaced = true; finish(23); }",
        "  return new Response(JSON.stringify({ ok: true, result: { results: [] } }), { status: 200 });",
        "};",
        "process.on('exit', () => write(" + JSON.stringify(journalPath) + ", JSON.stringify({",
        "  samples, signals, events, launch, attemptedSummary, closed, alive: Boolean(alive()),",
        "  rootExists: Boolean(syntheticRoot && fs.existsSync(syntheticRoot)),",
        "})));",
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
        "--allow-non-darwin",
        ...(scenario.startsWith("completed-threshold")
          ? ["--mode", "leak", "--min-leaked-fds", "1"]
          : ["--report-only"]),
        "--files",
        "1",
        "--sample-delay-ms",
        "0",
        "--settle-delay-ms",
        "0",
        "--output-dir",
        outputDir,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH,
          OPENCLAW_MEMORY_FD_REPRO_KEEP: "0",
          OPENCLAW_DEV_SOURCE_ROOT:
            scenario === "owned-success-inherited-root"
              ? path.join(root, "inherited-source")
              : undefined,
        },
        encoding: "utf8",
        timeout: 20_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(fs.readdirSync(path.join(root, ".vitest-resource-owner", "claims"))).toHaveLength(1);
    if (scenario === "ignored-stop") {
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    } else {
      expect(() => owner.assertReleased()).not.toThrow();
    }
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      samples: { pid: number; alive: boolean }[];
      signals: [number, string][];
      events: string[];
      launch: { entry: string; noCompileCache?: string; devSourceRoot?: string };
      closed: boolean;
      alive: boolean;
      rootExists: boolean;
      attemptedSummary?: GatewaySummary;
    };
    const summaryPath = path.join(outputDir, "summary.json");
    const summary = fs.existsSync(summaryPath)
      ? (JSON.parse(fs.readFileSync(summaryPath, "utf8")) as GatewaySummary)
      : undefined;
    return { result, journal, summary, fixtureRoot: root };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return address.port;
}

describe("check-memory-fd-repro", () => {
  it("rejects loose numeric environment limits before generating files", () => {
    expect(
      withEnv(
        {
          OPENCLAW_MEMORY_FD_REPRO_FILES: "17",
          OPENCLAW_MEMORY_FD_REPRO_MAX_WORKSPACE_REG_FDS: "0",
          OPENCLAW_MEMORY_FD_REPRO_SAMPLE_DELAY_MS: "0",
          OPENCLAW_MEMORY_FD_REPRO_SETTLE_DELAY_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
          OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
        },
        () => parseArgs([]),
      ),
    ).toMatchObject({
      fileCount: 17,
      invokeTimeoutMs: MAX_TIMER_TIMEOUT_MS,
      maxWorkspaceRegFds: 0,
      sampleDelayMs: 0,
      settleDelayMs: MAX_TIMER_TIMEOUT_MS,
    });

    expect(() =>
      withEnv({ OPENCLAW_MEMORY_FD_REPRO_FILES: "17files" }, () => parseArgs([])),
    ).toThrow("OPENCLAW_MEMORY_FD_REPRO_FILES must be a non-negative integer");
    expect(() =>
      withEnv({ OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS: "1e3" }, () => parseArgs([])),
    ).toThrow("OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS must be a non-negative integer");
  });

  it("lets explicit CLI numeric flags override malformed inherited env defaults", () => {
    expect(
      withEnv(
        {
          OPENCLAW_MEMORY_FD_REPRO_FILES: "17files",
          OPENCLAW_MEMORY_FD_REPRO_MAX_WORKSPACE_REG_FDS: "4fds",
          OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS: "1e3",
          OPENCLAW_MEMORY_FD_REPRO_SAMPLE_DELAY_MS: "soon",
          OPENCLAW_MEMORY_FD_REPRO_SETTLE_DELAY_MS: "later",
        },
        () =>
          parseArgs([
            "--files",
            "20",
            "--max-workspace-reg-fds",
            "4",
            "--invoke-timeout-ms",
            "1000",
            "--sample-delay-ms",
            "0",
            "--settle-delay-ms",
            "0",
          ]),
      ),
    ).toMatchObject({
      fileCount: 20,
      invokeTimeoutMs: 1000,
      maxWorkspaceRegFds: 4,
      sampleDelayMs: 0,
      settleDelayMs: 0,
    });
  });

  it("rejects missing valued options instead of consuming the next flag", () => {
    for (const flag of [
      "--files",
      "--invoke-timeout-ms",
      "--max-workspace-reg-fds",
      "--min-leaked-fds",
      "--mode",
      "--output-dir",
      "--sample-delay-ms",
      "--settle-delay-ms",
    ]) {
      for (const value of ["--keep", "-h"]) {
        expect(() => parseArgs([flag, value])).toThrow(`Missing value for ${flag}`);
      }
    }
  });

  it("stops parsing options after the argument terminator", () => {
    expect(parseArgs(["--files", "20", "--", "--files", "99"])).toMatchObject({
      fileCount: 20,
    });

    expect(
      withEnv({ OPENCLAW_MEMORY_FD_REPRO_FILES: "17" }, () => parseArgs(["--", "--unknown"])),
    ).toMatchObject({
      fileCount: 17,
    });
  });

  it("accepts the leading package-manager argument separator", () => {
    expect(parseArgs(["--", "--files", "20", "--allow-non-darwin"])).toMatchObject({
      allowNonDarwin: true,
      fileCount: 20,
    });
  });

  it("clamps oversized memory_search invoke timers before scheduling", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: true,
            result: {
              content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
            },
          }),
        );
      }, 25);
    });
    const port = await listen(server);
    try {
      await expect(
        invokeMemorySearch({
          port,
          token: "test-token",
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        }),
      ).resolves.toMatchObject({
        gatewayOk: true,
        ok: true,
        resultCount: 0,
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("uses a fast matching probe query instead of a no-hit stress query", () => {
    expect(MEMORY_SEARCH_PROBE_QUERY).toBe("Top-level memory file");
    expect(MEMORY_SEARCH_PROBE_QUERY).not.toContain("nomatch");
  });

  it("writes an offline FTS-only memory search config for repro indexing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-fd-config-"));
    try {
      const homeDir = path.join(root, "home");
      const workspaceDir = path.join(root, "workspace");
      const configPath = writeConfig({
        homeDir,
        workspaceDir,
        port: 12345,
        token: "test-token",
      });
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const memorySearch = config.memory.search;

      expect(validateConfigObject(config)).toMatchObject({ ok: true });
      expect(memorySearch.store).toEqual({ vector: { enabled: false } });
      expect(memorySearch).toMatchObject({
        provider: "none",
        model: "",
      });
      expect(memorySearch).not.toHaveProperty("sync");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an available memory_search tool payload", () => {
    const result = classifyMemorySearchInvokeResponse({
      httpOk: true,
      status: 200,
      bodyText: JSON.stringify({
        ok: true,
        result: {
          content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      gatewayOk: true,
      resultCount: 0,
    });
  });

  it("rejects disabled memory_search tool payloads", () => {
    const result = classifyMemorySearchInvokeResponse({
      httpOk: true,
      status: 200,
      bodyText: JSON.stringify({
        ok: true,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [],
                disabled: true,
                unavailable: true,
                error: 'No API key found for provider "openai".',
              }),
            },
          ],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      gatewayOk: true,
      toolDisabled: true,
      toolUnavailable: true,
      toolError: 'No API key found for provider "openai".',
    });
  });

  it("rejects gateway success envelopes without memory_search details", () => {
    const result = classifyMemorySearchInvokeResponse({
      httpOk: true,
      status: 200,
      bodyText: JSON.stringify({ ok: true, result: { content: [] } }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: "memory_search result payload missing or invalid",
    });
  });

  it.each([
    { exitCode: null, signalCode: "SIGTERM" },
    { exitCode: 0, signalCode: null },
  ])("rejects readiness for an exited child (%j)", async (exitState) => {
    const child = {
      ...exitState,
    };

    await expect(
      waitForGatewayReady({ child, port: 9, logPath: "gateway.log", timeoutMs: 10_000 }),
    ).rejects.toThrow("gateway exited before ready");
  });

  describe.skipIf(process.platform === "win32")("launched Gateway ownership", () => {
    it.each(["foreign-ready", "exited-ready"] as const)(
      "never samples or signals an unrelated listener (%s)",
      (scenario) => {
        const { result, journal, summary } = runGatewayOwnershipFixture(scenario);
        expect(result.status, result.stderr).toBe(1);
        expect(journal.samples).toEqual([]);
        expect(journal.signals.some(([pid]) => Math.abs(pid) === FOREIGN_PID)).toBe(false);
        expect(summary?.passed).not.toBe(true);
        expect(journal.closed).toBe(true);
      },
    );

    it("stops sampling when the launched process exits during measurement", () => {
      const { result, journal, summary } = runGatewayOwnershipFixture("replaced-during");
      expect(result.status, result.stderr).toBe(1);
      expect(journal.samples).toEqual([{ pid: OWNED_PID, alive: true }]);
      expect(journal.signals.some(([pid]) => Math.abs(pid) === FOREIGN_PID)).toBe(false);
      expect(summary?.passed).not.toBe(true);
      expect(result.stderr).toContain("23");
      expect(journal.closed).toBe(true);
    });

    it.each(["owned-success", "owned-success-inherited-root"] as const)(
      "joins the launched process before publishing success (%s)",
      (scenario) => {
        const { result, journal, summary, fixtureRoot } = runGatewayOwnershipFixture(scenario);
        expect(result.status, result.stderr).toBe(0);
        expect(journal.launch).toEqual({
          entry: path.join(fixtureRoot, "openclaw.mjs"),
          noCompileCache: "1",
          devSourceRoot:
            scenario === "owned-success-inherited-root"
              ? path.join(fixtureRoot, "inherited-source")
              : fixtureRoot,
        });
        expect(journal.samples).toEqual(
          Array.from({ length: 3 }, () => ({ pid: OWNED_PID, alive: true })),
        );
        expect(journal.closed).toBe(true);
        expect(journal.events.indexOf("close")).toBeLessThan(journal.events.indexOf("summary"));
        expect(journal.rootExists).toBe(false);
        expect(summary?.passed).toBe(true);
      },
    );

    it("fails report-only and retains inputs when the owned process cannot be joined", () => {
      const { result, journal, summary } = runGatewayOwnershipFixture("ignored-stop");
      expect(result.status, result.stderr).toBe(1);
      expect(journal.alive).toBe(true);
      expect(journal.rootExists).toBe(true);
      expect(summary?.passed).not.toBe(true);
    });

    it.each([
      { primary: "EACCES", cleanup: "EIO", scenario: "primary-EACCES-cleanup-EIO" },
      { primary: "EIO", cleanup: "EACCES", scenario: "primary-EIO-cleanup-EACCES" },
    ] as const)(
      "prints primary $primary and cleanup $cleanup failures",
      ({ primary, cleanup, scenario }) => {
        const { result, journal, summary } = runGatewayOwnershipFixture(scenario);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(`measurement denied ${primary}`);
        expect(result.stderr).toContain(`workspace removal failed ${cleanup}`);
        expect(journal.closed).toBe(true);
        expect(summary?.passed).not.toBe(true);
      },
    );
  });

  it("bounds gateway readiness output while keeping newest logs", () => {
    const first = updateGatewayReadyOutputState({ tail: "abc", readySeen: false }, "def", 8);
    expect(first).toEqual({ tail: "abcdef", readySeen: false });

    const second = updateGatewayReadyOutputState(first, "ghijkl", 8);
    expect(second).toEqual({ tail: "efghijkl", readySeen: false });
    expect(second.tail).toHaveLength(8);
    expect(GATEWAY_READY_OUTPUT_MAX_CHARS).toBeGreaterThan(1024);
  });

  it("keeps readiness after a coalesced noisy chunk truncates the marker", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "", readySeen: false },
      `[gateway] ready\n${"x".repeat(10_000)}`,
      64,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toHaveLength(64);
    expect(state.tail).not.toContain("[gateway] ready");
  });

  it("recognizes readiness split across the existing tail and new chunk", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "[gateway] rea", readySeen: false },
      "dy\n",
      64,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toBe("[gateway] ready\n");
  });

  it("preserves previous readiness once seen", () => {
    const state = updateGatewayReadyOutputState({ tail: "old", readySeen: true }, "new output", 8);

    expect(state.readySeen).toBe(true);
    expect(state.tail).toBe("w output");
  });

  describe.skipIf(process.platform === "win32")("completed measurement finalization", () => {
    it.each(["completed-pass-cleanup", "completed-threshold-cleanup"] as const)(
      "retains a failed summary after owned cleanup fails (%s)",
      (scenario) => {
        const { result, journal, summary } = runGatewayOwnershipFixture(scenario);
        expect(result.status, result.stderr).toBe(1);
        expect(journal.closed).toBe(true);
        expect(journal.alive).toBe(false);
        expect(journal.samples).toHaveLength(3);
        expect(journal.events).toEqual(["close", "cleanup", "summary"]);
        expect(summary).toMatchObject({
          passed: false,
          invoke: { ok: true },
          peakUniqueWorkspaceMarkdownRegFds: 0,
        });
        expect(summary?.samples).toHaveLength(3);
        expect(summary?.failure).toContain("workspace removal failed EIO");
        expect(result.stderr).toContain("workspace removal failed EIO");
        if (scenario === "completed-threshold-cleanup") {
          expect(summary?.failure).toContain("below leak threshold 1");
          expect(result.stderr).toContain("below leak threshold 1");
        }
      },
    );

    it("prints primary, cleanup and failed-report errors without publishing success", () => {
      const { result, journal, summary } = runGatewayOwnershipFixture(
        "completed-threshold-cleanup-report-error",
      );
      expect(result.status, result.stderr).toBe(1);
      expect(journal.closed).toBe(true);
      expect(journal.alive).toBe(false);
      expect(journal.samples).toHaveLength(3);
      expect(journal.events).toEqual(["close", "cleanup", "summary"]);
      expect(journal.attemptedSummary?.passed).toBe(false);
      expect(summary).toBeUndefined();
      expect(result.stderr).toContain("below leak threshold 1");
      expect(result.stderr).toContain("workspace removal failed EIO");
      expect(result.stderr).toContain("summary write failed EACCES");
    });
  });
});
