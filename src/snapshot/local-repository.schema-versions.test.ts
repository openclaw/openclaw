import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import { createGlobalDatabase } from "./local-repository.schema.test-support.js";
import {
  createGenericSnapshot,
  expectMissing,
  useLocalRepositoryFixtures,
  withDatabase,
} from "./local-repository.test-support.js";
import { hashSnapshotArtifact } from "./manifest.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotManifest,
} from "./snapshot-provider.js";

const { createTempDir } = useLocalRepositoryFixtures(afterEach);

it.each([
  ["global", OPENCLAW_STATE_SCHEMA_VERSION, 20],
  ["agent", OPENCLAW_AGENT_SCHEMA_VERSION, 25],
] as const)(
  "verifies and restores a previous-schema %s snapshot without migrating its bytes",
  async (role, currentVersion, previousVersion) => {
    const root = await createTempDir();
    const source = path.join(root, "source.sqlite");
    if (role === "global") {
      createGlobalDatabase(source);
    }
    const historicalSchema =
      role === "global"
        ? `
          DROP INDEX idx_meeting_transcript_sessions_source;
          DROP INDEX idx_meeting_transcript_sessions_account;
          DROP INDEX idx_meeting_transcript_sessions_agent;
          DROP INDEX idx_delivery_queue_bounded_retention;
          ALTER TABLE meeting_transcript_sessions DROP COLUMN source_account_id;
          ALTER TABLE meeting_transcript_sessions DROP COLUMN source_guild_id;
          ALTER TABLE meeting_transcript_sessions DROP COLUMN source_channel_id;
          ALTER TABLE meeting_transcript_sessions DROP COLUMN source_meeting_url;
          ALTER TABLE meeting_transcript_sessions DROP COLUMN source_thread_ts;
          ALTER TABLE meeting_transcript_sessions DROP COLUMN source_file_id;
          ALTER TABLE meeting_transcript_sessions DROP COLUMN metadata_agent_id;
          ALTER TABLE meeting_transcript_summaries DROP COLUMN overview;
          ALTER TABLE delivery_queue_entries DROP COLUMN retention_id_prefix;
          ALTER TABLE delivery_queue_entries DROP COLUMN retention_max_age_ms;
          ALTER TABLE delivery_queue_entries DROP COLUMN retention_max_entries;
        `
        : await fs.readFile(
            new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v25.sql", import.meta.url),
            "utf8",
          );
    withDatabase(source, (db) => {
      db.exec(`${historicalSchema}\nPRAGMA user_version = ${previousVersion};`);
      db.prepare(`INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, created_at, updated_at)
        VALUES ('primary', ?, ?, ?, 1, 1)
        ON CONFLICT(meta_key) DO UPDATE SET schema_version = excluded.schema_version
      `).run(role, previousVersion, role === "agent" ? "main" : null);
    });

    const provider = createLocalSqliteSnapshotProvider({ repositoryPath: path.join(root, "repo") });
    // Capture historical bytes without asking this build's current-schema creation validator.
    const snapshot = await createGenericSnapshot(provider, source, role);
    const artifactPath = path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
    let manifest: SnapshotManifest = {
      ...snapshot.manifest,
      database: {
        basename: snapshot.manifest.database.basename,
        userVersion: previousVersion,
        ...(role === "agent" ? { role, agentId: "main" } : { role }),
      },
    };
    const manifestPath = path.join(snapshot.ref.path, SNAPSHOT_MANIFEST_FILENAME);
    async function writeManifest(rehash = false) {
      if (rehash) {
        const { sha256, sizeBytes } = await hashSnapshotArtifact(snapshot.ref.path);
        manifest = { ...manifest, artifact: { ...manifest.artifact, sha256, sizeBytes } };
      }
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    }
    await writeManifest();
    const bytes = await fs.readFile(artifactPath);
    await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
    const target = path.join(root, "restored.sqlite");
    await expect(provider.restoreFresh(snapshot.ref, target)).resolves.toMatchObject({ ok: true });
    expect(await fs.readFile(target)).toEqual(bytes);
    expect(await fs.readFile(artifactPath)).toEqual(bytes);

    async function rewriteVersion(version: number, metadataVersion = version) {
      withDatabase(artifactPath, (db) => {
        db.exec(`PRAGMA user_version = ${version}`);
        db.prepare("UPDATE schema_meta SET schema_version = ?").run(metadataVersion);
      });
      manifest = { ...manifest, database: { ...manifest.database, userVersion: version } };
      await writeManifest(true);
    }

    await rewriteVersion(currentVersion + 1);
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/newer/u);
    const refusedTarget = path.join(root, "refused.sqlite");
    await expect(provider.restoreFresh(snapshot.ref, refusedTarget)).rejects.toThrow(/newer/u);
    await expectMissing(refusedTarget);

    await rewriteVersion(previousVersion, currentVersion);
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/snapshot schema version/u);

    await rewriteVersion(0);
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/snapshot schema version/u);

    await rewriteVersion(previousVersion);
    withDatabase(artifactPath, (db) => {
      db.prepare("UPDATE schema_meta SET role = ?").run(role === "global" ? "agent" : "global");
    });
    await writeManifest(true);
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/expected global|expected agent/u);
  },
);
