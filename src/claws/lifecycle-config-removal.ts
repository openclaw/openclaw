import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import {
  AgentSharedStoreOwnerError,
  assertAgentSessionStoreDeletionSafe,
  prepareAgentDeleteDatabases,
} from "../agents/agent-delete-databases.js";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { listAgentEntries, pruneAgentConfig } from "../commands/agents.config.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  inheritLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../config/legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  AgentConfigPreconditionError,
  deleteAgentConfigEntry,
} from "../gateway/server-methods/agents-config-mutations.js";
import { withAgentExecApprovalsRemoved } from "../infra/exec-approvals.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";
import { readAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { canonicalizeClawAgent, resolveCanonicalClawAgent } from "./agent-adoption-apply.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";
import { deletionEffects, type ClawCleanupTargets } from "./lifecycle-delete-support.js";
import {
  readClawInstallRecordFromDatabase,
  updateClawInstallRecordStatus,
  type PersistedClawInstall,
} from "./provenance.js";

type ClawAgentConfigRemovalParams = {
  agentId: string;
  expectedDigest: string;
  expectedInstall?: PersistedClawInstall | null;
  expectedRemovalSurfaceDigest: string;
  expectedState: "present" | "missing" | "modified";
  fallbackWorkspace: string;
  config?: OpenClawConfig;
  stateDatabase?: OpenClawStateDatabaseOptions;
  onModified: () => Error;
  retainAgentConfig?: boolean;
  retainHistoricalAgentState?: boolean;
  quiesceMonitors?: (operationId: string) => Promise<void>;
  drainMonitors?: (operationId: string) => Promise<void>;
};

type ClawAgentConfigRemovalResult = {
  agentRemoved: boolean;
  cleanupTargets: ClawCleanupTargets;
  configBeforeDelete: OpenClawConfig;
  nextConfig: OpenClawConfig;
};

export { digestClawAgentConfig } from "./agent-config-digest.js";

export function clawAgentSessionStoreRemovalBlocker(
  config: OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions,
): { code: "shared_session_store_owner"; message: string } | undefined {
  try {
    assertAgentSessionStoreDeletionSafe(config, agentId, options);
  } catch (error) {
    if (!(error instanceof AgentSharedStoreOwnerError)) {
      throw error;
    }
    return { code: "shared_session_store_owner", message: error.message };
  }
  return undefined;
}

export function digestClawAgentRemovalSurface(config: OpenClawConfig, agentId: string): string {
  const normalizedId = normalizeAgentId(agentId);
  const legacyOwner = tryGetLegacyDefaultAgentId(config);
  const pruned = pruneAgentConfig(config, agentId);
  const survivorWorkspaces = Object.fromEntries(
    listAgentEntries(pruned.config)
      .map((entry) => {
        const id = normalizeAgentId(entry.id);
        // Resolve the retained legacy owner against the pre-collapse topology. The writer later
        // pins that semantic workspace while canonicalizing the roster, so authored/runtime
        // spellings hash identically without hiding explicit-main workspace changes.
        const workspaceConfig = legacyOwner === id ? config : pruned.config;
        return [id, resolveAgentWorkspaceDir(workspaceConfig, id)] as const;
      })
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const surface = {
    bindings: (config.bindings ?? []).filter(
      (binding) => normalizeAgentId(binding.agentId) === normalizedId,
    ),
    agentToAgentAllow: (config.tools?.agentToAgent?.allow ?? []).filter((entry) => {
      const normalized = normalizeAgentIdStrict(entry);
      return normalized.ok && normalized.value === normalizedId;
    }),
    // Cover every config path deleteAgentConfigEntry would prune so a reference added after
    // planning is rejected instead of silently deleting operator-owned routing or policy.
    removedReferences: pruned.removedReferenceValues,
    // Bind the resulting topology, not whether each value was authored or materialized by the
    // config reader. Legacy-roster migration can insert the same values between preview and write.
    topologyAfter: {
      ownership: pruned.config.agents?.ownership ?? null,
      authInheritanceAgentId: pruned.config.agents?.defaults?.authInheritance?.agentId ?? null,
      sessionStoreAgentId: pruned.config.agents?.defaults?.sessionStore?.agentId ?? null,
      survivorWorkspaces,
    },
  };
  return `sha256:${createHash("sha256").update(stableStringify(surface)).digest("hex")}`;
}

function projectConfigMutationView(config: OpenClawConfig): OpenClawConfig {
  const clonedConfig = inheritLegacyDefaultAgentId(config, structuredClone(config));
  return migratePersistedImplicitMainRoster(clonedConfig).config as OpenClawConfig;
}

async function commitClawAgentConfigRemoval(
  params: ClawAgentConfigRemovalParams,
  assertCurrent: () => void,
): Promise<ClawAgentConfigRemovalResult> {
  const configBeforeDelete = params.config ?? getRuntimeConfig();
  try {
    const committed = await deleteAgentConfigEntry({
      agentId: params.agentId,
      assertCurrent,
      allowConfigSizeDrop: true,
      allowMissing: params.expectedState === "missing",
      fallbackWorkspace: params.fallbackWorkspace,
      validateConfig: (config) => {
        assertCurrent();
        if (!params.retainHistoricalAgentState) {
          assertAgentSessionStoreDeletionSafe(config, params.agentId, params.stateDatabase);
        }
        const actualRemovalSurface = digestClawAgentRemovalSurface(config, params.agentId);
        // The config writer may canonicalize legacy/default roster shape while loading the same
        // consented config. Accept only that exact projection, never arbitrary live drift.
        const writerSurface = digestClawAgentRemovalSurface(
          projectConfigMutationView(configBeforeDelete),
          params.agentId,
        );
        if (
          actualRemovalSurface !== params.expectedRemovalSurfaceDigest &&
          actualRemovalSurface !== writerSurface
        ) {
          throw params.onModified();
        }
      },
      validate: (agent) => {
        if (params.expectedState === "missing") {
          throw params.onModified();
        }
        const actualAgentDigest = digestClawAgentConfig(
          canonicalizeClawAgent(agent, params.agentId),
        );
        if (actualAgentDigest !== params.expectedDigest) {
          throw params.onModified();
        }
      },
    });
    const fallbackEffects = deletionEffects(
      configBeforeDelete,
      params.agentId,
      params.fallbackWorkspace,
      params.stateDatabase?.env,
    );
    return {
      agentRemoved: Boolean(committed.result),
      cleanupTargets: committed.result ?? {
        workspaceDir: fallbackEffects.workspace,
        agentDir: fallbackEffects.agentDir,
        sessionsDir: fallbackEffects.sessionsDir,
      },
      configBeforeDelete,
      nextConfig: committed.nextConfig,
    };
  } catch (error) {
    if (!(error instanceof AgentConfigPreconditionError)) {
      throw error;
    }
    const latestConfig = getRuntimeConfig();
    if (resolveCanonicalClawAgent(latestConfig, params.agentId)) {
      throw params.onModified();
    }
    const effects = deletionEffects(
      latestConfig,
      params.agentId,
      params.fallbackWorkspace,
      params.stateDatabase?.env,
    );
    return {
      agentRemoved: false,
      cleanupTargets: {
        workspaceDir: effects.workspace,
        agentDir: effects.agentDir,
        sessionsDir: effects.sessionsDir,
      },
      configBeforeDelete,
      nextConfig: latestConfig,
    };
  }
}

type CommittedClawAgentRemoval = ClawAgentConfigRemovalResult & {
  operationId: string;
  assertCurrent: (database?: OpenClawStateDatabase) => void;
  drainMonitors: () => Promise<void>;
  completeDeletion: (database: OpenClawStateDatabase) => void;
  runDatabaseCleanup: AgentDeletionOperation["runDatabaseCleanup"];
};

export async function withClawAgentConfigRemoval<T>(
  params: ClawAgentConfigRemovalParams,
  apply: (
    commitRemoval: () => Promise<CommittedClawAgentRemoval>,
    assertCurrent: () => void,
  ) => Promise<T>,
): Promise<T> {
  const expectedInstall = structuredClone(params.expectedInstall);
  const stateOptions = {
    ...params.stateDatabase,
    path: openOpenClawStateDatabase(params.stateDatabase).path,
  };
  return await withAgentDeletion(
    params.agentId,
    async (begin) => {
      const config = params.config ?? getRuntimeConfig();
      if (!params.retainAgentConfig && !params.retainHistoricalAgentState) {
        assertAgentSessionStoreDeletionSafe(config, params.agentId, stateOptions);
      }
      const effects = deletionEffects(
        config,
        params.agentId,
        params.fallbackWorkspace,
        stateOptions.env,
        params.retainAgentConfig,
      );
      const matchesInstall = (database: OpenClawStateDatabase) =>
        expectedInstall === undefined ||
        isDeepStrictEqual(
          readClawInstallRecordFromDatabase(database.db, params.agentId) ?? null,
          expectedInstall,
        );
      // Validate and claim together: a stale install snapshot must never fence a replacement.
      const { existingJournal, deletion } = runOpenClawStateWriteTransaction((database) => {
        if (!matchesInstall(database)) {
          throw params.onModified();
        }
        const previousJournal = readAgentDeletionJournalInDatabase(database, params.agentId);
        const claimedDeletion = begin({
          agentId: params.agentId,
          workspaceDir: effects.workspace,
          agentDir: effects.agentDir,
          sessionsDir: effects.sessionsDir,
          // Selective cleanup may retain modified or untracked workspace entries.
          deleteFiles: params.retainAgentConfig ? false : (previousJournal?.deleteFiles ?? false),
        });
        return { existingJournal: previousJournal, deletion: claimedDeletion };
      }, stateOptions);
      let committed = false;
      let monitorEffectsStarted = false;
      let fenceReleased = false;
      const assertCurrent = (database?: OpenClawStateDatabase) => {
        const check = (current: OpenClawStateDatabase) => {
          deletion.assertCurrent(current);
          if (!matchesInstall(current)) {
            throw new Error(`Claw removal no longer owns agent ${params.agentId}.`);
          }
        };
        if (database) {
          check(database);
        } else {
          runOpenClawStateWriteTransaction(check, stateOptions);
        }
      };
      try {
        // Fence new claims and drain existing owners before any external or local removal effect.
        if (params.quiesceMonitors) {
          // A lost RPC response can hide accepted cancellation. Keep the durable fence
          // until a retry has observed the serving owner and completed cleanup.
          monitorEffectsStarted = true;
          await params.quiesceMonitors(deletion.entry.operationId);
        }
        assertCurrent();
        if (!params.retainAgentConfig && !params.retainHistoricalAgentState) {
          await prepareAgentDeleteDatabases(config, params.agentId, effects.agentDir, stateOptions);
        }
        assertCurrent();
        return await apply(async () => {
          assertCurrent();
          const commitConfigRemoval = () =>
            commitClawAgentConfigRemoval(
              { ...params, config, stateDatabase: stateOptions },
              assertCurrent,
            );
          const result = params.retainAgentConfig
            ? {
                agentRemoved: false,
                cleanupTargets: {
                  workspaceDir: effects.workspace,
                  agentDir: effects.agentDir,
                  sessionsDir: effects.sessionsDir,
                },
                configBeforeDelete: config,
                nextConfig: config,
              }
            : params.retainHistoricalAgentState
              ? await commitConfigRemoval()
              : await withAgentExecApprovalsRemoved(
                  params.agentId,
                  commitConfigRemoval,
                  stateOptions,
                );
          committed = true;
          assertCurrent();
          return {
            ...result,
            operationId: deletion.entry.operationId,
            assertCurrent,
            drainMonitors: async () => {
              assertCurrent();
              await params.drainMonitors?.(deletion.entry.operationId);
              assertCurrent();
            },
            runDatabaseCleanup: deletion.runDatabaseCleanup,
            completeDeletion: params.retainAgentConfig
              ? (database) => {
                  deletion.releaseInTransaction(database);
                  fenceReleased = true;
                }
              : deletion.completeInTransaction,
          };
        }, assertCurrent);
      } finally {
        if (params.retainAgentConfig && !fenceReleased) {
          deletion.rollback();
        }
        // Pre-config partial results release only this attempt's fence; committed cleanup retains it.
        if (!params.retainAgentConfig && !committed && !monitorEffectsStarted && !existingJournal) {
          deletion.rollback();
        }
        if (expectedInstall) {
          // Result construction is pure; only the live operation may publish retry status.
          runOpenClawStateWriteTransaction((database) => {
            try {
              assertCurrent(database);
            } catch {
              return;
            }
            updateClawInstallRecordStatus(params.agentId, "partial", {
              ...stateOptions,
              database,
            });
          }, stateOptions);
        }
      }
    },
    stateOptions,
  );
}
