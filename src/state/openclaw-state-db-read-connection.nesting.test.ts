import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import {
  closeRetainedOpenClawStateReadConnections,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    closeRetainedOpenClawStateReadConnections();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function fixture() {
  const root = tempDirs.make("openclaw-nested-state-reader-");
  const pathname = path.join(root, "state.sqlite");
  const seed = openNodeSqliteDatabase(pathname);
  seed.exec("CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (1)");
  seed.close();
  const read = <T>(operation: (database: OpenClawStateReadOnlyDatabase) => T) =>
    withOpenClawStateReadOnlyLocation(
      operation,
      pathname,
      pathname,
      undefined,
      undefined,
      undefined,
      true,
    );
  const value = () => read(({ db }) => db.prepare("SELECT value FROM sample").get()?.value);
  return { read, value };
}

it("settles nested readers without closing the caller's retained handle", () => {
  const { read, value } = fixture();
  const operation = ({ db }: OpenClawStateReadOnlyDatabase) => {
    const nestedReaders: OpenClawStateReadOnlyDatabase["db"][] = [];
    expect(
      read(({ db: nested }) => {
        nestedReaders.push(nested);
        return nested.prepare("SELECT value FROM sample").get()?.value;
      }),
    ).toBe(1);
    expect(() =>
      read(({ db: nested }) => {
        nestedReaders.push(nested);
        throw new Error("nested read failed");
      }),
    ).toThrow("nested read failed");
    expect(db.prepare("SELECT value FROM sample").get()?.value).toBe(1);
    expect(nestedReaders.map((nested) => nested.isOpen)).toEqual([false, false]);
  };
  read(operation);
  expect(value()).toBe(1);
});
