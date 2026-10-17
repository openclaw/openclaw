import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Client } from "pg";
import type { PortDescriptor } from "../infra/database-engine/port-descriptor.js";
import {
  materializeDatabasePort,
  inspectDatabasePort,
  readDatabasePortAllocations,
} from "../infra/database-engine/port.worker.js";
import { sha256File } from "../infra/directory-durability.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { writePostgresExportEnvelope, type PostgresExportEnvelope } from "./export-envelope.js";
import type { GitBackupIdentity } from "./git-backup-codec.js";
import { createGitBackupRowTransform } from "./git-backup-sanitizer.js";
import { fingerprintPostgresGeneration, inspectPostgresGeneration } from "./postgres-generation.js";

type Anchor = Pick<PostgresExportEnvelope["source"], "engine" | "storeId" | "namespace">;

export async function captureDatabaseArtifact(file: string) {
  await using handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Database artifact must be an unaliased regular file: ${file}`);
  }
  const { digest, bytes } = await sha256File(handle);
  return { path: file, sha256: digest, size: bytes };
}

async function artifact(file: string) {
  const { sha256, size } = await captureDatabaseArtifact(file);
  return { sha256, sizeBytes: size };
}

export async function assertDatabaseArtifact(
  expected: Awaited<ReturnType<typeof captureDatabaseArtifact>>,
) {
  if (!isDeepStrictEqual(await captureDatabaseArtifact(expected.path), expected)) {
    throw new Error(`Database artifact changed: ${expected.path}`);
  }
}

/** Export from an admitted family into a private capture with its anchor already held. */
export async function exportPostgresBackup(params: {
  client: Client;
  descriptor: PortDescriptor;
  anchor: Anchor;
  sourcePath: string;
  directory: string;
  profile: PostgresExportEnvelope["profile"];
  assertCurrent: () => void;
  gitIdentity?: GitBackupIdentity;
}): Promise<PostgresExportEnvelope> {
  const { client, descriptor, anchor } = params;
  const raw = path.join(params.directory, ".export.sqlite");
  const image = path.join(params.directory, "database.sqlite");
  const anchorPath = path.join(params.directory, "anchor.sqlite");
  let verification;
  {
    params.assertCurrent();
    // The private artifact must exist before the host admits a worker's native open.
    await fs.writeFile(raw, "", { flag: "wx", mode: 0o600 });
    using db = openNodeSqliteDatabase(raw, { readBigInts: true });
    verification = await materializeDatabasePort({
      source: { engine: "postgres", db: client, namespace: anchor.namespace },
      destination: { engine: "sqlite", db },
      descriptor,
      storeId: anchor.storeId,
      assertCurrent: params.assertCurrent,
      transformRow: params.gitIdentity
        ? createGitBackupRowTransform(
            params.gitIdentity,
            descriptor.id,
            new Set(descriptor.tables.map(({ name }) => name)),
          )
        : undefined,
    });
    // The portable image uses SQLite allocation, while a matched PG restore retains its sequence.
    verification.allocations = await readDatabasePortAllocations(
      { engine: "postgres", db: client, namespace: anchor.namespace },
      descriptor,
    );
  }
  const sanitizedDifferences: string[] = [];
  params.assertCurrent();
  if (params.profile === "exact") {
    await fs.rename(raw, image);
  } else {
    const { createVerifiedSqliteSnapshot } = await import("../infra/sqlite-snapshot.js");
    const { sanitizeOpenClawGlobalStateSnapshot } =
      await import("../state/openclaw-state-snapshot-sanitizer.js");
    await createVerifiedSqliteSnapshot({
      sourcePath: raw,
      targetPath: image,
      preserveRowIds: true,
      async transform(db) {
        if (params.gitIdentity) {
          sanitizedDifferences.push("git-exclude-secrets");
        }
        const before = /* sqlite-allow-raw: count the sanitizer's native changes. */ db
          .prepare("SELECT total_changes() AS n")
          .get()?.n;
        sanitizeOpenClawGlobalStateSnapshot(db);
        const { embedSessionColdArchivesInSnapshot } =
          await import("../config/sessions/session-cold-storage-backup.js");
        await embedSessionColdArchivesInSnapshot({
          database: db,
          sourceStorePath: params.sourcePath,
        });
        const after = /* sqlite-allow-raw: count the sanitizer's native changes. */ db
          .prepare("SELECT total_changes() AS n")
          .get()?.n;
        if (after !== before) {
          sanitizedDifferences.push("transient-state");
        }
        if (params.gitIdentity) {
          // Publish hashes of redacted rows, never fingerprints of omitted credentials.
          verification.tables = (
            await inspectDatabasePort({ engine: "sqlite", db }, descriptor)
          ).tables;
        }
      },
    });
    await fs.unlink(raw);
  }
  const manifest: PostgresExportEnvelope = {
    schemaVersion: 2,
    snapshotId: path.basename(params.directory),
    createdAt: new Date().toISOString(),
    profile: params.profile,
    source: { ...anchor, owner: descriptor.id, schemaVersion: descriptor.version },
    exportSchemaVersion: descriptor.version,
    activeFragments: [...descriptor.activeFragments!],
    verification,
    artifacts: {
      "database.sqlite": await artifact(image),
      "anchor.sqlite": await artifact(anchorPath),
    },
    sanitizedDifferences,
  };
  params.assertCurrent();
  await writePostgresExportEnvelope(params.directory, manifest);
  return manifest;
}

/** Restore an already verified capture; the caller owns its client and publication. */
export async function restorePostgresBackup(params: {
  client: Client;
  descriptor: PortDescriptor;
  manifest: PostgresExportEnvelope;
  directory: string;
  anchorPath: string;
  profile: PostgresExportEnvelope["profile"];
  assertCurrent: () => void;
}) {
  const { client, descriptor, manifest } = params;
  if (
    descriptor.version !== manifest.exportSchemaVersion ||
    descriptor.version !== manifest.source.schemaVersion
  ) {
    throw new Error("PostgreSQL backup requires its matching family schema version.");
  }
  const namespace = `restore_${randomUUID().replaceAll("-", "")}`;
  using image = openNodeSqliteDatabase(path.join(params.directory, "database.sqlite"), {
    readOnly: true,
    readBigInts: true,
  });
  params.assertCurrent();
  const verified = await materializeDatabasePort({
    source: { engine: "sqlite", db: image },
    destination: { engine: "postgres", db: client, namespace },
    descriptor,
    storeId: manifest.source.storeId,
    sourceAllocations: manifest.verification.allocations,
    activeFragments: manifest.activeFragments,
    assertCurrent: params.assertCurrent,
  });
  if (params.profile === "exact" && !isDeepStrictEqual(verified, manifest.verification)) {
    throw new Error("Exact PostgreSQL export verification differs from its manifest.");
  }
  params.assertCurrent();
  await fs.copyFile(
    path.join(params.directory, "anchor.sqlite"),
    params.anchorPath,
    fs.constants.COPYFILE_EXCL,
  );
  if (!isDeepStrictEqual(await artifact(params.anchorPath), manifest.artifacts["anchor.sqlite"])) {
    throw new Error("PostgreSQL restore anchor changed during preparation.");
  }
  {
    using anchor = openNodeSqliteDatabase(params.anchorPath);
    anchor.prepare("UPDATE openclaw_engine_anchor SET schema = ?").run(namespace);
  }
  return { namespace };
}

export async function fingerprintPostgresDatabase(params: { client: Client; anchor: Anchor }) {
  const { client, anchor } = params;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    return fingerprintPostgresGeneration(anchor, await inspectPostgresGeneration(client, anchor));
  } finally {
    await client.query("ROLLBACK");
  }
}
