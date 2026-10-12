import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createRehearsalPathInspector } from "./doctor-update-rehearsal-paths.js";

/** Only core images in Doctor's currently owned disposable namespace need no second backup. */
export function createDoctorRehearsalDatabaseCoverage(env: NodeJS.ProcessEnv) {
  const root = resolveUpdateRehearsalRoot(env);
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!root || !maintenance?.ownsSchemaMaintenance) {
    return undefined;
  }
  maintenance.assertAdmission();
  // The native Doctor owner protects shared-state admission. Agent paths are
  // discovered separately; that owner does not pretend to lock each agent file.
  maintenance.assertDatabaseAccess(resolveOpenClawStateSqlitePath(env));
  const inspect = (pathname: string) => {
    const inspector = createRehearsalPathInspector(root, []);
    const stat = inspector.inspectPath(pathname);
    const identities = new Map<string, BigIntStats | undefined>();
    for (const filename of inspector.identities.keys()) {
      const identity = lstatSync(filename, { bigint: true });
      if (identity.dev === 0n || identity.ino === 0n) {
        throw new Error(`Disposable database identity is unavailable: ${filename}`);
      }
      identities.set(filename, identity);
    }
    if (!stat) {
      identities.set(pathname, undefined);
    }
    return { stat, identities };
  };
  let rootIdentity: BigIntStats;
  try {
    if (
      path.resolve(root) !== root ||
      realpathSync(root) !== root ||
      !inspect(root).stat?.isDirectory()
    ) {
      return undefined;
    }
    rootIdentity = lstatSync(root, { bigint: true });
  } catch {
    return undefined;
  }
  const identities = new Map<string, BigIntStats | undefined>([[root, rootIdentity]]);
  const databases = new Set<string>();
  const family = new Set<string>();
  const aliases = new Map<string, string>();
  const assertCurrent = () => {
    maintenance.assertAdmission();
    maintenance.assertDatabaseAccess(resolveOpenClawStateSqlitePath(env));
    if (resolveUpdateRehearsalRoot(env) !== root || realpathSync(root) !== root) {
      throw new Error("Disposable Doctor database namespace changed");
    }
    for (const [filename, before] of identities) {
      const { identities: current } = inspect(filename);
      const after = current.get(filename);
      if (
        before
          ? !after || after.dev !== before.dev || after.ino !== before.ino
          : after !== undefined
      ) {
        throw new Error(`Disposable Doctor database identity changed: ${filename}`);
      }
    }
    for (const [filename, target] of aliases) {
      if (resolvePathViaExistingAncestorSync(filename) !== target) {
        throw new Error(`Disposable Doctor database alias changed: ${filename}`);
      }
    }
  };
  return {
    assertCurrent,
    /** Call with the complete core discovery, never arbitrary plugin declarations. */
    admit(paths: readonly string[]): readonly string[] {
      assertCurrent();
      for (const filename of paths) {
        if (databases.has(filename)) {
          continue;
        }
        const captured = new Map<string, BigIntStats | undefined>();
        try {
          if (!inspect(filename).stat?.isFile() || realpathSync(filename) !== filename) {
            continue;
          }
          for (const companion of resolveSqliteDatabaseFilePaths(filename)) {
            const inspected = inspect(companion);
            if (inspected.stat && !inspected.stat.isFile()) {
              throw new Error(`Disposable database companion is not a regular file: ${companion}`);
            }
            for (const [entry, identity] of inspected.identities) {
              captured.set(entry, identity);
            }
          }
        } catch {
          // Unknown or foreign physical data keeps its ordinary backup requirement.
          continue;
        }
        for (const [entry, identity] of captured) {
          identities.set(entry, identity);
        }
        databases.add(filename);
        for (const companion of resolveSqliteDatabaseFilePaths(filename)) {
          family.add(companion);
        }
      }
      assertCurrent();
      return [...databases];
    },
    excludes(filename: string): boolean {
      const target = resolvePathViaExistingAncestorSync(filename);
      if (!family.has(target)) {
        return false;
      }
      if (target !== filename && !aliases.has(filename)) {
        aliases.set(filename, target);
      }
      return true;
    },
    get paths(): readonly string[] {
      return [...family].toSorted();
    },
  };
}

export type DoctorRehearsalDatabaseCoverage = NonNullable<
  ReturnType<typeof createDoctorRehearsalDatabaseCoverage>
>;
