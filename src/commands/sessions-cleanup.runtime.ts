import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import {
  createSessionsCleanupFailure,
  resolveSessionCleanupAction,
  runSessionsCleanup,
  SessionsCleanupFailureError,
  type SessionStoreTarget,
  type SessionsCleanupOptions,
} from "../config/sessions.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveMaintenanceConfig } from "../config/sessions/store-maintenance-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import { withActivatedPluginIds } from "../plugins/activation-context.js";
import { resolveManifestActivationPluginIds } from "../plugins/activation-planner.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { RuntimeEnv } from "../runtime.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "../state/openclaw-agent-db-lease.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import {
  DoctorSqliteMaintenanceLockUnavailableError,
  withDoctorSqliteMaintenanceLock,
} from "./doctor-sqlite-maintenance-lock.js";

type CleanupRunResult = Awaited<ReturnType<typeof runSessionsCleanup>>;

function prepareCleanupHarnessOwners(config: OpenClawConfig, workspaceDir: string) {
  const metadata = loadPluginMetadataSnapshot({ config, workspaceDir });
  const harnessOwners = metadata.plugins.flatMap((plugin) => {
    const runtime = plugin.activation?.onAgentHarnesses?.[0];
    return runtime ? [{ plugin, runtime }] : [];
  });
  const pluginIds = harnessOwners
    .flatMap(({ plugin, runtime }) =>
      resolveManifestActivationPluginIds({
        config,
        workspaceDir,
        manifestRecords: [plugin],
        trigger: { kind: "agentHarness", runtime },
        requireExplicitManifestOwnerTrust: true,
      }),
    )
    .toSorted();
  // Persisted sessions outlive model selection. Include every permitted harness
  // owner so concurrent rows and legacy entries do not lose their cleanup owner.
  const registry = loadPluginRegistryHandle({
    config: withActivatedPluginIds({ config, pluginIds }),
    activationSourceConfig: config,
    workspaceDir,
    onlyPluginIds: pluginIds,
    manifestRegistry: metadata.manifestRegistry,
    discovery: metadata.discovery,
    installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(metadata.index),
    throwOnLoadError: true,
  });
  return {
    registry,
    excludedOwners: harnessOwners
      .filter(({ plugin }) => !pluginIds.includes(plugin.id))
      .map(({ plugin }) => plugin),
  };
}

function warnUnavailableCleanupOwners(
  owners: ReturnType<typeof prepareCleanupHarnessOwners>,
  result: CleanupRunResult,
  runtime: RuntimeEnv,
): void {
  const summary = result.appliedSummaries[0];
  const preview = result.previewResults[0];
  if (
    owners.excludedOwners.length === 0 ||
    !summary ||
    !preview ||
    summary.missing +
      summary.dmScopeRetired +
      summary.modelRunPruned +
      summary.pruned +
      summary.capped ===
      0
  ) {
    return;
  }
  const candidateHarnessIds = new Set<string>();
  let hasLegacyCandidate = false;
  for (const [key, entry] of Object.entries(preview.beforeStore)) {
    const action = resolveSessionCleanupAction({ ...preview, key });
    if (
      !entry.sessionId ||
      action === "keep" ||
      action === "archive-dashboard" ||
      action === "archive-cap"
    ) {
      continue;
    }
    if (entry.agentHarnessId) {
      candidateHarnessIds.add(entry.agentHarnessId);
    } else {
      hasLegacyCandidate = true;
    }
  }
  const excluded = owners.excludedOwners.filter(
    (plugin) =>
      hasLegacyCandidate ||
      plugin.activation?.onAgentHarnesses?.some((id) => candidateHarnessIds.has(id)),
  );
  if (excluded.length > 0) {
    runtime.error(
      `Warning: native session resources were not cleaned for unavailable harness owners: ${excluded
        .map((plugin) => plugin.id)
        .toSorted()
        .join(", ")}. ` +
        "Their plugins are disabled or not trusted; resources may remain. Enable or trust those plugins and use their repair flow.",
    );
  }
}

/** Local destructive cleanup retains the offline owner through reclamation. */
export async function runLocalSessionsCleanup(
  params: { cfg: OpenClawConfig; opts: SessionsCleanupOptions; targets: SessionStoreTarget[] },
  runtime: RuntimeEnv,
): Promise<CleanupRunResult> {
  const run = async (): Promise<CleanupRunResult> => {
    const ownersByWorkspace = new Map<string, ReturnType<typeof prepareCleanupHarnessOwners>>();
    const results: CleanupRunResult[] = [];
    let failure: CleanupRunResult["failure"];
    for (const target of params.targets) {
      const workspaceDir = resolveAgentWorkspaceDir(params.cfg, target.agentId);
      let owners = ownersByWorkspace.get(workspaceDir);
      if (!owners) {
        owners = prepareCleanupHarnessOwners(params.cfg, workspaceDir);
        ownersByWorkspace.set(workspaceDir, owners);
      }
      let result: CleanupRunResult;
      try {
        result = await withPluginRuntimeRegistryScope(owners.registry, () =>
          // Reuse the CLI's admitted handle instead of rescanning the whole database
          // on a fresh reclamation Worker connection for every historical session.
          runSessionsCleanup({ ...params, targets: [target], reclamationMode: "in-process" }),
        );
      } catch (cause) {
        // The local runner changes plugin scope per store, so it owns combining
        // earlier results with the same partial outcome as the cleanup service.
        if (results.length === 0) {
          throw cause;
        }
        failure =
          cause instanceof SessionsCleanupFailureError
            ? cause.failure
            : createSessionsCleanupFailure(target, cause, false);
        break;
      }
      warnUnavailableCleanupOwners(owners, result, runtime);
      results.push(result);
      if (result.failure) {
        failure = result.failure;
        break;
      }
    }
    const first = results[0];
    if (!first) {
      return await runSessionsCleanup({ ...params, reclamationMode: "in-process" });
    }
    return {
      mode: first.mode,
      previewResults: results.flatMap((result) => result.previewResults),
      appliedSummaries: results.flatMap((result) => result.appliedSummaries),
      ...(failure ? { failure } : {}),
    };
  };
  if (
    params.opts.dryRun ||
    (!params.opts.enforce &&
      !params.opts.fixMissing &&
      !params.opts.fixDmScope &&
      resolveMaintenanceConfig().mode !== "enforce")
  ) {
    return await run();
  }
  try {
    return await withDoctorSqliteMaintenanceLock({
      operation: "sessions cleanup",
      protectedPaths: params.targets.map(
        (target) => resolveSqliteTargetFromSessionStorePath(target.storePath, target).path,
      ),
      run: async (authority) => {
        const owner = readActiveOpenClawAgentDatabaseLeasesReadOnly(
          {},
          openDoctorStateSchemaReadAdmission,
        ).find((lease) => lease.owner_pid !== process.pid);
        if (owner) {
          throw cleanupOwnerRefusal(`agent ${owner.agent_id} (PID ${owner.owner_pid})`);
        }
        authority.assertCurrent();
        return await run();
      },
    });
  } catch (error) {
    if (
      !(error instanceof DoctorSqliteMaintenanceLockUnavailableError) ||
      !(error.cause.cause instanceof GatewayStateOwnerContentionError)
    ) {
      throw error;
    }
    const owner = await readActiveGatewayLockIdentity({ includeEmbedded: true });
    throw cleanupOwnerRefusal(
      owner ? `OpenClaw process (PID ${owner.pid})` : "another OpenClaw process",
    );
  }
}

function cleanupOwnerRefusal(owner: string): ExpectedCliError {
  const message = `Cannot run local sessions cleanup: ${owner} owns this state; run Gateway-delegated cleanup without --store, or stop the Gateway and other owners first.`;
  return new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
}
