import fsNode, { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createPreUpdateConfigSnapshot } from "../../config/backup-rotation.js";
import { createConfigIO } from "../../config/io.factory.js";
import {
  containsConfigIncludeDirective,
  hashConfigRaw,
  parseConfigJson5,
} from "../../config/io.read-helpers.js";
import {
  assertConfigFileWritePathSnapshot,
  captureConfigFileWritePathProof,
  type ConfigFileWritePathSnapshot,
} from "../../config/io.write-safety.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import { resolveConfigPath } from "../../config/paths.js";
import {
  BackupConfigCaptureError,
  readBackupConfigCaptureFile,
  resolveBackupConfigCapture,
} from "../../infra/backup-config-capture.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";

type UpdateConfigFileSnapshot = {
  path: string;
  raw: string | null;
  hash: string;
  doctorOwned?: boolean;
  pathSnapshot?: ConfigFileWritePathSnapshot;
};

export type UpdateConfigSnapshot = UpdateConfigFileSnapshot & {
  includedFiles?: UpdateConfigFileSnapshot[];
};

export async function readUpdateConfigSnapshot(path: string): Promise<UpdateConfigSnapshot> {
  const raw = await fs.readFile(path, "utf8").catch((error: unknown) => {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    return null;
  });
  return { path, raw, hash: hashConfigRaw(raw) };
}

/** Keep the authored include graph with the root's existing rollback snapshot. */
export async function captureUpdateConfigSnapshot(
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<UpdateConfigSnapshot> {
  const root = await readUpdateConfigSnapshot(configPath);
  const parsed = root.raw === null ? undefined : parseConfigJson5(root.raw);
  if (!parsed?.ok || !containsConfigIncludeDirective(parsed.parsed)) {
    return root;
  }
  return await withOpenClawStateDatabaseReadSnapshot(
    async () => {
      const selected = await createConfigIO({
        configPath,
        env,
        observe: false,
        // The candidate may already have migrated state beyond this updater's schema.
        pluginValidation: "core-only",
      }).readConfigFileSnapshotForWrite();
      if (selected.snapshot.raw !== root.raw) {
        throw new ConfigMutationConflictError("config changed while preparing update capture");
      }
      // Doctor can repair an unresolved include; incomplete preimages cannot authorize rollback.
      if (selected.snapshot.includeProvenance === undefined) {
        return { ...root, doctorOwned: false };
      }
      const capture = await resolveBackupConfigCapture(selected, {
        env,
        pluginValidation: "core-only",
        allowIncludeAliases: true,
      });
      const rootTarget = await fs.realpath(configPath);
      const files = new Map<
        string,
        UpdateConfigFileSnapshot & { pathSnapshot: ConfigFileWritePathSnapshot }
      >();
      for (const file of capture.files) {
        const sourcePath = file.canonicalPath === rootTarget ? configPath : file.sourcePath;
        const proof = captureConfigFileWritePathProof(sourcePath, file.canonicalPath, fsNode);
        const raw = (await readBackupConfigCaptureFile(file)).toString("utf8");
        proof.assertCurrent();
        const existing = files.get(file.canonicalPath);
        if (existing) {
          if (existing.raw !== raw) {
            throw new ConfigMutationConflictError("config include changed during update capture");
          }
          existing.pathSnapshot.entries.push(...proof.snapshot.entries);
        } else {
          files.set(file.canonicalPath, {
            path: sourcePath,
            raw,
            hash: hashConfigRaw(raw),
            pathSnapshot: proof.snapshot,
          });
        }
      }
      await capture.revalidate();
      for (const file of files.values()) {
        assertConfigFileWritePathSnapshot(file.pathSnapshot, fsNode);
      }
      const capturedRoot = files.get(rootTarget);
      if (!capturedRoot) {
        throw new Error("Update config capture is missing its root file.");
      }
      return {
        ...capturedRoot,
        includedFiles: [...files.values()].filter((file) => file !== capturedRoot),
      };
    },
    { env },
  ).catch((error: unknown) => {
    if (error instanceof BackupConfigCaptureError || error instanceof ConfigMutationConflictError) {
      return { ...root, doctorOwned: false };
    }
    throw error;
  });
}

export async function createUpdateConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await createPreUpdateConfigSnapshot({
    configPath: resolveConfigPath(env),
    fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
  });
}
