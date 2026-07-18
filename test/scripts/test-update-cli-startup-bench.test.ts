// Test Update Cli Startup Bench tests cover fixture updater subprocess deadlines.
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock, terminateManagedChildMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  terminateManagedChildMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../../scripts/lib/managed-child-process.mjs", () => ({
  signalExitCode: (signal: NodeJS.Signals) => (signal === "SIGINT" ? 130 : 143),
  terminateManagedChild: terminateManagedChildMock,
}));

const UPDATE_SCRIPT_PATH = path.resolve(process.cwd(), "scripts/test-update-cli-startup-bench.mjs");
const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;
const originalVitest = process.env.VITEST;
const originalTimeoutCleanupGrace = process.env.OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS;
const originalProcessCleanupGrace =
  process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS;

function countBenchmarkCases(preset: "startup" | "real" | "all"): number {
  const source = readFileSync(path.resolve(process.cwd(), "scripts/bench-cli-startup.ts"), "utf8");
  const start = source.indexOf("const COMMAND_CASES");
  const end = source.indexOf("] as const;", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const cases = [...source.slice(start, end).matchAll(/presets:\s*\[([^\]]+)\]/gu)].map((match) =>
    [...(match[1] ?? "").matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]),
  );
  return preset === "all" ? cases.length : cases.filter((entry) => entry.includes(preset)).length;
}

function mockSuccessfulBenchmarkRun(contents = "replacement\n") {
  spawnMock.mockImplementation((_command, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { pid: 123_456, kill: vi.fn() });
    const outputIndex = args.indexOf("--output");
    writeFileSync(args[outputIndex + 1] ?? "", contents, "utf8");
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function setSuccessfulUpdateArgv(outputPath: string) {
  process.argv = [
    process.execPath,
    UPDATE_SCRIPT_PATH,
    "--out",
    outputPath,
    "--preset",
    "startup",
    "--runs",
    "1",
    "--warmup",
    "0",
    "--timeout-ms",
    "100",
  ];
}

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  if (originalVitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = originalVitest;
  }
  if (originalTimeoutCleanupGrace === undefined) {
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS;
  } else {
    process.env.OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS = originalTimeoutCleanupGrace;
  }
  if (originalProcessCleanupGrace === undefined) {
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS;
  } else {
    process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS =
      originalProcessCleanupGrace;
  }
  spawnMock.mockReset();
  terminateManagedChildMock.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("test-update-cli-startup-bench", () => {
  it("gives the benchmark driver a hard total deadline beyond all internal run budgets", async () => {
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS;
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS;
    mockSuccessfulBenchmarkRun("{}\n");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-budget-"));

    try {
      for (const preset of ["startup", "real", "all"] as const) {
        const outputPath = path.join(fixtureRoot, `${preset}.json`);
        process.argv = [
          process.execPath,
          UPDATE_SCRIPT_PATH,
          "--out",
          outputPath,
          "--preset",
          preset,
          "--runs",
          "2",
          "--warmup",
          "1",
          "--timeout-ms",
          "100",
        ];
        spawnMock.mockClear();
        setTimeoutSpy.mockClear();
        await import(pathToFileURL(UPDATE_SCRIPT_PATH).href);

        expect(spawnMock).toHaveBeenCalledOnce();
        const args = spawnMock.mock.calls[0]?.[1] as string[];
        const options = spawnMock.mock.calls[0]?.[2];
        const internalBudgetMs = countBenchmarkCases(preset) * (2 + 1) * (100 + 2 * 1_000);
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), internalBudgetMs + 5_000);
        expect(options?.detached).toBe(process.platform !== "win32");
        expect(options?.stdio).toEqual(["inherit", "inherit", "inherit", "ipc"]);
        expect(args.at(-1)).not.toBe(outputPath);
        expect(path.dirname(args.at(-1) ?? "")).toBe(path.dirname(outputPath));
        expect(readFileSync(outputPath, "utf8")).toBe("{}\n");
        vi.resetModules();
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("settles after force kill even when the driver never emits close", async () => {
    process.env.VITEST = "true";
    process.env.OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS = "0";
    process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS = "10";
    const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-no-close-"));
    const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      disconnect: vi.fn(),
      pid: 123_456,
      kill: vi.fn(),
      unref: vi.fn(),
    });
    child.disconnect.mockImplementation(() => {
      child.connected = false;
    });
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("message", {
          kind: "openclaw-cli-startup-bench-active-sample",
          pid: 654_321,
        });
      });
      return child;
    });
    process.argv = [
      process.execPath,
      UPDATE_SCRIPT_PATH,
      "--out",
      outputPath,
      "--preset",
      "startup",
      "--runs",
      "1",
      "--warmup",
      "0",
      "--timeout-ms",
      "1",
    ];

    try {
      const startedAt = Date.now();
      await import(pathToFileURL(UPDATE_SCRIPT_PATH).href);

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(process.exitCode).toBe(1);
      expect(terminateManagedChildMock).toHaveBeenCalledWith(child, "SIGTERM");
      expect(terminateManagedChildMock).toHaveBeenCalledWith(child, "SIGKILL");
      expect(terminateManagedChildMock).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 654_321 }),
        "SIGKILL",
      );
      expect(child.disconnect).toHaveBeenCalledOnce();
      expect(child.unref).toHaveBeenCalledOnce();
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("exits before a hanging benchmark driver can block fixture refresh forever", async () => {
    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const fixtureRoot = mkdtempSync(
      path.join(process.cwd(), ".tmp-test-update-cli-startup-bench-"),
    );
    const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
    try {
      mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
      writeFileSync(
        path.join(fixtureRoot, "scripts/bench-cli-startup.ts"),
        [
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1_000);",
          "await new Promise(() => {});",
          "",
        ].join("\n"),
        "utf8",
      );

      const startedAt = Date.now();
      const result = actualChildProcess.spawnSync(
        process.execPath,
        [
          UPDATE_SCRIPT_PATH,
          "--out",
          outputPath,
          "--preset",
          "startup",
          "--runs",
          "1",
          "--warmup",
          "0",
          "--timeout-ms",
          "10",
        ],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            VITEST: "true",
            OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS: "0",
            OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS: "100",
          },
          killSignal: "SIGKILL",
          timeout: 5_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("preserves the existing fixture when the benchmark writes output and then hangs", async () => {
    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const fixtureRoot = mkdtempSync(
      path.join(process.cwd(), ".tmp-test-update-cli-startup-bench-output-"),
    );
    const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
    const existingFixture = '{"fixture":"existing"}\n';
    try {
      mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
      writeFileSync(outputPath, existingFixture, "utf8");
      writeFileSync(
        path.join(fixtureRoot, "scripts/bench-cli-startup.ts"),
        [
          'import { writeFileSync } from "node:fs";',
          'const outputIndex = process.argv.indexOf("--output");',
          'writeFileSync(process.argv[outputIndex + 1], "replacement\\n", "utf8");',
          "setInterval(() => {}, 1_000);",
          "await new Promise(() => {});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = actualChildProcess.spawnSync(
        process.execPath,
        [
          UPDATE_SCRIPT_PATH,
          "--out",
          outputPath,
          "--preset",
          "startup",
          "--runs",
          "1",
          "--warmup",
          "0",
          "--timeout-ms",
          "10",
        ],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            VITEST: "true",
            OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS: "0",
            OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS: "1500",
          },
          killSignal: "SIGKILL",
          timeout: 5_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(readFileSync(outputPath, "utf8")).toBe(existingFixture);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "updates a symlink target without replacing the link and preserves its mode",
    async () => {
      const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-symlink-"));
      const targetRoot = path.join(fixtureRoot, "targets");
      const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
      const intermediateLinkPath = path.join(targetRoot, "fixture-link.json");
      const targetPath = path.join(targetRoot, "fixture.json");
      mkdirSync(targetRoot, { recursive: true });
      writeFileSync(targetPath, "existing\n", "utf8");
      chmodSync(targetPath, 0o600);
      symlinkSync(path.basename(targetPath), intermediateLinkPath);
      symlinkSync(path.relative(fixtureRoot, intermediateLinkPath), outputPath);
      const outputLinkTarget = readlinkSync(outputPath);
      const intermediateLinkTarget = readlinkSync(intermediateLinkPath);
      mockSuccessfulBenchmarkRun();
      setSuccessfulUpdateArgv(outputPath);

      try {
        await import(pathToFileURL(UPDATE_SCRIPT_PATH).href);

        expect(lstatSync(outputPath).isSymbolicLink()).toBe(true);
        expect(readlinkSync(outputPath)).toBe(outputLinkTarget);
        expect(lstatSync(intermediateLinkPath).isSymbolicLink()).toBe(true);
        expect(readlinkSync(intermediateLinkPath)).toBe(intermediateLinkTarget);
        expect(readFileSync(targetPath, "utf8")).toBe("replacement\n");
        expect(statSync(targetPath).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "creates the final target of a dangling relative symlink chain",
    async () => {
      const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-dangling-"));
      const targetRoot = path.join(fixtureRoot, "targets");
      const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
      const intermediateLinkPath = path.join(targetRoot, "fixture-link.json");
      const targetPath = path.join(targetRoot, "fixture.json");
      mkdirSync(targetRoot, { recursive: true });
      symlinkSync(path.basename(targetPath), intermediateLinkPath);
      symlinkSync(path.relative(fixtureRoot, intermediateLinkPath), outputPath);
      mockSuccessfulBenchmarkRun();
      setSuccessfulUpdateArgv(outputPath);

      try {
        await import(pathToFileURL(UPDATE_SCRIPT_PATH).href);

        expect(lstatSync(outputPath).isSymbolicLink()).toBe(true);
        expect(lstatSync(intermediateLinkPath).isSymbolicLink()).toBe(true);
        expect(readFileSync(targetPath, "utf8")).toBe("replacement\n");
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")("rejects an output symlink cycle", async () => {
    const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-cycle-"));
    const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
    const secondLinkPath = path.join(fixtureRoot, "second-link.json");
    symlinkSync(path.basename(secondLinkPath), outputPath);
    symlinkSync(path.basename(outputPath), secondLinkPath);
    process.argv = [process.execPath, UPDATE_SCRIPT_PATH, "--out", outputPath];

    try {
      await expect(import(pathToFileURL(UPDATE_SCRIPT_PATH).href)).rejects.toThrow(
        "CLI startup benchmark output symlink cycle detected",
      );
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
