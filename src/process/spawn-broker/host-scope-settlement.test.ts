import { ChildProcess, type MessageOptions, type SendHandle } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { spawnCommand, withCommandProcessScope } from "../exec-spawn.js";
import { runWithSpawnBrokerAdmission } from "./admission.js";
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
// mock-isolation: The synthetic transport must never resolve or launch a native worker.
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("./synthetic-spawn-broker.js", import.meta.url),
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

function brokerWorkerFixture() {
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
  const receive = (message: BrokerResponse) => worker.emit("message", message);
  return { worker, send, receive, requestSent: requestSent.promise };
}

function brokerFixture(ready = true) {
  const transport = brokerWorkerFixture();
  const host = createSpawnBrokerHost();
  hosts.push(host);
  expect(transport.send).toHaveBeenCalledExactlyOnceWith(
    { type: "bootstrap" },
    expect.any(Function),
  );
  // Assertions below distinguish command transmission from transport bootstrap.
  transport.send.mockClear();
  if (ready) {
    transport.receive({ type: "ready", pid: 41001 });
  }
  return { host, ...transport };
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

  it("keeps commands available with retained children and recovers startup capacity", async () => {
    const fixture = brokerFixture();
    const children: ReturnType<SpawnBrokerHost["spawn"]>[] = [];
    for (let index = 0; index < 255; index++) {
      const command = fixture.host.spawnExeca(["synthetic-command"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      void command.result.catch(() => {});
      const id = command.child.requestId;
      fixture.receive({ type: "owned", id, pid: 42000 + index });
      fixture.receive({
        type: "spawned",
        id,
        pid: 42000 + index,
        spawnfile: "synthetic-command",
        spawnargs: ["synthetic-command"],
        connected: false,
        stdioLength: 3,
      });
      await command.child.ready();
      children.push(command.child);
    }
    expect(children.every((child) => child.exitCode === null)).toBe(true);

    const pending = Array.from({ length: 256 }, () =>
      fixture.host.spawn("synthetic-command", [], { stdio: "ignore" }),
    );
    const refused = fixture.host.spawn("synthetic-command", [], { stdio: "ignore" });
    await expect(refused.ready()).rejects.toThrow("startup capacity exceeded");
    expect(refused.notStarted).toBe(true);
    const released = pending[0]!;
    fixture.receive({
      type: "error",
      id: released.requestId,
      error: { message: "synthetic startup failure" },
      notStarted: true,
    });
    await expect(released.ready()).rejects.toThrow("synthetic startup failure");
    const recovered = fixture.host.spawn("synthetic-command", [], { stdio: "ignore" });
    fixture.receive({ type: "owned", id: recovered.requestId, pid: 43000 });
    fixture.receive({
      type: "spawned",
      id: recovered.requestId,
      pid: 43000,
      spawnfile: "synthetic-command",
      spawnargs: ["synthetic-command"],
      connected: false,
      stdioLength: 3,
    });
    await recovered.ready();
    expect(recovered.pid).toBe(43000);
    // Startup admission must not relinquish cleanup custody of retained children.
    fixture.worker.emit("disconnect");
    await fixture.host.close();
    expect(native.lostChildCleanup).toHaveBeenCalledTimes(256);
  });

  it("reserves command capacity while MCP children retain cleanup custody", async () => {
    const fixture = brokerFixture();
    const children: ReturnType<SpawnBrokerHost["spawn"]>[] = [];
    const start = async (mcp: boolean) => {
      const spawn = () => fixture.host.spawn("synthetic-command", [], { stdio: "ignore" });
      const child = mcp ? runWithSpawnBrokerAdmission("mcp", spawn) : spawn();
      fixture.receive({ type: "owned", id: child.requestId, pid: 44000 + children.length });
      fixture.receive({
        type: "spawned",
        id: child.requestId,
        pid: 44000 + children.length,
        spawnfile: "synthetic-command",
        spawnargs: ["synthetic-command"],
        connected: false,
        stdioLength: 3,
      });
      await child.ready();
      children.push(child);
      return child;
    };
    for (let index = 0; index < 448; index++) {
      await start(true);
    }
    expect(fixture.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "spawn", admission: "mcp" }),
      undefined,
      expect.anything(),
      expect.any(Function),
    );
    const refusedMcp = runWithSpawnBrokerAdmission("mcp", () =>
      fixture.host.spawn("synthetic-command", [], { stdio: "ignore" }),
    );
    await expect(refusedMcp.ready()).rejects.toThrow(/capacity/);
    expect(refusedMcp.notStarted).toBe(true);
    for (let index = 0; index < 64; index++) {
      await start(false);
    }
    const refusedCommand = fixture.host.spawn("synthetic-command", [], { stdio: "ignore" });
    await expect(refusedCommand.ready()).rejects.toThrow(/capacity/);
    expect(refusedCommand.notStarted).toBe(true);
    const released = children[0]!;
    fixture.receive({ type: "exit", id: released.requestId, code: 0, signal: null });
    fixture.receive({ type: "closed", id: released.requestId });
    await released.waitForClose();
    await start(true);
    fixture.worker.emit("disconnect");
    await fixture.host.close();
    expect(native.lostChildCleanup).toHaveBeenCalledTimes(512);
  });

  it.each(["unknown after restart", "known cleanup after restart", "late ownership"] as const)(
    "retains MCP reservations during %s until native cleanup is proven",
    async (recovery) => {
      const fixture = brokerFixture();
      const cleanup = createDeferredCore();
      native.lostChildCleanup.mockImplementation(() => ({
        force: vi.fn(),
        settled: cleanup.promise,
      }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const children: ReturnType<SpawnBrokerHost["spawn"]>[] = [];
        for (let index = 0; index < 448; index++) {
          if (recovery !== "known cleanup after restart") {
            fixture.send.mockImplementationOnce((_message, ...args) => {
              args.find((arg) => typeof arg === "function")?.(new Error("synthetic lost receipt"));
              return false;
            });
          }
          const child = runWithSpawnBrokerAdmission("mcp", () =>
            fixture.host.spawn("synthetic-command", [], { stdio: "ignore", detached: true }),
          );
          if (recovery === "known cleanup after restart") {
            fixture.receive({ type: "owned", id: child.requestId, pid: 45000 + index });
            fixture.receive({
              type: "spawned",
              id: child.requestId,
              pid: 45000 + index,
              spawnfile: "synthetic-command",
              spawnargs: ["synthetic-command"],
              connected: false,
              stdioLength: 3,
            });
            await child.ready();
          } else {
            await expect(child.ready()).rejects.toThrow("request delivery failed");
            await child.waitForClose();
          }
          children.push(child);
        }
        let receive = fixture.receive;
        if (recovery === "late ownership") {
          for (const [index, child] of children.entries()) {
            fixture.receive({ type: "owned", id: child.requestId, pid: 45000 + index });
          }
        } else {
          const restarted = brokerWorkerFixture();
          fixture.worker.disconnect();
          await vi.advanceTimersByTimeAsync(100);
          restarted.receive({ type: "ready", pid: 41001 });
          await fixture.host.ready();
          receive = restarted.receive;
        }
        const refused = runWithSpawnBrokerAdmission("mcp", () =>
          fixture.host.spawn("synthetic-command", [], { stdio: "ignore" }),
        );
        expect(refused.notStarted).toBe(true);
        await expect(refused.ready()).rejects.toThrow(/capacity/);
        expect(native.lostChildCleanup).toHaveBeenCalledTimes(
          recovery === "unknown after restart" ? 0 : 448,
        );
        cleanup.resolve();
        await fixture.host.waitForCleanup();
        const recovered = runWithSpawnBrokerAdmission("mcp", () =>
          fixture.host.spawn("synthetic-command", [], { stdio: "ignore" }),
        );
        if (recovery === "unknown after restart") {
          expect(recovered.notStarted).toBe(true);
          await expect(recovered.ready()).rejects.toThrow(/capacity/);
        } else {
          receive({
            type: "error",
            id: recovered.requestId,
            error: { message: "synthetic authoritative no-start" },
            notStarted: true,
          });
          await expect(recovered.ready()).rejects.toThrow("synthetic authoritative no-start");
          expect(recovered.notStarted).toBe(true);
        }
      } finally {
        cleanup.resolve();
        await fixture.host.close();
        vi.useRealTimers();
        native.lostChildCleanup.mockImplementation(() => ({
          force: vi.fn(),
          settled: Promise.resolve(),
        }));
      }
    },
  );

  it("retires undelivered guarded preparations and refuses a late orphan", async () => {
    const fixture = brokerFixture();
    let orphanId: number | undefined;
    let initiations = 0;
    // Exceed the broker's request capacity without delivering any preparation to its peer.
    for (let attempt = 0; attempt < 257; attempt++) {
      fixture.send.mockImplementationOnce((message, ...args) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "prepare-spawn" &&
          "id" in message &&
          typeof message.id === "number"
        ) {
          orphanId ??= message.id;
        }
        args.find((arg) => typeof arg === "function")?.(new Error("synthetic delivery refusal"));
        return false;
      });
      const child = fixture.host.spawn("synthetic-command", [], { stdio: "ignore" }, (launch) => {
        initiations++;
        return launch();
      });
      await expect(child.ready(), `preparation ${attempt}`).rejects.toThrow(
        "Spawn broker request delivery failed",
      );
      await child.waitForClose();
    }
    if (orphanId === undefined) {
      throw new Error("Expected a transmitted preparation identity");
    }
    const refusal = createDeferredCore<unknown>();
    fixture.send.mockImplementationOnce((message, ...args) => {
      refusal.resolve(message);
      args.find((arg) => typeof arg === "function")?.(null);
      return true;
    });
    fixture.receive({ type: "prepared", id: orphanId });
    await expect(refusal.promise).resolves.toEqual({
      type: "launch",
      id: orphanId,
      allowed: false,
    });

    const recovered = fixture.host.spawn("synthetic-command", [], { stdio: "ignore" });
    const result = expect(recovered.ready()).rejects.toThrow("synthetic native refusal");
    const id = await fixture.requestSent;
    fixture.receive({ type: "error", id, error: { message: "synthetic native refusal" } });
    await result;
    await recovered.waitForClose();
    expect(initiations).toBe(0);
  });
});
