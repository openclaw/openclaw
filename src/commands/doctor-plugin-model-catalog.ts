import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { parseModelCatalogJson } from "../agents/model-catalog-json.js";
import { repairPluginModelCatalogTransportMetadata } from "../agents/plugin-model-catalog-repair.js";
import {
  inspectLegacyPluginModelCatalogs,
  isGeneratedPluginModelCatalog,
  loadPersistedPluginModelCatalogsReadOnly,
  migrateLegacyPluginModelCatalogs,
  repairPersistedPluginModelCatalogs,
  resolvePluginModelCatalogOwnerPluginId,
  type PersistedPluginModelCatalog,
  type PluginModelCatalogMigrationIssue,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { decodeUtf8Input, Utf8InputError } from "../infra/utf8-input.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

function catalogMigrationFinding(issue: PluginModelCatalogMigrationIssue): HealthFinding {
  const historical = issue.kind === "superseded-source" || issue.kind === "cleanup-failed";
  const fixHint =
    issue.kind === "conflicting-sources"
      ? "Keep every retained source. Compare their accounts and credentials with the current catalog before selecting an authoritative recovery source; do not overwrite either copy. Rerun openclaw doctor --fix after reconciling the conflict."
      : issue.kind === "superseded-source"
        ? "No cleanup is required merely because this older source was retained. Keep it for recovery and verify your expected accounts with openclaw models status."
        : issue.kind === "cleanup-failed"
          ? "The catalog was verified in SQLite, but its source could not be removed. Keep the source, correct its directory permissions, and rerun openclaw doctor --fix to retry cleanup. Verify current accounts with openclaw models status."
          : "Keep the retained catalog sources and recovery copy. Correct the reported source access or concurrent-writer problem, then rerun openclaw doctor --fix to verify the import. Check openclaw models status for the expected providers.";
  return {
    checkId: `core/doctor/plugin-model-catalog/${issue.kind}`,
    target: issue.pathname,
    severity: issue.kind === "superseded-source" ? "info" : "warning",
    category: historical ? "historical" : "fix-now",
    message: shortenHomePath(issue.message),
    fixHint,
    docsUrl: "https://docs.openclaw.ai/cli/doctor/running#auth-migration-recovery",
  };
}

/**
 * Finds generated plugin catalog blocks that older writers copied into the author-owned root
 * models.json.
 *
 * Discovery copies a plugin's provider under its hook aliases (`claude-cli` received the
 * `anthropic` catalog). When the owner lookup failed, the writer sent that copy to the root file,
 * and the merge kept it forever. Its frozen prices, including zero placeholders for unpriced
 * models, then outranked the live catalog. Only exact copies of a generated block qualify;
 * anything a user could have edited stays. Generated blocks carry exactly these keys;
 * credentials or request overrides mean authorship.
 */
const GENERATED_PROVIDER_KEYS = ["api", "baseUrl", "models"];

type RootProviderCopy = Readonly<{
  providerId: string;
  /** Plugin whose generated catalog holds the identical block. */
  pluginId: string;
  /** Provider key of the identical block inside that catalog. */
  catalogProviderId: string;
}>;

type RootProviderCopyReview = Readonly<{
  copies: RootProviderCopy[];
  /** Plugin-owned root ids left in place because they differ from every generated block. */
  keptPluginOwnedIds: string[];
}>;

type GeneratedBlock = Readonly<{ pluginId: string; providerId: string; block: unknown }>;

function readGeneratedBlocks(catalogs: readonly PersistedPluginModelCatalog[]): GeneratedBlock[] {
  return catalogs.flatMap(({ pluginId, contents }) => {
    const catalog = safeParseJsonRecord(contents);
    if (!isGeneratedPluginModelCatalog(catalog) || !isRecord(catalog.providers)) {
      return [];
    }
    return Object.entries(catalog.providers).map(([providerId, block]) => ({
      pluginId,
      providerId,
      block,
    }));
  });
}

function hasOnlyGeneratedProviderKeys(block: Record<string, unknown>): boolean {
  return (
    isDeepStrictEqual(Object.keys(block).toSorted(), GENERATED_PROVIDER_KEYS) &&
    Array.isArray(block.models)
  );
}

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

function readRootModelsFile(agentDir: string, runtime: RuntimeEnv): RootModelsFile | undefined {
  const pathname = path.join(agentDir, "models.json");
  try {
    const raw = decodeUtf8Input(fs.readFileSync(pathname), `Model catalog ${pathname}`);
    const root = parseModelCatalogJson(raw);
    return isRecord(root) && isRecord(root.providers)
      ? { raw, root, providers: root.providers }
      : undefined;
  } catch (error) {
    if (error instanceof Utf8InputError) {
      runtime.error(`${error.message} Left source unchanged.`);
    }
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
  reportFindings?: (findings: readonly HealthFinding[], warnings?: readonly string[]) => void;
}): Promise<void> {
  const warnings: string[] = [];
  const findings: HealthFinding[] = [];
  const report = (reported: readonly HealthFinding[], rawWarnings?: readonly string[]) => {
    findings.push(...reported);
    params.reportFindings?.(reported, rawWarnings);
  };
  const agents: Array<{
    agentDir: string;
    migrations: ReturnType<typeof inspectLegacyPluginModelCatalogs>["catalogs"];
    warnings: string[];
    inspectionFindings: readonly HealthFinding[];
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
    catalogs: readonly PersistedPluginModelCatalog[],
  ): RootProviderCopyReview => {
    if (!file || catalogs.length === 0) {
      return { copies: [], keptPluginOwnedIds: [] };
    }
    pluginMetadataSnapshot ??= resolvePluginMetadataSnapshot({
      config: params.cfg,
      env: params.env ?? process.env,
    });
    // A root block is a copy only when config does not declare its id, it carries nothing but
    // generated keys, no other plugin owns the id, and it deep-equals a generated catalog block.
    const generated = readGeneratedBlocks(catalogs);
    const copies: RootProviderCopy[] = [];
    const keptPluginOwnedIds: string[] = [];
    for (const [providerId, block] of Object.entries(file.providers)) {
      if (explicitProviderIds.has(normalizeProviderId(providerId))) {
        continue;
      }
      const owner = resolvePluginModelCatalogOwnerPluginId({
        providerId,
        pluginMetadataSnapshot,
      });
      const match =
        isRecord(block) && hasOnlyGeneratedProviderKeys(block)
          ? generated.find(
              (candidate) =>
                (owner === undefined || owner === candidate.pluginId) &&
                isDeepStrictEqual(candidate.block, block),
            )
          : undefined;
      if (match) {
        copies.push({ providerId, pluginId: match.pluginId, catalogProviderId: match.providerId });
      } else if (owner !== undefined) {
        keptPluginOwnedIds.push(providerId);
      }
    }
    return { copies, keptPluginOwnedIds };
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
    const rootCopies = reviewRootFile(readRootModelsFile(agentDir, params.runtime), [
      ...persisted,
      ...migrations,
    ]);
    agents.push({
      agentDir,
      migrations,
      warnings: agentWarnings,
      repairablePluginIds,
      rootCopies,
      inspectionFindings: inspected.issues.map(catalogMigrationFinding),
    });
    warnings.push(...agentWarnings);
    params.reportFindings?.([], agentWarnings);
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
    note(details.join("\n"), "Plugin model catalogs");
  }
  const shouldRepair =
    params.prompter.shouldRepair ||
    (detected > 0 &&
      (await params.prompter.confirmAutoFix({
        message: "Repair generated provider model catalogs now?",
        initialValue: true,
      })));
  if (!shouldRepair) {
    report(
      agents.flatMap((agent) => agent.inspectionFindings),
      [],
    );
    if (detected > 0) {
      report([
        {
          checkId: "core/doctor/plugin-model-catalog/repair-pending",
          severity: "warning",
          category: "fix-now",
          message: `${detected} generated provider catalog repair${detected === 1 ? "" : "s"} remain pending.`,
          fixHint:
            "Run openclaw doctor --fix to verify legacy catalog imports and repair model transport metadata. Keep the original catalogs and recovery copies until verification completes.",
          docsUrl: "https://docs.openclaw.ai/cli/doctor/running#auth-migration-recovery",
        },
      ]);
    }
    return;
  }

  let migrated = 0;
  const rootCopyChanges: string[] = [];
  const repairs: ReturnType<typeof repairPersistedPluginModelCatalogs> = [];
  for (const agent of agents) {
    // Fix also retires verified orphaned migration recovery rows when no sidecar remains.
    let result: ReturnType<typeof migrateLegacyPluginModelCatalogs>;
    try {
      result = migrateLegacyPluginModelCatalogs({
        agentDir: agent.agentDir,
        ...(agent.migrations.length > 0
          ? {
              expectedContents: new Map(
                agent.migrations.map((migration) => [migration.pluginId, migration.contents]),
              ),
            }
          : {}),
      });
    } catch (error) {
      report([
        {
          checkId: "core/doctor/plugin-model-catalog/import-failed",
          target: agent.agentDir,
          severity: "warning",
          category: "fix-now",
          message: `Generated provider catalog migration could not complete: ${error instanceof Error ? error.message : String(error)}`,
          fixHint:
            "Keep the retained catalog sources and recovery copy. Resolve the reported changed source or database error, then rerun openclaw doctor --fix. Avoid running an older catalog writer during migration.",
          docsUrl: "https://docs.openclaw.ai/cli/doctor/running#auth-migration-recovery",
        },
      ]);
      throw error;
    }
    migrated += result.migrated;
    params.reportFindings?.([], result.warnings.map(shortenHomePath));
    report(
      result.issues
        .map(catalogMigrationFinding)
        .filter(
          (finding) =>
            !findings.some(
              (existing) =>
                existing.checkId === finding.checkId && existing.target === finding.target,
            ),
        ),
      [],
    );
    for (const warning of result.warnings) {
      const displayWarning = shortenHomePath(warning);
      if (warnings.includes(displayWarning)) {
        continue;
      }
      warnings.push(displayWarning);
      params.runtime.error(displayWarning);
    }
    if (result.warnings.length === 0) {
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
    const file = readRootModelsFile(agent.agentDir, params.runtime);
    const review = reviewRootFile(file, loadPersistedPluginModelCatalogsReadOnly(agent.agentDir));
    if (!file || review.copies.length === 0) {
      continue;
    }
    try {
      const backupPath = await removeRootProviderCopies({ agentDir: agent.agentDir, file, review });
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
    note(
      `Migrated and verified ${migrated} generated provider catalog${migrated === 1 ? "" : "s"} in agent SQLite.`,
      "Doctor changes",
    );
  }
  if (repairs.length > 0) {
    note(
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
    note(rootCopyChanges.join("\n"), "Doctor changes");
  }
}
