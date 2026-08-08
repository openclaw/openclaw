// Shared-state read-only opener tests cover descriptor mode and schema refusal behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  close: vi.fn(),
  openNodeSqliteDatabase: vi.fn(),
  userVersion: 0,
}));

vi.mock("../infra/node-sqlite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/node-sqlite.js")>()),
  openNodeSqliteDatabase: (...args: unknown[]) => mocks.openNodeSqliteDatabase(...args),
}));

const { withExistingCurrentOpenClawStateDatabaseReadOnly } =
  await import("./openclaw-state-db-readonly.js");

describe("current shared-state read-only opener", () => {
  let root: string;
  let databasePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-ro-"));
    databasePath = path.join(root, "openclaw.sqlite");
    mocks.userVersion = OPENCLAW_STATE_SCHEMA_VERSION;
    mocks.exec.mockReset();
    mocks.close.mockReset();
    mocks.openNodeSqliteDatabase.mockReset();
    mocks.openNodeSqliteDatabase.mockReturnValue({
      close: mocks.close,
      exec: mocks.exec,
      isTransaction: false,
      prepare: vi.fn(() => ({
        get: () => ({ user_version: mocks.userVersion }),
      })),
    });
  });

  afterEach(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  it("does not create a database when shared state is absent", () => {
    const operation = vi.fn();

    expect(
      withExistingCurrentOpenClawStateDatabaseReadOnly(operation, { path: databasePath }),
    ).toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
    expect(mocks.openNodeSqliteDatabase).not.toHaveBeenCalled();
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("opens an existing current database with a read-only descriptor and no migration writes", () => {
    fs.writeFileSync(databasePath, "sqlite-placeholder");

    expect(
      withExistingCurrentOpenClawStateDatabaseReadOnly(({ path: openedPath }) => openedPath, {
        path: databasePath,
      }),
    ).toBe(path.resolve(databasePath));
    expect(mocks.openNodeSqliteDatabase).toHaveBeenCalledWith(path.resolve(databasePath), {
      readOnly: true,
    });
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec.mock.calls[0]?.[0]).toMatch(/^PRAGMA busy_timeout = /u);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("refuses an older schema with a migration instruction instead of upgrading it", () => {
    fs.writeFileSync(databasePath, "sqlite-placeholder");
    mocks.userVersion = OPENCLAW_STATE_SCHEMA_VERSION - 1;

    expect(() =>
      withExistingCurrentOpenClawStateDatabaseReadOnly(() => "unreachable", {
        path: databasePath,
      }),
    ).toThrow(
      `uses older schema version ${OPENCLAW_STATE_SCHEMA_VERSION - 1}; this read-only command requires ${OPENCLAW_STATE_SCHEMA_VERSION} and will not migrate it. Start the gateway or run openclaw doctor --fix`,
    );
    expect(mocks.openNodeSqliteDatabase).toHaveBeenCalledWith(path.resolve(databasePath), {
      readOnly: true,
    });
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
