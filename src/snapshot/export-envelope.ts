import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256File } from "../infra/directory-durability.js";
import { sameFileMutationFingerprint } from "../infra/file-descriptor.js";
import { root } from "../infra/fs-safe.js";
import { parseSnapshotManifest } from "./manifest.js";
import { assertNoSqliteSidecarsSync } from "./restore-paths.js";
import { SNAPSHOT_MANIFEST_FILENAME, type SnapshotManifest } from "./snapshot-provider.js";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().nonnegative().max(2_147_483_647);
const artifact = z.strictObject({ sha256: digest, sizeBytes: z.number().int().positive().safe() });
const table = z.strictObject({ rows: z.number().int().nonnegative().safe(), sha256: digest });
const allocation = z.strictObject({
  value: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine((value) => /^[0-9]{1,19}$/.test(value) && BigInt(value) <= 9223372036854775807n),
  called: z.boolean(),
});
const postgresEnvelope = z
  .strictObject({
    schemaVersion: z.literal(2),
    snapshotId: identifier,
    createdAt: z.iso.datetime({ precision: 3 }),
    profile: z.enum(["exact", "user-backup"]),
    source: z.strictObject({
      engine: z.literal("postgres"),
      storeId: z.uuid(),
      owner: identifier,
      namespace: identifier,
      schemaVersion: version,
    }),
    exportSchemaVersion: version,
    activeFragments: z.array(identifier),
    verification: z.strictObject({
      tables: z.record(identifier, table),
      allocations: z.record(identifier, allocation),
    }),
    artifacts: z.strictObject({ "database.sqlite": artifact, "anchor.sqlite": artifact }),
    sanitizedDifferences: z.array(identifier),
  })
  .refine((value) => value.profile !== "exact" || value.sanitizedDifferences.length === 0, {
    message: "Exact exports must not contain sanitization differences",
  });

export type PostgresExportEnvelope = z.infer<typeof postgresEnvelope>;
export type SnapshotExportEnvelope =
  | { engine: "sqlite"; manifest: SnapshotManifest }
  | { engine: "postgres"; manifest: PostgresExportEnvelope };

export function parsePostgresEnvelope(value: unknown, expectedId: string): PostgresExportEnvelope {
  const manifest = postgresEnvelope.parse(value);
  if (manifest.snapshotId !== expectedId) {
    throw new Error("Export manifest id does not match its directory");
  }
  return manifest;
}

export async function readSnapshotExportEnvelope(
  directory: string,
  expectedId = path.basename(directory),
): Promise<SnapshotExportEnvelope> {
  const files = await root(directory);
  const bytes = await files.read(SNAPSHOT_MANIFEST_FILENAME, {
    hardlinks: "reject",
    symlinks: "reject",
    maxBytes: 1024 * 1024,
  });
  const value: unknown = JSON.parse(bytes.buffer.toString("utf8"));
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 1) {
    return { engine: "sqlite", manifest: parseSnapshotManifest(value, directory, expectedId) };
  }
  return { engine: "postgres", manifest: parsePostgresEnvelope(value, expectedId) };
}

export async function writePostgresExportEnvelope(
  directory: string,
  value: PostgresExportEnvelope,
): Promise<void> {
  const manifest = parsePostgresEnvelope(value, path.basename(directory));
  const handle = await fs.open(path.join(directory, SNAPSHOT_MANIFEST_FILENAME), "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The owner inspects the held anchor, never a separately reopened pathname. */
export async function verifyPostgresExportEnvelope(
  directory: string,
  value: PostgresExportEnvelope,
  inspectAnchor: (
    handle: FileHandle,
  ) => Promise<{ engine: string; storeId: string; namespace: string }>,
  requiredProfile: PostgresExportEnvelope["profile"],
): Promise<void> {
  const manifest = parsePostgresEnvelope(value, path.basename(directory));
  if (manifest.profile !== requiredProfile) {
    throw new Error("Export profile does not match the requested restore");
  }
  const files = await root(directory);
  for (const name of ["database.sqlite", "anchor.sqlite"] as const) {
    assertNoSqliteSidecarsSync(
      path.join(directory, name),
      "PostgreSQL export has unexpected SQLite sidecar",
    );
    const opened = await files.open(name, { hardlinks: "reject", symlinks: "reject" });
    try {
      const before = await opened.handle.stat({ bigint: true });
      const actual = await sha256File(opened.handle);
      const expected = manifest.artifacts[name];
      if (actual.digest !== expected.sha256 || actual.bytes !== expected.sizeBytes) {
        throw new Error(`Export artifact verification failed: ${name}`);
      }
      if (name === "anchor.sqlite") {
        const anchor = await inspectAnchor(opened.handle);
        if (
          anchor.engine !== "postgres" ||
          anchor.storeId !== manifest.source.storeId ||
          anchor.namespace !== manifest.source.namespace
        ) {
          throw new Error("Export anchor does not match the source store identity");
        }
      }
      if (!sameFileMutationFingerprint(before, await opened.handle.stat({ bigint: true }))) {
        throw new Error(`Export artifact changed during verification: ${name}`);
      }
    } finally {
      await opened.handle.close();
    }
  }
}
