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
vi.mock("../infra/sqlite-schema-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-schema-facts.js")>()),
  admitSqliteSchema: vi.fn(),
}));
vi.mock("./openclaw-state-db-handle.js", () => ({
  openTrackedStateDatabaseResult: () => ({ status: "available", database: mocks.openTracked() }),
}));
vi.mock("./openclaw-state-db-schema-version.js", () => ({
  assertSupportedStateSchemaVersion: mocks.schema,
}));
vi.mock("./openclaw-state-db-schema-policy.js", () => ({
  isExistingOpenClawStateSchema: mocks.policy,
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  openClawStateDatabaseCache: { closeOpenClawStateDatabaseHandle: mocks.closeHandle },
}));

import {
  openOpenClawStateReadConnection,
  readOpenClawStateReadOnlyLocation,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";

const pathname = "/fixture/state.sqlite";
const expectedIdentity = "file:1:2";

beforeEach(() => {
  mocks.identity.mockReset();
  mocks.schema.mockReset();
  mocks.policy.mockReset().mockReturnValue(false);
  mocks.acquireToken.mockClear();
  mocks.releaseToken.mockReset();
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
  const fail = () => {
    throw failure;
  };
  if (phase === "schema") {
    mocks.schema.mockImplementation(fail);
  }
  if (phase === "policy") {
    mocks.policy.mockImplementation(fail);
  }
  if (phase === "handle policy") {
    mocks.policy.mockReturnValueOnce(false).mockImplementationOnce(fail);
  }
  if (phase === "native cleanup") {
    mocks.db.close.mockImplementation(fail);
  }
  const read = phase === "query" ? fail : () => "value";
  const admission =
    phase === "admission" ? fail : phase === "admission cleanup" ? () => fail : undefined;
  const run = () => readOpenClawStateReadOnlyLocation(read, pathname, pathname, admission);
  const unavailable = phase === "schema" || phase === "query";
  if (unavailable) {
    expect(run()).toEqual({ status: "unavailable", error: failure });
  } else {
    expect(run).toThrow(failure);
  }
  if (phase === "policy") {
    expect(mocks.openTracked).not.toHaveBeenCalled();
    expect(mocks.closeHandle).not.toHaveBeenCalled();
  } else {
    expect(mocks.closeHandle).toHaveBeenCalledOnce();
    expect(mocks.db.isOpen).toBe(phase === "native cleanup");
  }
  if (unavailable) {
    mocks.db.isOpen = true;
    expect(() => withOpenClawStateReadOnlyLocation(read, pathname, pathname)).toThrow(failure);
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
  const read = () => {
    if (queryFailed) {
      throw failure;
    }
    return "read";
  };
  if (queryFailed) {
    let caught: unknown;
    try {
      readOpenClawStateReadOnlyLocation(read, pathname, prepared);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      cause: failure,
      errors: [
        failure,
        expect.objectContaining({ message: "Shared-state snapshot cleanup is incomplete." }),
      ],
    });
  } else {
    expect(() => withOpenClawStateReadOnlyLocation(read, pathname, prepared)).toThrow(
      "Shared-state snapshot cleanup is incomplete.",
    );
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
  const fail = () => {
    throw primary;
  };
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
    mocks.db.close.mockImplementation(() => {
      throw cleanup;
    });
  }
  const prepared = snapshot();
  let failure: unknown;
  try {
    if (privateSource) {
      readOpenClawStateReadOnlyLocation(
        () => "read",
        pathname,
        prepared,
        undefined,
        expectedIdentity,
        "/fixture",
      );
    } else {
      openOpenClawStateReadConnection(pathname, pathname, expectedIdentity);
    }
  } catch (error) {
    failure = error;
  }
  if (closeFailed) {
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ cause: primary, errors: [primary, cleanup] });
  } else {
    expect(failure).toBe(primary);
  }
  expect(mocks.openPrivate).not.toHaveBeenCalled();
  if (privateSource) {
    expect(prepared.cleanup).toHaveBeenCalledOnce();
  } else {
    expect(mocks.identity).toHaveBeenCalledWith(pathname, expectedIdentity);
  }
  if (afterOpen) {
    expect(mocks.openTracked).toHaveBeenCalledOnce();
    expect(mocks.closeHandle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ db: mocks.db, path: pathname }),
    );
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(mocks.db.isOpen).toBe(closeFailed);
  } else {
    expect(mocks.openTracked).not.toHaveBeenCalled();
    expect(mocks.closeHandle).not.toHaveBeenCalled();
  }
});

it.each(["clean", "token failure", "incomplete snapshot"])(
  "preserves private open failure with %s cleanup",
  (cleanupKind) => {
    const primary = new Error("private native database open failed");
    const tokenFailure = new Error("private reader token close failed");
    mocks.openPrivate.mockImplementationOnce(() => {
      throw primary;
    });
    if (cleanupKind === "token failure") {
      mocks.releaseToken.mockImplementationOnce(() => {
        throw tokenFailure;
      });
    }
    const prepared = snapshot(cleanupKind !== "incomplete snapshot");
    if (cleanupKind === "clean") {
      expect(
        readOpenClawStateReadOnlyLocation(
          () => "value",
          pathname,
          prepared,
          undefined,
          undefined,
          "/fixture",
        ),
      ).toEqual({ status: "unavailable", error: primary });
    } else {
      let failure: unknown;
      try {
        openOpenClawStateReadConnection(
          pathname,
          prepared,
          undefined,
          cleanupKind === "token failure" ? "/fixture" : undefined,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        cause: primary,
        errors: [
          primary,
          cleanupKind === "token failure"
            ? tokenFailure
            : expect.objectContaining({ message: "Shared-state snapshot cleanup is incomplete." }),
        ],
      });
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
