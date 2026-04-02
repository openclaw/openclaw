import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_CLI_ENV_VALUE } from "../infra/openclaw-exec-env.js";
import { attachChildProcessBridge } from "./child-process-bridge.js";
import {
  resolveCommandEnv,
  resolveProcessExitCode,
  runCommandWithTimeout,
  shouldSpawnWithShell,
} from "./exec.js";

describe("runCommandWithTimeout", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    expect(resolved.OPENCLAW_CLI).toBe(OPENCLAW_CLI_ENV_VALUE);
  });

  it("suppresses npm fund prompts for npm argv", async () => {
    const resolved = resolveCommandEnv({
      argv: ["npm", "--version"],
      baseEnv: {},
    });

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

  it("does not infer success when this process already issued a timeout kill", () => {
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

  it.runIf(process.platform !== "win32")(
    "kills command when no output timeout elapses",
    { timeout: 15_000 },
    async () => {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", "setTimeout(() => {}, 5_000)"],
        {
          timeoutMs: 2_000,
          noOutputTimeoutMs: 200,
        },
      );

      expect(result.termination).toBe("no-output-timeout");
      expect(result.noOutputTimedOut).toBe(true);
      expect(result.code).not.toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports global timeout termination when overall timeout elapses",
    { timeout: 15_000 },
    async () => {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", "setTimeout(() => {}, 5_000)"],
        {
          timeoutMs: 200,
        },
      );

      expect(result.termination).toBe("timeout");
      expect(result.noOutputTimedOut).toBe(false);
      expect(result.code).not.toBe(0);
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
