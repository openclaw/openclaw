import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readSnapshotExportEnvelope,
  verifyPostgresExportEnvelope,
  writePostgresExportEnvelope,
  type PostgresExportEnvelope,
} from "./export-envelope.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const identity = {
  engine: "postgres" as const,
  storeId: "91fbe993-c1a9-4cbb-a671-466f8f777074",
  namespace: "openclaw_workboard_test",
};
const anchorBytes = Buffer.from(JSON.stringify(identity));

// Stand-in for the store owner's anchor decoder; the envelope owns file custody and matching.
async function inspectAnchor(handle: FileHandle) {
  const bytes = Buffer.alloc(anchorBytes.length);
  await handle.read(bytes, 0, bytes.length, 0);
  return JSON.parse(bytes.toString("utf8")) as typeof identity;
}

async function fixture() {
  const directory = tempDirs.make("openclaw-export-envelope-");
  const data = Buffer.from("synthetic SQLite export bytes\0\xff", "binary");
  await fs.writeFile(path.join(directory, "database.sqlite"), data);
  await fs.writeFile(path.join(directory, "anchor.sqlite"), anchorBytes);
  const artifact = (bytes: Buffer) => ({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  });
  const manifest: PostgresExportEnvelope = {
    schemaVersion: 2,
    snapshotId: path.basename(directory),
    createdAt: "2026-10-12T12:00:00.000Z",
    profile: "exact",
    source: { ...identity, owner: "workboard", schemaVersion: 7 },
    exportSchemaVersion: 7,
    activeFragments: ["workboard"],
    verification: {
      tables: { cards: { rows: 1, sha256: "1".repeat(64) } },
      allocations: { cards_id: { value: "9223372036854775807", called: true } },
    },
    artifacts: { "database.sqlite": artifact(data), "anchor.sqlite": artifact(anchorBytes) },
    sanitizedDifferences: [],
  };
  return { directory, manifest };
}

describe("engine-discriminated snapshot export envelope", () => {
  it("round-trips matched PostgreSQL artifacts and exact bigint allocation facts", async () => {
    const { directory, manifest } = await fixture();
    await writePostgresExportEnvelope(directory, manifest);
    expect(await readSnapshotExportEnvelope(directory)).toEqual({ engine: "postgres", manifest });
    await expect(
      verifyPostgresExportEnvelope(directory, manifest, inspectAnchor, "exact"),
    ).resolves.toBeUndefined();
    await expect(writePostgresExportEnvelope(directory, manifest)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("continues reading unchanged format-1 manifests through the native parser", async () => {
    const { directory } = await fixture();
    const manifest = {
      schemaVersion: 1,
      snapshotId: path.basename(directory),
      createdAt: "2026-10-12T12:00:00.000Z",
      database: { role: "generic", id: "workboard", basename: "workboard.sqlite", userVersion: 7 },
      artifact: { path: "database.sqlite", sha256: "a".repeat(64), sizeBytes: 1024 },
    };
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    expect(await readSnapshotExportEnvelope(directory)).toEqual({ engine: "sqlite", manifest });
    await fs.writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({ ...manifest, sourceEngine: "sqlite" }),
    );
    await expect(readSnapshotExportEnvelope(directory)).rejects.toThrow("fields must be exactly");
  });

  it.each(["database.sqlite", "anchor.sqlite"] as const)(
    "refuses changed %s bytes",
    async (name) => {
      const { directory, manifest } = await fixture();
      await fs.appendFile(path.join(directory, name), "changed");
      await expect(
        verifyPostgresExportEnvelope(directory, manifest, inspectAnchor, "exact"),
      ).rejects.toThrow(`verification failed: ${name}`);
    },
  );

  it("refuses a correctly hashed anchor belonging to another store", async () => {
    const { directory, manifest } = await fixture();
    manifest.source.storeId = "91111111-c1a9-4cbb-a671-466f8f777074";
    await expect(
      verifyPostgresExportEnvelope(directory, manifest, inspectAnchor, "exact"),
    ).rejects.toThrow("does not match the source store identity");
  });

  it.each([
    "database.sqlite-wal",
    "database.sqlite-shm",
    "database.sqlite-journal",
    "anchor.sqlite-wal",
    "anchor.sqlite-shm",
    "anchor.sqlite-journal",
  ])("refuses unmanifested SQLite sidecar %s", async (name) => {
    const { directory, manifest } = await fixture();
    await fs.writeFile(path.join(directory, name), "unmanifested pages");
    await expect(
      verifyPostgresExportEnvelope(directory, manifest, inspectAnchor, "exact"),
    ).rejects.toThrow("unexpected SQLite sidecar");
  });

  it("never accepts sanitized user backups as exact recovery exports", async () => {
    const { directory, manifest } = await fixture();
    manifest.profile = "user-backup";
    manifest.sanitizedDifferences = ["leases"];
    await writePostgresExportEnvelope(directory, manifest);
    await expect(
      verifyPostgresExportEnvelope(directory, manifest, inspectAnchor, "exact"),
    ).rejects.toThrow("profile does not match");
    await expect(
      verifyPostgresExportEnvelope(directory, manifest, inspectAnchor, "user-backup"),
    ).resolves.toBeUndefined();
    manifest.profile = "exact";
    await expect(
      verifyPostgresExportEnvelope(directory, manifest, inspectAnchor, "exact"),
    ).rejects.toThrow("must not contain sanitization");
  });

  it.each([
    ["unsupported version", { schemaVersion: 3 }],
    ["unknown connection field", { connectionString: "forbidden" }],
    ["mismatched directory", { snapshotId: "other" }],
    ["unsafe owner", { source: { ...identity, owner: "../workboard", schemaVersion: 7 } }],
    [
      "inexact allocation",
      {
        verification: {
          tables: {},
          allocations: { id: { value: "9223372036854775808", called: true } },
        },
      },
    ],
  ])("refuses %s", async (_label, fields) => {
    const { directory, manifest } = await fixture();
    await fs.writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({ ...manifest, ...fields }),
    );
    await expect(readSnapshotExportEnvelope(directory)).rejects.toThrow();
  });
});
