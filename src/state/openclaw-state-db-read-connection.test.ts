import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = { isOpen: true, close: vi.fn<() => void>() };
  const releaseToken = vi.fn<() => void>();
  return {
    db,
    releaseToken,
    acquireToken: vi.fn(() => releaseToken),
    identity: vi.fn<(location: string, expected: string) => void>(),
    openTracked: vi.fn(() => db),
    openPrivate: vi.fn(() => db),
    closeHandle: vi.fn<(owner: { db: typeof db; afterClose: () => void }) => unknown[]>(),
    schema: vi.fn<() => void>(),
    policy: vi.fn(() => false),
  };
});

vi.mock("../infra/sqlite-snapshot-staging.js", () => ({
  acquireSqliteSnapshotReadToken: mocks.acquireToken,
}));
vi.mock("../infra/sqlite-worker-identity.js", () => ({
  assertExistingDatabaseIdentity: mocks.identity,
}));
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: mocks.openPrivate,
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
  mocks.openTracked.mockClear();
  mocks.openPrivate.mockClear();
  mocks.db.isOpen = true;
  mocks.db.close.mockReset().mockImplementation(() => {
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

it.each(["schema", "query"])("certifies a %s failure only after native cleanup", (phase) => {
  const failure = new Error(`${phase} failed`);
  const read = () => {
    if (phase === "query") {
      throw failure;
    }
    return "value";
  };
  if (phase === "schema") {
    mocks.schema.mockImplementation(() => {
      throw failure;
    });
  }
  expect(readOpenClawStateReadOnlyLocation(read, pathname, pathname)).toEqual({
    status: "unavailable",
    error: failure,
  });
  expect(mocks.db.isOpen).toBe(false);
  expect(mocks.closeHandle).toHaveBeenCalledOnce();
  mocks.db.isOpen = true;
  expect(() => withOpenClawStateReadOnlyLocation(read, pathname, pathname)).toThrow(failure);
});

it.each(["policy", "handle policy", "admission", "admission cleanup", "native cleanup"])(
  "preserves a sole %s failure instead of certifying ordinary unavailability",
  (phase) => {
    const failure = new Error(`${phase} failed`);
    const fail = () => {
      throw failure;
    };
    if (phase === "policy") {
      mocks.policy.mockImplementation(fail);
    }
    if (phase === "handle policy") {
      mocks.policy.mockReturnValueOnce(false).mockImplementationOnce(fail);
    }
    if (phase === "native cleanup") {
      mocks.db.close.mockImplementation(fail);
    }
    const admission =
      phase === "admission" ? fail : phase === "admission cleanup" ? () => fail : undefined;
    expect(() =>
      readOpenClawStateReadOnlyLocation(() => "value", pathname, pathname, admission),
    ).toThrow(failure);
    if (phase === "policy") {
      expect(mocks.openTracked).not.toHaveBeenCalled();
      expect(mocks.closeHandle).not.toHaveBeenCalled();
    } else {
      expect(mocks.closeHandle).toHaveBeenCalledOnce();
      expect(mocks.db.isOpen).toBe(phase === "native cleanup");
    }
  },
);

it("does not turn a failed read into availability while snapshot cleanup needs retry", () => {
  const failure = new Error("query failed");
  const snapshot = {
    location: "/fixture/private.sqlite",
    cleanup: vi.fn(() => false),
    cleanupAsync: async () => true,
  };
  let caught: unknown;
  try {
    readOpenClawStateReadOnlyLocation(
      () => {
        throw failure;
      },
      pathname,
      snapshot,
    );
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
  expect(mocks.db.isOpen).toBe(false);
  expect(snapshot.cleanup).toHaveBeenCalledOnce();
});

it("rejects incomplete snapshot cleanup after a successful read", () => {
  const snapshot = {
    location: "/fixture/private.sqlite",
    cleanup: () => false,
    cleanupAsync: async () => true,
  };
  expect(() => withOpenClawStateReadOnlyLocation(() => "read", pathname, snapshot)).toThrow(
    "Shared-state snapshot cleanup is incomplete.",
  );
});

it.each(["policy", "identity", "token"])(
  "cleans prepared source bytes after a pre-open %s refusal",
  (phase) => {
    const failure = new Error(`${phase} refused`);
    const fail = () => {
      throw failure;
    };
    if (phase === "policy") {
      mocks.policy.mockImplementation(fail);
    }
    if (phase === "identity") {
      mocks.identity.mockImplementation(fail);
    }
    if (phase === "token") {
      mocks.acquireToken.mockImplementationOnce(fail);
    }
    const snapshot = {
      location: "/fixture/private.sqlite",
      cleanup: vi.fn(() => true),
      cleanupAsync: async () => true,
    };
    expect(() =>
      readOpenClawStateReadOnlyLocation(
        () => "read",
        pathname,
        snapshot,
        undefined,
        expectedIdentity,
        "/fixture",
      ),
    ).toThrow(failure);
    expect(snapshot.cleanup).toHaveBeenCalledOnce();
    expect(mocks.openPrivate).not.toHaveBeenCalled();
  },
);

it("certifies a private open failure only after its token and snapshot are released", () => {
  const failure = new Error("native open failed");
  mocks.openPrivate.mockImplementationOnce(() => {
    throw failure;
  });
  const snapshot = {
    location: "/fixture/private.sqlite",
    cleanup: vi.fn(() => true),
    cleanupAsync: async () => true,
  };
  expect(
    readOpenClawStateReadOnlyLocation(
      () => "value",
      pathname,
      snapshot,
      undefined,
      undefined,
      "/fixture",
    ),
  ).toEqual({ status: "unavailable", error: failure });
  expect(mocks.releaseToken).toHaveBeenCalledOnce();
  expect(snapshot.cleanup).toHaveBeenCalledOnce();
});

it("refuses a changed physical identity before opening a native reader", () => {
  const primary = new Error("SQLite file identity changed");
  mocks.identity.mockImplementation(() => {
    throw primary;
  });

  expect(() => openOpenClawStateReadConnection(pathname, pathname, expectedIdentity)).toThrow(
    primary,
  );
  expect(mocks.identity).toHaveBeenCalledWith(pathname, expectedIdentity);
  expect(mocks.openTracked).not.toHaveBeenCalled();
  expect(mocks.openPrivate).not.toHaveBeenCalled();
  expect(mocks.closeHandle).not.toHaveBeenCalled();
});

it("closes the opened reader before reporting a post-open identity change", () => {
  const primary = new Error("SQLite file identity changed after open");
  mocks.identity
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw primary;
    });

  expect(() => openOpenClawStateReadConnection(pathname, pathname, expectedIdentity)).toThrow(
    primary,
  );
  expect(mocks.openTracked).toHaveBeenCalledOnce();
  expect(mocks.closeHandle).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ db: mocks.db, path: pathname }),
  );
  expect(mocks.db.close).toHaveBeenCalledOnce();
  expect(mocks.db.isOpen).toBe(false);
});

it("preserves identity and close failures from a still-open native reader", () => {
  const primary = new Error("SQLite file identity changed after open");
  const cleanup = new Error("native reader close failed");
  mocks.identity
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw primary;
    });
  mocks.db.close.mockImplementation(() => {
    throw cleanup;
  });

  let failure: unknown;
  try {
    openOpenClawStateReadConnection(pathname, pathname, expectedIdentity);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({ cause: primary, errors: [primary, cleanup] });
  expect(mocks.identity).toHaveBeenCalledWith(pathname, expectedIdentity);
  expect(mocks.openTracked).toHaveBeenCalledOnce();
  expect(mocks.closeHandle).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ db: mocks.db, path: pathname }),
  );
  expect(mocks.db.isOpen).toBe(true);
});

it("preserves a native open failure and token cleanup failure while cleaning its snapshot", () => {
  const primary = new Error("private native database open failed");
  const tokenFailure = new Error("private reader token close failed");
  mocks.openPrivate.mockImplementationOnce(() => {
    throw primary;
  });
  mocks.releaseToken.mockImplementationOnce(() => {
    throw tokenFailure;
  });
  const snapshot = {
    location: "/fixture/snapshot/database.sqlite",
    cleanup: vi.fn(() => true),
    cleanupAsync: async () => true,
  };
  let failure: unknown;
  try {
    openOpenClawStateReadConnection(pathname, snapshot, undefined, "/fixture/snapshot");
  } catch (error) {
    failure = error;
  }
  expect(mocks.acquireToken).toHaveBeenCalledExactlyOnceWith("/fixture/snapshot");
  expect(mocks.openPrivate).toHaveBeenCalledOnce();
  expect(mocks.releaseToken).toHaveBeenCalledOnce();
  expect(snapshot.cleanup).toHaveBeenCalledOnce();
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({ cause: primary, errors: [primary, tokenFailure] });
  expect(mocks.closeHandle).not.toHaveBeenCalled();
});

it("reports incomplete snapshot cleanup alongside the native open failure", () => {
  const primary = new Error("private native database open failed");
  mocks.openPrivate.mockImplementationOnce(() => {
    throw primary;
  });
  const snapshot = {
    location: "/fixture/snapshot/database.sqlite",
    cleanup: vi.fn(() => false),
    cleanupAsync: async () => true,
  };
  let failure: unknown;
  try {
    openOpenClawStateReadConnection(pathname, snapshot);
  } catch (error) {
    failure = error;
  }
  expect(snapshot.cleanup).toHaveBeenCalledOnce();
  expect(failure).toMatchObject({
    cause: primary,
    errors: [
      primary,
      expect.objectContaining({ message: "Shared-state snapshot cleanup is incomplete." }),
    ],
  });
});
