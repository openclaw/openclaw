import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { root as openFsRoot } from "./fs-safe.js";
import {
  collectPackageDistInventory,
  isLegacyContentInventoryCompatVersion,
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  readPackageDistContentInventoryIfPresent,
} from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import {
  assertRecoveryRootOutsidePackageRoot,
  countChanges,
  fileModesHaveSameExecutableSemantics,
  isMissingPathError,
  normalizeDistPath,
  normalizeFileMode,
  normalizeRelativePath,
  packageRootExists,
  resolveSafePackagePath,
  writeFileWithMode,
  type LocalOverridePackageRoot,
  type LocalPackageOverrideChange,
  type LocalPackageOverridesPlan,
  type LocalPackageOverridesResult,
} from "./package-local-overrides-shared.js";

async function copyOverridePayload(params: {
  packageFs: LocalOverridePackageRoot;
  recoveryDir: string;
  relativePath: string;
}): Promise<{ savedPath: string; mode: number }> {
  const source = await params.packageFs.read(params.relativePath, {
    hardlinks: "allow",
    maxBytes: Number.POSITIVE_INFINITY,
    symlinks: "reject",
  });
  const mode = normalizeFileMode(source.stat.mode);
  const savedPath = path.join(
    params.recoveryDir,
    "files",
    normalizeRelativePath(params.relativePath),
  );
  await writeFileWithMode(source.buffer, savedPath, mode);
  return { savedPath, mode };
}

const BEST_EFFORT_LOCAL_PATH_LITERAL_PATTERN = /["'`]([^"'`\r\n]+)["'`]/gu;
const CONTENT_HASHED_DIST_ARTIFACT_PATTERN = /-([A-Za-z0-9_]{8,})\.(?:cjs|css|js|mjs)(?:\.map)?$/u;

function isLikelyContentHashedDistArtifact(relativePath: string): boolean {
  const filename = path.posix.basename(normalizeDistPath(relativePath));
  return CONTENT_HASHED_DIST_ARTIFACT_PATTERN.test(filename);
}

function resolveReferencedDistPath(params: {
  fromPath: string;
  specifier: string;
  actualSet: Set<string>;
}): string | null {
  const specifierPath = params.specifier.split(/[?#]/u, 1)[0] ?? "";
  if (!specifierPath.startsWith(".")) {
    return null;
  }
  const basePath = normalizeDistPath(
    path.posix.join(path.posix.dirname(params.fromPath), specifierPath),
  );
  const candidates = [
    basePath,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    `${basePath}.json`,
    path.posix.join(basePath, "index.js"),
  ];
  return candidates.find((candidate) => params.actualSet.has(candidate)) ?? null;
}

async function collectReferencedAddedOverridePaths(params: {
  packageFs: LocalOverridePackageRoot;
  changes: LocalPackageOverrideChange[];
  actualSet: Set<string>;
  baselineSet: Set<string>;
  standaloneAddedPaths: string[];
}): Promise<{
  addedPaths: string[];
  dependenciesByChangePath: Map<string, string[]>;
}> {
  const addedPaths = new Set<string>();
  const dependenciesByChangePath = new Map<string, Set<string>>();
  const scannedPathsByRoot = new Set<string>();
  const modifiedChangesByPath = new Map(
    params.changes
      .filter((change) => change.kind === "modified" && change.savedPath)
      .map((change) => [change.path, change]),
  );
  const queue: Array<
    | { path: string; rootPath: string; sourcePath: string }
    | { path: string; rootPath: string; packageRelativePath: string }
  > = [
    ...params.changes
      .filter((change) => change.kind === "modified" && change.savedPath)
      .map((change) => ({
        path: change.path,
        rootPath: change.path,
        sourcePath: change.savedPath as string,
      })),
    ...params.standaloneAddedPaths.map((relativePath) => ({
      path: relativePath,
      rootPath: relativePath,
      packageRelativePath: relativePath,
    })),
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    // Shared added files must be rescanned per override root so partial-conflict
    // reapply keeps each clean importer with its full dependency closure.
    const scanKey = `${current.rootPath}\0${current.path}`;
    if (scannedPathsByRoot.has(scanKey)) {
      continue;
    }
    scannedPathsByRoot.add(scanKey);
    const source =
      "packageRelativePath" in current
        ? await params.packageFs
            .readText(current.packageRelativePath, {
              hardlinks: "allow",
              maxBytes: Number.POSITIVE_INFINITY,
              symlinks: "reject",
            })
            .catch(() => "")
        : await fs.readFile(current.sourcePath, "utf8").catch(() => "");
    for (const match of source.matchAll(BEST_EFFORT_LOCAL_PATH_LITERAL_PATTERN)) {
      const specifier = match[1] ?? "";
      const referencedPath = resolveReferencedDistPath({
        fromPath: current.path,
        specifier,
        actualSet: params.actualSet,
      });
      if (!referencedPath) {
        continue;
      }
      const referencedModifiedChange = modifiedChangesByPath.get(referencedPath);
      if (params.baselineSet.has(referencedPath) && !referencedModifiedChange) {
        continue;
      }
      const dependencies = dependenciesByChangePath.get(current.rootPath) ?? new Set<string>();
      dependencies.add(referencedPath);
      dependenciesByChangePath.set(current.rootPath, dependencies);
      if (!params.baselineSet.has(referencedPath)) {
        addedPaths.add(referencedPath);
      }
      const referencedScanKey = `${current.rootPath}\0${referencedPath}`;
      if (!scannedPathsByRoot.has(referencedScanKey)) {
        queue.push(
          referencedModifiedChange?.savedPath
            ? {
                path: referencedPath,
                rootPath: current.rootPath,
                sourcePath: referencedModifiedChange.savedPath,
              }
            : {
                path: referencedPath,
                rootPath: current.rootPath,
                packageRelativePath: referencedPath,
              },
        );
      }
    }
  }

  return {
    addedPaths: [...addedPaths].toSorted((left, right) => left.localeCompare(right)),
    dependenciesByChangePath: new Map(
      [...dependenciesByChangePath].map(([changePath, dependencies]) => [
        changePath,
        [...dependencies].toSorted((left, right) => left.localeCompare(right)),
      ]),
    ),
  };
}

export async function captureLocalPackageOverrides(params: {
  packageRoot: string;
  recordedPackageRoot?: string;
}): Promise<LocalPackageOverridesPlan | null> {
  if (!(await packageRootExists(params.packageRoot))) {
    return null;
  }
  const baseline = await readPackageDistContentInventoryIfPresent(params.packageRoot);
  if (baseline === null) {
    const packageVersion = await readPackageVersion(params.packageRoot);
    if (isLegacyContentInventoryCompatVersion(packageVersion)) {
      return null;
    }
    throw new Error(
      `missing package dist content inventory ${PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH}`,
    );
  }
  const packageFs = await openFsRoot(params.packageRoot, {
    hardlinks: "reject",
    nonBlockingRead: true,
    symlinks: "reject",
  });

  const actualFiles = await collectPackageDistInventory(params.packageRoot, {
    includePackageExcludedFiles: true,
  });
  const actualSet = new Set(actualFiles);
  const actualCaseFoldedSet = new Set(
    actualFiles.map((relativePath) => relativePath.toLocaleLowerCase("en-US")),
  );
  const changes: LocalPackageOverrideChange[] = [];
  let recoveryDir: string | null = null;
  const ensureRecoveryDir = async () => {
    if (!recoveryDir) {
      const recoveryRoot = path.join(resolveStateDir(), "update-recovery");
      await assertRecoveryRootOutsidePackageRoot(params.packageRoot, recoveryRoot);
      if (params.recordedPackageRoot && params.recordedPackageRoot !== params.packageRoot) {
        await assertRecoveryRootOutsidePackageRoot(params.recordedPackageRoot, recoveryRoot);
      }
      await fs.mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
      recoveryDir = await fs.mkdtemp(path.join(recoveryRoot, "openclaw-local-overrides-"));
    }
    return recoveryDir;
  };

  try {
    const baselineSet = new Set(baseline.map((entry) => entry.path));
    for (const entry of baseline) {
      resolveSafePackagePath(params.packageRoot, entry.path);
      let current;
      try {
        current = await packageFs.read(entry.path, {
          hardlinks: "allow",
          maxBytes: Number.POSITIVE_INFINITY,
          symlinks: "reject",
        });
      } catch (error) {
        if (!actualSet.has(entry.path) && isMissingPathError(error)) {
          await ensureRecoveryDir();
          changes.push({ kind: "deleted", path: entry.path, baseline: entry });
          continue;
        }
        throw error;
      }
      if (!actualSet.has(entry.path)) {
        if (!actualCaseFoldedSet.has(entry.path.toLocaleLowerCase("en-US"))) {
          throw new Error(`package dist inventory changed during override capture: ${entry.path}`);
        }
        await ensureRecoveryDir();
        changes.push({ kind: "deleted", path: entry.path, baseline: entry });
        continue;
      }
      const currentMode = normalizeFileMode(current.stat.mode);
      const currentSha = createHash("sha256").update(current.buffer).digest("hex");
      if (
        currentSha === entry.sha256 &&
        fileModesHaveSameExecutableSemantics(currentMode, entry.mode)
      ) {
        continue;
      }
      const payload = await copyOverridePayload({
        packageFs,
        recoveryDir: await ensureRecoveryDir(),
        relativePath: entry.path,
      });
      changes.push({
        kind: "modified",
        path: entry.path,
        baseline: entry,
        savedPath: payload.savedPath,
        mode: payload.mode,
      });
    }
    const standaloneAddedPaths = actualFiles.filter(
      (relativePath) =>
        !baselineSet.has(relativePath) && !isLikelyContentHashedDistArtifact(relativePath),
    );
    const referencedAdded = await collectReferencedAddedOverridePaths({
      packageFs,
      changes,
      actualSet,
      baselineSet,
      standaloneAddedPaths,
    });
    for (const change of changes) {
      if (change.kind === "modified") {
        change.dependencies = referencedAdded.dependenciesByChangePath.get(change.path) ?? [];
      }
    }
    const replayableAddedPaths = new Set([...standaloneAddedPaths, ...referencedAdded.addedPaths]);
    const allAddedPaths = actualFiles.filter((relativePath) => !baselineSet.has(relativePath));
    for (const relativePath of allAddedPaths.toSorted((left, right) => left.localeCompare(right))) {
      const payload = await copyOverridePayload({
        packageFs,
        recoveryDir: await ensureRecoveryDir(),
        relativePath,
      });
      changes.push({
        kind: "added",
        path: relativePath,
        dependencies: referencedAdded.dependenciesByChangePath.get(relativePath) ?? [],
        ...(replayableAddedPaths.has(relativePath) ? {} : { reapply: false }),
        savedPath: payload.savedPath,
        mode: payload.mode,
      });
    }

    if (changes.length === 0) {
      return null;
    }
    const finalRecoveryDir = await ensureRecoveryDir();

    const counts = countChanges(changes);
    const result: LocalPackageOverridesResult = {
      status: "none",
      ...counts,
      applied: 0,
      conflicts: [],
      recoveryDir: finalRecoveryDir,
      warnings: [],
    };
    await fs.writeFile(
      path.join(finalRecoveryDir, "manifest.json"),
      JSON.stringify(
        { packageRoot: params.recordedPackageRoot ?? params.packageRoot, changes },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    return {
      packageRoot: params.recordedPackageRoot ?? params.packageRoot,
      recoveryDir: finalRecoveryDir,
      changes,
      result,
    };
  } catch (error) {
    if (recoveryDir) {
      await fs.rm(recoveryDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}
