import { ChildProcess, type MessageOptions, type SendHandle } from "node:child_process";
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
      ...args: Array<SendHandle | MessageOptions | ((error: Error | null) => void) | undefined>
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
      args.find((arg) => typeof arg === "function")?.(null);
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
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "bootstrap" }, expect.any(Function));
  // Assertions below distinguish command transmission from transport bootstrap.
  send.mockClear();
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

type FailureCase = {
  name: string;
  reject?: boolean;
  local?: boolean;
  owned?: boolean;
  disconnect?: boolean;
  result?: "missing" | "capacity";
};

const failures: FailureCase[] = [
  { name: "failed launch returned", result: "missing", reject: false },
  { name: "failed launch rejected", result: "missing" },
  { name: "unowned transport loss", disconnect: true },
  { name: "owned transport loss", disconnect: true, owned: true },
  { name: "capacity refusal with reject:false", result: "capacity", reject: false },
  { name: "capacity refusal with reject:true", result: "capacity" },
  { name: "unconfirmed unowned failure" },
  { name: "unconfirmed owned failure", owned: true },
  { name: "failed result after ownership", owned: true, result: "capacity" },
  { name: "local admission refusal", local: true },
];

describe("broker host scope settlement", () => {
  it.each(failures)("settles $name according to admission evidence", async (failure) => {
    const fixture = brokerFixture(!failure.local);
    let commandFailure: unknown;
    const scope = runWithSpawnBroker(fixture.host, () =>
      withCommandProcessScope(async () => {
        try {
          return await spawnCommand(
            [failure.result === "missing" ? "synthetic-missing" : "synthetic-command"],
            {
              reject: failure.reject ?? true,
              baseEnv: {},
            },
          );
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
    if (!failure.local) {
      const id = await fixture.requestSent;
      if (failure.owned) {
        fixture.receive({ type: "owned", id, pid: 41002 });
      }
      if (failure.disconnect) {
        fixture.worker.emit("disconnect");
        // Cancel the restart timer; native cleanup is mocked.
        await fixture.host.close();
      } else {
        const refusal = new SpawnBrokerError("Spawn broker request capacity exceeded");
        if (failure.result) {
          // Failed admission sends a result before the error, without ownership.
          fixture.receive({
            type: "execa-result",
            id,
            result: {
              ...missingExecutableResult(),
              ...(failure.result === "capacity"
                ? { code: refusal.code, error: serializeExecaError(refusal) }
                : {}),
            },
          });
        }
        fixture.receive({
          type: "error",
          id,
          error: failure.result === "missing" ? { message: "missing", code: "ENOENT" } : refusal,
          ...(failure.result === "missing" ? {} : { resultUnavailable: true }),
        });
      }
    }
    const completed = await outcome;
    const uncertain = !failure.local && (!failure.result || failure.owned);
    if (uncertain) {
      expect(completed.error).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
      expect(collectNestedErrorCandidates(completed.error)).toContain(commandFailure);
    } else if (failure.result === "missing" && failure.reject === false) {
      expect(completed.error).toBeUndefined();
      expect(completed.result).toMatchObject({ failed: true, code: "ENOENT" });
    } else {
      expect(completed.error).toBe(commandFailure);
      expect(completed.error).toMatchObject({
        code: failure.result === "missing" ? "ENOENT" : "ERR_SPAWN_BROKER_UNAVAILABLE",
      });
    }
    if (failure.disconnect) {
      expect(native.lostChildCleanup).toHaveBeenCalledTimes(failure.owned ? 1 : 0);
    } else if (!uncertain) {
      expect(native.lostChildCleanup).not.toHaveBeenCalled();
    }
    if (failure.local) {
      expect(fixture.send).not.toHaveBeenCalled();
    }
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
});
