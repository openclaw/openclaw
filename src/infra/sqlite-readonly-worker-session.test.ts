import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitChildProcessSpawnSample } from "../process/spawn-diagnostics.js";
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
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  send = vi.fn<Send>((_message, callback) => {
    callback(null);
    return true;
  });
  kill = vi.fn<(_signal?: NodeJS.Signals) => boolean>(() => true);
}
const mock = vi.hoisted(() => ({ spawn: vi.fn<() => MockChild>() }));
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
  const requestArgs = vi.fn((pathname: string, options: { mode: string }) => [
    options.mode,
    pathname,
  ]);
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
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

beforeEach(() => mock.spawn.mockReset());
afterEach(async () => {
  for (const { session, child } of sessions.splice(0)) {
    const closing = session.close();
    child.emit("close", 0, null);
    await closing;
  }
});

describe("SQLite read-only session operation custody", () => {
  it.each([false, true])(
    "attributes errors to startup only before the spawn event (spawned=%s)",
    async (spawned) => {
      const { session, child } = createSession();
      const failure = Object.assign(new Error("fixture process refusal"), { code: "EACCES" });
      const result = session.run("/fixture/snapshot", { mode: "staging-create" });
      const observed = result.catch((error: unknown) => error);
      const settled = observeSettlement(result);
      if (spawned) {
        child.emit("spawn");
      }
      child.emit("error", failure);
      await nextTurn();
      expect(settled()).toBe(false);
      child.emit("close", -1, null);
      const error = await observed;
      if (spawned) {
        expect(error).toBe(failure);
      } else {
        expect(error).toMatchObject({ code: "EACCES", cause: failure });
        expect((error as Error).message).toContain(process.execPath);
        expect((error as Error).message).toContain("/fixture/launch");
        expect((error as Error).message).not.toContain("OPENCLAW_STATE_DIR");
        expect((error as Error).message).not.toContain("--fixture-readonly-session");
      }
      await session.close();
    },
  );

  it.each([
    "staging-create",
    "staging-create-legacy",
    "staging-reconcile",
    "staging-retire",
  ] as const)("reuses its child after a well-formed %s refusal", async (mode) => {
    const { session, child } = createSession();
    const first = session.run("/fixture/first.sqlite", { mode });
    const observed = first.catch((error: unknown) => error);
    const firstId = requestId(child);
    child.emit("message", {
      id: firstId,
      result: { ok: false, message: "fixture staging refused" },
    });
    // An incorrect retirement must fail here, without waiting forever for a mock child close.
    await nextTurn();
    expect(child.kill).not.toHaveBeenCalled();
    expect(await observed).toMatchObject({
      message: expect.stringContaining("fixture staging refused"),
    });

    const second = session.run("/fixture/second.sqlite", { mode });
    const secondId = requestId(child);
    expect(secondId).not.toBe(firstId);
    child.emit("message", { id: secondId, result: { ok: true, location: "/fixture/staged" } });
    await expect(second).resolves.toBe("/fixture/staged");
    expect(mock.spawn).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("joins retirement for a malformed staging refusal instead of retaining its child", async () => {
    const { session, child } = createSession();
    const result = session.run("/fixture/source.sqlite", { mode: "staging-create" });
    const settled = observeSettlement(result);
    child.emit("message", {
      id: requestId(child),
      result: { ok: false, message: "fixture refusal", unexpected: true },
    });
    await nextTurn();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(settled()).toBe(false);
    const closing = session.close();
    const closeSettled = observeSettlement(closing);
    try {
      await nextTurn();
      expect(closeSettled()).toBe(false);
      expect(settled()).toBe(false);
    } finally {
      child.emit("close", null, "SIGKILL");
      await closing;
    }
    await expect(result).rejects.toThrow("returned an invalid result");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("joins a framed auth operation failure even when staging refusals may retain the child", async () => {
    const { session, child, env } = createSession();
    const coordinatorRuntime = { directory: "/fixture/coordinator", keepAlive: false };
    const result = session.run("/fixture/auth.sqlite", {
      mode: "auth-profile-rows",
      source: "canonical",
      expectedIdentity: "file:fixture-auth",
      env,
      coordinatorRuntime,
    });
    const settled = observeSettlement(result);
    const id = requestId(child);
    expect(child.send.mock.calls[0]?.[0]).toMatchObject({
      id,
      auth: { expectedIdentity: "file:fixture-auth", coordinatorRuntime },
    });
    const transfer = createSqliteWorkerTransferOwner();
    const handle = transfer.start(
      [
        { kind: "store", value: { status: "missing" } },
        { kind: "state", value: { status: "missing" } },
      ][Symbol.iterator](),
      { kinds: ["store", "state"] },
    );
    try {
      child.emit("message", {
        id,
        result: { type: "start", handle: { ...handle, cacheable: false } },
      });
      expect(child.send).toHaveBeenLastCalledWith(
        { id, transfer: { type: "next", transferId: handle.id } },
        expect.any(Function),
      );
      child.emit("message", {
        id,
        result: { type: "frame", frame: encodeSqliteAuthTransferFrame(transfer.next(handle.id)) },
      });
      expect(child.send).toHaveBeenCalledTimes(3);
      expect(child.send).toHaveBeenLastCalledWith(
        { id, transfer: { type: "next", transferId: handle.id } },
        expect.any(Function),
      );
      child.emit("message", { id, result: { ok: false, message: "fixture auth read refused" } });
      await nextTurn();
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(settled()).toBe(false);
      const closing = session.close();
      const closeSettled = observeSettlement(closing);
      try {
        await nextTurn();
        expect(closeSettled()).toBe(false);
      } finally {
        child.emit("close", null, "SIGKILL");
        await closing;
      }
      await expect(result).rejects.toThrow("fixture auth read refused");
      expect(child.kill).toHaveBeenCalledOnce();
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
    expect(readBudget).not.toHaveBeenCalled();
    expect(requestArgs).not.toHaveBeenCalled();
    await expect(late).rejects.toThrow("worker is closed");
    expect(child.kill).not.toHaveBeenCalled();
  });
});

it("keeps a detached staging command budget inside a caller-owned deadline scope", async () => {
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
        child.emit("message", {
          id: requestId(child),
          result: { ok: true, location: "/fixture/staged" },
        });
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

it("carries only its captured read scope and refuses callbacks after owner retirement", async () => {
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
    expect(() => other.run(() => run(late))).toThrow("scope closed");
    expect(late).not.toHaveBeenCalled();
  } finally {
    await Promise.all([owner.close(), other.close()]);
  }
});

it("counts admitted read-only session children in node spawn diagnostics", () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const events: unknown[] = [];
  const stop = onDiagnosticEvent((event) => {
    if (event.type === "diagnostic.child_process.spawn") {
      events.push(event);
    }
  });
  try {
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    setDiagnosticsEnabledForProcess(true);
    const { child } = createSession();
    now = 60_000;
    emitChildProcessSpawnSample();
    expect(events).toEqual([]);
    child.emit("spawn");
    now = 120_000;
    emitChildProcessSpawnSample();
    expect(events).toEqual([
      expect.objectContaining({ family: process.versions.bun ? "other" : "node", count: 1 }),
    ]);
  } finally {
    stop();
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    clock.mockRestore();
  }
});
