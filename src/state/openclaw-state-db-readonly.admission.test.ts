import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import {
  getWorkerComputeCapacity,
  type WorkerComputePermit,
} from "../infra/worker-task-capacity.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadLocation,
  OpenClawStateReadOutcome,
} from "./openclaw-state-read.types.js";

const mock = vi.hoisted(() => ({
  capacity: {
    admit: vi.fn<(bytes: number) => boolean>(),
    finish: vi.fn<(bytes: number) => void>(),
    acquire:
      vi.fn<(resume: () => void, checkpoint: () => boolean) => WorkerComputePermit | undefined>(),
    release: vi.fn<(permit: WorkerComputePermit) => void>(),
    remove: vi.fn<(resume: () => void) => void>(),
  },
  close: vi.fn<() => Promise<{ error: unknown } | undefined>>(),
  read: vi.fn<
    (
      source: OpenClawStateReadLocation,
      authority: OpenClawStateReadAuthority,
    ) => Promise<OpenClawStateReadOutcome>
  >(),
  validateFresh: vi.fn<() => Promise<void>>(),
  prepare: vi.fn<() => Promise<PreparedSqliteReadOnlyLocation>>(),
  cleanup: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("./openclaw-state-read-worker.js", () => ({
  createOpenClawStateReadTransport: () => ({
    read: mock.read,
    validateFresh: mock.validateFresh,
    close: mock.close,
  }),
}));
vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>()),
  prepareSqliteReadOnlyLocation: mock.prepare,
}));

import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const command = { type: "mcpOAuth.keys", input: "synthetic/" } as const;
const reply = {
  ok: true,
  sourceAdmitted: true,
  type: "mcpOAuth.keys",
  value: ["synthetic/one"],
} as const;
const permit: WorkerComputePermit = { requestCheckpoint: () => false };
let finishPending: (() => void) | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    finishPending?.();
    finishPending = undefined;
    mock.close.mockReset().mockResolvedValue(undefined);
    mock.cleanup.mockReset().mockResolvedValue(true);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    cleanup();
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  const capacity = getWorkerComputeCapacity();
  vi.spyOn(capacity, "admit").mockImplementation(mock.capacity.admit);
  vi.spyOn(capacity, "finish").mockImplementation(mock.capacity.finish);
  vi.spyOn(capacity, "acquire").mockImplementation(mock.capacity.acquire);
  vi.spyOn(capacity, "release").mockImplementation(mock.capacity.release);
  vi.spyOn(capacity, "remove").mockImplementation(mock.capacity.remove);
  mock.capacity.admit.mockReset().mockReturnValue(true);
  mock.capacity.acquire.mockReset().mockReturnValue(permit);
  mock.close.mockReset().mockResolvedValue(undefined);
  mock.read.mockReset().mockResolvedValue({ value: { ...reply, value: [...reply.value] } });
  mock.validateFresh.mockReset().mockResolvedValue(undefined);
  mock.cleanup.mockReset().mockResolvedValue(true);
  mock.prepare.mockReset().mockImplementation(async () => ({
    location: "/fixture/prepared.sqlite",
    cleanupRoot: "/fixture/prepared",
    cleanup: () => true,
    cleanupAsync: mock.cleanup,
  }));
});

function source() {
  const root = tempDirs.make("openclaw-read-admission-");
  const pathname = path.join(root, "source.sqlite");
  // The transport and snapshots are JavaScript mocks; this file supplies identity only.
  fs.writeFileSync(pathname, "mock read source");
  return { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
}

function observe<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("shared-state read lifetime admission", () => {
  it("keeps the captured caller and preservation policy while waiting for compute", async () => {
    const options = source();
    const original = captureOpenClawStateWorkerContext(options);
    const replacement = source();
    const queued = createDeferredCore();
    mock.capacity.acquire.mockImplementationOnce(() => {
      queued.resolve();
      return undefined;
    });
    const pending = observe(
      withArtifactPreservingStateReads(() =>
        executeExistingOpenClawStateRead(options, command, { context: original }),
      ),
    );
    await Promise.race([queued.promise, pending.then(() => undefined)]);
    expect(mock.capacity.acquire).toHaveBeenCalledTimes(1);
    expect(mock.validateFresh).not.toHaveBeenCalled();
    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.read).not.toHaveBeenCalled();
    options.env.OPENCLAW_STATE_DIR = replacement.env.OPENCLAW_STATE_DIR;
    vi.stubEnv("OPENCLAW_STATE_DIR", replacement.env.OPENCLAW_STATE_DIR);
    const resume = mock.capacity.acquire.mock.calls[0]?.[0];
    if (!resume) {
      throw new Error("Read did not register a compute waiter");
    }
    resume();
    expect(await pending).toEqual({ value: reply });
    expect(mock.prepare).toHaveBeenCalledWith(options.path, {
      preserveSourceArtifacts: true,
      signal: expect.any(AbortSignal),
    });
    expect(mock.read).toHaveBeenCalledWith(
      { context: original, location: "/fixture/prepared.sqlite", checkFreshAdmission: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mock.capacity.admit).toHaveBeenCalledWith(
      Buffer.byteLength(JSON.stringify(command), "utf8"),
    );
    expect(mock.capacity.release).toHaveBeenCalledExactlyOnceWith(permit);
    expect(mock.capacity.finish).toHaveBeenCalledExactlyOnceWith(
      Buffer.byteLength(JSON.stringify(command), "utf8"),
    );
  });

  it("removes an aborted queued caller once without starting preparation", async () => {
    const options = source();
    const context = captureOpenClawStateWorkerContext(options);
    const controller = new AbortController();
    const queued = createDeferredCore();
    mock.capacity.acquire.mockImplementation(() => {
      queued.resolve();
      return undefined;
    });
    const pending = observe(
      executeExistingOpenClawStateRead(options, command, {
        context,
        signal: controller.signal,
      }),
    );
    await Promise.race([queued.promise, pending.then(() => undefined)]);
    expect(mock.capacity.acquire).toHaveBeenCalledTimes(1);
    const reason = new Error("caller stopped while queued");
    controller.abort(reason);
    expect(await pending).toEqual({ error: reason });
    const resume = mock.capacity.acquire.mock.calls[0]?.[0];
    expect(mock.capacity.remove).toHaveBeenCalledExactlyOnceWith(resume);
    expect(mock.capacity.finish).toHaveBeenCalledExactlyOnceWith(
      Buffer.byteLength(JSON.stringify(command), "utf8"),
    );
    expect(mock.capacity.release).not.toHaveBeenCalled();
    expect(mock.validateFresh).not.toHaveBeenCalled();
    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.read).not.toHaveBeenCalled();
  });

  it("retains admission and compute through acknowledged stop and snapshot cleanup", async () => {
    const options = source();
    const stopEntered = createDeferredCore();
    const stop = createDeferredCore();
    const cleanupEntered = createDeferredCore();
    const cleanup = createDeferredCore();
    finishPending = () => {
      stop.resolve();
      cleanup.resolve();
    };
    mock.close.mockImplementationOnce(async () => {
      stopEntered.resolve();
      await stop.promise;
      return undefined;
    });
    mock.cleanup.mockImplementationOnce(async () => {
      cleanupEntered.resolve();
      await cleanup.promise;
      return true;
    });
    const pending = observe(
      withArtifactPreservingStateReads(() => executeExistingOpenClawStateRead(options, command)),
    );
    await stopEntered.promise;
    expect(mock.capacity.release).not.toHaveBeenCalled();
    expect(mock.capacity.finish).not.toHaveBeenCalled();
    expect(mock.cleanup).not.toHaveBeenCalled();
    stop.resolve();
    await cleanupEntered.promise;
    expect(mock.capacity.release).not.toHaveBeenCalled();
    expect(mock.capacity.finish).not.toHaveBeenCalled();
    cleanup.resolve();
    expect(await pending).toEqual({ value: reply });
    expect(mock.capacity.release).toHaveBeenCalledExactlyOnceWith(permit);
    expect(mock.capacity.finish).toHaveBeenCalledTimes(1);
  });

  it("retains its permit after a failed stop until the original owner retries cleanup", async () => {
    const options = source();
    const failure = new Error("transport stop was not acknowledged");
    mock.close.mockRejectedValueOnce(failure);
    await expect(
      withArtifactPreservingStateReads(() => executeExistingOpenClawStateRead(options, command)),
    ).rejects.toBe(failure);
    expect(mock.capacity.release).not.toHaveBeenCalled();
    expect(mock.capacity.finish).not.toHaveBeenCalled();
    expect(mock.cleanup).not.toHaveBeenCalled();
    await closeOpenClawStateDatabaseByPathAsync(source().path);
    expect(mock.close).toHaveBeenCalledTimes(1);
    expect(mock.capacity.release).not.toHaveBeenCalled();
    expect(mock.capacity.finish).not.toHaveBeenCalled();
    await closeOpenClawStateDatabaseByPathAsync(options.path);
    expect(mock.close).toHaveBeenCalledTimes(2);
    expect(mock.cleanup).toHaveBeenCalledTimes(1);
    expect(mock.capacity.release).toHaveBeenCalledExactlyOnceWith(permit);
    expect(mock.capacity.finish).toHaveBeenCalledTimes(1);
  });

  it("uses the inherited snapshot until its callback and read cleanup finish", async () => {
    const options = source();
    await withArtifactPreservingStateReads(() =>
      withOpenClawStateDatabaseReadSnapshot(async () => {
        expect(await executeExistingOpenClawStateRead(options, command)).toEqual(reply);
        expect(mock.read).toHaveBeenCalledWith(
          expect.objectContaining({ location: "/fixture/prepared.sqlite" }),
          expect.anything(),
        );
        expect(mock.prepare).toHaveBeenCalledExactlyOnceWith(options.path, {
          preserveSourceArtifacts: true,
        });
        expect(mock.cleanup).not.toHaveBeenCalled();
      }, options),
    );
    expect(mock.cleanup).toHaveBeenCalledTimes(1);
  });
});
