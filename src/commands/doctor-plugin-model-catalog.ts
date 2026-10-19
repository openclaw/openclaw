import fs from "node:fs";
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { parseModelCatalogJson } from "../agents/model-catalog-json.js";
import { repairPluginModelCatalogTransportMetadata } from "../agents/plugin-model-catalog-repair.js";
import {
  reviewRootProviderCopies,
  type RootProviderCopyReview,
} from "../agents/plugin-model-catalog-root-copies.js";
import {
  inspectLegacyPluginModelCatalogs,
  loadPersistedPluginModelCatalogsReadOnly,
  migrateLegacyPluginModelCatalogs,
  repairPersistedPluginModelCatalogs,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

function resolveMigrationAgentDirs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
}): string[] {
  let agentDirs = params.agentDirs;
  const env = params.env ?? process.env;
  if (!agentDirs) {
    const agentIds = listAgentIds(params.cfg);
    agentDirs =
      agentIds.length > 0
        ? agentIds.map((agentId) => resolveAgentDir(params.cfg, agentId, env))
        : [resolveDefaultAgentDir(params.cfg, env)];
  }
  return [...new Set(agentDirs)].toSorted((left, right) => left.localeCompare(right));
}

type RootModelsFile = Readonly<{
  raw: string;
  root: Record<string, unknown>;
  providers: Record<string, unknown>;
}>;

function readRootModelsFile(agentDir: string): RootModelsFile | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const root = parseModelCatalogJson(raw);
    return isRecord(root) && isRecord(root.providers)
      ? { raw, root, providers: root.providers }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes generated plugin copies from the root file. The exact previous bytes stay beside it as
 * `models.json.bak-<ms>`; the file is rewritten, never deleted, because registry reads require it.
 */
async function removeRootProviderCopies(params: {
  agentDir: string;
  file: RootModelsFile;
  review: RootProviderCopyReview;
}): Promise<string> {
  const providers = { ...params.file.providers };
  for (const { providerId } of params.review.copies) {
    delete providers[providerId];
  }
  const store = privateFileStore(params.agentDir);
  const backupName = `models.json.bak-${Date.now()}`;
  await store.writeText(backupName, params.file.raw);
  await store.writeText(
    "models.json",
    `${JSON.stringify({ ...params.file.root, providers }, null, 2)}\n`,
  );
  return path.join(params.agentDir, backupName);
}

function describeRootProviderCopies(agentDir: string, review: RootProviderCopyReview): string[] {
  const rootPath = shortenHomePath(path.join(agentDir, "models.json"));
  return [
    ...review.copies.map(
      ({ providerId, pluginId, catalogProviderId }) =>
        `${rootPath} provider "${providerId}" is an exact copy of plugin ${pluginId} catalog block "${catalogProviderId}"; its frozen rows override current model metadata and prices.`,
    ),
    ...review.keptPluginOwnedIds.map(
      (providerId) =>
        `${rootPath} provider "${providerId}" stays: it differs from every generated catalog block.`,
    ),
  ];
}

/** Imports released sidecars and repairs persisted SQLite catalogs only with Doctor authority. */
export async function maybeMigrateLegacyPluginModelCatalogs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
  prompter: DoctorPrompter;
  runtime: RuntimeEnv;
  note?: typeof note;
}): Promise<{
  detected: number;
  migrated: number;
  repaired: number;
  removedRootCopies: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const agents: Array<{
    agentDir: string;
    migrations: ReturnType<typeof inspectLegacyPluginModelCatalogs>["catalogs"];
    warnings: string[];
    repairablePluginIds: string[];
    rootCopies: RootProviderCopyReview;
  }> = [];
  const explicitProviderIds = new Set(
    Object.keys(params.cfg.models?.providers ?? {}).map((providerId) =>
      normalizeProviderId(providerId),
    ),
  );
  let pluginMetadataSnapshot: ReturnType<typeof resolvePluginMetadataSnapshot> | undefined;
  const reviewRootFile = (
    file: RootModelsFile | undefined,
    catalogs: Parameters<typeof reviewRootProviderCopies>[0]["catalogs"],
  ): RootProviderCopyReview => {
    if (!file || catalogs.length === 0) {
      return { copies: [], keptPluginOwnedIds: [] };
    }
    pluginMetadataSnapshot ??= resolvePluginMetadataSnapshot({
      config: params.cfg,
      env: params.env ?? process.env,
    });
    return reviewRootProviderCopies({
      rootProviders: file.providers,
      explicitProviderIds,
      catalogs,
      pluginMetadataSnapshot,
    });
  };
  for (const agentDir of resolveMigrationAgentDirs(params)) {
    const inspected = inspectLegacyPluginModelCatalogs(agentDir);
    const agentWarnings = inspected.warnings.map((warning) => shortenHomePath(warning));
    const migrations = inspected.catalogs;
    const persisted = loadPersistedPluginModelCatalogsReadOnly(agentDir);
    const repairablePluginIds = persisted
      .filter(({ contents }) => {
        return repairPluginModelCatalogTransportMetadata(contents).contents !== contents;
      })
      .map(({ pluginId }) => pluginId);
    const rootCopies = reviewRootFile(readRootModelsFile(agentDir), [...persisted, ...migrations]);
    agents.push({ agentDir, migrations, warnings: agentWarnings, repairablePluginIds, rootCopies });
    warnings.push(...agentWarnings);
  }
  const migrations = agents.flatMap((agent) => agent.migrations);
  const detected =
    migrations.length +
    agents.reduce(
      (count, agent) => count + agent.repairablePluginIds.length + agent.rootCopies.copies.length,
      0,
    );
  for (const warning of warnings) {
    params.runtime.error(warning);
  }

  const emitNote = params.note ?? note;
  if (detected > 0) {
    const details =
      migrations.length > 0
        ? [
            "Legacy generated provider catalogs contain model and credential state.",
            ...migrations.map((migration) => `- ${shortenHomePath(migration.pathname)}`),
          ]
        : [];
    for (const agent of agents) {
      for (const pluginId of agent.repairablePluginIds) {
        details.push(
          `Generated catalog ${pluginId} in ${shortenHomePath(agent.agentDir)} contains repairable model rows (missing transport API metadata or an incomplete cost).`,
        );
      }
      if (agent.rootCopies.copies.length > 0) {
        details.push(...describeRootProviderCopies(agent.agentDir, agent.rootCopies));
      }
    }
    details.push("Run openclaw doctor --fix to verify and repair these catalogs.");
    emitNote(details.join("\n"), "Plugin model catalogs");
  }
  const shouldRepair =
    params.prompter.shouldRepair ||
    (detected > 0 &&
      (await params.prompter.confirmAutoFix({
        message: "Repair generated provider model catalogs now?",
        initialValue: true,
      })));
  if (!shouldRepair) {
    return { detected, migrated: 0, repaired: 0, removedRootCopies: 0, warnings };
  }

  let migrated = 0;
  let removedRootCopies = 0;
  const rootCopyChanges: string[] = [];
  const repairs: ReturnType<typeof repairPersistedPluginModelCatalogs> = [];
  for (const agent of agents) {
    // Fix also retires verified orphaned migration recovery rows when no sidecar remains.
    const result = migrateLegacyPluginModelCatalogs({
      agentDir: agent.agentDir,
      ...(agent.migrations.length > 0
        ? {
            expectedContents: new Map(
              agent.migrations.map((migration) => [migration.pluginId, migration.contents]),
            ),
          }
        : {}),
    });
    migrated += result.migrated;
    for (const warning of result.warnings) {
      const displayWarning = shortenHomePath(warning);
      if (warnings.includes(displayWarning)) {
        continue;
      }
      warnings.push(displayWarning);
      params.runtime.error(displayWarning);
    }
    if (agent.warnings.length === 0 && result.warnings.length === 0) {
      // Migration can publish a malformed legacy payload. Re-read it before planning
      // repair; the storage owner still compares those bytes at the write boundary.
      repairs.push(
        ...repairPersistedPluginModelCatalogs({
          agentDir: agent.agentDir,
          catalogs: loadPersistedPluginModelCatalogsReadOnly(agent.agentDir),
        }),
      );
    }
    if (agent.rootCopies.copies.length === 0) {
      continue;
    }
    // Compare against the catalogs as they stand after migration, from the bytes being replaced.
    const file = readRootModelsFile(agent.agentDir);
    const review = reviewRootFile(file, loadPersistedPluginModelCatalogsReadOnly(agent.agentDir));
    if (!file || review.copies.length === 0) {
      continue;
    }
    try {
      const backupPath = await removeRootProviderCopies({ agentDir: agent.agentDir, file, review });
      removedRootCopies += review.copies.length;
      rootCopyChanges.push(
        ...review.copies.map(
          ({ providerId, pluginId }) =>
            `Removed provider "${providerId}" (a copy of plugin ${pluginId}'s generated catalog) from ${shortenHomePath(path.join(agent.agentDir, "models.json"))}; backup: ${shortenHomePath(backupPath)}.`,
        ),
      );
    } catch (error) {
      const warning = `Could not remove generated provider copies from ${shortenHomePath(agent.agentDir)}: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(warning);
      params.runtime.error(warning);
    }
  }

  if (migrated > 0) {
    emitNote(
      `Migrated and verified ${migrated} generated provider catalog${migrated === 1 ? "" : "s"} in agent SQLite.`,
      "Doctor changes",
    );
  }
  if (repairs.length > 0) {
    emitNote(
      repairs
        .map(({ pluginId, removedModelCount, completedCostModelCount }) => {
          const actions = [
            removedModelCount > 0
              ? `removed ${removedModelCount} model row(s) without transport API metadata`
              : undefined,
            completedCostModelCount > 0
              ? `completed the cost of ${completedCostModelCount} model row(s)`
              : undefined,
          ].filter((action) => action !== undefined);
          return `Repaired generated model catalog ${pluginId}: ${actions.join("; ")}.`;
        })
        .join("\n"),
      "Doctor changes",
    );
  }
  if (rootCopyChanges.length > 0) {
    emitNote(rootCopyChanges.join("\n"), "Doctor changes");
  }
  return { detected, migrated, repaired: repairs.length, removedRootCopies, warnings };
}
