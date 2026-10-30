import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const database = { isOpen: true, close: vi.fn<() => void>() };
  return {
    database,
    admit: vi.fn<() => void>(),
    open: vi.fn(() => database),
  };
});
vi.mock("../infra/gateway-state-owner.js", () => ({
  assertStateDatabaseAccessAllowed: mocks.admit,
}));
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: mocks.open,
  resolveExistingSqliteFileUri: (path: string) => path,
}));

import {
  openTrackedStateDatabase,
  openTrackedStateDatabaseResult,
} from "./openclaw-state-db-handle.js";

beforeEach(() => {
  mocks.admit.mockReset();
  mocks.open.mockReset().mockReturnValue(mocks.database);
  mocks.database.isOpen = true;
  mocks.database.close.mockReset().mockImplementation(() => {
    mocks.database.isOpen = false;
  });
});

it("reports native open failures without treating maintenance refusal as absence", () => {
  const failure = new Error("native open failed");
  mocks.open.mockImplementation(() => {
    throw failure;
  });
  expect(openTrackedStateDatabaseResult("/fixture/state.sqlite", { readOnly: true })).toEqual({
    status: "unavailable",
    error: failure,
  });
  expect(() => openTrackedStateDatabase("/fixture/state.sqlite")).toThrow(failure);
});

it("keeps maintenance admission failure exceptional before native opening", () => {
  const failure = new Error("maintenance owns this state");
  mocks.admit.mockImplementation(() => {
    throw failure;
  });
  expect(() => openTrackedStateDatabaseResult("/fixture/state.sqlite", { readOnly: true })).toThrow(
    failure,
  );
  expect(mocks.open).not.toHaveBeenCalled();
});
