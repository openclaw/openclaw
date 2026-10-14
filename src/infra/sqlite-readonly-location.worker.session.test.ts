import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import "../test-utils/prepare-compiled-subprocesses.js";

const owners = vi.hoisted(() => ({
  prepareCopy: vi.fn(),
  createToken: vi.fn(),
  releaseSnapshot: vi.fn(),
}));
// mock-isolation: The deferred copy owns synthetic paths; keep native SQLite backup and snapshot allocation outside the fake child.
vi.mock("./sqlite-readonly-location.js", () => ({
  prepareSqliteReadOnlyCopyInProcess: owners.prepareCopy,
  SqliteSourceChangedError: class extends Error {},
}));
// mock-isolation: Synthetic snapshot release must not join or mutate the process-wide snapshot custody singleton.
vi.mock("./sqlite-readonly-location-cleanup.js", () => ({
  releaseSnapshotTempDirectory: owners.releaseSnapshot,
}));
// mock-isolation: The fixture owns in-memory staging tokens, not native SQLite locks or filesystem reclamation.
vi.mock("./sqlite-snapshot-staging.js", () => ({
  createSqliteSnapshotStagingTokenSync: owners.createToken,
}));
// mock-isolation: The fake child must not acquire or retire native staging tokens for its synthetic snapshot paths.
vi.mock("./sqlite-snapshot-retirement.js", () => ({}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.resetModules();
  owners.prepareCopy.mockReset();
  owners.createToken.mockReset();
  owners.releaseSnapshot.mockReset();
});

async function openSession() {
  const events = new EventEmitter();
  const disconnected = createDeferred();
  const sent = createDeferred<{ id: number; result: unknown }>();
  const child = {
    ...process,
    argv: [process.execPath, "worker.mjs", "--openclaw-sqlite-readonly-child", "session"],
    exitCode: process.exitCode,
    exit: vi.fn(() => {
      throw new Error("unexpected forced process exit");
    }),
    connected: true,
    on: events.on.bind(events),
    once: events.once.bind(events),
    stdin: { destroy: vi.fn() },
    stderr: { write: vi.fn() },
    send: vi.fn(
      (message: { id: number; result: unknown }, callback: (error: Error | null) => void) => {
        queueMicrotask(() => {
          sent.resolve(message);
          callback(null);
        });
        return true;
      },
    ),
    disconnect: vi.fn(() => {
      child.connected = false;
      events.emit("disconnect");
      disconnected.resolve();
    }),
  };
  child.exitCode = undefined;
  vi.stubGlobal("process", child);
  await import("./sqlite-readonly-location.worker.js");
  return { child, events, disconnected: disconnected.promise, sent: sent.promise };
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
