import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emitChildProcessSpawnSample } from "../process/spawn-diagnostics.js";
import { readChildRuntimeViability } from "./child-runtime-viability.js";
import { onDiagnosticEvent, setDiagnosticsEnabledForProcess } from "./diagnostic-events.js";
import { encodeSqliteAuthTransferFrame } from "./sqlite-readonly-auth-transfer.js";
import { captureSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker-context.js";
import { createSqliteReadOnlyWorkerSession } from "./sqlite-readonly-worker-session.js";
import {
  createSqliteReadOnlyWorkerScope,
  resolveSqliteInspectionSignal,
  createScopedSqliteReadOnlyWorker,
  withSqliteReadOnlyWorkerScope,
} from "./sqlite-readonly-worker.js";
import { createSqliteWorkerTransferOwner } from "./sqlite-worker-transfer.js";

type Send = (message: unknown, callback: (error: Error | null) => void) => boolean;
class MockChild extends EventEmitter {
  ref = vi.fn();
  unref = vi.fn();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  send = vi.fn<Send>((_message, callback) => {
    callback(null);
    return true;
  });
  kill = vi.fn<(_signal?: NodeJS.Signals) => boolean>(() => true);
}
const mock = vi.hoisted(() => ({ spawn: vi.fn<(executable: string) => MockChild>() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mock.spawn,
}));

type Session = ReturnType<typeof createSqliteReadOnlyWorkerSession>;
const sessions: Array<{ session: Session; child: MockChild }> = [];
function createSession() {
  const child = new MockChild();
  mock.spawn.mockReturnValueOnce(child);
  const readBudget = vi.fn(() => ({ timeoutMs: 60_000, size: "fixture" }));
  const requestArgs = vi.fn((file: string, { mode }: { mode: string }) => [mode, file]);
  const env = { OPENCLAW_STATE_DIR: "/fixture/state" };
  const session = createSqliteReadOnlyWorkerSession({
    env,
    cwd: "/fixture/launch",
    transport: { kind: "native" },
    argv: ["--fixture-readonly-session"],
    retainLifetime: false,
    retainOnOperationError: true,
    requestArgs,
    readBudget,
    deadlineOwnedByCaller: () => true,
    timeoutError: () => new Error("fixture budget expired"),
    closeTimeoutMs: 60_000,
  });
  sessions.push({ session, child });
  return { session, child, env, readBudget, requestArgs };
}
function requestId(child: MockChild): number {
  const request: unknown = child.send.mock.calls.at(-1)?.[0];
  if (!isRecord(request) || typeof request.id !== "number") {
    throw new Error("Expected a posted session request");
  }
  return request.id;
}
function observeSettlement(promise: Promise<unknown>) {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  void promise.then(mark, mark);
  return () => settled;
}

function reply(child: MockChild, result: unknown) {
  child.emit("message", { id: requestId(child), result });
}

async function expectRetirement(
  session: Session,
  child: MockChild,
  result: Promise<unknown>,
  message: string,
) {
  const settled = observeSettlement(result);
  await nextTurn();
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(settled()).toBe(false);
  const closing = session.close();
  const closeSettled = observeSettlement(closing);
  try {
    await nextTurn();
    expect([closeSettled(), settled()]).toEqual([false, false]);
  } finally {
    child.emit("close", null, "SIGKILL");
    await closing;
  }
  await expect(result).rejects.toThrow(message);
  expect(child.kill).toHaveBeenCalledOnce();
}

beforeEach(() => mock.spawn.mockReset());
afterEach(async () => {
  for (const { session, child } of sessions.splice(0)) {
    const closing = session.close();
    child.emit("close", 0, null);
    await closing;
  }
});

it.each([
  { code: "EACCES", spawned: false },
  { code: "EPERM", spawned: true },
])(
  "attributes $code to startup only before the spawn event (spawned=$spawned)",
  async ({ code, spawned }) => {
    const { session, child } = createSession();
    const failure = Object.assign(new Error("fixture process refusal"), { code });
    const result = session.run("/fixture/snapshot", { mode: "staging-create" });
    const observed = result.catch((error: unknown) => error);
    const settled = observeSettlement(result);
    if (spawned) {
      child.emit("spawn");
    }
    child.emit("error", failure);
    await nextTurn();
    expect(settled()).toBe(false);
    expect(session.notStarted).toBe(false);
    child.emit("close", -1, null);
    const error = await observed;
    expect(session.notStarted).toBe(!spawned);
    if (spawned) {
      expect(error).toBe(failure);
    } else {
      expect(error).toMatchObject({ code, cause: failure });
      expect((error as Error).message).toContain(
        `runtime binary not executable: ${process.execPath}`,
      );
      expect((error as Error).message).toContain("/fixture/launch");
      expect((error as Error).message).not.toMatch(
        /disk space|XDG_CACHE_HOME|OPENCLAW_STATE_DIR|--fixture-readonly-session/,
      );
    }
    await session.close();
  },
);

it("does not mark a runnable runtime unavailable after an ordinary worker abort", async () => {
  const { session, child } = createSession();
  const result = session.run("/fixture/snapshot", { mode: "staging-create" });
  child.emit("spawn");
  child.emit("close", null, "SIGABRT");
  await expect(result).rejects.toThrow("SQLite read-only worker exited with signal SIGABRT");
  expect(readChildRuntimeViability().available).toBe(true);
});

it("reuses its child after a well-formed staging refusal", async () => {
  const mode = "staging-create";
  const { session, child } = createSession();
  const first = session.run("/fixture/first.sqlite", { mode });
  const observed = first.catch((error: unknown) => error);
  const firstId = requestId(child);
  reply(child, { ok: false, message: "fixture staging refused" });
  // An incorrect retirement must fail here, without waiting forever for a mock child close.
  await nextTurn();
  expect(child.kill).not.toHaveBeenCalled();
  expect(await observed).toMatchObject({
    message: expect.stringContaining("fixture staging refused"),
  });

  const second = session.run("/fixture/second.sqlite", { mode });
  const secondId = requestId(child);
  expect(secondId).not.toBe(firstId);
  reply(child, { ok: true, location: "/fixture/staged" });
  await expect(second).resolves.toBe("/fixture/staged");
  expect(mock.spawn).toHaveBeenCalledOnce();
  expect(child.kill).not.toHaveBeenCalled();
});

it("joins retirement for malformed staging refusals", async () => {
  const { session, child } = createSession();
  const result = session.run("/fixture/source.sqlite", { mode: "staging-create" });
  reply(child, { ok: false, message: "fixture refusal", unexpected: true });
  await expectRetirement(session, child, result, "returned an invalid result");
});

it("joins retirement after framed auth failure", async () => {
  const { session, child, env } = createSession();
  const result = session.run("/fixture/auth.sqlite", {
    mode: "auth-profile-rows",
    source: "canonical",
    expectedIdentity: "file:fixture-auth",
    env,
  });
  const id = requestId(child);
  expect(child.send.mock.calls[0]?.[0]).toMatchObject({
    id,
    auth: { expectedIdentity: "file:fixture-auth" },
  });
  const transfer = createSqliteWorkerTransferOwner();
  const handle = transfer.start(
    [{ kind: "fields", value: [{ kind: "object" }] }][Symbol.iterator](),
    { kinds: ["fields"] },
  );
  try {
    reply(child, { type: "start", handle });
    expect(child.send).toHaveBeenLastCalledWith(
      { id, transfer: { type: "next", transferId: handle.id } },
      expect.any(Function),
    );
    reply(child, {
      type: "frame",
      frame: encodeSqliteAuthTransferFrame(transfer.next(handle.id)),
    });
    expect(child.send).toHaveBeenCalledTimes(3);
    expect(child.send).toHaveBeenLastCalledWith(
      { id, transfer: { type: "next", transferId: handle.id } },
      expect.any(Function),
    );
    reply(child, { ok: false, message: "fixture auth read refused" });
    await expectRetirement(session, child, result, "fixture auth read refused");
  } finally {
    transfer.cancel();
  }
});

it("refuses a run after close without budgeting or sending another request", async () => {
  const { session, child, readBudget, requestArgs } = createSession();
  const closing = session.close();
  expect(child.send).toHaveBeenLastCalledWith("close", expect.any(Function));
  child.emit("close", 0, null);
  await closing;
  const sends = child.send.mock.calls.length;
  const late = session.run("/fixture/late.sqlite", { mode: "staging-create" });
  void late.catch(() => undefined);
  await nextTurn();
  // Check delivery before awaiting rejection so the original missing guard fails promptly.
  expect(child.send).toHaveBeenCalledTimes(sends);
  expect([readBudget.mock.calls, requestArgs.mock.calls]).toEqual([[], []]);
  await expect(late).rejects.toThrow("worker is closed");
  expect(child.kill).not.toHaveBeenCalled();
});

it("keeps detached staging budget inside a caller-owned deadline", async () => {
  const timer = vi.spyOn(globalThis, "setTimeout");
  try {
    await withSqliteReadOnlyWorkerScope(
      async () => {
        const child = new MockChild();
        mock.spawn.mockReturnValueOnce(child);
        const session = createScopedSqliteReadOnlyWorker({
          env: {},
          cwd: "/fixture",
          transport: { kind: "native" },
          retainLifetime: false,
          retainOnOperationError: true,
        });
        sessions.push({ session, child });
        timer.mockClear();
        const result = session.run("/fixture/staging", { mode: "staging-create" });
        const budgeted = timer.mock.calls.some(
          ([, delay]) => typeof delay === "number" && delay > 0,
        );
        reply(child, { ok: true, location: "/fixture/staged" });
        await expect(result).resolves.toBe("/fixture/staged");
        expect(budgeted).toBe(true);
        expect(child.kill).not.toHaveBeenCalled();
      },
      { signal: new AbortController().signal, deadlineOwnedByCaller: true },
    );
  } finally {
    timer.mockRestore();
  }
});

it("captures only read scope and refuses callbacks after owner retirement", async () => {
  const caller = new AsyncLocalStorage<string>();
  const withoutOwner = captureSqliteReadOnlyWorkerScope();
  const controller = new AbortController();
  const owner = createSqliteReadOnlyWorkerScope({
    signal: controller.signal,
    deadlineOwnedByCaller: false,
  });
  const other = createSqliteReadOnlyWorkerScope();
  const run = owner.run(() => caller.run("startup", captureSqliteReadOnlyWorkerScope));
  const signal = owner.run(() => resolveSqliteInspectionSignal());
  try {
    await other.run(() =>
      caller.run("request", () =>
        run(async () => {
          await Promise.resolve();
          expect(resolveSqliteInspectionSignal()).toBe(signal);
          expect(caller.getStore()).toBe("request");
          expect(withoutOwner(() => resolveSqliteInspectionSignal())).toBeUndefined();
          expect(resolveSqliteInspectionSignal()).toBe(signal);
        }),
      ),
    );
    const late = vi.fn();
    const aborted = new Error("captured owner cancelled");
    controller.abort(aborted);
    expect(() => run(late)).toThrow(aborted);
    await owner.close();
    expect(() => other.run(() => run(late))).toThrow(
      expect.objectContaining({
        message: "SQLite read-only worker scope closed",
        code: "SQLITE_READONLY_WORKER_SCOPE_CLOSED",
      }),
    );
    expect(late).not.toHaveBeenCalled();
  } finally {
    await Promise.all([owner.close(), other.close()]);
  }
});

it.each([
  { execPath: "/fixture/bin/node", family: "node" },
  { execPath: "/fixture/bin/custom-runtime", family: "other" },
])("counts admitted children as $family in spawn diagnostics", ({ execPath, family }) => {
  const originalExecPath = process.execPath;
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const events: unknown[] = [];
  const stop = onDiagnosticEvent((event) => {
    if (event.type === "diagnostic.child_process.spawn") {
      events.push(event);
    }
  });
  try {
    process.execPath = execPath;
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    setDiagnosticsEnabledForProcess(true);
    const { child } = createSession();
    expect(mock.spawn).toHaveBeenCalledWith(
      execPath,
      expect.any(Array),
      expect.objectContaining({ windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] }),
    );
    now = 60_000;
    emitChildProcessSpawnSample();
    expect(events).toEqual([]);
    child.emit("spawn");
    now = 120_000;
    emitChildProcessSpawnSample();
    expect(events).toEqual([
      expect.objectContaining({ family, operation: "sqlite.session.native", count: 1 }),
    ]);
  } finally {
    process.execPath = originalExecPath;
    stop();
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    clock.mockRestore();
  }
});
