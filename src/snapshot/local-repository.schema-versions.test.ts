import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import { createGlobalDatabase } from "./local-repository.schema.test-support.js";
import { useLocalRepositoryFixtures, withDatabase } from "./local-repository.test-support.js";
import { hashSnapshotArtifact } from "./manifest.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotManifest,
} from "./snapshot-provider.js";

const { createTempDir } = useLocalRepositoryFixtures(afterEach);

it.each(["global", "agent"] as const)(
  "verifies and restores a previous-schema %s snapshot without migrating its bytes",
  async (role) => {
    const root = await createTempDir();
    const source = path.join(root, "source.sqlite");
    const currentVersion =
      role === "global" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
    const previousVersion = role === "global" ? 20 : 25;
    if (role === "global") {
      createGlobalDatabase(source);
      withDatabase(source, (db) => {
        db.exec(`
          DROP INDEX idx_meeting_transcript_sessions_source;
          DROP INDEX idx_meeting_transcript_sessions_account;
          DROP INDEX idx_meeting_transcript_sessions_agent;
          DROP INDEX idx_delivery_queue_bounded_retention;
        `);
        for (const column of [
          "source_account_id",
          "source_guild_id",
          "source_channel_id",
          "source_meeting_url",
          "source_thread_ts",
          "source_file_id",
          "metadata_agent_id",
        ]) {
          db.exec(`ALTER TABLE meeting_transcript_sessions DROP COLUMN ${column}`);
        }
        db.exec("ALTER TABLE meeting_transcript_summaries DROP COLUMN overview");
        for (const column of [
          "retention_id_prefix",
          "retention_max_age_ms",
          "retention_max_entries",
        ]) {
          db.exec(`ALTER TABLE delivery_queue_entries DROP COLUMN ${column}`);
        }
      });
    } else {
      const schema = await fs.readFile(
        new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v25.sql", import.meta.url),
        "utf8",
      );
      withDatabase(source, (db) => {
        db.exec(schema);
        db.prepare(`INSERT INTO schema_meta
          (meta_key, role, schema_version, agent_id, created_at, updated_at)
          VALUES ('primary', 'agent', ?, 'main', 1, 1)`).run(previousVersion);
      });
    }
    withDatabase(source, (db) => {
      db.exec(`PRAGMA user_version = ${previousVersion}`);
      db.prepare("UPDATE schema_meta SET schema_version = ?").run(previousVersion);
    });

    const provider = createLocalSqliteSnapshotProvider({ repositoryPath: path.join(root, "repo") });
    // Capture historical bytes without asking this build's current-schema creation validator.
    const snapshot = await provider.create({
      path: source,
      identity: { role: "generic", id: role },
    });
    const artifactPath = path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
    let manifest: SnapshotManifest = {
      ...snapshot.manifest,
      database: {
        basename: snapshot.manifest.database.basename,
        userVersion: previousVersion,
        ...(role === "agent" ? { role, agentId: "main" } : { role }),
      },
    };
    const writeManifest = () =>
      fs.writeFile(
        path.join(snapshot.ref.path, SNAPSHOT_MANIFEST_FILENAME),
        `${JSON.stringify(manifest)}\n`,
      );
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
      const digest = await hashSnapshotArtifact(snapshot.ref.path);
      manifest = {
        ...manifest,
        database: { ...manifest.database, userVersion: version },
        artifact: { ...manifest.artifact, sha256: digest.sha256, sizeBytes: digest.sizeBytes },
      };
      await writeManifest();
    }

    await rewriteVersion(currentVersion + 1);
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/newer/u);
    const refusedTarget = path.join(root, "refused.sqlite");
    await expect(provider.restoreFresh(snapshot.ref, refusedTarget)).rejects.toThrow(/newer/u);
    await expect(fs.access(refusedTarget)).rejects.toMatchObject({ code: "ENOENT" });

    await rewriteVersion(previousVersion, currentVersion);
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/snapshot schema version/u);

    await rewriteVersion(0);
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/snapshot schema version/u);

    await rewriteVersion(previousVersion);
    withDatabase(artifactPath, (db) => {
      db.prepare("UPDATE schema_meta SET role = ?").run(role === "global" ? "agent" : "global");
    });
    const digest = await hashSnapshotArtifact(snapshot.ref.path);
    manifest = {
      ...manifest,
      artifact: { ...manifest.artifact, sha256: digest.sha256, sizeBytes: digest.sizeBytes },
    };
    await writeManifest();
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/expected global|expected agent/u);
  },
);
