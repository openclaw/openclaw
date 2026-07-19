// Test Update Cli Startup Bench tests cover fixture updater subprocess deadlines.
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
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
  signalExitCode: (signal: NodeJS.Signals) =>
    signal === "SIGINT" ? 130 : signal === "SIGQUIT" ? 131 : signal === "SIGKILL" ? 137 : 143,
  terminateManagedChild: terminateManagedChildMock,
}));

const UPDATE_SCRIPT_PATH = path.resolve(process.cwd(), "scripts/test-update-cli-startup-bench.mjs");
const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;
const originalVitest = process.env.VITEST;
const originalStartupTimeout = process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_STARTUP_TIMEOUT_MS;
const originalProcessCleanupGrace =
  process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS;

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
  if (originalStartupTimeout === undefined) {
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_STARTUP_TIMEOUT_MS;
  } else {
    process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_STARTUP_TIMEOUT_MS = originalStartupTimeout;
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
  it("uses the benchmark driver's canonical budget after a bounded startup phase", async () => {
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_STARTUP_TIMEOUT_MS;
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS;
    spawnMock.mockImplementation((_command, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { pid: 123_456, kill: vi.fn() });
      const outputIndex = args.indexOf("--output");
      writeFileSync(args[outputIndex + 1] ?? "", "{}\n", "utf8");
      queueMicrotask(() => {
        child.emit("message", {
          kind: "openclaw-cli-startup-bench-budget",
          timeoutMs: 1_234,
        });
        child.emit("close", 0, null);
      });
      return child;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-budget-"));

    try {
      const outputPath = path.join(fixtureRoot, "startup.json");
      setSuccessfulUpdateArgv(outputPath);
      await import(pathToFileURL(UPDATE_SCRIPT_PATH).href);

      expect(spawnMock).toHaveBeenCalledOnce();
      const args = spawnMock.mock.calls[0]?.[1] as string[];
      const options = spawnMock.mock.calls[0]?.[2];
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 6_234);
      expect(options?.detached).toBe(process.platform !== "win32");
      expect(options?.stdio).toEqual(["inherit", "inherit", "inherit", "ipc"]);
      expect(args.at(-1)).not.toBe(outputPath);
      expect(path.dirname(args.at(-1) ?? "")).toBe(path.dirname(outputPath));
      expect(readFileSync(outputPath, "utf8")).toBe("{}\n");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("settles after force kill even when the driver never emits close", async () => {
    process.env.VITEST = "true";
    process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_STARTUP_TIMEOUT_MS = "0";
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

  it.skipIf(process.platform === "win32")(
    "forwards SIGQUIT to the benchmark driver and exits 131",
    async () => {
      const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-sigquit-"));
      const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
      const child = Object.assign(new EventEmitter(), { pid: 123_456, kill: vi.fn() });
      spawnMock.mockReturnValue(child);
      setSuccessfulUpdateArgv(outputPath);
      const updatePromise = import(pathToFileURL(UPDATE_SCRIPT_PATH).href);

      try {
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());

        process.emit("SIGQUIT");
        expect(terminateManagedChildMock).toHaveBeenCalledWith(child, "SIGQUIT");
        child.emit("close", null, "SIGQUIT");
        await updatePromise;

        expect(process.exitCode).toBe(131);
        expect(existsSync(outputPath)).toBe(false);
      } finally {
        child.emit("close", 1, null);
        await updatePromise.catch(() => undefined);
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("preserves an interrupt that arrives just before the startup deadline", async () => {
    process.env.VITEST = "true";
    process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_STARTUP_TIMEOUT_MS = "200";
    process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS = "150";
    const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-signal-race-"));
    const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
    const child = Object.assign(new EventEmitter(), {
      connected: false,
      disconnect: vi.fn(),
      pid: 123_456,
      kill: vi.fn(),
      unref: vi.fn(),
    });
    spawnMock.mockReturnValue(child);
    setSuccessfulUpdateArgv(outputPath);

    try {
      const updatePromise = import(pathToFileURL(UPDATE_SCRIPT_PATH).href);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
      process.emit("SIGINT");
      await updatePromise;

      expect(process.exitCode).toBe(130);
      expect(terminateManagedChildMock).toHaveBeenCalledWith(child, "SIGINT");
      expect(terminateManagedChildMock).toHaveBeenCalledWith(child, "SIGKILL");
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      child.emit("close", 1, null);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("cleans the reported active sample when the driver crashes", async () => {
    const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-driver-crash-"));
    const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
    const child = Object.assign(new EventEmitter(), { pid: 123_456, kill: vi.fn() });
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("message", {
          kind: "openclaw-cli-startup-bench-active-sample",
          pid: 654_321,
        });
        child.emit("close", null, "SIGKILL");
      });
      return child;
    });
    setSuccessfulUpdateArgv(outputPath);

    try {
      await import(pathToFileURL(UPDATE_SCRIPT_PATH).href);

      expect(process.exitCode).toBe(1);
      expect(terminateManagedChildMock).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 654_321 }),
        "SIGKILL",
      );
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
            OPENCLAW_TEST_CLI_STARTUP_BENCH_STARTUP_TIMEOUT_MS: "0",
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
            OPENCLAW_TEST_CLI_STARTUP_BENCH_STARTUP_TIMEOUT_MS: "0",
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
      const hardLinkPath = path.join(targetRoot, "fixture-hard-link.json");
      mkdirSync(targetRoot, { recursive: true });
      writeFileSync(targetPath, "existing\n", "utf8");
      linkSync(targetPath, hardLinkPath);
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
        expect(readFileSync(hardLinkPath, "utf8")).toBe("replacement\n");
        expect(statSync(targetPath).ino).toBe(statSync(hardLinkPath).ino);
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

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO output without replacing it",
    async () => {
      const actualChildProcess =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-fifo-"));
      const outputPath = path.join(fixtureRoot, "cli-startup-bench.fifo");
      expect(actualChildProcess.spawnSync("mkfifo", [outputPath]).status).toBe(0);
      process.argv = [process.execPath, UPDATE_SCRIPT_PATH, "--out", outputPath];

      try {
        await expect(import(pathToFileURL(UPDATE_SCRIPT_PATH).href)).rejects.toThrow(
          "CLI startup benchmark output must be a regular file or missing",
        );
        expect(lstatSync(outputPath).isFIFO()).toBe(true);
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a device output without replacing it",
    async () => {
      process.argv = [process.execPath, UPDATE_SCRIPT_PATH, "--out", "/dev/null"];

      await expect(import(pathToFileURL(UPDATE_SCRIPT_PATH).href)).rejects.toThrow(
        "CLI startup benchmark output must be a regular file or missing: /dev/null",
      );
      expect(lstatSync("/dev/null").isCharacterDevice()).toBe(true);
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a read-only regular output before starting the benchmark",
    async () => {
      const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-read-only-"));
      const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
      writeFileSync(outputPath, "existing\n", "utf8");
      chmodSync(outputPath, 0o400);
      process.argv = [process.execPath, UPDATE_SCRIPT_PATH, "--out", outputPath];

      try {
        await expect(import(pathToFileURL(UPDATE_SCRIPT_PATH).href)).rejects.toThrow(
          "CLI startup benchmark output is not writable",
        );
        expect(readFileSync(outputPath, "utf8")).toBe("existing\n");
        expect(statSync(outputPath).mode & 0o777).toBe(0o400);
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "updates an existing output inside a non-writable directory",
    async () => {
      const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-restricted-dir-"));
      const outputRoot = path.join(fixtureRoot, "restricted");
      const outputPath = path.join(outputRoot, "cli-startup-bench.json");
      mkdirSync(outputRoot);
      writeFileSync(outputPath, "existing\n", "utf8");
      chmodSync(outputPath, 0o600);
      chmodSync(outputRoot, 0o500);
      mockSuccessfulBenchmarkRun();
      setSuccessfulUpdateArgv(outputPath);

      try {
        await import(pathToFileURL(UPDATE_SCRIPT_PATH).href);

        const args = spawnMock.mock.calls[0]?.[1] as string[];
        const temporaryOutputPath = args[args.indexOf("--output") + 1] ?? "";
        expect(path.dirname(temporaryOutputPath)).not.toBe(outputRoot);
        expect(existsSync(path.dirname(temporaryOutputPath))).toBe(false);
        expect(readFileSync(outputPath, "utf8")).toBe("replacement\n");
        expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      } finally {
        chmodSync(outputRoot, 0o700);
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "updates an existing write-only output without requiring read access",
    async () => {
      const fixtureRoot = mkdtempSync(path.join(process.cwd(), ".tmp-cli-startup-write-only-"));
      const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
      writeFileSync(outputPath, "existing\n", "utf8");
      chmodSync(outputPath, 0o200);
      mockSuccessfulBenchmarkRun();
      setSuccessfulUpdateArgv(outputPath);

      try {
        await import(pathToFileURL(UPDATE_SCRIPT_PATH).href);

        const args = spawnMock.mock.calls[0]?.[1] as string[];
        const temporaryOutputPath = args[args.indexOf("--output") + 1] ?? "";
        expect(path.dirname(temporaryOutputPath)).not.toBe(fixtureRoot);
        expect(existsSync(path.dirname(temporaryOutputPath))).toBe(false);
        expect(statSync(outputPath).mode & 0o777).toBe(0o200);
        chmodSync(outputPath, 0o600);
        expect(readFileSync(outputPath, "utf8")).toBe("replacement\n");
      } finally {
        chmodSync(outputPath, 0o600);
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );
});
