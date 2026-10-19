import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryReadJsonSync } from "../infra/json-files.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import {
  isPluginNpmProjectDir,
  resolvePluginNpmProjectsDir,
  validatePluginId,
} from "./install-paths.js";

function sortPaths(paths: string[]): string[] {
  return paths.toSorted((left, right) => left.localeCompare(right));
}

type ManagedNpmProject = {
  projectRoot: string;
  manifest: Record<string, unknown>;
};

function readManagedProjects(projectDirs: string[], npmDir: string): ManagedNpmProject[] {
  return sortPaths(projectDirs).flatMap((projectRoot) => {
    const manifest = tryReadJsonSync(path.join(projectRoot, "package.json"));
    if (!isRecord(manifest) || !isRecord(manifest.dependencies)) {
      return [];
    }
    // Staging, backup, and quarantine directories are not published projects.
    // Carry the admitted manifest into recovery instead of opening it again.
    const managed = Object.keys(manifest.dependencies).some(
      (packageName) =>
        validatePluginId(packageName) === null &&
        isPluginNpmProjectDir({ packageName, projectDir: projectRoot, npmDir }),
    );
    return managed ? [{ projectRoot, manifest }] : [];
  });
}

/** Lists directory candidates; each consumer establishes its own package ownership. */
export function listPluginNpmProjectCandidatesSync(npmRoot: string): string[] {
  const projectsDir = resolvePluginNpmProjectsDir(npmRoot);
  try {
    return sortPaths(
      fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsDir, entry.name)),
    );
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return [];
    }
    throw error;
  }
}

/** Lists admitted projects with the manifest that established their managed ownership. */
export function listManagedPluginNpmProjectsSync(npmRoot: string): ManagedNpmProject[] {
  return readManagedProjects(listPluginNpmProjectCandidatesSync(npmRoot), npmRoot);
}

/** Returns the root npm install plus all managed project npm roots. */
export function listManagedPluginNpmRootsSync(npmRoot: string): string[] {
  return [
    npmRoot,
    ...listManagedPluginNpmProjectsSync(npmRoot).map(({ projectRoot }) => projectRoot),
  ];
}
