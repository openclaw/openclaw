import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ManagedRun, ProcessSupervisor, RunExit } from "../process/supervisor/types.js";
import type { NodeWorkerWorkspaceQuiescenceInput } from "../worker/node-workspace-protocol.js";
import { NodeWorkerWorkspaceQuiescence } from "./node-worker-workspace-quiescence.js";

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn<() => Promise<void>>(async () => {}),
  acquire: vi.fn<ProcessSupervisor["acquireScopeCleanup"]>(),
  spawn: vi.fn<ProcessSupervisor["spawn"]>(),
  cancel: vi.fn<ProcessSupervisor["cancel"]>(),
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    acquireScopeCleanup: mocks.acquire,
    spawn: mocks.spawn,
    cancel: mocks.cancel,
  }),
}));
vi.mock("node:child_process", () => ({
  spawn: () => {
    throw new Error("Windows must not start a POSIX watchdog");
  },
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  mocks.acquire.mockImplementation(() => mocks.cleanup);
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.resetAllMocks();
});
const nonce = "a".repeat(32);
const result: RunExit = {
  reason: "exit",
  exitCode: 0,
  exitSignal: null,
  durationMs: 0,
  stdout: "ok",
  stderr: "",
  timedOut: false,
  noOutputTimedOut: false,
};
function fixture(operation: NodeWorkerWorkspaceQuiescenceInput) {
  const release = vi.fn();
  const context = {
    input: {
      gatewayNamespace: "gateway-one",
      environmentId: "environment-one",
      sessionId: "session-one",
      generation: 1,
      argv: ["openclaw-internal-workspace-quiescence", "C:\\workspace"],
      quiescence: operation,
    },
    workspaceDir: "C:\\workspace",
    env: { HOME: "C:\\home", USERPROFILE: "C:\\home", SystemRoot: "C:\\Windows" },
    retainWorkspace: vi.fn(() => release),
  };
  const run: ManagedRun = {
    activity: { resultSettled: false, lastOutputAtMs: 0 },
    runId: "controlled-run",
    startedAtMs: 0,
    wait: vi.fn(async () => result),
    cancel: vi.fn(),
  };
  mocks.spawn.mockResolvedValue(run);
  return { owner: new NodeWorkerWorkspaceQuiescence(), context, run, release };
}

// The platform selector and process backend are simulated. These unit contracts
// complement, but never count as, native Windows Job/filesystem acceptance.
describe("Windows-selected quiescence controller contracts", () => {
  it("does not admit an already-aborted operation", async () => {
    const f = fixture({ action: "release", nonce });
    const controller = new AbortController();
    controller.abort(new Error("caller revoked"));
    await expect(f.owner.execute(f.context, controller.signal)).rejects.toThrow("caller revoked");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("joins accepted Windows command cleanup before close and workspace release", async () => {
    const f = fixture({ action: "acquire", nonce, timeoutMs: 30_000 });
    const cleanupEntered = createDeferred();
    const cleaned = createDeferred();
    mocks.cleanup.mockImplementation(async () => {
      cleanupEntered.resolve();
      await cleaned.promise;
    });
    const operation = f.owner.execute(f.context);
    await cleanupEntered.promise;
    let closed = false;
    const closing = f.owner.close().then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(f.owner.hasActiveWork()).toBe(true);
      expect(f.context.retainWorkspace).toHaveBeenCalledOnce();
      expect(f.release).not.toHaveBeenCalled();
    } finally {
      cleaned.resolve();
      await Promise.allSettled([operation, closing]);
    }
    await expect(operation).resolves.toBe("ok");
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.owner.hasActiveWork()).toBe(false);
  });

  it("preserves uncertain cleanup custody across repeated close attempts", async () => {
    const f = fixture({ action: "release", nonce });
    const failure = new Error("uncertain Job cleanup");
    // The real scope-cleanup owner caches its result; retrying cannot invent extinction.
    mocks.cleanup.mockRejectedValue(failure);
    await expect(f.owner.execute(f.context)).rejects.toBe(failure);
    expect(f.owner.hasActiveWork()).toBe(true);
    expect(f.release).not.toHaveBeenCalled();
    await expect(f.owner.close()).rejects.toMatchObject({ errors: [failure] });
    await expect(f.owner.close()).rejects.toMatchObject({ errors: [failure] });
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.owner.hasActiveWork()).toBe(true);
  });

  it.each([false, true])(
    "joins failed command cleanup (caller cancelled: %s)",
    async (cancelled) => {
      const f = fixture(
        cancelled
          ? { action: "renew", nonce, timeoutMs: 30_000, validationMode: "final" }
          : { action: "release", nonce },
      );
      const entered = createDeferred();
      const exit = createDeferred<RunExit>();
      vi.mocked(f.run.wait).mockImplementation(async () => {
        entered.resolve();
        return exit.promise;
      });
      const controller = new AbortController();
      const operation = f.owner.execute(f.context, cancelled ? controller.signal : undefined);
      const stderr = cancelled ? "cancelled command" : "lease rejected";
      const rejected = expect(operation).rejects.toThrow(stderr);
      try {
        await entered.promise;
        if (cancelled) {
          controller.abort();
          expect(mocks.cancel).toHaveBeenCalledWith(mocks.spawn.mock.calls[0]![0].runId);
        }
      } finally {
        exit.resolve({
          ...result,
          exitCode: cancelled ? null : 1,
          exitSignal: cancelled ? "SIGTERM" : null,
          stderr,
        });
        await rejected;
        if (cancelled) {
          await f.owner.close();
        }
      }
      expect(mocks.cleanup).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.owner.hasActiveWork()).toBe(false);
      if (!cancelled) {
        await f.owner.close();
      }
    },
  );
});
