import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertDirectoryIdentitySync } from "@openclaw/fs-safe/advanced";
import { hasErrnoCode } from "../infra/errno.js";
import type { PluginCohortRecovery } from "../infra/update-plugin-cohort-schema.js";
import {
  isPluginNpmManagedPath,
  isPluginNpmProjectDir,
  resolveDefaultPluginNpmDir,
} from "./install-paths.js";
import {
  resolveRetainedManagedNpmInstallPackageInfo,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";

export type PluginCohortArtifactIdentity = NonNullable<
  PluginCohortRecovery["priorArtifacts"][number]["identity"]
>;

/** Small metadata observations run in the index worker or the owning updater. */
export function readPluginCohortArtifactIdentity(packageDir: string): PluginCohortArtifactIdentity {
  const stat = fs.lstatSync(packageDir, { bigint: true });
  const identity = {
    realPath: fs.realpathSync.native(packageDir),
    dev: String(stat.dev),
    ino: String(stat.ino),
    manifestSha256: createHash("sha256")
      .update(fs.readFileSync(path.join(packageDir, "package.json")))
      .digest("hex"),
  };
  assertPluginCohortArtifactDirectory(packageDir, identity);
  return identity;
}

/** A missing directory is a baseline; an existing partial payload is still an error. */
export function readPluginCohortArtifactPreimage(
  packageDir: string,
): PluginCohortArtifactIdentity | null {
  try {
    return readPluginCohortArtifactIdentity(packageDir);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    try {
      fs.lstatSync(packageDir);
    } catch (inspectionError) {
      if (hasErrnoCode(inspectionError, "ENOENT")) {
        return null;
      }
      throw inspectionError;
    }
    throw error;
  }
}

export function assertPluginCohortArtifactDirectory(
  packageDir: string,
  identity: PluginCohortArtifactIdentity,
): void {
  assertDirectoryIdentitySync(packageDir, {
    dev: BigInt(identity.dev),
    ino: BigInt(identity.ino),
    realPath: identity.realPath,
  });
}

export function ownsPluginCohortRetentionMarker(
  packageDir: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const info = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!info) {
    return false;
  }
  const npmDir = resolveDefaultPluginNpmDir(env);
  return (
    isPluginNpmManagedPath({ managedPath: packageDir, npmDir }) &&
    (path.resolve(info.projectRoot) === path.resolve(npmDir) ||
      isPluginNpmProjectDir({
        npmDir,
        packageName: info.packageName,
        projectDir: info.projectRoot,
      }))
  );
}

export function readPluginCohortRetentionMarker(
  packageDir: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!ownsPluginCohortRetentionMarker(packageDir, env)) {
    return null;
  }
  try {
    return fs.readFileSync(resolveRetainedManagedNpmInstallMarkerPath(packageDir), "utf8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}
