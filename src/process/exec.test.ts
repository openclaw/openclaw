// Exec tests cover command execution, output capture, and cancellation behavior.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { OPENCLAW_CLI_ENV_VALUE } from "../infra/openclaw-exec-env.js";
import { attachChildProcessBridge } from "./child-process-bridge.js";
import {
  resolveCommandEnv,
  resolveProcessExitCode,
  runCommandWithTimeout,
  runExec,
  shouldSpawnWithShell,
} from "./exec.js";

describe("runCommandWithTimeout", () => {
  it("never enables shell execution (Windows cmd.exe injection hardening)", () => {
    expect(
      shouldSpawnWithShell({
        resolvedCommand: "npm.cmd",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("merges custom env with base env and drops undefined values", () => {
    const resolved = resolveCommandEnv({
      argv: ["node", "script.js"],
      baseEnv: {
        OPENCLAW_BASE_ENV: "base",
        OPENCLAW_CHILD_ENV_REMOVE: "base",
        OPENCLAW_TO_REMOVE: undefined,
      },
      env: {
        OPENCLAW_CHILD_ENV_REMOVE: undefined,
        OPENCLAW_TEST_ENV: "ok",
      },
    });

    expect(resolved.OPENCLAW_BASE_ENV).toBe("base");
    expect(resolved.OPENCLAW_CHILD_ENV_REMOVE).toBeUndefined();
    expect(resolved.OPENCLAW_TEST_ENV).toBe("ok");
    expect(resolved.OPENCLAW_TO_REMOVE).toBeUndefined();
    expect(resolved.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
  });

  it("collapses case-insensitive duplicate env keys on Windows", () => {
    const resolved = resolveCommandEnv({
      argv: ["node", "script.js"],
      platform: "win32",
      baseEnv: {
        Path: "C:\\base\\bin",
        OPENCLAW_BASE_ENV: "base",
      },
      env: {
        PATH: "C:\\override\\bin",
        OPENCLAW_TEST_ENV: "ok",
      },
    });

    expect(resolved.Path).toBeUndefined();
    expect(resolved.PATH).toBe("C:\\override\\bin");
    expect(resolved.OPENCLAW_BASE_ENV).toBe("base");
    expect(resolved.OPENCLAW_TEST_ENV).toBe("ok");
  });

  it("removes case-insensitive inherited env keys on Windows", () => {
    const resolved = resolveCommandEnv({
      argv: ["node", "script.js"],
      platform: "win32",
      baseEnv: {
        Path: "C:\\base\\bin",
      },
      env: {
        PATH: undefined,
      },
    });

    expect(resolved.Path).toBeUndefined();
    expect(resolved.PATH).toBeUndefined();
  });

  it("preserves case-distinct env keys outside Windows", () => {
    const resolved = resolveCommandEnv({
      argv: ["node", "script.js"],
      platform: "linux",
      baseEnv: { Path: "/base/bin" },
      env: { PATH: "/override/bin" },
    });

    expect(resolved.Path).toBe("/base/bin");
    expect(resolved.PATH).toBe("/override/bin");
  });

  it("does not restore parent variables excluded from the child environment", async () => {
    const key = "OPENCLAW_EXECA_PARENT_ONLY_TEST";
    const previous = process.env[key];
    process.env[key] = "parent-value";
    try {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", `process.stdout.write(process.env.${key} ?? "missing")`],
        {
          timeoutMs: 2_000,
          baseEnv: {},
        },
      );

      expect(result.stdout).toBe("missing");
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("suppresses npm fund prompts for npm argv", () => {
    const resolved = resolveCommandEnv({ argv: ["npm", "--version"], baseEnv: {} });

    expect(resolved.NPM_CONFIG_FUND).toBe("false");
    expect(resolved.npm_config_fund).toBe("false");
  });

  it("infers success for shimmed Windows commands when exit codes are missing", () => {
    expect(
      resolveProcessExitCode({
        explicitCode: null,
        childExitCode: null,
        resolvedSignal: null,
        usesWindowsExitCodeShim: true,
        timedOut: false,
        noOutputTimedOut: false,
        killIssuedByTimeout: false,
      }),
    ).toBe(0);
  });

  it("does not infer success after this process issued a timeout kill", () => {
    expect(
      resolveProcessExitCode({
        explicitCode: null,
        childExitCode: null,
        resolvedSignal: null,
        usesWindowsExitCodeShim: true,
        timedOut: true,
        noOutputTimedOut: false,
        killIssuedByTimeout: true,
      }),
    ).toBeNull();
  });

  it("returns without spawning when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runCommandWithTimeout([process.execPath, "-e", "process.exit(99)"], {
        timeoutMs: 2_000,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      code: null,
      killed: false,
      noOutputTimedOut: false,
      signal: null,
      stderr: "",
      stdout: "",
      termination: "signal",
    });
  });

  it.runIf(process.platform === "win32")(
    "rejects unresolved commands before Execa can fall through to ambient ComSpec",
    async () => {
      const command = `openclaw-missing-${process.pid}\r\ncalc.exe`;
      const previousComspec = process.env.comspec;
      process.env.comspec = process.execPath;
      try {
        await expect(runCommandWithTimeout([command], { timeoutMs: 2_000 })).rejects.toMatchObject({
          code: "ENOENT",
          path: command,
          syscall: `spawn ${command}`,
        });
      } finally {
        if (previousComspec === undefined) {
          delete process.env.comspec;
        } else {
          process.env.comspec = previousComspec;
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "swallows stdin EPIPE when the child exits before input is consumed (#75438)",
    { timeout: 5_000 },
    async () => {
      const result = await runCommandWithTimeout([process.execPath, "-e", "process.exit(0)"], {
        timeoutMs: 3_000,
        input: "this input will EPIPE because the child ignores stdin\n",
      });
      expect(result.code).toBe(0);
    },
  );

  it("preserves matching output lines even when tail capture truncates them", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        [
          "process.stdout.write('Visit https://example.com/device and enter code ABCD-EFGH\\n')",
          "process.stdout.write('x'.repeat(200))",
        ].join(";"),
      ],
      {
        timeoutMs: 3_000,
        maxOutputBytes: 24,
        preserveOutputLine: (line) => line.includes("enter code"),
      },
    );

    expect(result.stdout).toBe("x".repeat(24));
    expect(result.stdoutTruncatedBytes).toBeGreaterThan(0);
    expect(result.preservedStdoutLines).toEqual([
      "Visit https://example.com/device and enter code ABCD-EFGH",
    ]);
  });

  it("bounds preserved matching output for long lines without newlines", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "process.stdout.write('x'.repeat(10_000))"],
      {
        timeoutMs: 3_000,
        maxOutputBytes: 24,
        preserveOutputLine: () => true,
      },
    );

    expect(result.stdout).toBe("x".repeat(24));
    expect(result.stdoutTruncatedBytes).toBeGreaterThan(0);
    expect(result.preservedStdoutLines).toEqual(["x".repeat(24)]);
  });

  it("keeps preserved line tails on a UTF-8 boundary", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "process.stdout.write('😀' + 'x'.repeat(22))"],
      {
        timeoutMs: 3_000,
        maxOutputBytes: 24,
        preserveOutputLine: () => true,
      },
    );

    expect(result.preservedStdoutLines).toEqual(["x".repeat(22)]);
  });
});

describe("runExec", () => {
  it("captures stdout and stderr", async () => {
    await expect(
      runExec(process.execPath, ["-e", "process.stdout.write('ok'); process.stderr.write('warn')"]),
    ).resolves.toEqual({ stdout: "ok", stderr: "warn" });
  });

  it("preserves the numeric exit code on command failures", async () => {
    await expect(runExec(process.execPath, ["-e", "process.exit(7)"])).rejects.toMatchObject({
      code: 7,
      exitCode: 7,
    });
  });
});

describe("attachChildProcessBridge", () => {
  it("forwards SIGTERM to the wrapped child and detaches on exit", () => {
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const child = new EventEmitter() as EventEmitter & ChildProcess;
    const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
    child.kill = kill as ChildProcess["kill"];
    const observedSignals: NodeJS.Signals[] = [];

    const { detach } = attachChildProcessBridge(child, {
      signals: ["SIGTERM"],
      onSignal: (signal) => observedSignals.push(signal),
    });
    const addedSigterm = process
      .listeners("SIGTERM")
      .find((listener) => !beforeSigterm.has(listener));
    if (!addedSigterm) {
      throw new Error("expected SIGTERM listener");
    }

    addedSigterm("SIGTERM");
    expect(observedSignals).toEqual(["SIGTERM"]);
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit");
    expect(process.listeners("SIGTERM")).toHaveLength(beforeSigterm.size);
    detach();
  });
});
