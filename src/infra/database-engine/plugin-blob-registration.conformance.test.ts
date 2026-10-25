import { channel } from "node:diagnostics_channel";
import { describe, expect, it, vi } from "vitest";
import {
  pluginBlobDeleteExpiredKeyInDatabase,
  pluginBlobEntriesInDatabase,
  pluginBlobRegisterIfAbsentInDatabase,
  type BlobWriteParams,
} from "../../plugin-state/plugin-blob-store.sqlite.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const defaults: BlobWriteParams = {
  pluginId: "synthetic-blob",
  namespace: "registration",
  key: "new",
  bytes: new Uint8Array([7]),
  metadataJson: '{"synthetic":true}',
  maxEntries: 2,
  maxBytesPerNamespace: 32,
  overflowPolicy: "reject-new",
};

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} blob registration`,
    () => {
      useMixedAgentPair(engine, engine);

      it.each(["reject-new", "evict-oldest"] as const)(
        "keeps receipts, expired occupancy and two-statement admission under %s",
        (overflowPolicy) =>
          withEngineStoreAdmission(() => {
            const database = openOpenClawStateDatabase();
            const { db } = database;
            const write = { ...defaults, namespace: overflowPolicy, overflowPolicy };
            const register = (params: BlobWriteParams) =>
              runOpenClawStateWriteTransaction(
                () => pluginBlobRegisterIfAbsentInDatabase(db, params),
                { database },
              );
            let statements = 0;
            const observation = channel("openclaw.database.statement");
            const observe = (event: unknown) => {
              if (
                event &&
                typeof event === "object" &&
                "sql" in event &&
                typeof event.sql === "string" &&
                /plugin_blob_entries/i.test(event.sql)
              ) {
                statements++;
              }
            };
            observation.subscribe(observe);
            let receipt: ReturnType<typeof register>;
            try {
              receipt = register({ ...write, ttlMs: 1 });
            } finally {
              observation.unsubscribe(observe);
            }
            expect(receipt).toEqual({
              createdAt: expect.any(Number),
              expiresAt: expect.any(Number),
            });
            // Expired rows still occupy their keys and duplicate admission precedes expiry validation.
            runOpenClawStateWriteTransaction(
              () =>
                db
                  .prepare("UPDATE plugin_blob_entries SET expires_at = 1 WHERE namespace = ?")
                  .run(overflowPolicy),
              { database },
            );
            expect(
              register({ ...write, bytes: new Uint8Array([9]), ttlMs: Number.MAX_VALUE }),
            ).toBeUndefined();
            const expired = runOpenClawStateWriteTransaction(
              () => pluginBlobDeleteExpiredKeyInDatabase(db, write),
              { database },
            );
            expect(expired).toMatchObject({ metadata: { synthetic: true }, sizeBytes: 1 });
            expect(register(write)).toEqual({ createdAt: expect.any(Number) });
            expect(statements).toBe(2);
          }),
      );

      it("evicts in created/key order, protects the inserted key, and keeps sibling/expired metadata", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase();
          const { db } = database;
          const write = {
            ...defaults,
            namespace: "ordered",
            overflowPolicy: "evict-oldest" as const,
          };
          const register = (params: BlobWriteParams) =>
            runOpenClawStateWriteTransaction(
              () => pluginBlobRegisterIfAbsentInDatabase(db, params),
              {
                database,
              },
            );
          const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
          try {
            register({ ...write, namespace: "sibling", key: "sibling" });
            register({ ...write, key: "expired", ttlMs: 1, maxEntries: 4 });
            register({ ...write, key: "zeta", maxEntries: 4 });
            register({ ...write, key: "alpha", maxEntries: 4 });
            clock.mockReturnValue(1_002);
            register({ ...write, key: "protected", maxEntries: 3 });
            expect(pluginBlobEntriesInDatabase(db, write).map((row) => row.key)).toEqual([
              "zeta",
              "protected",
            ]);
            expect(
              pluginBlobEntriesInDatabase(db, { ...write, namespace: "sibling" }),
            ).toHaveLength(1);
            expect(
              runOpenClawStateWriteTransaction(
                () => pluginBlobDeleteExpiredKeyInDatabase(db, { ...write, key: "expired" }),
                { database },
              ),
            ).toMatchObject({ key: "expired", metadata: { synthetic: true } });
          } finally {
            clock.mockRestore();
          }
        }));

      it("preserves row/byte quota precedence ahead of invalid expiry and rolls rejected inserts back", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase();
          const { db } = database;
          const write = {
            ...defaults,
            pluginId: "synthetic-quota",
            bytes: new Uint8Array(2),
            ttlMs: Number.MAX_VALUE,
          };
          runOpenClawStateWriteTransaction(
            () => {
              db.prepare(`WITH RECURSIVE entries(n) AS (
              VALUES (1) UNION ALL SELECT n + 1 FROM entries WHERE n < 49999
            ) INSERT INTO plugin_blob_entries
              (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
              SELECT 'synthetic-quota', 'sibling', CAST(n AS TEXT), '{}', ?, 1, 2 FROM entries`).run(
                new Uint8Array(),
              );
              db.prepare(
                "INSERT INTO plugin_blob_entries (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at) VALUES ('synthetic-quota', 'registration', 'held', '{}', ?, 1, NULL)",
              ).run(new Uint8Array());
              // Six physical rows cross the public 512 MiB bound without a larger per-row allocation.
              const fill = db.prepare(
                "UPDATE plugin_blob_entries SET blob = ? WHERE plugin_id = 'synthetic-quota' AND entry_key = ?",
              );
              const bytes = new Uint8Array(86 * 1024 * 1024);
              for (let index = 1; index <= 6; index++) {
                fill.run(bytes, String(index));
              }
            },
            { database },
          );
          const reject = (params: Partial<BlobWriteParams>, message: string) =>
            expect(() =>
              runOpenClawStateWriteTransaction(
                () => pluginBlobRegisterIfAbsentInDatabase(db, { ...write, ...params }),
                { database },
              ),
            ).toThrow(message);
          reject(
            { maxEntries: 1, maxBytesPerNamespace: 1 },
            "namespace reached its stored row limit",
          );
          reject({ maxBytesPerNamespace: 1 }, "namespace reached its stored byte limit");
          reject({}, "per-plugin row limit");
          runOpenClawStateWriteTransaction(
            () =>
              db
                .prepare(
                  "DELETE FROM plugin_blob_entries WHERE plugin_id = ? AND entry_key = '49999'",
                )
                .run(write.pluginId),
            { database },
          );
          reject({}, "per-plugin byte limit");
          expect(
            db
              .prepare(
                "SELECT entry_key FROM plugin_blob_entries WHERE plugin_id = ? AND entry_key = 'new'",
              )
              .get(write.pluginId),
          ).toBeUndefined();
          runOpenClawStateWriteTransaction(
            () =>
              db.prepare("DELETE FROM plugin_blob_entries WHERE plugin_id = ?").run(write.pluginId),
            { database },
          );
          reject({}, "ttlMs cannot produce a valid expiry timestamp");
        }));
    },
  );
}
