import fsNode, { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { createPreUpdateConfigSnapshot } from "../../config/backup-rotation.js";
import { createConfigIO } from "../../config/io.factory.js";
import {
  containsConfigIncludeDirective,
  hashConfigRaw,
  parseConfigJson5,
  normalizeConfigIoDeps,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
} from "../../config/io.read-helpers.js";
import type { ConfigFileWritePathSnapshot } from "../../config/io.write-path.types.js";
import {
  captureConfigFileWritePathProof,
  assertConfigFileWritePathSnapshot,
} from "../../config/io.write-safety.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import { resolveConfigPath } from "../../config/paths.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import {
  BackupConfigCaptureError,
  readBackupConfigCaptureFile,
  resolveBackupConfigCapture,
} from "../../infra/backup-config-capture.js";
import { ignoreMissingPath } from "../../infra/errno.js";

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
  const raw = (await fs.readFile(path, "utf8").catch(ignoreMissingPath)) ?? null;
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
  try {
    const selected = await createConfigIO({
      configPath,
      env,
      observe: false,
      // Capture authored files only; candidate Doctor owns state verification.
      pluginValidation: "core-only",
    }).readConfigFileSnapshotForWrite();
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
    const capturedRoot = files.get(rootTarget);
    if (!capturedRoot) {
      throw new Error("Update config capture is missing its root file.");
    }
    return {
      ...capturedRoot,
      includedFiles: [...files.values()].filter((file) => file !== capturedRoot),
    };
  } catch (error) {
    if (error instanceof BackupConfigCaptureError || error instanceof ConfigMutationConflictError) {
      return { ...root, doctorOwned: false };
    }
    throw error;
  }
}

export async function createUpdateConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await createPreUpdateConfigSnapshot({
    configPath: resolveConfigPath(env),
    fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
  });
}

/** Read the activation-owned files under their captured path proofs before rollback. */
export async function isUpdateConfigRollbackUnchanged(params: {
  files: readonly UpdateConfigFileSnapshot[];
  expectedHashes: ReadonlyMap<string, string>;
  cohortPaths: ReadonlySet<string>;
  cohortSettled: boolean;
  legacySnapshot: Pick<ConfigFileSnapshot, "path" | "parsed" | "includedPaths"> | undefined;
  baseline: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
}): Promise<boolean> {
  const { assertCurrent } = params;
  assertCurrent();
  let unchanged = params.files.every(
    (file) => params.cohortPaths.has(file.path) || file.doctorOwned !== false,
  );
  for (const file of params.files) {
    if (!unchanged) {
      break;
    }
    try {
      if (file.pathSnapshot) {
        assertConfigFileWritePathSnapshot(file.pathSnapshot, fsNode);
      }
      // The cohort journal checks its authored leaves; whole-file hashes cover other files.
      if (params.cohortSettled || !params.cohortPaths.has(file.path)) {
        unchanged =
          (await readUpdateConfigSnapshot(file.path)).hash === params.expectedHashes.get(file.path);
      }
      if (file.pathSnapshot) {
        assertConfigFileWritePathSnapshot(file.pathSnapshot, fsNode);
      }
    } catch (error) {
      if (!(error instanceof ConfigMutationConflictError)) {
        throw error;
      }
      unchanged = false;
    }
    assertCurrent();
  }
  const legacy = params.legacySnapshot;
  if (unchanged && legacy?.includedPaths?.length) {
    // Older handoffs carry only the root snapshot; keep their include refusal.
    const deps = normalizeConfigIoDeps({ env: { ...params.env } });
    const included = resolveConfigIncludesForRead(legacy.parsed, legacy.path, deps);
    unchanged = isDeepStrictEqual(
      params.baseline,
      resolveConfigForRead(included, deps.env).resolvedConfigRaw,
    );
  }
  assertCurrent();
  return unchanged;
}
