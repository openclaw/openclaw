import { EventEmitter, once } from "node:events";
import { serialize } from "node:v8";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createSqliteOperationTransferReceiver } from "./sqlite-readonly-auth-transfer.js";
import type { SqliteReadOnlyOperationExecutionContext } from "./sqlite-readonly-operation-types.js";
import "../test-utils/prepare-compiled-subprocesses.js";

const owners = vi.hoisted(() => ({
  prepareCopy: vi.fn(),
  createToken: vi.fn(),
  releaseSnapshot: vi.fn(),
  registerSnapshot: vi.fn(),
  cleanup: vi.fn(),
  executeOperation: vi.fn(),
  assertIdentity: vi.fn(),
}));
// mock-isolation: The deferred copy owns synthetic paths; keep native SQLite backup and snapshot allocation outside the fake child.
vi.mock("./sqlite-readonly-location.js", () => ({
  prepareSqliteReadOnlyCopyInProcess: owners.prepareCopy,
  SqliteSourceChangedError: class extends Error {},
}));
// mock-isolation: Synthetic snapshot release must not join or mutate the process-wide snapshot custody singleton.
vi.mock("./sqlite-readonly-location-cleanup.js", () => ({
  releaseSnapshotTempDirectory: owners.releaseSnapshot,
  registerSnapshotTempDirectory: owners.registerSnapshot,
  cleanupSnapshotOperations: owners.cleanup,
}));
// mock-isolation: The fixture owns in-memory staging tokens, not native SQLite locks or filesystem reclamation.
vi.mock("./sqlite-snapshot-staging.js", () => ({
  createSqliteSnapshotStagingTokenSync: owners.createToken,
}));
// mock-isolation: The fake child must not acquire or retire native staging tokens for its synthetic snapshot paths.
vi.mock("./sqlite-snapshot-retirement.js", () => ({}));
// mock-isolation: Deferred operations exercise child IPC settlement without opening a synthetic database.
vi.mock("./sqlite-readonly-operation-registry.js", () => ({
  sqliteReadOnlyOperations: {
    prepare: () => undefined,
    has: () => true,
    execute: owners.executeOperation,
  },
}));
// mock-isolation: The fixture controls physical replacement at the post-operation identity boundary.
vi.mock("./sqlite-worker-identity.js", () => ({
  assertExistingDatabaseIdentity: owners.assertIdentity,
}));

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(owners)) {
    mock.mockReset();
  }
});

async function openSession() {
  const events = new EventEmitter();
  const disconnected = once(events, "disconnect");
  const retired = once(events, "retired");
  const sent = once(events, "sent");
  const child = {
    ...process,
    argv: [process.execPath, "worker.mjs", "--openclaw-sqlite-readonly-child", "session"],
    exitCode: undefined,
    exit: vi.fn(() => {
      throw new Error("unexpected forced process exit");
    }),
    connected: true,
    on: events.on.bind(events),
    once: events.once.bind(events),
    stdin: { destroy: vi.fn(() => events.emit("retired")) },
    stderr: { write: vi.fn() },
    send: vi.fn((message: unknown, callback: (error: Error | null) => void) => {
      queueMicrotask(() => {
        events.emit("sent", message);
        callback(null);
      });
      return true;
    }),
    disconnect: vi.fn(() => {
      child.connected = false;
      events.emit("disconnect");
    }),
  };
  vi.stubGlobal("process", child);
  await import("./sqlite-readonly-location.worker.js");
  return { child, events, disconnected, retired, sent };
}

it("settles an accepted copy before retiring on malformed input", async () => {
  const copy = createDeferred<{ location: string; cleanupRoot: string }>();
  owners.prepareCopy.mockReturnValue(copy.promise);
  const session = await openSession();
  session.events.emit("message", { id: 1, args: ["sync", "/source.sqlite"] });
  expect(owners.prepareCopy).toHaveBeenCalledOnce();
  session.events.emit("message", { invalid: true });
  session.events.emit("message", { id: 2, args: ["sync", "/other.sqlite"] });
  expect(session.child.disconnect).not.toHaveBeenCalled();
  expect(owners.prepareCopy).toHaveBeenCalledOnce();
  copy.resolve({ location: "/private/snapshot.sqlite", cleanupRoot: "/private" });
  await session.disconnected;
  expect(owners.releaseSnapshot).toHaveBeenCalledExactlyOnceWith("/private");
  expect(owners.registerSnapshot).toHaveBeenCalledExactlyOnceWith("/private");
  expect(owners.cleanup).toHaveBeenCalledOnce();
  expect(session.child.send).not.toHaveBeenCalled();
  expect(session.child.exitCode).toBe(1);
});

it("releases retained staging tokens before disconnecting an idle session", async () => {
  const release = vi.fn();
  owners.createToken.mockReturnValue({ directory: "/private/staging", release });
  const session = await openSession();
  session.events.emit("message", { id: 1, args: ["staging-create", "/private"] });
  await session.sent;
  session.events.emit("message", "close");
  await session.disconnected;
  expect(release).toHaveBeenCalledOnce();
  expect(release.mock.invocationCallOrder[0]).toBeLessThan(
    session.child.disconnect.mock.invocationCallOrder[0]!,
  );
  expect(session.child.exitCode).toBe(0);
  expect(session.child.exit).not.toHaveBeenCalled();
});

it.each(["close", "busy", "disconnect", "replacement", "rejection"] as const)(
  "settles an asynchronous operation before %s retires its session",
  async (boundary) => {
    const entered = createDeferred();
    const operation = createDeferred<unknown>();
    owners.executeOperation.mockImplementation(
      async (_request, context: SqliteReadOnlyOperationExecutionContext) => {
        entered.resolve();
        const value = await operation.promise;
        context.assertCurrent();
        return value;
      },
    );
    const session = await openSession();
    const command = { type: "startupMetadata.readCurrent", input: { type: "config.health.read" } };
    const request = {
      id: 1,
      args: ["operation", "/source.sqlite"],
      operation: {
        expectedIdentity: "file:source",
        command: serialize(command).toString("base64"),
      },
    };
    session.events.emit("message", request);
    await entered.promise;
    expect(session.child.send).not.toHaveBeenCalled();
    if (boundary === "close") {
      session.events.emit("message", "close");
    } else if (boundary === "busy") {
      session.events.emit("message", { ...request, id: 2 });
    } else if (boundary === "disconnect") {
      session.child.connected = false;
      session.events.emit("disconnect");
    } else if (boundary === "replacement") {
      owners.assertIdentity.mockImplementationOnce(() => {
        throw new Error("source replaced during operation");
      });
    }
    expect(owners.cleanup).not.toHaveBeenCalled();
    expect(session.child.disconnect).not.toHaveBeenCalled();
    expect(owners.executeOperation).toHaveBeenCalledOnce();
    if (boundary === "rejection") {
      operation.reject(new Error("metadata import failed"));
    } else {
      operation.resolve({ value: "settled metadata" });
    }
    if (boundary === "close") {
      const receiver = createSqliteOperationTransferReceiver(command.type);
      let [message] = await session.sent;
      for (;;) {
        const received = receiver.accept(message.result);
        if ("value" in received) {
          expect(received.value).toEqual({
            operation: command.type,
            value: { value: "settled metadata" },
          });
          break;
        }
        const sent = once(session.events, "sent");
        session.events.emit("message", { id: 1, transfer: received.request });
        [message] = await sent;
      }
    }
    // Incoming disconnect can precede retirement; stdin closes only after work and cleanup settle.
    await session.retired;
    expect(owners.cleanup).toHaveBeenCalledOnce();
    expect(session.child.exitCode).toBe(boundary === "close" ? 0 : 1);
    if (boundary === "busy" || boundary === "disconnect") {
      expect(session.child.send).not.toHaveBeenCalled();
    } else if (boundary !== "close") {
      expect(session.child.send).toHaveBeenCalledWith(
        {
          id: 1,
          result: {
            ok: false,
            message:
              boundary === "replacement"
                ? "source replaced during operation"
                : "metadata import failed",
          },
        },
        expect.any(Function),
      );
    }
    expect(owners.assertIdentity).toHaveBeenCalledTimes(
      boundary === "close" ? 3 : boundary === "replacement" ? 2 : 1,
    );
  },
);
