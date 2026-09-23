import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32")(
  "admits a legacy parent through an aliased lease path without changing its row",
  async () => {
    const root = fs.realpathSync(dirs.make("legacy-lease-path-"));
    const temporary = path.join(root, "private-tmp");
    fs.mkdirSync(temporary, { mode: 0o700 });
    const location = vi
      .spyOn(tempRoot, "resolvePreferredOpenClawTmpDir")
      .mockReturnValue(temporary);
    const parent = createManagedHandoffLeaseStore().processIdentity(process.ppid);
    const databasePath = path.join(temporary, "managed-update-handoffs.sqlite");
    const original = {
      install_root: root,
      owner: randomUUID(),
      payload_json: JSON.stringify({ version: 1, ...parent }),
      updated_at: 7,
    };
    createManagedHandoffLeaseDatabase(databasePath)(true, (db) => {
      db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
        original.install_root,
        original.owner,
        original.payload_json,
        original.updated_at,
      );
    });
    const identity = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
    const alias = path.join(dirs.make("legacy-lease-alias-"), "root");
    fs.symlinkSync(root, alias, "dir");
    location.mockReturnValue(path.join(alias, "private-tmp"));
    const readRows = () => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return db.prepare("SELECT * FROM managed_update_handoffs ORDER BY install_root").all();
      } finally {
        db.close();
      }
    };
    const fence = await withUpdateCommandExecutor(
      randomUUID(),
      async (executor) => {
        const admitted = await executor.enter(root);
        admitted.assertCurrent();
        expect(captureUpdateCommandExecutorAuthority(admitted)).toMatchObject(identity);
        expect(readRows()).toEqual([
          original,
          expect.objectContaining({
            install_root: expect.stringContaining(`${root}/.openclaw-update-child-`),
          }),
        ]);
        return admitted;
      },
      { legacyPackageParent: parent, legacyPackageHandoff: { handoffId: original.owner, root } },
    );
    expect(readRows()).toEqual([original]);
    expect(fence.assertCurrent).toThrow("no longer current");
  },
);
