import { ChildProcess, type MessageOptions, type SendHandle } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { spawnCommand, withCommandProcessScope } from "../exec-spawn.js";
import { runWithSpawnBroker } from "./context.js";
import { serializeExecaError, type BrokerExecaResult } from "./execa-protocol.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import {
  SpawnBrokerError,
  type BrokerError,
  type BrokerRequest,
  type BrokerResponse,
} from "./protocol.js";
import type { BrokerBootstrap } from "./resource-protocol.js";

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  lostChildCleanup: vi.fn(() => ({ force: vi.fn(), settled: Promise.resolve() })),
  groupCleanup: vi.fn(() => ({ force: vi.fn(), settled: Promise.resolve() })),
  forbidden: () => {
    throw new Error("Synthetic transport must not execute or probe native processes");
  },
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
vi.mock("execa", () => ({ execa: native.forbidden }));
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/spawn-broker.js"),
  resolveRuntimeWorkerArgv: () => ["synthetic-spawn-broker"],
}));
vi.mock("./cleanup.js", () => ({
  terminateLostBrokerChild: native.lostChildCleanup,
  terminateBrokerProcessGroup: native.groupCleanup,
}));
vi.mock("../../shared/pid-alive.js", () => ({ getFileLockProcessStartTime: native.forbidden }));
vi.mock("../child-process-tree.js", () => ({ isChildProcessTreeAlive: native.forbidden }));
vi.mock("../kill-tree.js", () => ({ killProcessTree: native.forbidden }));
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
  vi.spyOn(process, "kill").mockImplementation(native.forbidden);
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
  const worker = new (class extends ChildProcess {
    override readonly pid = 41001;
    override connected = true;
    override exitCode: number | null = null;
    override disconnect() {
      this.connected = false;
      this.emit("disconnect");
      this.kill();
    }
    override kill() {
      if (this.exitCode === null) {
        this.exitCode = 0;
        this.emit("exit", 0, null);
      }
      return true;
    }
  })();
  const requestSent = createDeferredCore<number>();
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
  Object.defineProperty(worker, "send", { value: send });
  native.spawn.mockReturnValueOnce(worker);
  const host = createSpawnBrokerHost();
  hosts.push(host);
  // Assertions below distinguish command transmission from transport bootstrap.
  send.mockClear();
  const receive = (message: BrokerResponse) => worker.emit("message", message);
  const refuse = (
    id: number,
    error: BrokerError,
    result?: BrokerExecaResult,
    unavailable = true,
  ) => {
    if (result) {
      receive({ type: "execa-result", id, result });
    }
    receive({ type: "error", id, error, ...(unavailable ? { resultUnavailable: true } : {}) });
  };
  if (ready) {
    receive({ type: "ready", pid: 41001 });
  }
  return { host, worker, send, receive, refuse, requestSent: requestSent.promise };
}

function failedResult(
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

it.each(failures)("settles $name according to admission evidence", async (failure) => {
  const fixture = brokerFixture(!failure.local);
  let commandFailure: unknown;
  const scope = runWithSpawnBroker(fixture.host, () =>
    withCommandProcessScope(() =>
      spawnCommand([failure.result === "missing" ? "synthetic-missing" : "synthetic-command"], {
        reject: failure.reject ?? true,
        baseEnv: {},
      }).catch((error: unknown) => {
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
      // Failed admission sends a result before the error, without ownership.
      fixture.refuse(
        id,
        failure.result === "missing" ? { message: "missing", code: "ENOENT" } : refusal,
        failure.result
          ? failedResult(failure.result === "capacity" ? refusal : undefined)
          : undefined,
        failure.result !== "missing",
      );
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
  fixture.refuse(id, refusal, failedResult(refusal));
  await closed;
  expect(await ready).toMatchObject({ code: refusal.code });
  expect(child.notStarted).toBe(true);
  expect(native.lostChildCleanup).not.toHaveBeenCalled();
});

it("retires undelivered guarded preparations and refuses a late orphan", async () => {
  const fixture = brokerFixture();
  let orphanId: number | undefined;
  let initiations = 0;
  // Exceed the broker's request capacity without delivering any preparation to its peer.
  for (let attempt = 0; attempt < 257; attempt++) {
    fixture.send.mockImplementationOnce((message, ...args) => {
      if (message.type === "prepare-spawn") {
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
