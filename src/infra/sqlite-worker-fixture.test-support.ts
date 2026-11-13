import fs from "node:fs";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOpenInput, FixtureOperations } from "./sqlite-worker-store.test-support.js";

type Store = SqliteWorkerStore<FixtureOperations>;

export function useSqliteWorkerStoreFixture(prefix: string, beforeClose?: () => void) {
  const stores = new Set<Store>();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      beforeClose?.();
      try {
        await Promise.all([...stores].map((store) => store.close()));
      } finally {
        stores.clear();
        cleanup();
      }
    }),
  );
  return {
    stores,
    tempDirs,
    databasePath: () => path.join(tempDirs.make(prefix), "store.sqlite"),
    open: async (databasePath: string, input?: FixtureOpenInput) => {
      const store = await openSqliteWorkerStore<FixtureOperations>({
        moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath,
        input,
      });
      stores.add(store);
      return store;
    },
  };
}

export function appendWorkerRow(store: Store, value: string, signal?: AbortSignal) {
  return store.execute({ type: "append", input: { value } }, { signal });
}

export function readWorkerRows(store: Store) {
  return store.execute({ type: "read", input: undefined });
}

type OpenCallback = Parameters<typeof fs.open>[1];
export type SqliteFixtureOpenArguments =
  | [file: fs.PathLike, callback: OpenCallback]
  | [file: fs.PathLike, flags: fs.OpenMode | undefined, callback: OpenCallback]
  | [
      file: fs.PathLike,
      flags: fs.OpenMode | undefined,
      mode: fs.Mode | undefined | null,
      callback: OpenCallback,
    ];

// Hold the actual successful OS creation callback while its native owner settles.
export function holdCreatedFileCallback(pathname: string) {
  const entered = createDeferredCore();
  let descriptor: number | undefined;
  let released = false;
  let resume: (() => void) | undefined;
  const open = fs.open;
  const interception = vi
    .spyOn(fs, "open")
    .mockImplementation((...args: SqliteFixtureOpenArguments) => {
      if (args.length === 2) {
        return open(...args);
      }
      if (args.length === 3) {
        return open(...args);
      }
      const [file, flags, mode, callback] = args;
      if (String(file) !== pathname || flags !== "wx") {
        return open(file, flags, mode, callback);
      }
      return open(file, flags, mode, (error, fd) => {
        if (error || released) {
          callback(error, fd);
          return;
        }
        descriptor = fd;
        resume = () => callback(null, fd);
        entered.resolve();
      });
    });
  const release = () => {
    released = true;
    const complete = resume;
    resume = undefined;
    complete?.();
  };
  return {
    entered: entered.promise,
    get descriptor() {
      return descriptor;
    },
    release,
    [Symbol.dispose]() {
      release();
      interception.mockRestore();
    },
  };
}
