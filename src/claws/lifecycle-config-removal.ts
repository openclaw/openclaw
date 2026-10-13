import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import {
  assertAgentSessionStoreDeletionSafe,
  prepareAgentDeleteDatabases,
} from "../agents/agent-delete-databases.js";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  AgentConfigPreconditionError,
  deleteAgentConfigEntry,
} from "../gateway/server-methods/agents-config-mutations.js";
import { withAgentExecApprovalsRemoved } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { AgentDeletionJournalTransport } from "../state/agent-deletion-journal-transport.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { digestClawValue } from "./digest.js";
import { deletionEffects, type ClawCleanupTargets } from "./lifecycle-delete-support.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawRemovalJournalGateway } from "./removal-journal-contract.js";

type ClawAgentConfigRemovalParams = {
  agentId: string;
  expectedDigest: string;
  expectedInstall?: PersistedClawInstall | null;
  expectedRemovalSurfaceDigest: string;
  expectedState: "present" | "missing";
  fallbackWorkspace: string;
  config?: OpenClawConfig;
  stateDatabase?: OpenClawStateDatabaseOptions;
  journalGateway?: ClawRemovalJournalGateway;
  onModified: () => Error;
  quiesceMonitors?: (operationId: string) => Promise<void>;
  drainMonitors?: (operationId: string) => Promise<void>;
};

type ClawAgentConfigRemovalResult = {
  agentRemoved: boolean;
  cleanupTargets: ClawCleanupTargets;
  configBeforeDelete: OpenClawConfig;
  nextConfig: OpenClawConfig;
};

export function digestClawAgentRemovalSurface(config: OpenClawConfig, agentId: string): string {
  const normalizedId = normalizeAgentId(agentId);
  const surface = {
    bindings: (config.bindings ?? []).filter(
      (binding) => normalizeAgentId(binding.agentId) === normalizedId,
    ),
    agentToAgentAllow: (config.tools?.agentToAgent?.allow ?? []).filter(
      (entry) => entry === normalizedId,
    ),
  };
  return digestClawValue(surface);
}

async function commitClawAgentConfigRemoval(
  params: ClawAgentConfigRemovalParams,
  deletion: AgentDeletionOperation,
): Promise<ClawAgentConfigRemovalResult> {
  const configBeforeDelete = params.config ?? getRuntimeConfig();
  try {
    const committed = await deleteAgentConfigEntry({
      agentId: params.agentId,
      assertCurrent: deletion.assertCurrentFinal,
      assertCurrentAsync: deletion.assertCurrentAsync,
      allowConfigSizeDrop: true,
      allowMissing: params.expectedState === "missing",
      fallbackWorkspace: params.fallbackWorkspace,
      validateConfig: async (config) => {
        await assertAgentSessionStoreDeletionSafe(config, params.agentId, params.stateDatabase);
        deletion.assertCurrentHost();
        if (
          digestClawAgentRemovalSurface(config, params.agentId) !==
          params.expectedRemovalSurfaceDigest
        ) {
          throw params.onModified();
        }
      },
      validate: (agent) => {
        if (params.expectedState === "missing") {
          throw params.onModified();
        }
        if (digestClawValue(agent) !== params.expectedDigest) {
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
    if (listAgentEntries(latestConfig).some((agent) => agent.id === params.agentId)) {
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
  drainMonitors: () => Promise<void>;
};

export async function withClawAgentConfigRemoval<T>(
  params: ClawAgentConfigRemovalParams,
  apply: (
    commitRemoval: () => Promise<CommittedClawAgentRemoval>,
    deletion: AgentDeletionOperation,
  ) => Promise<T>,
): Promise<T> {
  const expectedInstall = structuredClone(params.expectedInstall);
  const context = captureOpenClawStateWorkerContext({
    ...params.stateDatabase,
    path: params.stateDatabase?.database?.path ?? params.stateDatabase?.path,
  });
  const stateOptions = {
    ...params.stateDatabase,
    path: context.admission.databasePath,
    env: { ...(params.stateDatabase?.env ?? process.env) },
  };
  let beginConfig = params.config ?? getRuntimeConfig();
  const journalTransport: AgentDeletionJournalTransport | undefined = params.journalGateway
    ? (mutation, authority) =>
        params.journalGateway!(
          {
            ...mutation,
            expectedInstallDigest: digestClawValue(expectedInstall ?? null),
            configDigest: digestClawValue(
              mutation.kind === "begin" ? beginConfig : getRuntimeConfig(),
            ),
          },
          authority,
        )
    : undefined;
  return await withAgentDeletion(
    params.agentId,
    async (begin) => {
      const config = params.config ?? getRuntimeConfig();
      beginConfig = config;
      await assertAgentSessionStoreDeletionSafe(config, params.agentId, stateOptions);
      const effects = deletionEffects(
        config,
        params.agentId,
        params.fallbackWorkspace,
        stateOptions.env,
      );
      // Validate and claim together: a stale install snapshot must never fence a replacement.
      const deletion = await begin(
        {
          agentId: params.agentId,
          workspaceDir: effects.workspace,
          agentDir: effects.agentDir,
          sessionsDir: effects.sessionsDir,
          // Selective cleanup may retain modified or untracked workspace entries.
          deleteFiles: false,
        },
        { expectedClawInstall: expectedInstall, preserveDeleteFiles: true },
      ).catch((error: unknown) => {
        if (extractErrorCode(error) === "CLAW_INSTALL_CHANGED") {
          throw params.onModified();
        }
        throw error;
      });
      let committed = false;
      let monitorEffectsStarted = false;
      try {
        // Fence new claims and drain existing owners before any external or local removal effect.
        if (params.quiesceMonitors) {
          await deletion.assertCurrentAsync();
          // A lost RPC response can hide accepted cancellation. Keep the durable fence
          // until a retry has observed the serving owner and completed cleanup.
          monitorEffectsStarted = true;
          await params.quiesceMonitors(deletion.entry.operationId);
        }
        await deletion.assertCurrentAsync();
        await prepareAgentDeleteDatabases(
          config,
          params.agentId,
          effects.agentDir,
          stateOptions,
          deletion,
        );
        await deletion.assertCurrentAsync();
        return await apply(async () => {
          await deletion.assertCurrentAsync();
          const result = await withAgentExecApprovalsRemoved(
            params.agentId,
            async () =>
              commitClawAgentConfigRemoval(
                { ...params, config, stateDatabase: stateOptions },
                deletion,
              ),
            deletion,
          );
          committed = true;
          await deletion.assertCurrentAsync();
          return {
            ...result,
            drainMonitors: async () => {
              await deletion.assertCurrentAsync();
              await params.drainMonitors?.(deletion.entry.operationId);
              await deletion.assertCurrentAsync();
            },
          };
        }, deletion);
      } finally {
        // Pre-config partial results release only this attempt's fence; committed cleanup retains it.
        if (!committed && !monitorEffectsStarted && !deletion.previousEntry) {
          await deletion.rollback();
        }
        if (expectedInstall) {
          // Result construction is pure; only the live operation may publish retry status.
          await deletion.handoffClawRetry();
        }
      }
    },
    {
      ...stateOptions,
      ...(journalTransport ? { journalTransport } : {}),
    },
  );
}
