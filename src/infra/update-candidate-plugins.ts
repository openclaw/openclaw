import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import {
  parsePluginInstallRecordMap,
  serializePluginInstallRecordMap,
} from "../config/plugin-install-record-map.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  isPluginInPackageBundledRoots,
  resolveBundledDirFromPackageRoot,
  resolveBundledPluginsDir,
} from "../plugins/bundled-dir.js";
import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import {
  discoverConfiguredPluginLoadPaths,
  resolveBundledSourceCheckoutExtensionsDir,
  resolvePluginPackageEntries,
} from "../plugins/discovery.js";
import { INSTALLED_PLUGIN_INDEX_STATE_KEY } from "../plugins/installed-plugin-index-row.js";
import { loadBundledPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolvePackageExtensionEntries } from "../plugins/manifest.js";
import { pluginCacheRealpathSync } from "../plugins/plugin-cache-files.js";
import { inspectPluginSourceDependencies } from "../plugins/plugin-generation-source-inspection.js";
import type { ConfigMachineStateDatabase } from "../state/config-machine-state.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256Hex } from "./crypto-digest.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { resolveUserPath } from "./home-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import { resolveUpdateCandidatePluginPath } from "./update-candidate-paths.js";
import { resolveUpdateCandidatePluginSourceEntries } from "./update-candidate-plugin-sources.js";
import {
  assertUpdateCandidatePluginCopySource,
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
  UpdateCandidatePluginTreePlanSchema,
} from "./update-candidate-plugin-tree.js";
import { relocateRuntimePath } from "./update-runtime-relocation.js";

function bundledPluginRedirects(
  candidateRoot: string,
  env?: NodeJS.ProcessEnv,
): Map<string, string> {
  const redirects = new Map<string, string>();
  const sourceDir = resolveBundledPluginsDir(env);
  const sourcePackageRoot = sourceDir && resolveOpenClawPackageRootSync({ cwd: sourceDir });
  const candidateDir = resolveBundledDirFromPackageRoot(candidateRoot);
  if (
    !sourceDir ||
    !sourcePackageRoot ||
    !candidateDir ||
    !isPluginInPackageBundledRoots({ rootDir: candidateDir, packageRoot: candidateRoot })
  ) {
    return redirects;
  }
  const bundledEnv = { ...env, OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1" };
  const candidates = new Map(
    loadBundledPluginManifestRegistry({ env: bundledEnv, bundledRoot: candidateDir }).plugins.map(
      (plugin) => [plugin.id, plugin],
    ),
  );
  for (const directory of [sourceDir, resolveBundledSourceCheckoutExtensionsDir(sourceDir)]) {
    if (
      !directory ||
      !isPluginInPackageBundledRoots({ rootDir: directory, packageRoot: sourcePackageRoot })
    ) {
      continue;
    }
    const sourceReal = pluginCacheRealpathSync(directory, true);
    if (!sourceReal) {
      continue;
    }
    for (const source of listBundledPluginMetadata({
      scanDir: directory,
      includeChannelConfigs: false,
    })) {
      const sourceRoot = pluginCacheRealpathSync(path.join(directory, source.dirName), true);
      if (!sourceRoot || !isPathInside(sourceReal, sourceRoot)) {
        continue;
      }
      const manifest = { name: source.packageName, openclaw: source.packageManifest };
      const extensions = resolvePackageExtensionEntries(manifest);
      if (extensions.status !== "ok") {
        continue;
      }
      const entries = resolvePluginPackageEntries({
        packageDir: sourceRoot,
        packageRootRealPath: sourceRoot,
        manifest,
        manifestId: source.manifest.id,
        extensions: extensions.entries,
        origin: "bundled",
        sourceLabel: sourceRoot,
        diagnostics: [],
        rejectHardlinks: false,
      });
      let allEntriesMatched = entries.length === extensions.entries.length;
      const candidateRoots = new Set<string>();
      for (const entry of entries) {
        const candidate = candidates.get(entry.idHint);
        if (!candidate || path.parse(entry.source).name !== path.parse(candidate.source).name) {
          allEntriesMatched = false;
          continue;
        }
        const from = pluginCacheRealpathSync(entry.source, true);
        const to = pluginCacheRealpathSync(candidate.source, true);
        const targetRoot = pluginCacheRealpathSync(candidate.rootDir, true);
        if (
          !from ||
          !to ||
          !targetRoot ||
          !isPathInside(sourceRoot, from) ||
          !isPathInside(targetRoot, to) ||
          !isPluginInPackageBundledRoots({ rootDir: targetRoot, packageRoot: candidateRoot })
        ) {
          allEntriesMatched = false;
          continue;
        }
        redirects.set(from, to);
        const declared = pluginCacheRealpathSync(path.resolve(sourceRoot, entry.entryPath), true);
        if (declared && isPathInside(sourceRoot, declared)) {
          redirects.set(declared, to);
        }
        candidateRoots.add(targetRoot);
      }
      // A package alias moves only when all its entries move together to one candidate package.
      const [targetRoot] = candidateRoots;
      if (allEntriesMatched && candidateRoots.size === 1 && targetRoot) {
        redirects.set(sourceRoot, targetRoot);
      }
    }
  }
  return redirects;
}

async function resolvePluginFilePackageRoot(file: string): Promise<string> {
  const directory = path.dirname(file);
  for (let current = directory; ; current = path.dirname(current)) {
    const manifestExists = await fs.access(path.join(current, "package.json")).then(
      () => true,
      (error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      },
    );
    if (manifestExists) {
      return current;
    }
    if (path.dirname(current) === current) {
      return directory;
    }
  }
}

type UpdateCandidatePluginProjectionParams = {
  config: OpenClawConfig;
  stateDir: string;
  targetStateDir: string;
  candidateRoot: string;
  env?: NodeJS.ProcessEnv;
};

export const UpdateCandidatePluginPlanSchema = z.object({
  bytes: z.number().int().nonnegative(),
  stateDir: z.string(),
  installRecordsHash: z.string().nullable(),
  configInstallRecordsHash: z.string(),
  configLoadPaths: z.array(z.string()),
  bindings: z.array(
    z.object({
      source: z.string(),
      real: z.string().nullable(),
      dev: z.string().nullable(),
      ino: z.string().nullable(),
    }),
  ),
  pluginPaths: z.record(z.string(), z.string()),
  recordPaths: z.record(
    z.string(),
    z.object({
      installPath: z.string().optional(),
      sourcePath: z.string().optional(),
    }),
  ),
  aliases: z.array(z.object({ alias: z.string(), target: z.string(), file: z.boolean() })),
  trees: UpdateCandidatePluginTreePlanSchema,
});
type UpdateCandidatePluginPlan = z.infer<typeof UpdateCandidatePluginPlanSchema>;

function installRecordsHash(records: Record<string, PluginInstallRecord>): string {
  return sha256Hex(serializePluginInstallRecordMap(records));
}

async function readCopiedPluginIndex(shared: string): Promise<
  | {
      value: Record<string, unknown>;
      records: Record<string, PluginInstallRecord>;
    }
  | undefined
> {
  if (
    await fs.stat(shared).then(
      () => true,
      (error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      },
    )
  ) {
    const db = openNodeSqliteDatabase(shared, { readOnly: true });
    try {
      if (tableExists(db, "config_machine_state")) {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<ConfigMachineStateDatabase>(db)
            .selectFrom("config_machine_state")
            .select("value_json")
            .where("state_key", "=", INSTALLED_PLUGIN_INDEX_STATE_KEY),
        );
        if (row) {
          const parsed: unknown = JSON.parse(row.value_json);
          if (!isRecord(parsed) || !isRecord(parsed.index)) {
            throw new Error("Invalid copied plugin index");
          }
          const installed = parsePluginInstallRecordMap(parsed.index.installRecords);
          if (!installed) {
            throw new Error("Invalid copied plugin install records");
          }
          return { value: parsed, records: installed };
        }
      }
    } finally {
      db.close();
    }
  }
  return undefined;
}

/** Inventory reads only private SQLite state and freezes the complete plugin projection. */
export async function prepareUpdateCandidatePlugins(
  params: UpdateCandidatePluginProjectionParams & {
    sharedStateDatabasePath?: string;
    onProgress?: () => void | Promise<void>;
  },
): Promise<UpdateCandidatePluginPlan> {
  const sourceRoot = path.resolve(params.stateDir);
  const targetStateDir = resolvePathViaExistingAncestorSync(path.resolve(params.targetStateDir));
  const shared =
    params.sharedStateDatabasePath ?? path.join(targetStateDir, "state", "openclaw.sqlite");
  const copied = await readCopiedPluginIndex(shared);
  const records = copied?.records ?? params.config.plugins?.installs ?? {};
  const resolve = (locator: string) => resolveUserPath(locator, params.env);
  const canonicalStateRoot = await fs.realpath(sourceRoot).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return sourceRoot;
    }
    throw error;
  });
  const project = (source: string) =>
    resolveUpdateCandidatePluginPath(canonicalStateRoot, targetStateDir, source);
  const bindings: UpdateCandidatePluginPlan["bindings"] = [];
  const locators: Array<{
    source: string;
    real: string;
    file: boolean;
    preserveBasename: boolean;
  }> = [];
  const roots = new Map<string, string>();
  const npmProjects = path.join(canonicalStateRoot, "npm", "projects");
  const npmModules = path.join(canonicalStateRoot, "npm", "node_modules");
  const allRecords = Object.values(records).concat(
    Object.values(params.config.plugins?.installs ?? {}),
  );
  const sources = new Set(
    allRecords
      .flatMap((record) => [
        record.installPath,
        record.source === "path" ? record.sourcePath : undefined,
      ])
      .filter((locator): locator is string => typeof locator === "string" && locator.length > 0)
      .map(resolve),
  );
  for (const source of params.config.plugins?.load?.paths ?? []) {
    sources.add(resolve(source));
  }
  const bundledRedirects =
    sources.size > 0
      ? bundledPluginRedirects(params.candidateRoot, params.env)
      : new Map<string, string>();
  const pluginPaths: Record<string, string> = {};
  for (const source of sources) {
    const stat = await fs.stat(source, { bigint: true }).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (!stat) {
      // Keep a missing locator private and missing; candidate validation owns the failure.
      pluginPaths[source] = project(source);
      bindings.push({ source, real: null, dev: null, ino: null });
      continue;
    }
    const real = await fs.realpath(source);
    bindings.push({ source, real, dev: stat.dev.toString(), ino: stat.ino.toString() });
    const bundled = bundledRedirects.get(real);
    if (bundled) {
      pluginPaths[source] = bundled;
      continue;
    }
    const file = stat.isFile();
    locators.push({
      source,
      real,
      file,
      preserveBasename: path.basename(source) !== path.basename(real),
    });
    // Copy the whole managed project so hoisted dependencies remain available.
    const owner = isPathInside(npmProjects, real)
      ? path.join(npmProjects, path.relative(npmProjects, real).split(path.sep)[0]!)
      : isPathInside(npmModules, real)
        ? npmModules
        : file
          ? await resolvePluginFilePackageRoot(real)
          : real;
    if (!roots.has(owner)) {
      roots.set(owner, project(owner));
    }
  }
  for (const source of roots.keys()) {
    assertUpdateCandidatePluginCopySource(source, targetStateDir);
  }
  const dependencies = inspectPluginSourceDependencies(
    resolveUpdateCandidatePluginSourceEntries(
      discoverConfiguredPluginLoadPaths({
        loadPaths: locators.map(({ real }) => real),
        env: params.env,
      }).candidates,
      params.config,
    ),
  );
  for (const source of [...dependencies.packageRoots, ...dependencies.files]) {
    if (![...roots.keys()].some((root) => isPathInside(root, source))) {
      roots.set(source, project(source));
    }
  }
  const trees = await prepareUpdateCandidatePluginTrees({
    roots,
    project,
    targetStateDir,
    candidateRoot: params.candidateRoot,
    onProgress: params.onProgress,
  });
  dependencies.assertSourceCurrent();
  const aliases: UpdateCandidatePluginPlan["aliases"] = [];
  for (const { source, real, file, preserveBasename } of locators) {
    const copy = trees.copies.find(([directory]) => isPathInside(directory, real));
    if (!copy) {
      throw new Error("Plugin payload has no private copy root");
    }
    const target = path.join(copy[1], path.relative(copy[0], real));
    const alias = preserveBasename ? project(source) : target;
    if (alias !== target) {
      aliases.push({ alias, target, file });
    }
    pluginPaths[source] = alias;
  }
  const recordPaths = Object.fromEntries(
    Object.entries(records).map<[string, Pick<PluginInstallRecord, "installPath" | "sourcePath">]>(
      ([id, record]) => {
        const locations: Pick<PluginInstallRecord, "installPath" | "sourcePath"> = {};
        for (const key of ["installPath", "sourcePath"] as const) {
          const locator =
            key === "sourcePath" && record.source !== "path" ? undefined : record[key];
          if (!locator) {
            continue;
          }
          const projected = pluginPaths[resolve(locator)];
          if (!projected) {
            throw new Error("Plugin record locator was not inventoried");
          }
          locations[key] = projected;
        }
        return [id, locations];
      },
    ),
  );
  return {
    bytes: trees.bytes + aliases.length * 4096,
    stateDir: sourceRoot,
    installRecordsHash: copied ? installRecordsHash(copied.records) : null,
    configInstallRecordsHash: installRecordsHash(params.config.plugins?.installs ?? {}),
    configLoadPaths: [...(params.config.plugins?.load?.paths ?? [])],
    bindings,
    pluginPaths,
    recordPaths,
    aliases,
    trees,
  };
}

/** Rebind admitted paths only; newer records or locator owners require a fresh inventory. */
export async function copyUpdateCandidatePlugins(
  plan: UpdateCandidatePluginPlan,
  params: UpdateCandidatePluginProjectionParams,
): Promise<Record<string, string>> {
  const targetStateDir = resolvePathViaExistingAncestorSync(path.resolve(params.targetStateDir));
  if (plan.stateDir !== path.resolve(params.stateDir)) {
    throw new Error("Plugin state root changed after snapshot inventory");
  }
  const shared = path.join(targetStateDir, "state", "openclaw.sqlite");
  const copied = await readCopiedPluginIndex(shared);
  if ((copied ? installRecordsHash(copied.records) : null) !== plan.installRecordsHash) {
    throw new Error("Plugin install records changed after snapshot inventory");
  }
  if (
    installRecordsHash(params.config.plugins?.installs ?? {}) !== plan.configInstallRecordsHash ||
    !isDeepStrictEqual(params.config.plugins?.load?.paths ?? [], plan.configLoadPaths)
  ) {
    throw new Error("Configured plugin locators changed after snapshot inventory");
  }
  const assertBindings = async () => {
    for (const binding of plan.bindings) {
      const stat = await fs.stat(binding.source, { bigint: true }).catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      const real = stat ? await fs.realpath(binding.source) : null;
      if (
        real !== binding.real ||
        (stat?.dev.toString() ?? null) !== binding.dev ||
        (stat?.ino.toString() ?? null) !== binding.ino
      ) {
        throw new Error(`Plugin locator changed after snapshot inventory: ${binding.source}`);
      }
    }
  };
  const rebase = (file: string) =>
    relocateRuntimePath(file, [
      { sourceRoot: plan.trees.privateRoot, destinationRoot: targetStateDir },
    ]);
  await assertBindings();
  await copyUpdateCandidatePluginTrees(plan.trees, params);
  await assertBindings();
  for (const entry of plan.aliases) {
    const alias = rebase(entry.alias);
    const target = rebase(entry.target);
    // Preserve the entry basename/ID while imports use the canonical copied owner.
    const [existing, targetIdentity] = await Promise.all([
      fs.stat(alias, { bigint: true }).catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      }),
      fs.stat(target, { bigint: true }),
    ]);
    // A case-equivalent name can already be this file; unlinking it destroys the target.
    if (!existing || !sameFileIdentity(existing, targetIdentity)) {
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.rm(alias, { force: true });
      await fs.symlink(
        target,
        alias,
        entry.file ? "file" : process.platform === "win32" ? "junction" : "dir",
      );
    }
  }
  if (copied) {
    const projected = structuredClone(copied.records);
    for (const [id, locations] of Object.entries(plan.recordPaths)) {
      const record = projected[id];
      if (!record) {
        throw new Error("Plugin install records changed after snapshot inventory");
      }
      if (locations.sourcePath) {
        record.sourcePath = rebase(locations.sourcePath);
      }
      if (locations.installPath) {
        record.installPath = rebase(locations.installPath);
      }
    }
    // Preserve the copied index wrapper; metadata naming source paths must be rebuilt.
    const next = { ...copied.value, index: { installRecords: projected } };
    const db = openNodeSqliteDatabase(shared);
    try {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<ConfigMachineStateDatabase>(db)
          .updateTable("config_machine_state")
          .set({ value_json: JSON.stringify(next) })
          .where("state_key", "=", INSTALLED_PLUGIN_INDEX_STATE_KEY),
      );
    } finally {
      db.close();
    }
  }
  return Object.fromEntries(
    Object.entries(plan.pluginPaths).map<[string, string]>(([source, target]) => [
      source,
      rebase(target),
    ]),
  );
}
