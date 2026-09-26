import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createStubChild } from "./supervisor/adapters/child.test-support.js";

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  koffiAvailable: true,
  launcherAvailable: true,
  create: vi.fn(() => 1n),
  configure: vi.fn(() => true),
  inspect: vi.fn<() => number[]>(),
  terminate: vi.fn(),
  close: vi.fn(() => true),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
vi.mock("node:module", async (original) => {
  const actual = await original<typeof import("node:module")>();
  const createRequire = (...args: Parameters<typeof actual.createRequire>) =>
    new Proxy(actual.createRequire(...args), {
      apply: (target, receiver, argumentsList) =>
        argumentsList[0] === "koffi"
          ? (() => {
              if (!native.koffiAvailable) {
                throw new Error("Cannot find module koffi");
              }
              return {};
            })()
          : Reflect.apply(target, receiver, argumentsList),
    });
  return new Proxy(actual, {
    get: (target, property, receiver) =>
      property === "createRequire" ? createRequire : Reflect.get(target, property, receiver),
  });
});
vi.mock("./supervisor/service-child-windows-job-native.ts", () => ({
  createWindowsJobBindings: () => ({
    assertLayouts() {},
    CreateJobObjectW: native.create,
    requireHandle: (handle: bigint) => handle,
    SetExtendedLimits: native.configure,
    TerminateJobObject: native.terminate,
    CloseHandle: native.close,
    readJobProcessIds: native.inspect,
    lastError: (operation: string) => new Error(operation),
  }),
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

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let createOwnedStdioProcess: typeof import("./owned-stdio.js").createOwnedStdioProcess;
let closeOwnedStdioProcess: typeof import("./owned-stdio.js").closeOwnedStdioProcess;
let createProcessSupervisor: typeof import("./supervisor/supervisor.js").createProcessSupervisor;
let stub: ReturnType<typeof createStubChild>;
beforeEach(async () => {
  vi.resetModules();
  ({ createOwnedStdioProcess, closeOwnedStdioProcess } = await import("./owned-stdio.js"));
  ({ createProcessSupervisor } = await import("./supervisor/supervisor.js"));
  native.koffiAvailable = true;
  native.launcherAvailable = true;
  Object.defineProperty(process, "platform", { value: "win32" });
  stub = createStubChild();
  native.create.mockReset().mockReturnValue(1n);
  native.configure.mockReset().mockReturnValue(true);
  native.inspect.mockReset().mockReturnValue([1234]);
  native.close.mockReset().mockReturnValue(true);
  native.terminate.mockReset().mockImplementation(() => {
    native.inspect.mockReturnValue([]);
    stub.child.stdout?.emit("end");
    stub.child.stderr?.emit("end");
    stub.emitClose(0);
    return true;
  });
  native.spawn.mockReset().mockImplementation((_command, args) => {
    stub.child.send = vi.fn((message: unknown, ...sendArgs: unknown[]) => {
      if (message && typeof message === "object" && "command" in message) {
        stub.child.emit("message", { job: args[1], type: "spawned", pid: 5678 });
      }
      const callback = sendArgs.findLast((value) => typeof value === "function");
      if (typeof callback === "function") {
        callback(null);
      }
      return true;
    });
    queueMicrotask(() => {
      stub.child.emit("spawn");
      stub.child.emit("message", { job: args[1], type: "ready" });
    });
    return stub.child;
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

it("joins the retained Windows Job after the root exits with descendants still holding stdio", async () => {
  const child = await createOwnedStdioProcess({
    argv: [process.execPath, "fixture"],
    exactEnv: true,
  });
  child.onStdout(() => {});
  child.onStderr(() => {});
  try {
    expect(child.waitForExtinction).toBeTypeOf("function");
    expect(child.pid).toBe(5678);
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

it("retains a failed Job observation as cleanup uncertainty", async () => {
  const cause = new Error("Job accounting unavailable");
  const child = await createOwnedStdioProcess({
    argv: [process.execPath, "fixture"],
    exactEnv: true,
  });
  native.inspect.mockImplementation(() => {
    throw cause;
  });
  stub.emitExit(0);
  stub.emitClose(0);
  await expect(child.waitForExtinction!()).resolves.toEqual({
    status: "uncertain",
    reason: "job-observation-failed",
    cause,
  });
  await expect(closeOwnedStdioProcess(child)).resolves.toBeUndefined();
  expect(native.close).toHaveBeenCalledOnce();
});

it("publishes an empty Job's cleanup before the root completion", async () => {
  const child = await createOwnedStdioProcess({
    argv: [process.execPath, "fixture"],
    exactEnv: true,
  });
  let confirmed = false;
  const extinction = child.waitForExtinction!().then(() => {
    confirmed = true;
  });
  native.inspect.mockReturnValue([]);
  stub.emitExit(0);
  stub.emitClose(0);
  try {
    await child.wait();
    expect(confirmed).toBe(true);
  } finally {
    await extinction;
    child.dispose();
  }
});

it.each(["koffi", "launcher"] as const)(
  "spawns without %s and reports unavailable Job certification",
  async (missing) => {
    native.koffiAvailable = missing !== "koffi";
    native.launcherAvailable = missing !== "launcher";
    const child = await createOwnedStdioProcess({
      argv: [process.execPath, "fixture"],
      exactEnv: true,
    });
    expect(native.spawn).toHaveBeenCalledWith(process.execPath, ["fixture"], expect.any(Object));
    stub.emitExit(0);
    stub.emitClose(0);
    await expect(child.wait()).resolves.toEqual({ code: 0, signal: null });
    await expect(child.waitForExtinction!()).resolves.toEqual({
      status: "uncertain",
      reason: "job-unavailable",
    });
    await expect(closeOwnedStdioProcess(child)).resolves.toBeUndefined();
    expect(native.terminate).not.toHaveBeenCalled();
    expect(native.close).not.toHaveBeenCalled();
  },
);

it.each(["job-unavailable", "job-admission-failed"] as const)(
  "preserves %s certification through a supervised exec session",
  async (reason) => {
    if (reason === "job-unavailable") {
      native.koffiAvailable = false;
    } else {
      rejectJobAdmission(new Error("Job admission failed"));
    }
    const supervisor = createProcessSupervisor();
    const run = await supervisor.spawn({
      mode: "child",
      argv: [process.execPath, "fixture"],
      exactEnv: true,
    });
    stub.child.stdout?.emit("end");
    stub.child.stderr?.emit("end");
    stub.emitExit(0);
    stub.emitClose(0);
    await expect(run.wait()).resolves.toMatchObject({ exitCode: 0, reason: "exit" });
    await expect(run.waitForExtinction!()).resolves.toMatchObject({
      status: "uncertain",
      reason,
    });
    await supervisor.shutdown();
  },
);

it.each(["create", "configuration", "admission"] as const)(
  "launches once without containment when Job %s fails",
  async (phase) => {
    const cause = new Error(`Job ${phase} failed`);
    if (phase === "create") {
      native.create.mockImplementationOnce(() => {
        throw cause;
      });
    } else if (phase === "configuration") {
      native.configure.mockImplementationOnce(() => {
        throw cause;
      });
    } else {
      rejectJobAdmission(cause);
    }
    const child = await createOwnedStdioProcess({
      argv: [process.execPath, "fixture"],
      exactEnv: true,
    });
    expect(native.spawn.mock.calls.filter(([, args]) => args[0] === "fixture")).toHaveLength(1);
    if (phase !== "create") {
      expect(native.close.mock.invocationCallOrder[0]).toBeLessThan(
        native.spawn.mock.invocationCallOrder.at(-1)!,
      );
    }
    stub.emitExit(0);
    stub.emitClose(0);
    await expect(child.wait()).resolves.toEqual({ code: 0, signal: null });
    await expect(child.waitForExtinction!()).resolves.toMatchObject({
      status: "uncertain",
      reason: `job-${phase}-failed`,
      cause: expect.objectContaining({ message: cause.message }),
    });
    await expect(closeOwnedStdioProcess(child)).resolves.toBeUndefined();
  },
);

it("does not retry a genuine command-launch error after Job admission", async () => {
  const cause = Object.assign(new Error("command not found"), { code: "ENOENT" });
  native.spawn.mockImplementationOnce((_command, args) => {
    stub.child.send = vi.fn(() => {
      stub.child.emit("message", {
        job: args[1],
        type: "error",
        error: cause.message,
        code: cause.code,
      });
      return true;
    });
    queueMicrotask(() => {
      stub.child.emit("spawn");
      stub.child.emit("message", { job: args[1], type: "ready" });
    });
    return stub.child;
  });
  await expect(
    createOwnedStdioProcess({ argv: ["missing-command"], exactEnv: true }),
  ).rejects.toMatchObject(cause);
  expect(native.spawn).toHaveBeenCalledOnce();
});

it.each(["create", "admission"] as const)(
  "does not fall back when cancelled during Job %s failure",
  async (phase) => {
    const abort = new AbortController();
    if (phase === "create") {
      native.create.mockImplementationOnce(() => {
        abort.abort();
        throw new Error("Job creation failed");
      });
    } else {
      rejectJobAdmission(new Error("Job admission failed"), abort);
    }
    await expect(
      createOwnedStdioProcess({
        argv: [process.execPath, "fixture"],
        exactEnv: true,
        abortSignal: abort.signal,
      }),
    ).rejects.toThrow("child construction aborted");
    expect(native.spawn).toHaveBeenCalledTimes(phase === "create" ? 0 : 1);
    expect(stub.sendMock).not.toHaveBeenCalled();
  },
);

describe.each([
  { processTree: "required-all", external: false, requiresTree: true },
  { processTree: "owned-only", external: false, requiresTree: true },
  { processTree: "transport-only", external: false, requiresTree: false },
  { processTree: "owned-only", external: true, requiresTree: false },
  { processTree: "required-all", external: true, requiresTree: true },
] as const)(
  "$processTree cleanup (external=$external)",
  ({ processTree, external, requiresTree }) => {
    it.each([
      "job-unavailable",
      "job-admission-failed",
      "job-observation-failed",
      "confirmed",
    ] as const)(
      "interprets %s certification without failing command execution",
      async (certification) => {
        if (certification === "job-unavailable") {
          native.koffiAvailable = false;
        } else if (certification === "job-admission-failed") {
          rejectJobAdmission(new Error("Job admission failed"));
        }
        const supervisor = createProcessSupervisor();
        const scopeKey = "scope:windows-certification";
        const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree });
        const transportCleanup = supervisor.acquireScopeCleanup(scopeKey, {
          processTree: "transport-only",
        });
        const run = await supervisor.spawn({
          mode: "child",
          argv: [process.execPath, "fixture"],
          exactEnv: true,
          scopeKey,
          ...(external ? { cleanupOwnership: "external" } : {}),
        });
        try {
          stub.child.stdout?.emit("data", Buffer.from("command succeeded"));
          stub.child.stdout?.emit("end");
          stub.child.stderr?.emit("end");
          if (certification === "job-observation-failed") {
            native.inspect.mockImplementation(() => {
              throw new Error("Job accounting unavailable");
            });
          } else {
            native.inspect.mockReturnValue([]);
          }
          stub.emitExit(0);
          stub.emitClose(0);
          await expect(run.wait()).resolves.toMatchObject({
            exitCode: 0,
            stdout: "command succeeded",
          });
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
            await expect(cleanup()).rejects.toThrow(
              "cannot confirm owned execution-tree settlement",
            );
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
  },
);
