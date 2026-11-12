import { ChildProcess, type MessageOptions, type SendHandle } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { spawnCommand, withCommandProcessScope } from "../exec-spawn.js";
import { runWithSpawnBrokerAdmission } from "./admission.js";
import { runWithSpawnBroker } from "./context.js";
import { serializeExecaError, type BrokerExecaResult } from "./execa-protocol.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import { SpawnBrokerError, type BrokerRequest, type BrokerResponse } from "./protocol.js";
import type { BrokerBootstrap } from "./resource-protocol.js";

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  unexpectedEffect: () => {
    throw new Error("Synthetic broker fixture cannot authorize native effects");
  },
  lostChildCleanup: vi.fn(() => ({ force: vi.fn(), settled: Promise.resolve() })),
  groupCleanup: vi.fn(() => ({ force: vi.fn(), settled: Promise.resolve() })),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
vi.mock("execa", () => ({ execa: native.unexpectedEffect }));
// mock-isolation: The transport fixture never launches compiled subprocesses.
vi.mock("../../infra/runtime-process-entrypoints.js", () => ({
  runtimeProcessEntrypoints: { spawnBroker: "synthetic-spawn-broker" },
}));
// mock-isolation: The synthetic transport never resolves a native worker.
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("./synthetic-spawn-broker.js", import.meta.url),
  resolveRuntimeWorkerArgv: () => ["synthetic-spawn-broker"],
}));
vi.mock("./cleanup.js", () => ({
  terminateLostBrokerChild: native.lostChildCleanup,
  terminateBrokerProcessGroup: native.groupCleanup,
}));
// mock-isolation: Synthetic processes cannot authorize native pid effects.
vi.mock("../../shared/pid-alive.js", () => ({
  getFileLockProcessStartTime: native.unexpectedEffect,
}));
// mock-isolation: Synthetic processes cannot authorize native tree effects.
vi.mock("../child-process-tree.js", () => ({ isChildProcessTreeAlive: native.unexpectedEffect }));
// mock-isolation: Synthetic processes cannot authorize native signal effects.
vi.mock("../kill-tree.js", () => ({ killProcessTree: native.unexpectedEffect }));
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
  vi.spyOn(process, "kill").mockImplementation(native.unexpectedEffect);
});

afterEach(async () => {
  try {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  } finally {
    vi.restoreAllMocks();
  }
});

function brokerFixture(ready = true) {
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
      message: BrokerRequest | BrokerBootstrap,
      ...args: Array<SendHandle | MessageOptions | ((error: Error | null) => void) | undefined>
    ) => {
      if (message.type === "spawn-execa" || message.type === "spawn") {
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
  send.mockClear();
  const receive = (message: BrokerResponse) => worker.emit("message", message);
  if (ready) {
    receive({ type: "ready", pid: 41001 });
  }
  return { host, worker, send, receive, requestSent: requestSent.promise };
}

function failedLaunchResult(
  error = Object.assign(new Error("spawn synthetic-missing ENOENT"), { code: "ENOENT" }),
): BrokerExecaResult {
  return {
    failed: true,
    code: error.code,
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
  raw?: boolean;
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
  { name: "raw worker refusal", result: "capacity", raw: true },
];

describe("broker host scope settlement", () => {
  it.each(failures)("settles $name according to admission evidence", async (failure) => {
    const fixture = brokerFixture(!failure.local);
    const raw = failure.raw
      ? fixture.host.spawn("synthetic-command", [], { stdio: "pipe" })
      : undefined;
    const argv = [failure.result === "missing" ? "synthetic-missing" : "synthetic-command"];
    const options = { reject: failure.reject ?? true, baseEnv: {} };
    let commandFailure: unknown;
    const scope = runWithSpawnBroker(fixture.host, () =>
      withCommandProcessScope(
        async () =>
          await (raw?.ready() ?? spawnCommand(argv, options)).catch((error: unknown) => {
            commandFailure = error;
            throw error;
          }),
      ),
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
            result: failedLaunchResult(failure.result === "capacity" ? refusal : undefined),
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
    if (raw) {
      await raw.waitForClose();
      expect(raw.notStarted).toBe(true);
    }
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
    };
    for (let index = 0; index < 448; index++) {
      await start(true);
    }
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

  it("retires undelivered guarded preparations and refuses a late orphan", async () => {
    const fixture = brokerFixture();
    let initiations = 0;
    const firstPreparation = createDeferredCore<number>();
    for (let attempt = 0; attempt < 257; attempt++) {
      fixture.send.mockImplementationOnce((message, ...args) => {
        if (message.type === "prepare-spawn") {
          firstPreparation.resolve(message.id);
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
    const orphanId = await firstPreparation.promise;
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
