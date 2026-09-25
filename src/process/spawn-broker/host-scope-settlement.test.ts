import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { spawnCommand, withCommandProcessScope } from "../exec-spawn.js";
import { runWithSpawnBroker } from "./context.js";
import { serializeExecaError, type BrokerExecaResult } from "./execa-protocol.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import { SpawnBrokerError, type BrokerResponse } from "./protocol.js";

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  lostChildCleanup: vi.fn(() => ({ force: vi.fn(), settled: Promise.resolve() })),
  groupCleanup: vi.fn(() => ({ force: vi.fn(), settled: Promise.resolve() })),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
vi.mock("execa", () => ({
  execa: () => {
    throw new Error("Native command execution is outside this transport fixture");
  },
}));
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/spawn-broker.js"),
  resolveRuntimeWorkerArgv: () => ["synthetic-spawn-broker"],
}));
vi.mock("./cleanup.js", () => ({
  terminateLostBrokerChild: native.lostChildCleanup,
  terminateBrokerProcessGroup: native.groupCleanup,
}));
vi.mock("../../shared/pid-alive.js", () => ({
  getFileLockProcessStartTime: () => {
    throw new Error("Synthetic broker children cannot authorize a PID probe");
  },
}));
vi.mock("../child-process-tree.js", () => ({
  isChildProcessTreeAlive: () => {
    throw new Error("Synthetic broker children cannot authorize a tree probe");
  },
}));
vi.mock("../kill-tree.js", () => ({
  killProcessTree: () => {
    throw new Error("Synthetic broker children cannot authorize a process signal");
  },
}));
vi.mock("../windows-command.js", () => ({
  resolveSafeChildProcessInvocation: ({ argv }: { argv: string[] }) => ({
    command: argv[0],
    args: argv.slice(1),
    windowsHide: true,
    windowsVerbatimArguments: false,
    usesWindowsExitCodeShim: false,
  }),
}));

const hosts: SpawnBrokerHost[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("This fixture must not signal or inspect native processes");
  });
});

afterEach(async () => {
  try {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  } finally {
    vi.restoreAllMocks();
  }
});

function brokerFixture(ready = true) {
  // Construct the event surface only; the mocked spawn never starts this child.
  const worker = new ChildProcess();
  const requestSent = createDeferredCore<number>();
  let connected = true;
  let exited = false;
  const exit = () => {
    if (!exited) {
      exited = true;
      worker.emit("exit", 0, null);
    }
  };
  const send = vi.fn(
    (
      message: unknown,
      _handle: unknown,
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        (message.type === "spawn-execa" || message.type === "spawn") &&
        "id" in message &&
        typeof message.id === "number"
      ) {
        requestSent.resolve(message.id);
      }
      callback(null);
      return true;
    },
  );
  Object.defineProperties(worker, {
    pid: { value: 41001 },
    connected: { get: () => connected },
    exitCode: { get: () => (exited ? 0 : null) },
    send: { value: send },
    disconnect: {
      value: () => {
        connected = false;
        worker.emit("disconnect");
        exit();
      },
    },
    kill: {
      value: () => {
        exit();
        return true;
      },
    },
  });
  native.spawn.mockReturnValueOnce(worker);
  const host = createSpawnBrokerHost();
  hosts.push(host);
  const receive = (message: BrokerResponse) => worker.emit("message", message);
  if (ready) {
    receive({ type: "ready", pid: 41001 });
  }
  return { host, worker, send, receive, requestSent: requestSent.promise };
}

function missingExecutableResult(): BrokerExecaResult {
  const error = Object.assign(new Error("spawn synthetic-missing ENOENT"), { code: "ENOENT" });
  return {
    failed: true,
    code: "ENOENT",
    timedOut: false,
    isCanceled: false,
    isGracefullyCanceled: false,
    isMaxBuffer: false,
    isTerminated: false,
    isForcefullyTerminated: false,
    command: "synthetic-missing",
    escapedCommand: "synthetic-missing",
    cwd: "/synthetic",
    durationMs: 0,
    stdout: "",
    stderr: "",
    error: serializeExecaError(error),
  };
}

describe("broker host scope settlement", () => {
  it.each([false, true])("preserves a confirmed failed launch (reject=%s)", async (reject) => {
    const fixture = brokerFixture();
    let commandFailure: unknown;
    const scope = runWithSpawnBroker(fixture.host, () =>
      withCommandProcessScope(async () => {
        try {
          return await spawnCommand(["synthetic-missing"], { reject, baseEnv: {} });
        } catch (error) {
          commandFailure = error;
          throw error;
        }
      }),
    );
    const outcome = scope.then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    const id = await fixture.requestSent;
    // The worker's failed-admission branch sends its result before the error,
    // without publishing ownership or a spawned notification.
    fixture.receive({ type: "execa-result", id, result: missingExecutableResult() });
    fixture.receive({ type: "error", id, error: { message: "missing", code: "ENOENT" } });
    const completed = await outcome;
    if (reject) {
      expect(completed.error).toBe(commandFailure);
      expect(completed.error).toMatchObject({ code: "ENOENT" });
    } else {
      expect(completed.error).toBeUndefined();
      expect(completed.result).toMatchObject({ failed: true, code: "ENOENT" });
    }
    expect(native.lostChildCleanup).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps transport loss before readiness uncertain (owned=%s)",
    async (owned) => {
      const fixture = brokerFixture();
      let commandFailure: unknown;
      const scope = runWithSpawnBroker(fixture.host, () =>
        withCommandProcessScope(async () => {
          try {
            return await spawnCommand(["synthetic-command"], { baseEnv: {} });
          } catch (error) {
            commandFailure = error;
            throw error;
          }
        }),
      );
      const outcome = scope.catch((error: unknown) => error);
      const id = await fixture.requestSent;
      if (owned) {
        fixture.receive({ type: "owned", id, pid: 41002 });
      }
      fixture.worker.emit("disconnect");
      // Close immediately to cancel the host's restart timer; its cleanup is mocked.
      await fixture.host.close();
      const error = await outcome;
      expect(error).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
      expect(collectNestedErrorCandidates(error)).toContain(commandFailure);
      expect(native.lostChildCleanup).toHaveBeenCalledTimes(owned ? 1 : 0);
    },
  );

  it.each([false, true])("preserves worker capacity rejection (reject=%s)", async (reject) => {
    const fixture = brokerFixture();
    let commandFailure: unknown;
    const work = runWithSpawnBroker(fixture.host, () =>
      withCommandProcessScope(async () => {
        try {
          return await spawnCommand(["synthetic-command"], { reject, baseEnv: {} });
        } catch (error) {
          commandFailure = error;
          throw error;
        }
      }),
    ).catch((error: unknown) => error);
    const id = await fixture.requestSent;
    const refusal = new SpawnBrokerError("Spawn broker request capacity exceeded");
    fixture.receive({
      type: "execa-result",
      id,
      result: {
        ...missingExecutableResult(),
        code: refusal.code,
        error: serializeExecaError(refusal),
      },
    });
    fixture.receive({ type: "error", id, error: refusal, resultUnavailable: true });
    expect(await work).toBe(commandFailure);
    expect(await work).toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
    expect(native.lostChildCleanup).not.toHaveBeenCalled();
  });

  it("settles raw-spawn readiness and close after confirmed worker refusal", async () => {
    const fixture = brokerFixture();
    const child = fixture.host.spawn("synthetic-command", [], { stdio: "pipe" });
    const ready = child.ready().catch((error: unknown) => error);
    const closed = child.waitForClose();
    const id = await fixture.requestSent;
    const refusal = new SpawnBrokerError("Spawn broker request capacity exceeded");
    fixture.receive({
      type: "execa-result",
      id,
      result: {
        ...missingExecutableResult(),
        code: refusal.code,
        error: serializeExecaError(refusal),
      },
    });
    fixture.receive({ type: "error", id, error: refusal, resultUnavailable: true });
    await closed;
    expect(await ready).toMatchObject({ code: refusal.code });
    expect(child.notStarted).toBe(true);
    expect(native.lostChildCleanup).not.toHaveBeenCalled();
  });

  it.each([
    { owned: false, result: false },
    { owned: true, result: false },
    { owned: true, result: true },
  ])("keeps unconfirmed failure uncertain (owned=$owned, result=$result)", async (failure) => {
    const fixture = brokerFixture();
    let commandFailure: unknown;
    const work = runWithSpawnBroker(fixture.host, () =>
      withCommandProcessScope(async () => {
        try {
          return await spawnCommand(["synthetic-command"], { baseEnv: {} });
        } catch (error) {
          commandFailure = error;
          throw error;
        }
      }),
    ).catch((error: unknown) => error);
    const id = await fixture.requestSent;
    if (failure.owned) {
      fixture.receive({ type: "owned", id, pid: 41002 });
    }
    const unavailable = new SpawnBrokerError("Spawn broker request capacity exceeded");
    if (failure.result) {
      fixture.receive({
        type: "execa-result",
        id,
        result: {
          ...missingExecutableResult(),
          code: unavailable.code,
          error: serializeExecaError(unavailable),
        },
      });
    }
    fixture.receive({ type: "error", id, error: unavailable, resultUnavailable: true });
    const error = await work;
    expect(error).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
    expect(collectNestedErrorCandidates(error)).toContain(commandFailure);
  });

  it("preserves a local admission refusal without transmitting a command", async () => {
    const fixture = brokerFixture(false);
    let commandFailure: unknown;
    const scope = runWithSpawnBroker(fixture.host, () =>
      withCommandProcessScope(async () => {
        try {
          return await spawnCommand(["synthetic-command"], { baseEnv: {} });
        } catch (error) {
          commandFailure = error;
          throw error;
        }
      }),
    );
    const error = await scope.catch((failure: unknown) => failure);
    expect(error).toBe(commandFailure);
    expect(error).toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
    expect(fixture.send).not.toHaveBeenCalled();
    expect(native.lostChildCleanup).not.toHaveBeenCalled();
  });
});
