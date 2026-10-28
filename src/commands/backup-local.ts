import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { z } from "zod";
import { createConfigIO, resolveStateDir } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import {
  publishFileExclusive,
  requireDirectorySync,
  syncDirectory,
} from "../infra/directory-durability.js";
import { tryReadDiskSpace } from "../infra/disk-space.js";
import { ignoreMissingPath } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "../infra/update-candidate-state.js";
import {
  createUpdateDatabaseBackupInProcess,
  UpdateDatabaseBackupSchema,
  type UpdateDatabaseBackup,
} from "../infra/update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "../infra/update-database-restore.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  BACKUP_MAX_DECOMPRESSION_RATIO,
  resolveBackupAgentRoots,
  resolveRequiredBackupPath,
} from "./backup-shared.js";

const imageEntry = UpdateDatabaseBackupSchema.shape.databases.element
  .omit({ snapshotPath: true, engine: true, storeId: true, namespace: true, exportDirectory: true })
  .extend({ image: z.string().regex(/^images\/\d+\.sqlite$/u) })
  .strict();
const localManifest = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("local-checkpoint"),
  stateDir: z.string(),
  databases: z.array(imageEntry).min(2),
});

function readLocalCheckpointConfig() {
  // Config observation would create the database targets before a fresh restore.
  return createConfigIO({
    observe: false,
    pluginValidation: "core-only",
    shellEnvFallback: "defer",
  }).loadConfigAsync({ skipSuspiciousRecovery: true });
}

async function localTargets(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  return new Set(
    [
      resolveOpenClawStateSqlitePath(env),
      resolveClientCredentialStorePath(env),
      ...(await resolveBackupAgentRoots(config)).map((entry) => entry.databasePath),
    ].map(resolvePathViaExistingAncestorSync),
  );
}

export async function backupLocalCreateCommand(
  runtime: RuntimeEnv,
  options: { output?: string; json?: boolean },
) {
  const archivePath = resolvePathViaExistingAncestorSync(
    resolveRequiredBackupPath(options.output, "--output"),
  );
  const stateDir = resolvePathViaExistingAncestorSync(resolveStateDir());
  const relative = path.relative(stateDir, archivePath);
  if (
    !relative ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  ) {
    throw new Error("Local checkpoint output must be outside the state directory.");
  }
  const config = await readLocalCheckpointConfig();
  const scratch = await fs.mkdtemp(path.join(path.dirname(archivePath), ".openclaw-local-backup-"));
  try {
    const input = {
      backupRoot: path.join(scratch, "capture"),
      stateDir,
      stagingRoot: path.join(scratch, "staging"),
      config,
      env: process.env,
      captureScope: "local-files" as const,
      preserveSourceArtifacts: true,
    };
    await fs.mkdir(`${input.backupRoot}.databases`, { mode: 0o700 });
    await fs.mkdir(input.stagingRoot, { mode: 0o700 });
    const backup = await createUpdateDatabaseBackupInProcess({
      ...input,
      inspectionPlan: await discoverUpdateStateSchemaInspectionInProcess(input),
    });
    await fs.mkdir(path.join(scratch, "images"), { mode: 0o700 });
    const databases = [];
    for (const [index, entry] of backup.databases.entries()) {
      const image = `images/${index}.sqlite`;
      await fs.copyFile(entry.snapshotPath, path.join(scratch, image));
      await fs.chmod(path.join(scratch, image), 0o600);
      const {
        snapshotPath: _snapshotPath,
        engine: _engine,
        storeId: _storeId,
        namespace: _namespace,
        exportDirectory: _exportDirectory,
        ...stored
      } = entry;
      databases.push(imageEntry.parse({ ...stored, image }));
    }
    const manifest = localManifest.parse({
      schemaVersion: 1,
      kind: "local-checkpoint",
      stateDir,
      databases,
    });
    await fs.writeFile(path.join(scratch, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    });
    const stagedArchive = path.join(scratch, "archive.tar.gz");
    await tar.create(
      { file: stagedArchive, gzip: true, cwd: scratch, portable: true, noDirRecurse: true },
      ["manifest.json", ...databases.map((entry) => entry.image)],
    );
    await fs.chmod(stagedArchive, 0o600);
    const handle = await fs.open(stagedArchive, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishFileExclusive({
      sourcePath: stagedArchive,
      targetPath: archivePath,
      expectedSourceIdentity: await fs.lstat(stagedArchive, { bigint: true }),
      strategy: "link-required",
    });
    requireDirectorySync(
      await syncDirectory(path.dirname(archivePath)),
      "Local checkpoint archive",
    );
    const result = {
      ok: true as const,
      archivePath,
      databaseCount: databases.length,
      sizeBytes: (await fs.stat(archivePath)).size,
    };
    if (options.json) {
      writeRuntimeJson(runtime, result);
    } else {
      runtime.log(`Local checkpoint created: ${archivePath}`);
    }
    return result;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

export async function backupLocalRestoreCommand(
  runtime: RuntimeEnv,
  archive: string,
  options: { json?: boolean },
) {
  const archivePath = resolveRequiredBackupPath(archive, "<archive>");
  const stateDir = resolvePathViaExistingAncestorSync(resolveStateDir());
  const config = await readLocalCheckpointConfig();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-restore-"));
  let restoreStarted = false;
  let restored = false;
  try {
    const entries = new Set<string>();
    let invalidEntry: string | undefined;
    let extractionBytes = 0;
    await tar.list({
      file: archivePath,
      strict: true,
      onReadEntry: (entry) => {
        if (
          entry.type !== "File" ||
          !(entry.path === "manifest.json" || /^images\/\d+\.sqlite$/u.test(entry.path)) ||
          entries.has(entry.path)
        ) {
          invalidEntry ??= entry.path;
        }
        entries.add(entry.path);
        extractionBytes += entry.size;
      },
    });
    if (invalidEntry !== undefined) {
      throw new Error(`Invalid local checkpoint archive entry: ${invalidEntry}`);
    }
    if (!entries.has("manifest.json")) {
      throw new Error("Local checkpoint manifest is missing.");
    }
    const archiveBytes = (await fs.stat(archivePath)).size;
    const disk = tryReadDiskSpace(scratch);
    if (
      extractionBytes > archiveBytes * BACKUP_MAX_DECOMPRESSION_RATIO ||
      (disk && disk.availableBytes < extractionBytes + 64 * 1024 * 1024)
    ) {
      throw new Error("Local checkpoint exceeds safe extraction capacity.");
    }
    await tar.extract({
      file: archivePath,
      cwd: scratch,
      strict: true,
      filter: (entry, metadata) =>
        entries.has(entry) && metadata instanceof tar.ReadEntry && metadata.type === "File",
    });
    const manifest = localManifest.parse(
      JSON.parse(await fs.readFile(path.join(scratch, "manifest.json"), "utf8")),
    );
    if (manifest.stateDir !== stateDir) {
      throw new Error("Local checkpoint belongs to a different state directory.");
    }
    const targets = await localTargets(config, process.env);
    const paths = new Set<string>();
    const images = new Set<string>();
    for (const entry of manifest.databases) {
      if (
        !targets.has(entry.path) ||
        paths.has(entry.path) ||
        images.has(entry.image) ||
        !entries.has(entry.image)
      ) {
        throw new Error(
          `Local checkpoint database path does not match configured ownership: ${entry.path}`,
        );
      }
      paths.add(entry.path);
      images.add(entry.image);
    }
    const sharedPath = resolvePathViaExistingAncestorSync(
      resolveOpenClawStateSqlitePath(process.env),
    );
    const clientPath = resolvePathViaExistingAncestorSync(
      resolveClientCredentialStorePath(process.env),
    );
    if (!paths.has(sharedPath) || !paths.has(clientPath) || entries.size !== images.size + 1) {
      throw new Error(
        "Local checkpoint requires its matched global/client pair and exact image inventory.",
      );
    }
    for (const file of paths) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const present = await fs.lstat(`${file}${suffix}`).catch(ignoreMissingPath);
        if (present) {
          throw new Error(`Local checkpoint restore requires fresh database targets: ${file}`);
        }
      }
    }
    const backup: UpdateDatabaseBackup = {
      captureScope: "local-files",
      directory: scratch,
      databases: manifest.databases.map(({ image, ...entry }) => ({
        ...entry,
        snapshotPath: path.join(scratch, image),
      })),
      sourcePaths: [...paths],
      missingPaths: [],
      sourceGenerations: {},
      warnings: [],
    };
    restoreStarted = true;
    await restoreUpdateDatabaseBackup({
      backup,
      env: process.env,
      runId: randomUUID(),
      requireFresh: true,
      assertCurrent() {},
    });
    restored = true;
    const result = {
      ok: true as const,
      archivePath,
      stateDir,
      databaseCount: manifest.databases.length,
    };
    if (options.json) {
      writeRuntimeJson(runtime, result);
    } else {
      runtime.log(`Local checkpoint restored: ${stateDir}`);
    }
    return result;
  } catch (error) {
    if (restoreStarted && !restored) {
      throw new Error(
        `Local checkpoint restore failed: ${formatErrorMessage(error)}; recovery images retained at ${scratch}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  } finally {
    if (!restoreStarted || restored) {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
}
