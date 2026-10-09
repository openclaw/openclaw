import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  borrowOpenClawStateDatabaseForAsyncRead,
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseByPath,
} from "./openclaw-state-db-cache.js";
import * as stateOpen from "./openclaw-state-db-open.js";
import {
  withDisposableOpenClawStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveLeaseDatabasePath } from "./openclaw-state-lease-storage.js";
import { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    cleanup();
  });
});

it.each([String.raw`C:\OpenClaw`, String.raw`\\Server\Share\OpenClaw`])(
  "shares the native writer and admission across Windows spellings under %s",
  async (windowsRoot) => {
    const hostPlatform = process.platform;
    const root = tempDirs.make("openclaw-shared-windows-alias-");
    const env = { OPENCLAW_STATE_DIR: root };
    const physical = openOpenClawStateDatabase({ env }).path;
    await closeOpenClawStateDatabaseAsync();
    const ordinary = path.win32.join(windowsRoot, "state", "openclaw.sqlite");
    const namespaced = path.win32.toNamespacedPath(ordinary);
    const spellings = new Set([ordinary, namespaced]);

    // Keep SQLite and the cache real; these exact synthetic locators refer to one host file.
    const nativePath = (value: unknown) => (spellings.has(String(value)) ? physical : value);
    const resolve = path.resolve;
    const win32Resolve = path.win32.resolve;
    vi.spyOn(path, "resolve").mockImplementation((...segments) =>
      segments.some((segment) => spellings.has(segment))
        ? win32Resolve(...segments)
        : resolve(...segments),
    );
    const stat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((...args) =>
      Reflect.apply(stat, fs, [nativePath(args[0]), ...args.slice(1)]),
    );
    const realpath = fs.realpathSync.native;
    vi.spyOn(fs.realpathSync, "native").mockImplementation((...args) =>
      Reflect.apply(realpath, fs.realpathSync, [nativePath(args[0]), ...args.slice(1)]),
    );
    const open = stateOpen.openUnpublishedStateDatabase;
    const fileUri = nodeSqlite.resolveExistingSqliteFileUri;
    vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((pathname, platform) =>
      fileUri(pathname, pathname === physical ? hostPlatform : platform),
    );
    vi.spyOn(stateOpen, "openUnpublishedStateDatabase").mockImplementation((params) => ({
      ...open({ ...params, pathname: physical }),
      path: params.pathname,
    }));
    vi.spyOn(os, "homedir").mockReturnValue(root);
    mockProcessPlatform("win32");
    syncBuiltinESMExports();

    const first = openOpenClawStateDatabase({ env, path: namespaced });
    const second = openOpenClawStateDatabase({ env, path: ordinary });
    expect(second.db).toBe(first.db);
    expect(
      resolveLeaseDatabasePath({
        scope: "shared",
        schemaPolicy: "existing",
        options: { path: namespaced },
      }),
    ).toBe(first.path);
    expect(captureOpenClawStateDatabaseReadAdmission(namespaced)).toBe(
      captureOpenClawStateDatabaseReadAdmission(ordinary),
    );
    expect(isOpenClawStateDatabaseOpen(namespaced)).toBe(true);
    const borrow = borrowOpenClawStateDatabaseForAsyncRead(namespaced);
    expect(borrow?.database.db).toBe(first.db);
    borrow?.release();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        runOpenClawStateWriteTransaction(({ db: nested }) => expect(nested).toBe(db), {
          env,
          path: ordinary,
        });
      },
      { env, path: namespaced },
    );
    withExistingOpenClawStateSchema({ path: namespaced }, () => {
      const context = captureOpenClawStateReadWorkerContext({ env, path: namespaced });
      withExistingOpenClawStateSchema({ path: ordinary }, () => {
        expect(
          captureOpenClawStateReadWorkerContext({ env, path: ordinary }).existingSchemaPath,
        ).toBe(context.existingSchemaPath);
        expect(context.existingSchemaPath).toBe(first.path);
      });
    });
    const closedReadScope = await withDisposableOpenClawStateReads(namespaced, async () =>
      AsyncLocalStorage.snapshot(),
    );
    expect(() =>
      closedReadScope(() =>
        withExistingOpenClawStateDatabaseReadOnly(() => undefined, { env, path: ordinary }),
      ),
    ).toThrow("Shared-state read scope is closing or closed");
    expect(closeOpenClawStateDatabaseByPath(namespaced)).toBe(true);
    expect(isOpenClawStateDatabaseOpen(ordinary)).toBe(false);
  },
);
