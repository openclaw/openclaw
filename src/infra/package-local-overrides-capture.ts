import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isMissingPathError } from "./errno.js";
import { root as openFsRoot } from "./fs-safe.js";
import {
  collectPackageDistInventory,
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  readPackageDistContentInventoryIfPresent,
} from "./package-dist-inventory.js";
import {
  assertRecoveryRootOutsidePackageRoot,
  emptyResult,
  fileModesHaveSameExecutableSemantics,
  normalizeDistPath,
  normalizeFileMode,
  normalizeLocalOverridePathSeparators,
  packageRootExists,
  resolveSafePackagePath,
  writeFileWithMode,
  type LocalPackageOverrideChange,
  type LocalPackageOverridesPlan,
} from "./package-local-overrides-shared.js";

const BEST_EFFORT_LOCAL_PATH_LITERAL_PATTERN = /["'`]([^"'`\r\n]+)["'`]/gu;
const CONTENT_HASHED_DIST_ARTIFACT_PATTERN = /-([A-Za-z0-9_]{8,})\.(?:cjs|css|js|mjs)(?:\.map)?$/u;

function isLikelyContentHashedDistArtifact(relativePath: string): boolean {
  const filename = path.posix.basename(normalizeDistPath(relativePath));
  return CONTENT_HASHED_DIST_ARTIFACT_PATTERN.test(filename);
}

export async function captureLocalPackageOverrides(params: {
  packageRoot: string;
  recordedPackageRoot?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LocalPackageOverridesPlan | null> {
  if (!(await packageRootExists(params.packageRoot))) {
    return null;
  }
  const baseline = await readPackageDistContentInventoryIfPresent(params.packageRoot);
  const packageFs = await openFsRoot(params.packageRoot, {
    hardlinks: "reject",
    symlinks: "reject",
  });

  async function copyOverridePayload(
    recoveryDir: string,
    relativePath: string,
  ): Promise<{ savedPath: string; mode: number }> {
    const source = await packageFs.read(relativePath, {
      hardlinks: "allow",
      maxBytes: Number.POSITIVE_INFINITY,
      symlinks: "reject",
    });
    const mode = normalizeFileMode(source.stat.mode);
    const savedPath = path.join(
      recoveryDir,
      "files",
      normalizeLocalOverridePathSeparators(relativePath),
    );
    await writeFileWithMode(source.buffer, savedPath, mode);
    return { savedPath, mode };
  }

  const actualFiles = (
    await collectPackageDistInventory(params.packageRoot, {
      includePackageExcludedFiles: true,
    })
  ).filter((file) => file !== PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH);
  const actualSet = new Set(actualFiles);
  const actualCaseFoldedSet = new Set(
    actualFiles.map((relativePath) => relativePath.toLocaleLowerCase("en-US")),
  );
  const changes: LocalPackageOverrideChange[] = [];
  let recoveryDir: string | null = null;
  const ensureRecoveryDir = async () => {
    if (!recoveryDir) {
      const recoveryRoot = path.join(resolveStateDir(params.env), "update-recovery");
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
    if (baseline === null) {
      // Shipped filename-only packages cannot distinguish vendor bytes from local edits.
      // Preserve its dist artifact (excluding dependency trees), without claiming a classified/replayable delta.
      const snapshotDir = await ensureRecoveryDir();
      for (const relativePath of actualFiles) {
        await copyOverridePayload(snapshotDir, relativePath);
      }
      const packageRoot = params.recordedPackageRoot ?? params.packageRoot;
      await fs.writeFile(
        path.join(snapshotDir, "manifest.json"),
        JSON.stringify({ packageRoot, changes }, null, 2) + "\n",
      );
      return {
        recoveryDir: snapshotDir,
        changes,
        result: {
          ...emptyResult("preserved"),
          recoveryDir: snapshotDir,
          warnings: [
            "The previous package has no content inventory. Its dist files were preserved in the recovery bundle; local changes cannot be classified or automatically replayed. Inspect and restore trusted files manually.",
          ],
        },
      };
    }
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
          changes.push({ kind: "deleted", path: entry.path, baseline: entry });
          continue;
        }
        throw error;
      }
      if (!actualSet.has(entry.path)) {
        if (!actualCaseFoldedSet.has(entry.path.toLocaleLowerCase("en-US"))) {
          throw new Error(`package dist inventory changed during override capture: ${entry.path}`);
        }
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
      const payload = await copyOverridePayload(await ensureRecoveryDir(), entry.path);
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
    const referencedAdded = await (async (): Promise<{
      addedPaths: string[];
      dependenciesByChangePath: Map<string, string[]>;
    }> => {
      function resolveReferencedDistPath(fromPath: string, specifier: string): string | null {
        const specifierPath = specifier.split(/[?#]/u, 1)[0] ?? "";
        if (!specifierPath.startsWith(".")) {
          return null;
        }
        const basePath = normalizeDistPath(
          path.posix.join(path.posix.dirname(fromPath), specifierPath),
        );
        const candidates = [
          basePath,
          `${basePath}.js`,
          `${basePath}.mjs`,
          `${basePath}.cjs`,
          `${basePath}.json`,
          path.posix.join(basePath, "index.js"),
        ];
        return candidates.find((candidate) => actualSet.has(candidate)) ?? null;
      }

      const addedPaths = new Set<string>();
      const dependenciesByChangePath = new Map<string, Set<string>>();
      const scannedPathsByRoot = new Set<string>();
      const modifiedChangesByPath = new Map(
        changes
          .filter((change) => change.kind === "modified")
          .map((change) => [change.path, change]),
      );
      const queue = [...modifiedChangesByPath.keys(), ...standaloneAddedPaths].map(
        (relativePath) => ({ path: relativePath, rootPath: relativePath }),
      );

      for (const current of queue) {
        // Shared added files are rescanned per override root to retain each
        // importer's complete dependency closure in the recovery manifest.
        const scanKey = `${current.rootPath}\0${current.path}`;
        if (scannedPathsByRoot.has(scanKey)) {
          continue;
        }
        scannedPathsByRoot.add(scanKey);
        const modified = modifiedChangesByPath.get(current.path);
        const source = modified
          ? await fs.readFile(modified.savedPath, "utf8").catch(() => "")
          : await packageFs
              .readText(current.path, {
                hardlinks: "allow",
                maxBytes: Number.POSITIVE_INFINITY,
                symlinks: "reject",
              })
              .catch(() => "");
        for (const match of source.matchAll(BEST_EFFORT_LOCAL_PATH_LITERAL_PATTERN)) {
          const specifier = match[1] ?? "";
          const referencedPath = resolveReferencedDistPath(current.path, specifier);
          if (!referencedPath) {
            continue;
          }
          const referencedModifiedChange = modifiedChangesByPath.get(referencedPath);
          if (baselineSet.has(referencedPath) && !referencedModifiedChange) {
            continue;
          }
          const dependencies = dependenciesByChangePath.get(current.rootPath) ?? new Set<string>();
          dependencies.add(referencedPath);
          dependenciesByChangePath.set(current.rootPath, dependencies);
          if (!baselineSet.has(referencedPath)) {
            addedPaths.add(referencedPath);
          }
          const referencedScanKey = `${current.rootPath}\0${referencedPath}`;
          if (!scannedPathsByRoot.has(referencedScanKey)) {
            queue.push({ path: referencedPath, rootPath: current.rootPath });
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
    })();
    for (const change of changes) {
      if (change.kind === "modified") {
        change.dependencies = referencedAdded.dependenciesByChangePath.get(change.path) ?? [];
      }
    }
    const replayableAddedPaths = new Set([...standaloneAddedPaths, ...referencedAdded.addedPaths]);
    const allAddedPaths = actualFiles.filter((relativePath) => !baselineSet.has(relativePath));
    for (const relativePath of allAddedPaths.toSorted((left, right) => left.localeCompare(right))) {
      const payload = await copyOverridePayload(await ensureRecoveryDir(), relativePath);
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

    const result = {
      ...emptyResult("none"),
      added: changes.filter((change) => change.kind === "added").length,
      modified: changes.filter((change) => change.kind === "modified").length,
      deleted: changes.filter((change) => change.kind === "deleted").length,
      recoveryDir: finalRecoveryDir,
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
