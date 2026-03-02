import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { attachChildProcessBridge } from "./child-process-bridge.js";
import { resolveCommandEnv, runCommandWithTimeout, shouldSpawnWithShell } from "./exec.js";

describe("runCommandWithTimeout", () => {
  it("never enables shell execution (Windows cmd.exe injection hardening)", () => {
    expect(
      shouldSpawnWithShell({
        resolvedCommand: "npm.cmd",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("merges custom env with base env and drops undefined values", async () => {
    const resolved = resolveCommandEnv({
      argv: ["node", "script.js"],
      baseEnv: {
        OPENCLAW_BASE_ENV: "base",
        OPENCLAW_TO_REMOVE: undefined,
      },
      env: {
        OPENCLAW_TEST_ENV: "ok",
      },
    });

    expect(resolved.OPENCLAW_BASE_ENV).toBe("base");
    expect(resolved.OPENCLAW_TEST_ENV).toBe("ok");
    expect(resolved.OPENCLAW_TO_REMOVE).toBeUndefined();
  });

  it("suppresses npm fund prompts for npm argv", async () => {
    const resolved = resolveCommandEnv({
      argv: ["npm", "--version"],
      baseEnv: {},
    });

    expect(resolved.NPM_CONFIG_FUND).toBe("false");
    expect(resolved.npm_config_fund).toBe("false");
  });

  it("kills command when no output timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setTimeout(() => {}, 10)"],
      {
        timeoutMs: 30,
        noOutputTimeoutMs: 4,
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
          "if (count === 3) {",
          "clearInterval(ticker);",
          "process.exit(0);",
          "}",
          "}, 6);",
        ].join(" "),
      ],
      {
        timeoutMs: 180,
        // Keep a healthy margin above the emit interval while avoiding long idle waits.
        noOutputTimeoutMs: 120,
      },
    );

    expect(result.code ?? 0).toBe(0);
    expect(result.termination).toBe("exit");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.stdout.length).toBeGreaterThanOrEqual(3);
  });

  it("reports global timeout termination when overall timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setTimeout(() => {}, 10)"],
      {
        timeoutMs: 4,
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
