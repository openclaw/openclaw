import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { recordSuccessfulStartupMigrations } from "./startup-migration-checkpoint.js";
import {
  prepareUpdateCheckpointRestore,
  restoreUpdateCheckpointResource,
} from "./update-checkpoint-restore.js";
import { buildCheckpointReaderRuntime } from "./update-checkpoint-runtime.test-support.js";
import { captureUpdateCheckpoint, type UpdateCheckpointAccess } from "./update-checkpoint.js";

const roots: string[] = [];
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(kind = "current") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-startup-")));
  roots.push(root);
  const runtime = await buildCheckpointReaderRuntime(path.join(root, "package"));
  const stateDir = path.join(root, "live");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const file = path.join(stateDir, "state", "openclaw.sqlite");
  const record = (fingerprint: string, nowMs: number) => {
    recordSuccessfulStartupMigrations({
      env,
      buildIdentity: "same-package-build",
      nowMs,
      identity: {
        effectiveConfigFingerprint: "same-config",
        pluginDoctorConfigFingerprint: "same-doctor-config",
        pluginMigrationFingerprint: fingerprint,
      },
    });
    closeOpenClawStateDatabaseForTest();
  };
  const sql = (query: string) => {
    const db = new DatabaseSync(file);
    try {
      db.exec(query);
    } finally {
      db.close();
    }
  };
  const rows = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare("SELECT rowid, * FROM schema_meta ORDER BY meta_key").all();
    } finally {
      db.close();
    }
  };
  record("before-startup", 100);
  sql("CREATE TABLE online_work(id INTEGER PRIMARY KEY, value TEXT)");
  if (kind.startsWith("legacy")) {
    sql(
      "UPDATE schema_meta SET schema_version=2,app_version='2026.7.1\nsame-package-build' WHERE meta_key!='primary'",
    );
  }
  if (kind === "rowid-conflict") {
    sql("INSERT INTO schema_meta VALUES('unknown-metadata','global',1,NULL,'retained',1,1)");
  }
  const before = rows();
  const access: UpdateCheckpointAccess = {
    artifactRoot: path.join(root, "checkpoints"),
    binding: {
      runId: "startup-checkpoint",
      stateDir,
      configPath: path.join(stateDir, "config.json"),
      fromRuntime: runtime.runtime,
    },
    assertQuiescent() {},
  };
  const capture = () =>
    captureUpdateCheckpoint({
      ...access,
      resources: [{ sourcePath: file, kind: "sqlite", restore: "replace" }],
      exclusions: [],
    });
  const checkpointRef = await capture();
  // The migration owner changes primary metadata before its immutable afterimage.
  sql("UPDATE schema_meta SET updated_at=updated_at+1 WHERE meta_key='primary'");
  if (kind === "legacy-before-image") {
    record("before-startup", 150);
  }
  if (kind === "rowid-conflict") {
    // Synthetic changed-schema owner removes an unrelated row; its identity must
    // not be reused when restoring that row alongside a newer startup checkpoint.
    sql(
      "DELETE FROM schema_meta WHERE meta_key='unknown-metadata'; UPDATE schema_meta SET rowid=4 WHERE meta_key='state-migrations'",
    );
  }
  const afterUpdateRef = await capture();
  // Real startup work happens after the last update-owned image, as in the installed failure.
  record("after-candidate-startup", 200);
  sql("INSERT INTO online_work VALUES(1,'preserve this turn')");
  const current = rows();
  const prepare = (
    prepareSharedDatabase: (params: { stagedDb: DatabaseSync }) => void = () => {},
  ) =>
    prepareUpdateCheckpointRestore({
      ...access,
      checkpointRef,
      afterUpdateRef,
      prepareSharedDatabase,
    });
  return { file, sql, rows, before, current, access, prepare };
}

describe("startup metadata across update checkpoint restoration", () => {
  it.each(["current", "legacy-before-image", "legacy-after-image"])(
    "preserves completed startup checkpoints and online data while restoring primary metadata: %s",
    async (kind) => {
      const f = await fixture(kind);
      const prepared = await f.prepare();
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") {
        throw new Error("Expected compatible startup metadata to be preserved");
      }
      expect(
        (
          await restoreUpdateCheckpointResource({
            ...f.access,
            planRef: prepared.planRef,
            resourceCursor: 0,
          })
        ).status,
      ).toBe("applied");
      expect(f.rows()).toEqual(
        [
          ...f.before.filter((row) => row.meta_key === "primary"),
          ...f.current.filter((row) => row.meta_key !== "primary"),
        ].toSorted((a, b) => String(a.meta_key).localeCompare(String(b.meta_key))),
      );
      const db = new DatabaseSync(f.file, { readOnly: true });
      try {
        expect(db.prepare("SELECT * FROM online_work").all()).toEqual([
          { id: 1, value: "preserve this turn" },
        ]);
      } finally {
        db.close();
      }
    },
  );

  it.each([
    "UPDATE schema_meta SET role='agent' WHERE meta_key='primary'",
    "INSERT INTO schema_meta VALUES('unknown-metadata','global',1,NULL,'new',1,1)",
    "ALTER TABLE online_work ADD COLUMN future TEXT",
    "DELETE FROM schema_meta WHERE meta_key='startup-migrations'",
    "UPDATE schema_meta SET schema_version=4 WHERE meta_key='startup-migrations'",
  ])("refuses unowned schema or metadata drift: %s", async (change) => {
    const f = await fixture();
    f.sql(change);
    const before = await fs.readFile(f.file);
    expect((await f.prepare()).status).toBe("unavailable");
    expect(await fs.readFile(f.file)).toEqual(before);
  });

  it("refuses duplicate historical row identities before staging instead of inventing a replacement", async () => {
    const f = await fixture("rowid-conflict");
    const before = await fs.readFile(f.file);
    expect(await f.prepare()).toEqual({ status: "unavailable", resource: "schema_meta" });
    expect(await fs.readFile(f.file)).toEqual(before);
  });

  it("rejects an owner callback that changes carried startup metadata before sealing", async () => {
    const f = await fixture();
    await expect(
      f.prepare(({ stagedDb }) => {
        stagedDb.exec(
          "UPDATE schema_meta SET app_version='unbound' WHERE meta_key='startup-migrations'",
        );
      }),
    ).rejects.toThrow(/schema metadata mismatch/u);
  });
});
