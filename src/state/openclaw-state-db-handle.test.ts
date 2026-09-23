import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const release = vi.fn<() => void>();
  const database = { isOpen: true, close: vi.fn<() => void>() };
  return {
    release,
    database,
    acquire: vi.fn(() => ({ release })),
    open: vi.fn(() => database),
  };
});
vi.mock("../infra/state-database-coordinator.js", () => ({
  acquireStateDatabaseHandleLease: mocks.acquire,
}));
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: mocks.open,
  resolveExistingSqliteFileUri: (path: string) => path,
}));

import {
  closeTrackedStateDatabase,
  openTrackedStateDatabase,
  openTrackedStateDatabaseResult,
} from "./openclaw-state-db-handle.js";

beforeEach(() => {
  mocks.release.mockReset();
  mocks.acquire.mockReset().mockReturnValue({ release: mocks.release });
  mocks.open.mockReset().mockReturnValue(mocks.database);
  mocks.database.isOpen = true;
  mocks.database.close.mockReset().mockImplementation(() => {
    mocks.database.isOpen = false;
  });
});

it("reports a native open failure only after releasing its handle lease", () => {
  const failure = new Error("native open failed");
  mocks.open.mockImplementation(() => {
    throw failure;
  });
  expect(openTrackedStateDatabaseResult("/fixture/state.sqlite", { readOnly: true })).toEqual({
    status: "unavailable",
    error: failure,
  });
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(() => openTrackedStateDatabase("/fixture/state.sqlite")).toThrow(failure);
});

it.each(["acquire", "release"])("keeps lease %s failure exceptional", (phase) => {
  const failure = new Error(`lease ${phase} failed`);
  if (phase === "acquire") {
    mocks.acquire.mockImplementation(() => {
      throw failure;
    });
  } else {
    mocks.open.mockImplementation(() => {
      throw new Error("native open failed");
    });
    mocks.release.mockImplementation(() => {
      throw failure;
    });
  }
  expect(() => openTrackedStateDatabaseResult("/fixture/state.sqlite", { readOnly: true })).toThrow(
    failure,
  );
  if (phase === "acquire") {
    expect(mocks.open).not.toHaveBeenCalled();
  }
});

it("holds the successful reader lease through failed native close and releases it on retry", () => {
  const result = openTrackedStateDatabaseResult("/fixture/state.sqlite", { readOnly: true });
  expect(result.status).toBe("available");
  if (result.status !== "available") {
    throw new Error("Expected an opened native reader");
  }
  mocks.database.close.mockImplementationOnce(() => {
    throw new Error("close failed");
  });
  expect(() => closeTrackedStateDatabase(result.database)).toThrow("close failed");
  expect(mocks.release).not.toHaveBeenCalled();
  closeTrackedStateDatabase(result.database);
  expect(mocks.release).toHaveBeenCalledOnce();
});
