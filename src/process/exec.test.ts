import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { attachChildProcessBridge } from "./child-process-bridge.js";
import { runCommandWithTimeout, shouldSpawnWithShell } from "./exec.js";

describe("runCommandWithTimeout", () => {
  it("never enables shell execution (Windows cmd.exe injection hardening)", () => {
    expect(
      shouldSpawnWithShell({
        resolvedCommand: "npm.cmd",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("merges custom env with process.env", async () => {
    await withEnvAsync({ OPENCLAW_BASE_ENV: "base" }, async () => {
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          'process.stdout.write((process.env.OPENCLAW_BASE_ENV ?? "") + "|" + (process.env.OPENCLAW_TEST_ENV ?? ""))',
        ],
        {
          timeoutMs: 400,
          env: { OPENCLAW_TEST_ENV: "ok" },
        },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("base|ok");
      expect(result.termination).toBe("exit");
    });
  });

  it("kills command when no output timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setTimeout(() => {}, 20)"],
      {
        timeoutMs: 180,
        noOutputTimeoutMs: 8,
      },
    );

    expect(result.termination).toBe("no-output-timeout");
    expect(result.noOutputTimedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("resets no output timer when command keeps emitting output", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        [
          'process.stdout.write(".");',
          "let count = 0;",
          'const ticker = setInterval(() => { process.stdout.write(".");',
          "count += 1;",
          "if (count === 2) {",
          "clearInterval(ticker);",
          "process.exit(0);",
          "}",
          "}, 5);",
        ].join(" "),
      ],
      {
        timeoutMs: 400,
        // Keep a healthy margin above the emit interval while avoiding long idle waits.
        noOutputTimeoutMs: 60,
      },
    );

    expect(result.code ?? 0).toBe(0);
    expect(result.termination).toBe("exit");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.stdout.length).toBeGreaterThanOrEqual(3);
  });

  it("reports global timeout termination when overall timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setTimeout(() => {}, 12)"],
      {
        timeoutMs: 8,
      },
    );

    expect(result.termination).toBe("timeout");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.code).not.toBe(0);
  });

  it.runIf(process.platform === "win32")(
    "on Windows spawns node + npm-cli.js for npm argv to avoid spawn EINVAL",
    async () => {
      const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 10_000 });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    },
  );
});

describe("attachChildProcessBridge", () => {
  function createFakeChild() {
    const emitter = new EventEmitter() as EventEmitter & ChildProcess;
    const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
    emitter.kill = kill as ChildProcess["kill"];
    return { child: emitter, kill };
  }

  it("forwards SIGTERM to the wrapped child and detaches on exit", () => {
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const { child, kill } = createFakeChild();
    const observedSignals: NodeJS.Signals[] = [];

    const { detach } = attachChildProcessBridge(child, {
      signals: ["SIGTERM"],
      onSignal: (signal) => observedSignals.push(signal),
    });

    const afterSigterm = process.listeners("SIGTERM");
    const addedSigterm = afterSigterm.find((listener) => !beforeSigterm.has(listener));

    if (!addedSigterm) {
      throw new Error("expected SIGTERM listener");
    }

    addedSigterm("SIGTERM");
    expect(observedSignals).toEqual(["SIGTERM"]);
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit");
    expect(process.listeners("SIGTERM")).toHaveLength(beforeSigterm.size);

    // Detached already via exit; should remain a safe no-op.
    detach();
  });
});
