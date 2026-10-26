import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createStubChild } from "./supervisor/adapters/child.test-support.js";

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  bindingAvailable: true,
  launcherAvailable: true,
  create: vi.fn(() => 1n),
  inspect: vi.fn<() => number[]>(),
  terminate: vi.fn(),
  close: vi.fn(() => true),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
vi.mock("@openclaw/proc-safe/windows-job", () => ({
  isSupported: () => native.bindingAvailable,
  WindowsJob: {
    create: () => {
      native.create();
      return { terminate: native.terminate, close: native.close, processIds: native.inspect };
    },
  },
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (target: Parameters<typeof actual.existsSync>[0]) =>
      String(target).includes("managed-windows-job-launcher")
        ? native.launcherAvailable
        : actual.existsSync(target),
  };
});

function rejectJobAdmission(cause: Error, abort?: AbortController) {
  const launcher = createStubChild(4321);
  native.spawn.mockImplementationOnce((_command, args) => {
    queueMicrotask(() => {
      launcher.child.emit("spawn");
      abort?.abort();
      launcher.child.emit("message", { job: args[1], type: "job-error", error: cause.message });
      launcher.emitExit(1);
      launcher.emitClose(1);
    });
    return launcher.child;
  });
  native.terminate.mockImplementationOnce(() => true);
  native.inspect.mockReturnValue([]);
}

function stubLauncher(error?: Error & { code?: string }) {
  return (_command: string, args: string[]) => {
    stub.child.send = vi.fn((message: unknown, ...sendArgs: unknown[]) => {
      if (error || (message && typeof message === "object" && "command" in message)) {
        stub.child.emit(
          "message",
          error
            ? { job: args[1], type: "error", error: error.message, code: error.code }
            : { job: args[1], type: "spawned", pid: 5678 },
        );
      }
      return error ? true : stub.sendMock(message, ...sendArgs);
    });
    queueMicrotask(() => {
      stub.child.emit("spawn");
      stub.child.emit("message", { job: args[1], type: "ready" });
    });
    return stub.child;
  };
}

function finishRoot() {
  stub.emitExit(0);
  stub.emitClose(0);
}

type JobPhase = "binding" | "launcher" | "create" | "admission";
function failJob(phase: JobPhase, cause: Error, abort?: AbortController) {
  if (phase === "binding" || phase === "launcher") {
    native[`${phase}Available`] = false;
  } else if (phase === "create") {
    native.create.mockImplementationOnce(() => {
      abort?.abort();
      throw cause;
    });
  } else {
    rejectJobAdmission(cause, abort);
  }
}

function observeJob(cause?: Error) {
  native.inspect.mockImplementation(() => {
    if (cause) {
      throw cause;
    }
    return [];
  });
}

const fixture = {
  argv: [process.execPath, "fixture"],
  exactEnv: true,
} satisfies Parameters<typeof createOwnedStdioProcess>[0];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let createOwnedStdioProcess: typeof import("./owned-stdio.js").createOwnedStdioProcess;
let closeOwnedStdioProcess: typeof import("./owned-stdio.js").closeOwnedStdioProcess;
let createProcessSupervisor: typeof import("./supervisor/supervisor.js").createProcessSupervisor;
let stub: ReturnType<typeof createStubChild>;
beforeEach(async () => {
  vi.resetModules();
  ({ createOwnedStdioProcess, closeOwnedStdioProcess } = await import("./owned-stdio.js"));
  ({ createProcessSupervisor } = await import("./supervisor/supervisor.js"));
  native.bindingAvailable = true;
  native.launcherAvailable = true;
  Object.defineProperty(process, "platform", { value: "win32" });
  stub = createStubChild();
  native.create.mockReset().mockReturnValue(1n);
  native.inspect.mockReset().mockReturnValue([1234]);
  native.close.mockReset().mockReturnValue(true);
  native.terminate.mockReset().mockImplementation(() => {
    native.inspect.mockReturnValue([]);
    stub.child.stdout?.emit("end");
    stub.child.stderr?.emit("end");
    stub.emitClose(0);
    return true;
  });
  native.spawn.mockReset().mockImplementation(stubLauncher());
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

it("joins the Job after root exit with descendants holding stdio", async () => {
  const child = await createOwnedStdioProcess(fixture);
  child.onStdout(() => {});
  child.onStderr(() => {});
  try {
    const observed = createDeferred();
    native.inspect.mockImplementation(() => {
      observed.resolve();
      return [9876];
    });
    stub.emitExit(0);
    const confirmed = vi.fn();
    void child.waitForExtinction!().then(confirmed);
    await observed.promise;
    expect(confirmed).not.toHaveBeenCalled();
    await closeOwnedStdioProcess(child, { force: true });
    expect(confirmed).toHaveBeenCalledWith({ status: "confirmed" });
    expect(native.terminate).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
  } finally {
    native.inspect.mockReturnValue([]);
    stub.emitClose(0);
    child.dispose();
  }
});

it.each([false, true])(
  "publishes Job certification before root completion (observation fails=%s)",
  async (fails) => {
    const cause = new Error("Job accounting unavailable");
    const child = await createOwnedStdioProcess(fixture);
    observeJob(fails ? cause : undefined);
    const observed = vi.fn();
    const extinction = child.waitForExtinction!();
    void extinction.then(observed);
    finishRoot();
    try {
      await child.wait();
      expect(observed).toHaveBeenCalledOnce();
      await expect(extinction).resolves.toEqual(
        fails
          ? { status: "uncertain", reason: "job-observation-failed", cause }
          : { status: "confirmed" },
      );
      await expect(closeOwnedStdioProcess(child)).resolves.toBeUndefined();
      expect(native.close).toHaveBeenCalledOnce();
    } finally {
      await extinction;
      child.dispose();
    }
  },
);

it.each<[JobPhase, boolean]>([
  ["binding", false],
  ["launcher", false],
  ["create", false],
  ["admission", false],
  ["create", true],
  ["admission", true],
])("handles Job %s failure with cancellation=%s", async (phase, cancelled) => {
  const unavailable = phase === "binding" || phase === "launcher";
  const cause = new Error(`Job ${phase} failed`);
  const abort = new AbortController();
  failJob(phase, cause, cancelled ? abort : undefined);
  const starting = createOwnedStdioProcess(
    cancelled ? { ...fixture, abortSignal: abort.signal } : fixture,
  );
  if (cancelled) {
    await expect(starting).rejects.toThrow("child construction aborted");
    expect(native.spawn).toHaveBeenCalledTimes(phase === "create" ? 0 : 1);
    expect(stub.sendMock).not.toHaveBeenCalled();
    return;
  }
  const child = await starting;
  if (!unavailable && phase !== "create") {
    expect(native.close.mock.invocationCallOrder[0]).toBeLessThan(
      native.spawn.mock.invocationCallOrder.at(-1)!,
    );
  }
  finishRoot();
  await expect(child.wait()).resolves.toEqual({ code: 0, signal: null });
  const extinction = expect(child.waitForExtinction!()).resolves;
  const expected = {
    status: "uncertain",
    reason: unavailable ? "job-unavailable" : `job-${phase}-failed`,
    ...(!unavailable && { cause: expect.objectContaining({ message: cause.message }) }),
  };
  await (unavailable ? extinction.toEqual(expected) : extinction.toMatchObject(expected));
  await expect(closeOwnedStdioProcess(child)).resolves.toBeUndefined();
  if (unavailable) {
    expect(native.terminate).not.toHaveBeenCalled();
    expect(native.close).not.toHaveBeenCalled();
  }
});

it("does not retry a genuine command-launch error after Job admission", async () => {
  const cause = Object.assign(new Error("command not found"), { code: "ENOENT" });
  native.spawn.mockImplementationOnce(stubLauncher(cause));
  await expect(
    createOwnedStdioProcess({ argv: ["missing-command"], exactEnv: true }),
  ).rejects.toMatchObject(cause);
  expect(native.spawn).toHaveBeenCalledOnce();
});

it.each([
  ["required-all", false, true, "job-unavailable"],
  ["required-all", false, true, "confirmed"],
  ["owned-only", false, true, "job-unavailable"],
  ["transport-only", false, false, "job-unavailable"],
  ["owned-only", true, false, "job-unavailable"],
  ["required-all", true, true, "job-unavailable"],
  ["required-all", true, true, "confirmed"],
] as const)(
  "%s cleanup (external=%s, requires tree=%s) interprets %s certification",
  async (processTree, external, requiresTree, certification) => {
    if (certification === "job-unavailable") {
      native.bindingAvailable = false;
    }
    const supervisor = createProcessSupervisor();
    const scopeKey = "scope:windows-certification";
    const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree });
    const transportCleanup = supervisor.acquireScopeCleanup(scopeKey, {
      processTree: "transport-only",
    });
    const run = await supervisor.spawn({
      mode: "child",
      ...fixture,
      scopeKey,
      ...(external ? { cleanupOwnership: "external" } : {}),
    });
    try {
      stub.child.stdout?.emit("end");
      stub.child.stderr?.emit("end");
      observeJob();
      finishRoot();
      await expect(run.wait()).resolves.toMatchObject({ exitCode: 0, reason: "exit" });
      const outcome = await run.waitForExtinction!();
      expect(outcome).toMatchObject(
        certification === "confirmed"
          ? { status: "confirmed" }
          : { status: "uncertain", reason: certification },
      );
      // Join after the run has retired, alongside a policy that permits uncertainty.
      await expect(transportCleanup()).resolves.toBeUndefined();
      if (requiresTree && certification !== "confirmed") {
        await expect(cleanup()).rejects.toMatchObject({
          reason: certification,
          cause: outcome,
          message: expect.stringContaining(certification),
        });
      } else if (requiresTree && external) {
        await expect(cleanup()).rejects.toThrow("cannot confirm owned execution-tree settlement");
      } else {
        await expect(cleanup()).resolves.toBeUndefined();
      }
      await expect(supervisor.shutdown()).resolves.toBeUndefined();
    } finally {
      stub.emitClose(0);
      await Promise.allSettled([cleanup(), transportCleanup(), supervisor.shutdown()]);
    }
  },
);
