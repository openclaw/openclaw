import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveCurrentOpenClawCliInvocation } from "../infra/openclaw-cli-invocation.js";
import {
  getProcessSupervisor,
  type ManagedRun,
  type ProcessSupervisor,
} from "../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createTuiLocalCliRunner } from "./tui-local-cli.js";

vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: vi.fn() }));
vi.mock("../infra/openclaw-cli-invocation.js", () => ({
  resolveCurrentOpenClawCliInvocation: vi.fn(),
}));

const exit: RunExit = {
  reason: "exit",
  exitCode: 0,
  exitSignal: null,
  durationMs: 1,
  stdout: "",
  stderr: "",
  timedOut: false,
  noOutputTimedOut: false,
};

function harness(
  options: {
    output?: string;
    result?: Partial<RunExit>;
    error?: Error;
    pendingSpawn?: boolean;
  } = {},
) {
  const result = createDeferred<RunExit>();
  const admission = createDeferred();
  const run: ManagedRun = {
    activity: { resultSettled: false, lastOutputAtMs: 0 },
    runId: "setup",
    startedAtMs: 0,
    wait: vi.fn(() => result.promise),
    cancel: vi.fn(() => result.resolve({ ...exit, reason: "manual-cancel" })),
    detachOutput: vi.fn(),
  };
  let spawnInput: SpawnInput | undefined;
  const spawn = vi.fn<ProcessSupervisor["spawn"]>(async (input) => {
    spawnInput = input;
    if (options.pendingSpawn) {
      await admission.promise;
    }
    input.assertCurrent?.();
    if (options.error) {
      throw options.error;
    }
    if (options.output !== undefined) {
      input.onStdout?.(options.output);
      input.onStderr?.("secret-stderr");
      result.resolve({ ...exit, ...options.result });
    }
    return run;
  });
  const cleanup = vi.fn(async () => {
    run.cancel();
  });
  const supervisor: ProcessSupervisor = {
    spawn,
    cancel: vi.fn(),
    cancelScope: vi.fn(() => run.cancel()),
    acquireScopeCleanup: vi.fn(() => cleanup),
  };
  vi.mocked(getProcessSupervisor).mockReturnValue(supervisor);
  const runner = createTuiLocalCliRunner();
  return { runner, spawn, run, cleanup, admission, result, supervisor, input: () => spawnInput };
}

beforeEach(() => {
  vi.mocked(resolveCurrentOpenClawCliInvocation).mockReset();
  vi.mocked(resolveCurrentOpenClawCliInvocation).mockImplementation((args) => ({
    command: "/host/node",
    args: ["/host/openclaw.mjs", ...args],
    cwd: "/host/package",
    env: { TSX_TSCONFIG_PATH: "/host/tsconfig.json" },
  }));
});

describe("TUI local CLI subprocess owner", () => {
  it("uses canonical invocation and supervisor on this process host, with no shell or retained diagnostics", async () => {
    const h = harness({ output: '{"safe":true}' });
    expect(h.spawn).not.toHaveBeenCalled();
    await expect(h.runner.runJson(["browser", "extension", "setup"])).resolves.toEqual({
      ok: true,
      value: { safe: true },
    });
    expect(h.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "child",
        argv: ["/host/node", "/host/openclaw.mjs", "browser", "extension", "setup"],
        cwd: "/host/package",
        captureOutput: false,
        stdinMode: "pipe-closed",
        env: expect.objectContaining({ TSX_TSCONFIG_PATH: "/host/tsconfig.json" }),
      }),
    );
    expect(h.run.detachOutput).toHaveBeenCalledOnce();
    await h.runner.shutdown();
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    { output: "secret-non-json", reason: "invalid_response" },
    { output: '"' + "s".repeat(40_000) + '"', reason: "invalid_response" },
    { output: "secret-error", result: { exitCode: 1 }, reason: "execution_failed" },
    { output: "secret-timeout", result: { timedOut: true }, reason: "timeout" },
    { error: new Error("secret-spawn-error"), reason: "execution_failed" },
  ])("returns only $reason for failed subprocess output", async ({ reason, ...options }) => {
    const h = harness(options);
    await expect(h.runner.runJson(["browser", "extension", "setup"])).resolves.toEqual({
      ok: false,
      reason,
    });
    await h.runner.shutdown();
  });

  it("cancels an active run, refuses overlapping actions, and allows a later inspect", async () => {
    const h = harness();
    const running = h.runner.runJson(["browser", "extension", "setup"]);
    await expect(h.runner.runJson(["browser", "extension", "setup"])).resolves.toEqual({
      ok: false,
      reason: "busy",
    });
    expect(h.runner.cancel()).toBe(true);
    await expect(running).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(h.runner.cancel()).toBe(false);
    h.spawn.mockImplementationOnce(async (input) => {
      input.assertCurrent?.();
      input.onStdout?.('{"safe":true}');
      return { ...h.run, runId: "later-inspect", wait: async () => exit };
    });
    await expect(h.runner.runJson(["browser", "extension", "setup"])).resolves.toEqual({
      ok: true,
      value: { safe: true },
    });
    expect(h.spawn).toHaveBeenCalledTimes(2);
    await h.runner.shutdown();
  });

  it.each(["cancel", "shutdown"] as const)("%s fences delayed launch admission", async (method) => {
    const h = harness({ pendingSpawn: true });
    const running = h.runner.runJson(["browser", "extension", "setup"]);
    await h.runner[method]();
    expect(() => h.input()?.assertCurrent?.()).toThrow("cancelled");
    h.admission.resolve();
    await expect(running).resolves.toEqual({ ok: false, reason: "cancelled" });
    await h.runner.shutdown();
    await h.runner.shutdown();
    expect(h.cleanup).toHaveBeenCalledOnce();
    await expect(h.runner.runJson(["browser", "extension", "setup"])).resolves.toEqual({
      ok: false,
      reason: "closed",
    });
  });
});
