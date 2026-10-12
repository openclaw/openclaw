import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import {
  closeRetainedOpenClawStateReadConnections,
  prepareOpenClawStateDirectReader,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

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
  return { root, pathname, read, value };
}

it.each(["pooled", "direct"] as const)(
  "settles nested readers without closing the %s caller's retained handle",
  (mode) => {
    const { read, value, pathname, root } = fixture();
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
    if (mode === "direct") {
      prepareOpenClawStateDirectReader(
        captureOpenClawStateWorkerContext({ path: pathname, env: { OPENCLAW_STATE_DIR: root } }),
      ).read(operation);
    } else {
      read(operation);
    }
    expect(value()).toBe(1);
  },
);
