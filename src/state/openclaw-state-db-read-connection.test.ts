import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = { isOpen: true, close: vi.fn<() => void>() };
  const releaseToken = vi.fn<() => void>();
  return {
    db,
    releaseToken,
    acquireToken: vi.fn(() => releaseToken),
    identity: vi.fn<(location: string, expected: string) => void>(),
    openTracked: vi.fn<() => typeof db>(),
    openPrivate: vi.fn<() => typeof db>(),
    closeHandle: vi.fn<(owner: { db: typeof db; afterClose: () => void }) => unknown[]>(),
    schema: vi.fn<() => void>(),
    policy: vi.fn(() => false),
  };
});

vi.mock("../infra/sqlite-snapshot-staging.js", () => ({
  acquireSqliteSnapshotReadToken: mocks.acquireToken,
}));
vi.mock("../infra/sqlite-worker-identity.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/sqlite-worker-identity.js")>(
    "../infra/sqlite-worker-identity.js",
  )),
  assertExistingDatabaseIdentity: mocks.identity,
}));
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: mocks.openPrivate,
}));
vi.mock("../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/bun-sqlite-library.js")>()),
  // The fake handles close synchronously, independently of the host runtime.
  getSqliteRuntimeCapabilities: () => ({
    explicitSqliteCloseReleasesNativeResources: true,
    decided: true,
    reason: "synchronous fixture close",
  }),
}));
vi.mock("../infra/sqlite-schema-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-schema-facts.js")>()),
  admitSqliteSchema: vi.fn(),
}));
vi.mock("./openclaw-state-db-handle.js", () => ({
  openTrackedStateDatabaseResult: () => ({ status: "available", database: mocks.openTracked() }),
}));
vi.mock("./openclaw-state-db-schema-version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-schema-version.js")>()),
  assertSupportedStateSchemaVersion: mocks.schema,
}));
vi.mock("./openclaw-state-db-schema-policy.js", () => ({
  isExistingOpenClawStateSchema: mocks.policy,
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  openClawStateDatabaseCache: { closeOpenClawStateDatabaseHandle: mocks.closeHandle },
}));

import {
  openOpenClawStateReadConnection as openConnection,
  readOpenClawStateReadOnlyLocation as readLocation,
  withOpenClawStateReadOnlyLocation as withLocation,
} from "./openclaw-state-db-read-connection.js";

const pathname = "/fixture/state.sqlite";
const expectedIdentity = "file:1:2";
const cleanupMessage = "Shared-state snapshot cleanup is incomplete.";
const value = () => "value";
const failWith = (error: Error) => () => {
  throw error;
};

function caught(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected an exception");
}

function readPrivate(prepared: ReturnType<typeof snapshot>, identity?: string) {
  return readLocation(value, pathname, prepared, undefined, identity, "/fixture");
}

function expectAggregate(error: unknown, primary: Error, cleanup: unknown) {
  expect(error).toBeInstanceOf(AggregateError);
  expect(error).toMatchObject({ cause: primary, errors: [primary, cleanup] });
}

beforeEach(() => {
  for (const mock of [mocks.identity, mocks.schema, mocks.policy, mocks.releaseToken]) {
    mock.mockReset();
  }
  mocks.policy.mockReturnValue(false);
  mocks.acquireToken.mockClear();
  mocks.db = { isOpen: true, close: vi.fn<() => void>() };
  mocks.openTracked.mockReset().mockImplementation(() => mocks.db);
  mocks.openPrivate.mockReset().mockImplementation(() => mocks.db);
  mocks.db.close.mockImplementation(() => {
    mocks.db.isOpen = false;
  });
  mocks.closeHandle.mockReset().mockImplementation((owner) => {
    try {
      owner.db.close();
      owner.afterClose();
      return [];
    } catch (error) {
      return [error];
    }
  });
});

it.each([
  "schema",
  "query",
  "policy",
  "handle policy",
  "admission",
  "admission cleanup",
  "native cleanup",
])("settles a %s failure only after releasing native custody", (phase) => {
  const failure = new Error(`${phase} failed`);
  const fail = failWith(failure);
  const configure: Partial<Record<typeof phase, () => unknown>> = {
    schema: () => mocks.schema.mockImplementation(fail),
    policy: () => mocks.policy.mockImplementation(fail),
    "handle policy": () => mocks.policy.mockReturnValueOnce(false).mockImplementationOnce(fail),
    "native cleanup": () => mocks.db.close.mockImplementation(fail),
  };
  configure[phase]?.();
  const read = phase === "query" ? fail : value;
  const admission =
    phase === "admission" ? fail : phase === "admission cleanup" ? () => fail : undefined;
  const run = () => readLocation(read, pathname, pathname, admission);
  const unavailable = phase === "schema" || phase === "query";
  if (unavailable) {
    expect(run()).toEqual({ status: "unavailable", error: failure });
  } else {
    expect(run).toThrow(failure);
  }
  expect(mocks.closeHandle).toHaveBeenCalledTimes(phase === "policy" ? 0 : 1);
  if (phase === "policy") {
    expect(mocks.openTracked).not.toHaveBeenCalled();
  } else {
    expect(mocks.db.isOpen).toBe(phase === "native cleanup");
  }
  if (unavailable) {
    mocks.db.isOpen = true;
    expect(() => withLocation(read, pathname, pathname)).toThrow(failure);
  }
});

function snapshot(cleaned = true) {
  return {
    location: "/fixture/private.sqlite",
    cleanup: vi.fn(() => cleaned),
    cleanupAsync: async () => true,
  };
}

it.each([false, true])("rejects incomplete snapshot cleanup (query failed: %s)", (queryFailed) => {
  const failure = new Error("query failed");
  const prepared = snapshot(false);
  const read = queryFailed ? failWith(failure) : value;
  if (queryFailed) {
    expectAggregate(
      caught(() => readLocation(read, pathname, prepared)),
      failure,
      expect.objectContaining({ message: cleanupMessage }),
    );
  } else {
    expect(() => withLocation(read, pathname, prepared)).toThrow(cleanupMessage);
  }
  expect(mocks.db.isOpen).toBe(false);
  expect(prepared.cleanup).toHaveBeenCalledOnce();
});

it.each([
  "private policy",
  "private identity",
  "private token",
  "native pre-open identity",
  "native post-open identity",
  "native identity and close",
])("releases only acquired resources after %s refusal", (phase) => {
  const primary = new Error("reader admission refused");
  const cleanup = new Error("native reader close failed");
  const fail = failWith(primary);
  const privateSource = phase.startsWith("private");
  const afterOpen = phase === "native post-open identity" || phase === "native identity and close";
  const closeFailed = phase === "native identity and close";
  const nativeClose = mocks.db.close;
  if (phase === "private policy") {
    mocks.policy.mockImplementation(fail);
  } else if (phase === "private token") {
    mocks.acquireToken.mockImplementationOnce(fail);
  } else if (afterOpen) {
    mocks.identity.mockImplementationOnce(() => {}).mockImplementationOnce(fail);
  } else {
    mocks.identity.mockImplementation(fail);
  }
  if (closeFailed) {
    mocks.db.close.mockImplementation(failWith(cleanup));
  }
  const prepared = snapshot();
  const failure = caught(() =>
    privateSource
      ? readPrivate(prepared, expectedIdentity)
      : openConnection(pathname, pathname, expectedIdentity),
  );
  if (closeFailed) {
    expectAggregate(failure, primary, cleanup);
  } else {
    expect(failure).toBe(primary);
  }
  expect(mocks.openPrivate).not.toHaveBeenCalled();
  expect(mocks.openTracked).toHaveBeenCalledTimes(afterOpen ? 1 : 0);
  expect(mocks.closeHandle).toHaveBeenCalledTimes(afterOpen ? 1 : 0);
  if (privateSource) {
    expect(prepared.cleanup).toHaveBeenCalledOnce();
  } else {
    expect(mocks.identity).toHaveBeenCalledWith(pathname, expectedIdentity);
  }
  if (afterOpen) {
    expect(mocks.closeHandle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ db: mocks.db, path: pathname }),
    );
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(mocks.db.isOpen).toBe(closeFailed);
  }
});

it.each(["clean", "token failure", "incomplete snapshot"])(
  "preserves private open failure with %s cleanup",
  (cleanupKind) => {
    const primary = new Error("private native database open failed");
    const tokenFailure = new Error("private reader token close failed");
    mocks.openPrivate.mockImplementationOnce(failWith(primary));
    if (cleanupKind === "token failure") {
      mocks.releaseToken.mockImplementationOnce(failWith(tokenFailure));
    }
    const prepared = snapshot(cleanupKind !== "incomplete snapshot");
    if (cleanupKind === "clean") {
      expect(readPrivate(prepared)).toEqual({ status: "unavailable", error: primary });
    } else {
      const failure = caught(() =>
        openConnection(
          pathname,
          prepared,
          undefined,
          cleanupKind === "token failure" ? "/fixture" : undefined,
        ),
      );
      expectAggregate(
        failure,
        primary,
        cleanupKind === "token failure"
          ? tokenFailure
          : expect.objectContaining({ message: cleanupMessage }),
      );
    }
    if (cleanupKind !== "incomplete snapshot") {
      expect(mocks.acquireToken).toHaveBeenCalledExactlyOnceWith("/fixture");
      expect(mocks.releaseToken).toHaveBeenCalledOnce();
    }
    expect(mocks.openPrivate).toHaveBeenCalledOnce();
    expect(prepared.cleanup).toHaveBeenCalledOnce();
    expect(mocks.closeHandle).not.toHaveBeenCalled();
  },
);
