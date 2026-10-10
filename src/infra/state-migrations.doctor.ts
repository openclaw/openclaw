import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  discardLegacyRegistryWorktrees,
  rewriteRegistryWorktreePathsForMigration,
} from "../agents/worktrees/registry.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { listReferencedLegacyOAuthSidecarPaths } from "../commands/doctor-auth-legacy-paths.js";
import { createConfigRuntimeEnv } from "../config/config-env-vars.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { resolveConfigPath, resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { migrateLegacyMainSessionKeys } from "../config/sessions/legacy-main-session-migration.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveConfiguredAgentDatabaseTargets,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectRelevantDoctorPluginIds,
  listPluginDoctorSessionStoreAgentIds,
  type PluginDoctorStateMigrationInventory,
  resolveLivePluginDoctorStateMigrationInventory,
  resolvePluginDoctorStateMigrationInventory,
} from "../plugins/doctor-contract-registry.js";
import {
  legacyInstalledPluginIndexUnsupportedMessage,
  resolveLegacyInstalledPluginIndexStorePath,
} from "../plugins/installed-plugin-index-store-path.js";
import {
  EMPTY_LEGACY_SESSION_SURFACES,
  type PreparedLegacySessionSurfaces,
} from "../plugins/legacy-session-surfaces.types.js";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MAIN_KEY,
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
} from "../routing/session-key.js";
import { listAgentDatabaseAdmissionRefusals } from "../state/agent-database-admission.js";
import { inspectOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry.js";
import { detectOpenClawStateDatabaseSchemaMigrations } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { listLegacyPairingStoreFiles } from "./pairing-files.js";
import { isPathInside } from "./path-guards.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker.js";
import {
  legacyAgentQuarantineNotices,
  resolveLegacyStandaloneAgentDir,
} from "./state-migrations.agent-dir-receipt.js";
import {
  detectLegacyApnsRegistrations,
  migrateLegacyApnsRegistrations,
} from "./state-migrations.apns.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";
import {
  detectLegacyChannelPairingState,
  migrateLegacyChannelPairingState,
} from "./state-migrations.channel-pairing.js";
import {
  detectLegacyCommitments,
  migrateLegacyCommitments,
} from "./state-migrations.commitments.js";
import { migrateLegacyConfigMachineState } from "./state-migrations.config-machine-state.js";
import {
  detectLegacyDebugProxyCaptureSidecar,
  migrateLegacyDebugProxyCaptureSidecar,
} from "./state-migrations.debug-proxy.js";
import { detectLegacyDeviceAuth, migrateLegacyDeviceAuth } from "./state-migrations.device-auth.js";
import {
  detectLegacyDeviceIdentity,
  migrateLegacyDeviceIdentity,
} from "./state-migrations.device-identity.js";
import {
  detectManagedWorktreeStateMigration,
  prepareDoctorAgentDatabaseDiscovery,
  resolveConcreteBindingAccountId,
} from "./state-migrations.doctor-discovery.js";
import {
  detectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "./state-migrations.exec-approvals.js";
import { migrationFileExists, readSessionStoreJson5 } from "./state-migrations.fs.js";
import {
  classifyLegacyOwnerFindings,
  hasCustomAgentDirOverride,
  resolveLegacyStateMigrationOwner,
} from "./state-migrations.legacy-owner.js";
import {
  inspectLegacyAgentDir,
  migrateLegacyAgentDir,
  migrateLegacySessions,
} from "./state-migrations.legacy-sessions.js";
import {
  detectLegacyManagedOutgoingImages,
  migrateLegacyManagedOutgoingImages,
} from "./state-migrations.managed-outgoing-images.js";
import {
  detectLegacyMcpOAuthStores,
  migrateLegacyMcpOAuthStores,
} from "./state-migrations.mcp-oauth.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "./state-migrations.media-persistence-targets.js";
import {
  detectLegacyMeetingTranscripts,
  migrateLegacyMeetingTranscripts,
} from "./state-migrations.meeting-transcripts.js";
import {
  formatStartupMigrationFailure,
  logStateMigrationResult,
  mergeNotices,
} from "./state-migrations.messages.js";
import {
  detectLegacyNodeHostConfig,
  migrateLegacyNodeHostConfig,
} from "./state-migrations.node-host.js";
import {
  captureLegacyStateSnapshotIdentity,
  closeMigrationPlanTail,
  createBlockedLegacyStateMigrationStepReceipts,
  migrationStepPlan,
  createLegacyStateMigrationCallerEnv,
  createLegacyStateMigrationPlanEnv,
  createLegacyStateMigrationPlan,
  readLegacyStateMigrationPlanConfig,
  refuseLegacyStateMigrationPlan,
  remapMigrationEndpointRoot,
  type PreparedLegacyStateMigrationStep,
} from "./state-migrations.plan.js";
import {
  collectPluginDoctorStateMigrationPlans,
  runPluginDoctorStateMigrationPlans,
} from "./state-migrations.plugin-doctor.js";
import {
  buildPlannedPluginStateMigrationDescriptor,
  preparePostSessionPluginMigration,
} from "./state-migrations.plugin-plan.js";
import {
  buildLegacyStateMigrationPreludeSteps,
  buildUnresolvedBlockedPreludeSteps,
  createAgentTargetDiscoveryStep,
  createConfigMigrationSources,
  createDeferredPluginSessionStoreRefusal,
  inspectOrphanSessionStoreEndpoints,
  uniqueMigrationEndpoints,
} from "./state-migrations.prelude.js";
import {
  detectLegacyRescuePending,
  discardLegacyRescuePending,
} from "./state-migrations.rescue-pending.js";
import { listRetiredDeliveryQueueFiles } from "./state-migrations.retired-delivery-files.js";
import { assertNoRetiredStateFiles } from "./state-migrations.retired-files.js";
import { assertNoRetiredRuntimeStateFiles } from "./state-migrations.retired-runtime-files.js";
import {
  migrateLegacyConfigHealth,
  resolveLegacyConfigHealthPath,
} from "./state-migrations.runtime-state.js";
import {
  listLegacySessionKeys,
  mergeSessionStoreAliasPlans,
  migrateLegacyAcpSessionMetadata,
  resolveSessionStoreOwnership,
  type SessionStoreOwnership,
} from "./state-migrations.session-store.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "./state-migrations.shared-auth-store.js";
import {
  autoMigrateLegacyStateDir,
  resolvePendingLegacyStateDirMigrationPaths,
} from "./state-migrations.state-dir.js";
import {
  createStateSchemaMigrationStep,
  describeStateSchemaMigration,
} from "./state-migrations.state-schema.js";
import { runLegacyStateMigrationSteps } from "./state-migrations.steps.js";
import {
  detectLegacyTuiLastSessions,
  inspectLegacyTuiLastSessionRefusal,
  migrateLegacyTuiLastSessions,
} from "./state-migrations.tui-last-session.js";
import type {
  LegacyStateDetection,
  LegacyStateMigrationEndpoint,
  LegacyStateMigrationInvocationPurpose,
  LegacyStateMigrationMode,
  LegacyStateMigrationPlan,
  LegacyStateMigrationStepReceipt,
  MigrationLogger,
  MigrationMessages,
  LegacyStateMigrationStep,
  PreparedPostSessionPluginMigration,
} from "./state-migrations.types.js";
import { detectLegacyWebPush, migrateLegacyWebPush } from "./state-migrations.web-push.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "./state-migrations.workspace-setup.js";
import {
  isUpdateRehearsalReadOnlyPath,
  resolveUpdateRehearsalRoot,
} from "./update-rehearsal-paths.js";

const autoMigrateChecked = new Set<string>();

export async function detectLegacyStateMigrations(params: {
  cfg: OpenClawConfigWithLegacyRoster;
  /** Doctor's original resolved locators, before roster ownership was materialized. */
  sourceConfigBeforeMigrations?: OpenClawConfigWithLegacyRoster;
  /** Legacy session file inspection belongs to Doctor, including its read-only preview. */
  mode?: "automatic" | "doctor";
  pluginDoctorConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  pluginSessionStoreAgentIds?: readonly string[];
  sessionStoreOwnership?: SessionStoreOwnership;
  doctorOnlyStateMigrations?: boolean;
  /** Candidate planning must not load plugin-owned Doctor contracts. */
  pluginPlanning?: "enabled" | "deferred";
  /** Candidate planning must not update SQLite coordination artifacts or runtime caches. */
  artifactPreservingReadOnly?: boolean;
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
}): Promise<LegacyStateDetection> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const stateDir = resolveStateDir(env, homedir);
  assertNoRetiredRuntimeStateFiles(stateDir, env, homedir);
  assertNoRetiredStateFiles("JSON delivery queues", listRetiredDeliveryQueueFiles(stateDir));
  const oauthDir = resolveOAuthDir(
    createConfigRuntimeEnv(params.sourceConfigBeforeMigrations ?? params.cfg, env),
    stateDir,
  );
  const detectSessionFiles = params.mode !== "automatic";
  const { installAgentDir, migrationTarget, migrationAgentId, sessionMigrationAgentId } =
    resolveLegacyStateMigrationOwner({
      cfg: params.cfg,
      locatorConfig: params.sourceConfigBeforeMigrations ?? params.cfg,
      env,
      homedir,
    });
  const targetAgentId = migrationAgentId ?? sessionMigrationAgentId ?? LEGACY_IMPLICIT_AGENT_ID;
  const targetMainKey = normalizeOptionalString(params.cfg.session?.mainKey) ?? DEFAULT_MAIN_KEY;
  const targetScope = params.cfg.session?.scope;

  const sessionsTargetDir = path.join(stateDir, "agents", targetAgentId, "sessions");
  const sessionsTargetStorePath = path.join(sessionsTargetDir, "sessions.json");
  const pluginConfig = params.pluginDoctorConfig ?? params.cfg;
  const pluginPlanningEnabled = params.pluginPlanning !== "deferred";
  const pluginSessionStoreAgentIds =
    params.pluginSessionStoreAgentIds ??
    (pluginPlanningEnabled
      ? listPluginDoctorSessionStoreAgentIds({
          config: pluginConfig,
          env,
          pluginIds: collectRelevantDoctorPluginIds(pluginConfig),
        })
      : []);
  const currentSessionStoreOwnership =
    detectSessionFiles && sessionMigrationAgentId
      ? resolveSessionStoreOwnership({
          cfg: params.cfg,
          env,
          stateDir,
          targetAgentId: sessionMigrationAgentId,
          pluginSessionStoreAgentIds,
        })
      : {
          preserveAmbiguousKeys: true,
          preserveForeignMainAliases: true,
          targetStoreAliases: {
            hasDistinctAliases: false,
            hasFinalSymlink: false,
            hasUnresolvedIdentity: false,
          },
        };
  const sessionStoreOwnership: SessionStoreOwnership = {
    preserveAmbiguousKeys:
      params.sessionStoreOwnership?.preserveAmbiguousKeys === true ||
      currentSessionStoreOwnership.preserveAmbiguousKeys,
    preserveForeignMainAliases:
      params.sessionStoreOwnership?.preserveForeignMainAliases === true ||
      currentSessionStoreOwnership.preserveForeignMainAliases,
    targetStoreAliases: mergeSessionStoreAliasPlans(
      params.sessionStoreOwnership?.targetStoreAliases,
      currentSessionStoreOwnership.targetStoreAliases,
    ),
  };
  const { preserveForeignMainAliases } = sessionStoreOwnership;
  const targetSessionParsed =
    detectSessionFiles && migrationFileExists(sessionsTargetStorePath)
      ? readSessionStoreJson5(sessionsTargetStorePath)
      : { store: {}, ok: true };
  const legacySessionSurfaces = detectSessionFiles
    ? params.legacySessionSurfaces
    : EMPTY_LEGACY_SESSION_SURFACES;
  const legacyKeys =
    targetSessionParsed.ok && legacySessionSurfaces.failures.length === 0
      ? listLegacySessionKeys({
          store: targetSessionParsed.store,
          agentId: targetAgentId,
          mainKey: targetMainKey,
          scope: targetScope,
          preserveAmbiguousKeys: sessionStoreOwnership.preserveAmbiguousKeys,
          preserveForeignMainAliases,
          legacySessionSurfaces: legacySessionSurfaces.surfaces,
        })
      : [];
  const targetAgentDir = migrationTarget?.dir;
  const targetAgentIdentity = targetAgentDir
    ? resolveIdentityPathViaExistingAncestorSync(targetAgentDir)
    : undefined;
  const rehearsalRoot = resolveUpdateRehearsalRoot(env);
  const seenAgentSources = new Set<string>();
  const legacyAgentInspections = [
    { legacyDir: resolveLegacyStandaloneAgentDir(homedir), standalone: true },
    { legacyDir: path.join(stateDir, "agent"), standalone: false },
  ]
    .filter(({ legacyDir }) => {
      const identity = resolveIdentityPathViaExistingAncestorSync(legacyDir);
      if (identity === targetAgentIdentity || seenAgentSources.has(identity)) {
        return false;
      }
      seenAgentSources.add(identity);
      return true;
    })
    .map((source) => {
      // Copied plans bind stateDir, not a separate home tree; do not open its payload.
      const outsideSnapshot = Boolean(
        isUpdateRehearsalReadOnlyPath(source.legacyDir, env) ||
        (params.artifactPreservingReadOnly &&
          listMigrationEndpointsOutsideRoot([{ kind: "path", path: source.legacyDir }], stateDir)
            .length > 0),
      );
      const inspection = outsideSnapshot
        ? lstatSync(source.legacyDir, { throwIfNoEntry: false })
          ? {
              status: "failed" as const,
              warning: `Legacy agent source is outside the copied state snapshot: ${source.legacyDir}. Run openclaw doctor --fix on the original installation.`,
            }
          : { status: "empty" as const }
        : inspectLegacyAgentDir(source.legacyDir);
      return { source, inspection, outsideSnapshot };
    });
  const legacyAgentSources = legacyAgentInspections.flatMap(({ source, inspection }) =>
    inspection.status === "payload"
      ? [
          {
            ...source,
            // Keep the permitted source root fixed across discovery and execution.
            boundaryRoot: resolveIdentityPathViaExistingAncestorSync(
              rehearsalRoot ?? (source.standalone ? path.dirname(source.legacyDir) : stateDir),
            ),
          },
        ]
      : [],
  );
  const hasLegacyAgentDir = legacyAgentSources.length > 0;
  const pluginInstallIndexPath = resolveLegacyInstalledPluginIndexStorePath({ stateDir });
  const hasPluginInstallIndex = migrationFileExists(pluginInstallIndexPath);
  const debugProxyCaptureSidecar = detectLegacyDebugProxyCaptureSidecar(stateDir, env);
  const stateSchemaMigrations = detectOpenClawStateDatabaseSchemaMigrations(
    { env: { ...env, OPENCLAW_STATE_DIR: stateDir } },
    { artifactPreservingReadOnly: params.artifactPreservingReadOnly },
  );
  const worktrees = await detectManagedWorktreeStateMigration({
    env,
    stateDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
  });
  const pairingStoreFiles =
    params.mode === "automatic" ? [] : await listLegacyPairingStoreFiles(stateDir);
  const configHealth = {
    sourcePath: resolveLegacyConfigHealthPath(stateDir),
  };
  const hasConfigHealth = migrationFileExists(configHealth.sourcePath);
  const detectDoctorOwnedState = <TDetection>(
    detect: (options: { stateDir: string; doctorOnlyStateMigrations?: boolean }) => TDetection,
  ): TDetection =>
    detect({ stateDir, doctorOnlyStateMigrations: params.doctorOnlyStateMigrations });
  const tuiLastSessions = detectDoctorOwnedState(detectLegacyTuiLastSessions);
  const commitments = await detectLegacyCommitments({
    stateDir,
    env,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const auditLogs = detectDoctorOwnedState(detectLegacyAuditLogs);
  const managedOutgoingImages = detectDoctorOwnedState(detectLegacyManagedOutgoingImages);
  const apns = detectDoctorOwnedState(detectLegacyApnsRegistrations);
  const deviceAuth = detectDoctorOwnedState(detectLegacyDeviceAuth);
  const sharedAuthStore = detectSharedAuthStoreMigration({
    stateDir,
    env,
    doctorOnlyStateMigrations:
      stateSchemaMigrations.length === 0 && params.doctorOnlyStateMigrations === true,
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
  });
  const deviceIdentity = detectLegacyDeviceIdentity({
    stateDir,
    env,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const execApprovals = detectDoctorOwnedState(detectLegacyExecApprovals);
  const mcpOauth = detectDoctorOwnedState(detectLegacyMcpOAuthStores);
  const meetingTranscripts = detectLegacyMeetingTranscripts({
    stateDir,
    env,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
  });
  const workspace = await detectLegacyWorkspaceState({
    cfg: params.cfg,
    stateDir,
    env,
    homedir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const webPush = detectDoctorOwnedState(detectLegacyWebPush);
  const nodeHost = detectDoctorOwnedState(detectLegacyNodeHostConfig);
  const rescuePending = detectDoctorOwnedState(detectLegacyRescuePending);
  const channelPairing = detectLegacyChannelPairingState({
    sourceDir: oauthDir,
    configuredChannelIds: Object.keys(params.cfg.channels ?? {}),
    deferConfiguredAccountDiscovery: !pluginPlanningEnabled,
    resolveAccounts: () => {
      const configuredChannels = Object.entries(params.cfg.channels ?? {});
      // Doctor already resolved this migration owner; plugin defaults must not infer it again.
      let migrationOwnerConfig = params.cfg;
      if (migrationAgentId && listAgentIds(params.cfg).length > 1 && params.cfg.agents) {
        const agents = structuredClone(params.cfg.agents);
        delete agents.ownership;
        for (const [agentId, entry] of Object.entries(agents.entries ?? {})) {
          entry.default = normalizeAgentId(agentId) === targetAgentId;
        }
        for (const entry of agents.list ?? []) {
          entry.default = normalizeAgentId(entry.id) === targetAgentId;
        }
        migrationOwnerConfig = { ...params.cfg, agents };
      }
      const configuredAccountIds = Object.fromEntries(
        configuredChannels.map(([channelId, value]) => {
          const channelConfig = asOptionalRecord(value);
          const plugin = pluginPlanningEnabled
            ? getChannelPlugin(channelId as ChannelId)
            : undefined;
          const accountIds = [
            ...(plugin?.config.listAccountIds(params.cfg) ?? []),
            ...Object.keys(asOptionalRecord(channelConfig?.accounts) ?? {}),
            ...(typeof channelConfig?.defaultAccount === "string"
              ? [channelConfig.defaultAccount]
              : []),
            ...(params.cfg.bindings ?? []).flatMap((binding) => {
              const accountId =
                binding.match?.channel === channelId
                  ? resolveConcreteBindingAccountId(binding.match.accountId)
                  : undefined;
              return accountId ? [accountId] : [];
            }),
          ];
          return [
            channelId,
            Array.from(new Set(accountIds.map((entry) => entry.trim()).filter(Boolean))),
          ];
        }),
      );
      return {
        defaultAccountIds: Object.fromEntries(
          configuredChannels.map(([channelId, value]) => {
            const boundAccountId = params.cfg.bindings?.find(
              (binding) =>
                normalizeAgentId(binding.agentId) === targetAgentId &&
                binding.match?.channel === channelId &&
                resolveConcreteBindingAccountId(binding.match.accountId) !== undefined,
            )?.match.accountId;
            const concreteBoundAccountId = resolveConcreteBindingAccountId(boundAccountId);
            if (concreteBoundAccountId) {
              return [channelId, concreteBoundAccountId];
            }
            const defaultAccount = normalizeOptionalString(asOptionalRecord(value)?.defaultAccount);
            if (defaultAccount) {
              return [channelId, defaultAccount];
            }
            const plugin = pluginPlanningEnabled
              ? getChannelPlugin(channelId as ChannelId)
              : undefined;
            if (plugin) {
              const accountId = resolveChannelDefaultAccountId({
                plugin,
                cfg: migrationOwnerConfig,
              });
              return [channelId, accountId];
            }
            return [
              channelId,
              configuredAccountIds[channelId]?.toSorted()[0] ?? DEFAULT_ACCOUNT_ID,
            ];
          }),
        ),
        accountIds: configuredAccountIds,
      };
    },
  });
  const pluginPlanWarnings: string[] = [];
  const pluginPlans =
    stateSchemaMigrations.length > 0 || !pluginPlanningEnabled
      ? []
      : (
          await collectPluginDoctorStateMigrationPlans(
            { config: pluginConfig, env, stateDir, oauthDir },
            {
              includeDoctorOnly: params.doctorOnlyStateMigrations === true,
              warnings: pluginPlanWarnings,
              // Keep preview facts so execution can receipt the exact frozen endpoints.
              // The writer validates every declared action before phase filtering.
              validateDeclarations: false,
            },
          )
        ).plans;

  const sessionsHaveLegacy = Boolean(sessionMigrationAgentId) && legacyKeys.length > 0;
  const agentDirHasLegacy = Boolean(migrationAgentId) && hasLegacyAgentDir;
  const deferredSessions = !sessionMigrationAgentId && legacyKeys.length > 0;
  const deferredAgentDir = !migrationAgentId && hasLegacyAgentDir;
  const ownerFindings = classifyLegacyOwnerFindings({
    requiredWarnings: [...pluginPlanWarnings, ...legacySessionSurfaces.failures],
    agentInspections: legacyAgentInspections,
    usesLegacyRuntimeDirectory: () =>
      installAgentDir.optionalDirectory?.migrationState === "legacy",
    deferredSessions,
    deferredAgentDir,
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations,
  });
  const preview: string[] = [];
  if (sessionsHaveLegacy && legacyKeys.length > 0) {
    preview.push(`- Sessions: canonicalize legacy keys in ${sessionsTargetStorePath}`);
  }
  if (agentDirHasLegacy) {
    preview.push(
      ...legacyAgentSources.map(({ legacyDir }) => `- Agent dir: ${legacyDir} → ${targetAgentDir}`),
    );
  }
  if (hasPluginInstallIndex) {
    preview.push(`- ${legacyInstalledPluginIndexUnsupportedMessage(pluginInstallIndexPath)}`);
  }
  if (debugProxyCaptureSidecar.hasLegacy) {
    preview.push(
      `- Debug proxy capture sidecar: ${debugProxyCaptureSidecar.sourcePath} → shared SQLite state`,
    );
  }
  if (stateSchemaMigrations.length > 0) {
    for (const migration of stateSchemaMigrations) {
      preview.push(`- Shared SQLite schema: ${describeStateSchemaMigration(migration)}`);
    }
    preview.push(
      "- Rerun doctor after shared SQLite schema repair to detect plugin state migrations",
    );
  }
  if (worktrees.hasLegacy) {
    preview.push("- Managed worktrees: discard rows without provisioned-file ledgers");
  }
  if (worktrees.pathRewrites.length > 0) {
    preview.push(
      `- Managed worktrees: canonicalize ${worktrees.pathRewrites.length} persisted ${worktrees.pathRewrites.length === 1 ? "path" : "paths"} for symlinked state directories`,
    );
  }
  const stateMigrationPreviews: Array<readonly [hasLegacy: boolean, message: string]> = [
    [
      sharedAuthStore.hasLegacy,
      sharedAuthStore.held
        ? `- Shared auth store skipped: store held: ${sharedAuthStore.sourcePath}`
        : "- Shared auth store: legacy main-agent rows → shared SQLite state",
    ],
    [hasConfigHealth, "- Config health state: legacy JSON file → shared SQLite state"],
    [
      tuiLastSessions.hasLegacy,
      "- TUI last-session pointers: legacy JSON file → shared SQLite state",
    ],
    [
      commitments.hasLegacy,
      "- Commitments: discard retired commitments/commitments.json rows without import, archive, or export",
    ],
    ...auditLogs.sources.map((source): readonly [boolean, string] => [
      true,
      `- ${source.label}: legacy JSONL file → shared SQLite state`,
    ]),
    [
      managedOutgoingImages.hasLegacy,
      "- Managed outgoing images: legacy record JSON → shared SQLite state",
    ],
    [apns.hasLegacy, "- APNs registrations: legacy JSON → shared SQLite state"],
    [deviceAuth.hasLegacy, "- Device auth tokens: legacy JSON → shared SQLite state"],
    [deviceIdentity.hasLegacy, "- Primary device identity: legacy JSON → shared SQLite state"],
    [
      deviceIdentity.hasInvalidCanonical && !deviceIdentity.hasLegacy,
      "- Primary device identity: invalid SQLite row → new device identity",
    ],
    [execApprovals.hasLegacy, execApprovals.preview],
    [mcpOauth.hasLegacy, "- MCP OAuth credentials: legacy JSON → shared SQLite state"],
    [
      meetingTranscripts.hasLegacy,
      "- Meeting transcripts: legacy JSON/JSONL files → shared SQLite state",
    ],
    [workspace.hasLegacy, "- Workspace setup and attestations: legacy files → shared SQLite state"],
    [
      webPush.hasLegacy,
      "- Web Push subscriptions and VAPID identity: legacy JSON → shared SQLite state",
    ],
    [nodeHost.hasLegacy, "- Node-host config: legacy node.json → shared SQLite state"],
    [
      rescuePending.hasLegacy,
      "- System-agent rescue approvals: discard retired pending JSON capabilities",
    ],
    [channelPairing.hasLegacy, "- Channel pairing state: legacy JSON files → shared SQLite state"],
    [
      pairingStoreFiles.length > 0,
      "- Device and node pairing: legacy JSON files → shared SQLite state",
    ],
  ];
  for (const [hasLegacy, message] of stateMigrationPreviews) {
    if (hasLegacy) {
      preview.push(message);
    }
  }
  if (pluginPlans.length > 0) {
    preview.push(...pluginPlans.flatMap((plan) => plan.preview));
  }

  return {
    doctorOnlyStateMigrations: params.doctorOnlyStateMigrations === true,
    targetAgentId,
    targetMainKey,
    targetScope,
    stateDir,
    oauthDir,
    pluginSessionStoreAgentIds,
    sessions: {
      targetDir: sessionsTargetDir,
      targetStorePath: sessionsTargetStorePath,
      hasLegacy: sessionsHaveLegacy,
      legacyKeys: sessionMigrationAgentId ? legacyKeys : [],
      preserveAmbiguousKeys: sessionStoreOwnership.preserveAmbiguousKeys,
      preserveForeignMainAliases,
      targetStoreAliases: sessionStoreOwnership.targetStoreAliases,
    },
    agentDir: {
      sources: legacyAgentSources,
      targetDir: targetAgentDir,
      hasLegacy: agentDirHasLegacy,
    },
    pluginPlans: {
      hasLegacy: pluginPlans.length > 0,
      plans: pluginPlans,
    },
    pluginInstallIndex: {
      sourcePath: pluginInstallIndexPath,
      hasLegacy: hasPluginInstallIndex,
    },
    debugProxyCaptureSidecar,
    stateSchema: {
      hasLegacy: stateSchemaMigrations.length > 0,
      preview: stateSchemaMigrations.map((migration) => migration.path),
    },
    sharedAuthStore,
    worktrees,
    pairingStores: { sourcePaths: pairingStoreFiles, hasLegacy: pairingStoreFiles.length > 0 },
    configHealth: {
      ...configHealth,
      hasLegacy: hasConfigHealth,
    },
    tuiLastSessions,
    commitments,
    auditLogs,
    managedOutgoingImages,
    apns,
    deviceAuth,
    deviceIdentity,
    execApprovals,
    mcpOauth,
    meetingTranscripts,
    workspace,
    webPush,
    nodeHost,
    rescuePending,
    channelPairing,
    ...ownerFindings,
    notices: [...ownerFindings.notices, ...legacyAgentQuarantineNotices(stateDir, targetAgentId)],
    preview,
  };
}

const unresolvedMigrationStepLayout = [
  ["device-auth", "shared", "all"],
  ["device-identity", "shared", "all"],
  ["meeting-transcripts", "shared", "all"],
  ["managed-worktrees", "shared", "all"],
  ["shared-auth-store", "shared", "all"],
  ["debug-proxy-capture", "shared", "all"],
  ["config-health", "shared", "all"],
  ["delivery-queues", "shared", "doctor"],
  ["pairing-stores", "shared", "doctor"],
  ["tui-last-session", "final", "doctor"],
  ["commitments", "final", "doctor"],
  ["audit-logs", "final", "doctor"],
  ["managed-outgoing-images", "final", "doctor"],
  ["apns-registrations", "final", "doctor"],
  ["exec-approvals", "final", "doctor"],
  ["mcp-oauth", "final", "doctor"],
  ["workspace-state", "final", "all"],
  ["web-push", "final", "doctor"],
  ["node-host", "final", "doctor"],
  ["rescue-pending", "final", "doctor"],
  ["skill-workshop", "final", "doctor"],
  ["channel-pairing", "final", "doctor"],
  ["plugin-doctor-state", "final", "all"],
  ["sessions", "final", "doctor-agent"],
  ["legacy-main-session-keys", "final", "automatic"],
  ["acp-session-metadata", "final", "doctor-agent"],
  ["agent-dir", "final", "agent"],
  ["plugin-doctor-post-session-state", "final", "doctor"],
] as const satisfies ReadonlyArray<
  readonly [
    id: string,
    phase: LegacyStateMigrationStep["phase"],
    scope: "all" | "doctor" | "automatic" | "doctor-agent" | "agent",
  ]
>;

function buildUnresolvedBlockedMigrationSteps(params: {
  mode: LegacyStateMigrationMode;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  skipAgentScopedMigrations: boolean;
  pluginStateMigrationInventory?: PluginDoctorStateMigrationInventory;
}): LegacyStateMigrationStep[] {
  return unresolvedMigrationStepLayout.flatMap(([id, phase, scope]) => {
    const included =
      scope === "all" ||
      (id === "agent-dir" && Boolean(params.env.OPENCLAW_AGENT_DIR)) ||
      (scope === "doctor" && params.mode === "doctor") ||
      (scope === "automatic" && params.mode === "automatic") ||
      (scope === "doctor-agent" && params.mode === "doctor" && !params.skipAgentScopedMigrations) ||
      (scope === "agent" && !params.skipAgentScopedMigrations);
    if (!included) {
      return [];
    }
    const pluginDescriptor =
      (id === "plugin-doctor-state" || id === "plugin-doctor-post-session-state") &&
      params.pluginStateMigrationInventory
        ? buildPlannedPluginStateMigrationDescriptor({
            inventory: params.pluginStateMigrationInventory,
            mode: params.mode,
            ...(id === "plugin-doctor-post-session-state"
              ? { phase: "after-session-repair" as const }
              : {}),
          })
        : undefined;
    return [
      {
        id,
        phase,
        // Artifact endpoints are unknowable after detection itself fails. Empty
        // endpoints preserve that fact while the receipt closes every stable owner.
        source: pluginDescriptor?.source ?? [],
        target: pluginDescriptor?.target ?? [],
        requiredness: pluginDescriptor?.requiredness ?? "conditional",
        reversibility: "checkpoint-required",
        ...(id === "tui-last-session"
          ? {
              inspectRefusal: () =>
                inspectLegacyTuiLastSessionRefusal(
                  detectLegacyTuiLastSessions({
                    stateDir: params.stateDir,
                    doctorOnlyStateMigrations: true,
                  }),
                ),
            }
          : {}),
        run: () => ({ changes: [], warnings: [] }),
      },
    ];
  });
}

function createPluginInstallIndexStep(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  hasLegacy: boolean;
}): LegacyStateMigrationStep {
  const sourcePath = resolveLegacyInstalledPluginIndexStorePath(params);
  const message = legacyInstalledPluginIndexUnsupportedMessage(sourcePath);
  return {
    id: "plugin-install-index",
    phase: "shared",
    source: [{ kind: "path", path: sourcePath }],
    target: [],
    requiredness: params.hasLegacy ? "required" : "not-required",
    reversibility: "not-applicable",
    ...(params.hasLegacy ? { refusal: { code: "unsupported-plugin-install-index", message } } : {}),
    run: () => ({
      changes: [],
      warnings: migrationFileExists(sourcePath) ? [message] : [],
    }),
  };
}

function createConfigMachineStateStep(params: {
  config: OpenClawConfig;
  configPath: string;
  configIncludedPaths: readonly string[];
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): LegacyStateMigrationStep {
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  return {
    id: "config-machine-state",
    phase: "shared",
    source: createConfigMigrationSources(params.configPath, params.configIncludedPaths),
    target: [{ kind: "sqlite", path: resolveOpenClawStateSqlitePath(stateEnv) }],
    requiredness: "conditional",
    reversibility: "checkpoint-required",
    run: () => migrateLegacyConfigMachineState({ config: params.config, env: stateEnv }),
  };
}

function createMigrationDetectionStep(params: {
  configPath: string;
  configIncludedPaths: readonly string[];
  stateDir: string;
  run: LegacyStateMigrationStep["run"];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
}): LegacyStateMigrationStep {
  return {
    id: "migration-detection",
    phase: "shared",
    source: [
      ...createConfigMigrationSources(params.configPath, params.configIncludedPaths),
      { kind: "path", path: params.stateDir },
    ],
    target: [],
    requiredness: "required",
    reversibility: "not-applicable",
    ...(params.refusal ? { refusal: params.refusal } : {}),
    run: params.run,
  };
}

function createPluginMigrationPreparationStep(params: {
  configPath: string;
  configIncludedPaths: readonly string[];
  pluginIds: readonly string[];
  run: LegacyStateMigrationStep["run"];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
}): LegacyStateMigrationStep {
  return {
    id: "plugin-migration-preparation",
    phase: "shared",
    source: [
      ...createConfigMigrationSources(params.configPath, params.configIncludedPaths),
      ...params.pluginIds.map((pluginId): LegacyStateMigrationEndpoint => ({
        kind: "owner",
        id: `plugin:${pluginId}`,
      })),
    ],
    target: [],
    requiredness: "required",
    reversibility: "not-applicable",
    ...(params.refusal ? { refusal: params.refusal } : {}),
    run: params.run,
  };
}

function listMigrationEndpointsOutsideRoot(
  endpoints: readonly LegacyStateMigrationEndpoint[],
  root: string,
): LegacyStateMigrationEndpoint[] {
  const resolvedRoot = path.resolve(root);
  const identityRoot = resolveIdentityPathViaExistingAncestorSync(resolvedRoot);
  return uniqueMigrationEndpoints(
    endpoints.filter((endpoint) => {
      if (endpoint.kind === "owner") {
        return false;
      }
      const resolvedPath = path.resolve(endpoint.path);
      const identityPath = resolveIdentityPathViaExistingAncestorSync(resolvedPath);
      return !isPathInside(resolvedRoot, resolvedPath) || !isPathInside(identityRoot, identityPath);
    }),
  );
}

function createSessionTargetOutsideSnapshotRefusal(
  endpoints: readonly LegacyStateMigrationEndpoint[],
): NonNullable<PreparedLegacyStateMigrationStep["refusal"]> {
  return {
    code: "session-target-outside-snapshot",
    message: `Configured session migration endpoints are outside the copied state root and require a separately bound snapshot: ${endpoints
      .map((endpoint) => (endpoint.kind === "owner" ? endpoint.id : path.resolve(endpoint.path)))
      .toSorted()
      .join(", ")}`,
  };
}

function createDeferredPluginSessionStoreEndpoints(
  config: OpenClawConfig,
  inventory: PluginDoctorStateMigrationInventory,
): LegacyStateMigrationEndpoint[] {
  const knownPluginIds = new Set(inventory.knownPluginIds);
  const sessionStoreOwnerPluginIds = new Set(inventory.sessionStoreOwnerPluginIds);
  return collectRelevantDoctorPluginIds(config)
    .filter((pluginId) => !knownPluginIds.has(pluginId) || sessionStoreOwnerPluginIds.has(pluginId))
    .map((pluginId) => ({
      kind: "owner",
      id: `plugin:${pluginId}:session-store`,
    }));
}

function createPluginMigrationPreparationRefusal(params: {
  inventory: PluginDoctorStateMigrationInventory;
  deferredSessionStoreEndpoints: readonly LegacyStateMigrationEndpoint[];
}): PreparedLegacyStateMigrationStep["refusal"] | undefined {
  if (
    params.deferredSessionStoreEndpoints.length === 0 &&
    params.inventory.unresolvedPluginIds.length === 0
  ) {
    return undefined;
  }
  return {
    code: "plugin-planning-deferred",
    message:
      "Plugin migration preparation requires plugin and session-store descriptors for the new version.",
  };
}

function resolveConfiguredSessionStoreEndpoints(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): LegacyStateMigrationEndpoint[] {
  return uniqueMigrationEndpoints(
    [
      ...new Set([
        ...listConfiguredSessionStoreAgentIds(config),
        resolveSessionStoreCompatibilityAgentId(config),
      ]),
    ].map((agentId) => ({
      kind: "path" as const,
      path: resolveSessionStorePathCore(config.session?.store, { agentId, env }),
    })),
  );
}

function bindAgentDatabaseTargetsToStateRoot(
  targets: readonly { agentId: string; path: string }[],
  stateDir: string,
): {
  targets: Array<{ agentId: string; path: string }>;
  outsideEndpoints: LegacyStateMigrationEndpoint[];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
} {
  const outsideEndpoints = listMigrationEndpointsOutsideRoot(
    targets.map(({ path: databasePath }) => ({
      kind: "sqlite" as const,
      path: databasePath,
    })),
    stateDir,
  );
  const outsidePaths = new Set(
    outsideEndpoints.flatMap((endpoint) =>
      endpoint.kind === "owner" ? [] : [path.resolve(endpoint.path)],
    ),
  );
  if (outsidePaths.size === 0) {
    return { targets: [...targets], outsideEndpoints: [] };
  }
  return {
    targets: targets.filter((target) => !outsidePaths.has(path.resolve(target.path))),
    outsideEndpoints,
    refusal: createSessionTargetOutsideSnapshotRefusal(outsideEndpoints),
  };
}

type LegacyStateMigrationExecutionPlan = {
  mode: LegacyStateMigrationMode;
  detected: LegacyStateDetection;
  config: OpenClawConfig;
  sessionConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  agentDatabaseEndpoints?: LegacyStateMigrationEndpoint[];
  legacySessionStoreEndpoints?: LegacyStateMigrationEndpoint[];
  legacySessionStoreRefusal?: PreparedLegacyStateMigrationStep["refusal"];
  skipAgentScopedMigrations?: boolean;
  pluginStateMigrationInventory?: PluginDoctorStateMigrationInventory;
  deferPostSessionPluginMigrations?: boolean;
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
  beforeWorkspaceStateMigration?: (config: OpenClawConfig) => Promise<void>;
};

function buildLegacyStateMigrationSteps(params: LegacyStateMigrationExecutionPlan): {
  preparation: [LegacyStateMigrationStep, LegacyStateMigrationStep];
  remaining: LegacyStateMigrationStep[];
} {
  const { detected, env } = params;
  const stateDir = detected.stateDir;
  const stateDatabase: LegacyStateMigrationEndpoint = {
    kind: "sqlite",
    path: resolveOpenClawStateSqlitePath({ ...env, OPENCLAW_STATE_DIR: stateDir }),
  };
  const now = params.now ?? (() => Date.now());
  const isDoctor = params.mode === "doctor";
  const repairSessionFiles = isDoctor && !params.skipAgentScopedMigrations;
  const pathEndpoints = (...paths: Array<string | undefined>): LegacyStateMigrationEndpoint[] =>
    paths.flatMap((entry) => (entry ? [{ kind: "path" as const, path: entry }] : []));
  type StepSpec = readonly [
    source: LegacyStateMigrationEndpoint[],
    required: boolean | PreparedLegacyStateMigrationStep["requiredness"],
    target?: LegacyStateMigrationEndpoint[],
  ];
  // Detection owns plugin session-store discovery. Carry the prepared owner set
  // into receipts and execution so planning cannot observe a different plugin load.
  const pluginSessionStoreAgentIds = detected.pluginSessionStoreAgentIds;
  const legacySessionStores =
    params.legacySessionStoreEndpoints ??
    inspectOrphanSessionStoreEndpoints({
      config: params.sessionConfig ?? params.config,
      env,
      pluginSessionStoreAgentIds,
    }).endpoints;
  const agentDatabases = params.agentDatabaseEndpoints ?? [
    { kind: "owner" as const, id: "configured-agent-databases" },
  ];
  const canonicalSessionStores = uniqueMigrationEndpoints([
    ...legacySessionStores,
    ...agentDatabases,
  ]);
  // Interactive Doctor confirmation can authorize core migrations without --fix.
  // Plugin doctor-only actions retain detection's explicit-repair authority.
  const pluginMigrationMode = detected.doctorOnlyStateMigrations === true ? "doctor" : "automatic";
  const plannedPluginDescriptor = params.pluginStateMigrationInventory
    ? buildPlannedPluginStateMigrationDescriptor({
        inventory: params.pluginStateMigrationInventory,
        mode: pluginMigrationMode,
      })
    : undefined;
  const plannedPostSessionPluginMigration = params.pluginStateMigrationInventory
    ? preparePostSessionPluginMigration({
        inventory: params.pluginStateMigrationInventory,
        mode: pluginMigrationMode,
      })
    : undefined;
  const pluginMigrationSources = plannedPluginDescriptor
    ? plannedPluginDescriptor.source
    : (detected.pluginPlans?.plans ?? []).map((plan) => ({
        kind: "owner" as const,
        id: `plugin:${plan.pluginId}:${plan.migration.id}`,
      }));
  const pluginMigrationTargets = plannedPluginDescriptor
    ? plannedPluginDescriptor.target
    : [...new Set((detected.pluginPlans?.plans ?? []).map((plan) => plan.pluginId))].map(
        (pluginId) => ({
          kind: "owner" as const,
          id: `plugin:${pluginId}:doctor-state`,
        }),
      );
  const stepSpecs = {
    "managed-worktrees": [
      [
        stateDatabase,
        ...sortUniqueStrings([
          ...detected.worktrees.legacyIds,
          ...detected.worktrees.pathRewrites.map((rewrite) => rewrite.id),
        ]).map((id) => ({
          kind: "owner" as const,
          id: `core:managed-worktree:${id}`,
        })),
      ],
      (isDoctor && detected.worktrees.hasLegacy) || detected.worktrees.pathRewrites.length > 0,
      [stateDatabase],
    ],
    "delivery-queues": [[stateDatabase], "conditional"],
    "pairing-stores": [
      pathEndpoints(...detected.pairingStores.sourcePaths),
      detected.pairingStores.hasLegacy,
    ],
    "device-identity": [
      pathEndpoints(
        detected.deviceIdentity.sourcePath,
        detected.deviceIdentity.claimPath,
        detected.deviceIdentity.nativeClaimPath,
      ),
      detected.deviceIdentity.hasLegacy || detected.deviceIdentity.hasInvalidCanonical,
    ],
    "meeting-transcripts": [
      [...pathEndpoints(detected.meetingTranscripts?.sourceDir), stateDatabase],
      detected.meetingTranscripts?.hasLegacy === true,
    ],
    "skill-workshop": [
      [
        stateDatabase,
        ...pathEndpoints(path.join(stateDir, "skill-workshop")),
        { kind: "owner", id: "core:skill-workshop" },
      ],
      "conditional",
      [stateDatabase, { kind: "owner", id: "core:skill-workshop" }],
    ],
    "channel-pairing": [
      pathEndpoints(
        ...detected.channelPairing.files.map((file) =>
          path.join(detected.channelPairing.sourceDir, file),
        ),
      ),
      detected.channelPairing.hasLegacy,
    ],
    "plugin-doctor-state": [
      pluginMigrationSources,
      plannedPluginDescriptor?.requiredness ?? detected.pluginPlans?.hasLegacy === true,
      pluginMigrationTargets,
    ],
    sessions: [
      pathEndpoints(detected.sessions.targetDir, detected.sessions.targetStorePath),
      detected.sessions.hasLegacy,
      pathEndpoints(detected.sessions.targetDir, detected.sessions.targetStorePath),
    ],
    "legacy-main-session-keys": [canonicalSessionStores, "conditional", canonicalSessionStores],
    "acp-session-metadata": [
      legacySessionStores,
      "conditional",
      uniqueMigrationEndpoints([...legacySessionStores, stateDatabase]),
    ],
    "agent-dir": [
      pathEndpoints(...detected.agentDir.sources.map(({ legacyDir }) => legacyDir)),
      detected.agentDir.hasLegacy,
      pathEndpoints(detected.agentDir.targetDir),
    ],
  } satisfies Record<string, StepSpec>;
  type StepId = keyof typeof stepSpecs;
  const requiredness = (
    required: boolean | PreparedLegacyStateMigrationStep["requiredness"],
  ): PreparedLegacyStateMigrationStep["requiredness"] =>
    typeof required === "string" ? required : required ? "required" : "not-required";
  const descriptor = (
    id: StepId,
    phase: LegacyStateMigrationStep["phase"],
  ): PreparedLegacyStateMigrationStep => {
    const [source, required, target = [stateDatabase]] = stepSpecs[id];
    return {
      id,
      phase,
      source,
      target,
      requiredness: requiredness(required),
      reversibility: "checkpoint-required",
    };
  };
  const sharedStep = (
    id: StepId,
    run: LegacyStateMigrationStep["run"],
    collectNotices = false,
  ): LegacyStateMigrationStep => ({
    ...descriptor(id, "shared"),
    run,
    collectNotices,
  });
  const finalStep = (
    id: StepId,
    run: LegacyStateMigrationStep["run"],
    collectNotices = false,
    refusal?: PreparedLegacyStateMigrationStep["refusal"],
  ): LegacyStateMigrationStep => ({
    ...descriptor(id, "final"),
    ...(refusal ? { refusal } : {}),
    run,
    collectNotices,
  });
  const ownerStep = <TDetection extends { hasLegacy: boolean; sourcePath?: string }>(
    id: (typeof unresolvedMigrationStepLayout)[number][0],
    detection: TDetection,
    migrate: (options: {
      detected: TDetection;
      env: NodeJS.ProcessEnv;
      stateDir: string;
    }) => MigrationMessages | Promise<MigrationMessages>,
    options: Partial<
      Pick<
        LegacyStateMigrationStep,
        "phase" | "source" | "target" | "requiredness" | "collectNotices"
      >
    > = {},
  ): LegacyStateMigrationStep => ({
    id,
    phase: options.phase ?? "final",
    source: options.source ?? pathEndpoints(detection.sourcePath),
    target: options.target ?? [stateDatabase],
    requiredness: options.requiredness ?? (detection.hasLegacy ? "required" : "not-required"),
    reversibility: "checkpoint-required",
    collectNotices: options.collectNotices ?? true,
    run: () => migrate({ detected: detection, env, stateDir }),
  });

  const managedWorktreePrelude: LegacyStateMigrationStep[] = [
    sharedStep("managed-worktrees", () => {
      const stateEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
      const discardedWorktrees =
        isDoctor && detected.worktrees.hasLegacy
          ? discardLegacyRegistryWorktrees(stateEnv, detected.worktrees.legacyIds)
          : 0;
      const canonicalizedWorktrees = rewriteRegistryWorktreePathsForMigration(
        stateEnv,
        detected.worktrees.pathRewrites,
      );
      return {
        changes: [
          ...(discardedWorktrees > 0
            ? [
                `Discarded ${discardedWorktrees} legacy managed worktree ${discardedWorktrees === 1 ? "row" : "rows"}; affected worktrees will provision fresh on next use`,
              ]
            : []),
          ...(canonicalizedWorktrees > 0
            ? [
                `Canonicalized ${canonicalizedWorktrees} managed worktree ${canonicalizedWorktrees === 1 ? "path" : "paths"} for symlinked state directories`,
              ]
            : []),
        ],
        warnings: [],
      };
    }),
  ];

  const sharedSteps: LegacyStateMigrationStep[] = [
    ownerStep("shared-auth-store", detected.sharedAuthStore, migrateSharedAuthStore, {
      phase: "shared",
      source: detected.sharedAuthStore.sourcePath
        ? [{ kind: "sqlite", path: detected.sharedAuthStore.sourcePath }]
        : [],
      requiredness: detected.sharedAuthStore.sourcePath ? "conditional" : "not-required",
    }),
    ownerStep(
      "debug-proxy-capture",
      detected.debugProxyCaptureSidecar,
      migrateLegacyDebugProxyCaptureSidecar,
      {
        phase: "shared",
        collectNotices: false,
        source: pathEndpoints(
          detected.debugProxyCaptureSidecar.sourcePath,
          detected.debugProxyCaptureSidecar.blobDir,
        ),
      },
    ),
    ownerStep("config-health", detected.configHealth, migrateLegacyConfigHealth, {
      phase: "shared",
      collectNotices: false,
    }),
  ];

  const eagerStateSteps: LegacyStateMigrationStep[] = [
    ownerStep("device-auth", detected.deviceAuth, migrateLegacyDeviceAuth, { phase: "shared" }),
    sharedStep(
      "device-identity",
      () =>
        migrateLegacyDeviceIdentity({
          detected: detected.deviceIdentity,
          env,
          stateDir,
          doctorOnlyStateMigrations: isDoctor,
        }),
      true,
    ),
    sharedStep(
      "meeting-transcripts",
      () =>
        migrateLegacyMeetingTranscripts({
          detected: detected.meetingTranscripts,
          env,
          stateDir,
          now,
        }),
      true,
    ),
  ];

  const doctorStateSteps: LegacyStateMigrationStep[] = isDoctor
    ? [
        {
          ...sharedStep("delivery-queues", async () => {
            const { migrateDoctorDeliveryQueues } =
              await import("../commands/doctor-outbound-delivery.js");
            return migrateDoctorDeliveryQueues({ cfg: params.config, stateDir, env });
          }),
          runWithoutFileDetection: true,
        },
        sharedStep("pairing-stores", async () => {
          const { migrateDoctorPairingStores } = await import("./state-migrations.pairing.js");
          return migrateDoctorPairingStores({ stateDir, env, cfg: params.config });
        }),
        {
          ...ownerStep("tui-last-session", detected.tuiLastSessions, migrateLegacyTuiLastSessions),
          inspectRefusal: () => inspectLegacyTuiLastSessionRefusal(detected.tuiLastSessions),
        },
        ...(detected.commitments
          ? [ownerStep("commitments", detected.commitments, migrateLegacyCommitments)]
          : []),
        ownerStep("audit-logs", detected.auditLogs, migrateLegacyAuditLogs, {
          source: pathEndpoints(...detected.auditLogs.sources.map((source) => source.sourcePath)),
        }),
        ownerStep(
          "managed-outgoing-images",
          detected.managedOutgoingImages,
          migrateLegacyManagedOutgoingImages,
          { source: pathEndpoints(detected.managedOutgoingImages.sourceDir) },
        ),
        ownerStep("apns-registrations", detected.apns, migrateLegacyApnsRegistrations),
        ownerStep("exec-approvals", detected.execApprovals, migrateLegacyExecApprovals, {
          source: [...pathEndpoints(detected.execApprovals.sourcePath), stateDatabase],
        }),
        ownerStep("mcp-oauth", detected.mcpOauth, migrateLegacyMcpOAuthStores, {
          source: pathEndpoints(detected.mcpOauth.sourceDir, ...detected.mcpOauth.sourcePaths),
        }),
      ]
    : [];

  const doctorFinalSteps: LegacyStateMigrationStep[] = isDoctor
    ? [
        ownerStep("web-push", detected.webPush, migrateLegacyWebPush, {
          source: pathEndpoints(detected.webPush.subscriptionsPath, detected.webPush.vapidKeysPath),
        }),
        ownerStep("node-host", detected.nodeHost, migrateLegacyNodeHostConfig),
        ownerStep("rescue-pending", detected.rescuePending, discardLegacyRescuePending, {
          source: pathEndpoints(...detected.rescuePending.sourcePaths),
          target: [],
          collectNotices: false,
        }),
      ]
    : [];

  const channelPairingRefusal = detected.channelPairing.accountDiscoveryDeferred
    ? {
        code: "plugin-planning-deferred",
        message: "Channel pairing account discovery is deferred to plugin validation.",
      }
    : undefined;
  const finalSteps: LegacyStateMigrationStep[] = [
    {
      ...ownerStep(
        "workspace-state",
        detected.workspace,
        async (options) => {
          // Shared/agent schemas are ready here. Repair alias ownership before
          // carried legacy files can be imported under the wrong workspace key.
          if (isDoctor) {
            await params.beforeWorkspaceStateMigration?.(params.sessionConfig ?? params.config);
          }
          return await migrateLegacyWorkspaceState(options);
        },
        { source: pathEndpoints(...detected.workspace.sources.map((source) => source.sourcePath)) },
      ),
      runWithoutFileDetection: isDoctor && params.beforeWorkspaceStateMigration !== undefined,
    },
    ...doctorFinalSteps,
    ...(isDoctor
      ? [
          {
            ...finalStep("skill-workshop", async () => {
              const { retireSkillWorkshopProposals } =
                await import("../commands/doctor-skill-workshop-retire-proposals.js");
              return retireSkillWorkshopProposals({
                config: params.sessionConfig ?? params.config,
                env: { ...env, OPENCLAW_STATE_DIR: stateDir },
              });
            }),
            runWithoutFileDetection: true,
          },
          finalStep(
            "channel-pairing",
            channelPairingRefusal
              ? () => ({ changes: [], warnings: [channelPairingRefusal.message] })
              : () =>
                  migrateLegacyChannelPairingState({
                    detected: detected.channelPairing,
                    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
                  }),
            false,
            channelPairingRefusal,
          ),
        ]
      : []),
    finalStep(
      "plugin-doctor-state",
      () =>
        plannedPluginDescriptor?.refusal
          ? { changes: [], warnings: [plannedPluginDescriptor.refusal.message] }
          : runPluginDoctorStateMigrationPlans({
              detected,
              config: params.config,
              env,
              inventory: params.pluginStateMigrationInventory,
              ...(plannedPluginDescriptor
                ? {
                    plannedActions: plannedPluginDescriptor.actions.map((action) => ({
                      pluginId: action.pluginId,
                      id: action.id,
                    })),
                  }
                : {}),
            }),
      true,
      plannedPluginDescriptor?.refusal,
    ),
  ];

  if (repairSessionFiles) {
    finalSteps.push(
      finalStep("sessions", () =>
        migrateLegacySessions(detected, {
          cfg: params.sessionConfig ?? params.config,
          env,
          legacySessionSurfaces: params.legacySessionSurfaces,
        }),
      ),
    );
  }
  if (!isDoctor) {
    const legacySessionStoreRefusal = params.legacySessionStoreRefusal;
    finalSteps.push({
      ...finalStep(
        "legacy-main-session-keys",
        legacySessionStoreRefusal
          ? () => ({ changes: [], warnings: [legacySessionStoreRefusal.message] })
          : async () => {
              const result = await migrateLegacyMainSessionKeys({
                cfg: params.sessionConfig ?? params.config,
                env,
                mode: "detect",
                now,
              });
              return { changes: [], warnings: [], notices: result.warnings };
            },
        true,
        legacySessionStoreRefusal,
      ),
      runWithoutFileDetection: true,
    });
  }
  if (repairSessionFiles) {
    // ACP metadata must run once after sessions are canonicalized; otherwise
    // existing rows and newly imported rows generate conflicting repeat warnings.
    finalSteps.push({
      ...finalStep("acp-session-metadata", () =>
        migrateLegacyAcpSessionMetadata({
          cfg: params.sessionConfig ?? params.config,
          env: isDoctor ? { ...env, OPENCLAW_STATE_DIR: stateDir } : env,
          now,
          pluginSessionStoreAgentIds,
          legacySessionSurfaces: params.legacySessionSurfaces,
        }),
      ),
      runWithoutFileDetection: true,
    });
  }
  if (!params.skipAgentScopedMigrations || env.OPENCLAW_AGENT_DIR) {
    finalSteps.push(finalStep("agent-dir", () => migrateLegacyAgentDir(detected, now)));
  }
  if (
    isDoctor &&
    plannedPostSessionPluginMigration &&
    params.deferPostSessionPluginMigrations !== false
  ) {
    finalSteps.push({
      ...plannedPostSessionPluginMigration.step,
      run: () => ({ changes: [], warnings: [] }),
      collectNotices: true,
      deferredExecution: {
        kind: "post-session-plugin",
        migration: plannedPostSessionPluginMigration,
      },
    });
  }

  return {
    preparation: [
      createStateSchemaMigrationStep({
        stateDir,
        env,
        mode: params.mode,
        requiredness: detected.stateSchema.hasLegacy ? "required" : "conditional",
      }),
      createPluginInstallIndexStep({
        stateDir,
        env,
        hasLegacy: detected.pluginInstallIndex.hasLegacy,
      }),
    ],
    remaining: [
      ...eagerStateSteps,
      ...managedWorktreePrelude,
      ...sharedSteps,
      ...doctorStateSteps,
      ...finalSteps,
    ],
  };
}

/**
 * Inspect a copied state/config snapshot without loading plugins or acquiring write authority.
 * Plugin action identities come from manifests; undeclared owners remain an explicit refusal.
 */
export async function planLegacyStateMigrationsReadOnly(params: {
  mode: LegacyStateMigrationMode;
  invocationPurpose?: LegacyStateMigrationInvocationPurpose;
  candidate: Pick<LegacyStateMigrationPlan["candidate"], "root" | "version">;
  snapshot: LegacyStateMigrationPlan["snapshot"];
  env?: NodeJS.ProcessEnv;
  initialWarnings?: readonly string[];
  legacySessionSurfaces?: PreparedLegacySessionSurfaces;
}): Promise<LegacyStateMigrationPlan> {
  const invocationPurpose =
    params.invocationPurpose ?? (params.mode === "doctor" ? "doctor" : "startup");
  const expectedConfigDigest = params.snapshot.configDigest;
  const expectedStateDigest = params.snapshot.stateDigest;
  const requestedSnapshot = {
    homeDir: path.resolve(params.snapshot.homeDir),
    configPath: path.resolve(params.snapshot.configPath),
    stateDir: path.resolve(params.snapshot.stateDir),
  };
  const callerEnv = createLegacyStateMigrationCallerEnv({
    env: params.env,
    snapshot: requestedSnapshot,
  });
  const rawOAuthDir = (params.env ?? process.env).OPENCLAW_OAUTH_DIR?.trim();
  const callerOAuthDir = rawOAuthDir
    ? resolveOAuthDir({ ...callerEnv, OPENCLAW_OAUTH_DIR: rawOAuthDir }, requestedSnapshot.stateDir)
    : undefined;
  const oauthDirOutsideSnapshot =
    callerOAuthDir !== undefined && !isPathInside(requestedSnapshot.stateDir, callerOAuthDir);
  const pendingStateDirMigration = resolvePendingLegacyStateDirMigrationPaths({
    env: params.env,
    homedir: () => requestedSnapshot.homeDir,
  });
  // This exported boundary authorizes the paths recorded in the plan. Capture
  // their identity here so direct callers cannot substitute a symlink or digest.
  const identityBefore = await captureLegacyStateSnapshotIdentity(requestedSnapshot);
  const env = createLegacyStateMigrationPlanEnv({
    env: params.env,
    snapshot: requestedSnapshot,
  });
  if (callerOAuthDir && !oauthDirOutsideSnapshot) {
    env.OPENCLAW_OAUTH_DIR = callerOAuthDir;
  }
  const configBefore = await readLegacyStateMigrationPlanConfig({
    configPath: requestedSnapshot.configPath,
    homeDir: requestedSnapshot.homeDir,
    env,
  });
  const snapshot = {
    ...requestedSnapshot,
    ...(configBefore.configDigest ? { configDigest: configBefore.configDigest } : {}),
    ...(identityBefore.stateDigest ? { stateDigest: identityBefore.stateDigest } : {}),
  };
  const stepContext = {
    config: configBefore.config,
    configPath: snapshot.configPath,
    configIncludedPaths: configBefore.configIncludedPaths,
    stateDir: snapshot.stateDir,
    env,
  };
  const refusedPlan = (
    refusal: NonNullable<LegacyStateMigrationPlan["refusal"]>,
    warnings: string[],
    steps: PreparedLegacyStateMigrationStep[] = [],
  ) =>
    createLegacyStateMigrationPlan({
      mode: params.mode,
      candidate: params.candidate,
      snapshot,
      steps,
      warnings: [...(params.initialWarnings ?? []), ...warnings],
      refusal,
    });
  if (identityBefore.warnings.length > 0 || !configBefore.configDigest) {
    const warnings = [
      ...(params.initialWarnings ?? []),
      ...identityBefore.warnings,
      ...configBefore.warnings,
    ];
    return refusedPlan({ code: "snapshot-identity-unavailable", message: warnings.join("\n") }, [
      ...identityBefore.warnings,
      ...configBefore.warnings,
    ]);
  }
  // The identity owner refuses unusable snapshot paths first; only an admitted
  // state directory is scanned for retired files, so a non-directory path keeps
  // its `snapshot-identity-unavailable` refusal instead of an inspection error.
  assertNoRetiredRuntimeStateFiles(
    requestedSnapshot.stateDir,
    env,
    () => requestedSnapshot.homeDir,
  );
  assertNoRetiredStateFiles(
    "JSON delivery queues",
    listRetiredDeliveryQueueFiles(requestedSnapshot.stateDir),
  );
  if (identityBefore.configDigest !== configBefore.rootDigest) {
    const message = "Copied config changed while migration planning was starting.";
    return refusedPlan({ code: "snapshot-identity-changed", message }, [
      ...configBefore.warnings,
      message,
    ]);
  }
  const mismatchedSnapshotDigests = [
    expectedConfigDigest && expectedConfigDigest !== configBefore.configDigest
      ? "config"
      : undefined,
    expectedStateDigest && expectedStateDigest !== identityBefore.stateDigest ? "state" : undefined,
  ].filter((label): label is string => label !== undefined);
  if (mismatchedSnapshotDigests.length > 0) {
    const message = `Caller-provided copied ${mismatchedSnapshotDigests.join(" and ")} digest did not match the observed snapshot.`;
    return refusedPlan({ code: "snapshot-identity-mismatch", message }, [message]);
  }
  const pluginStateMigrationInventory = resolvePluginDoctorStateMigrationInventory({
    config: configBefore.config,
    env,
    candidateRoot: params.candidate.root,
    artifactPreservingReadOnly: true,
  });
  const pluginInstallIndexStep = createPluginInstallIndexStep({
    stateDir: snapshot.stateDir,
    env,
    hasLegacy: migrationFileExists(
      resolveLegacyInstalledPluginIndexStorePath({ stateDir: snapshot.stateDir }),
    ),
  });
  if (
    pendingStateDirMigration &&
    path.resolve(pendingStateDirMigration.source) !== requestedSnapshot.stateDir
  ) {
    const message = `Pending legacy state root is outside the copied state snapshot: ${pendingStateDirMigration.source}`;
    return refusedPlan({ code: "state-dir-source-outside-snapshot", message }, [message]);
  }
  const unresolvedSteps = (
    discovery: LegacyStateMigrationStep,
    detection: LegacyStateMigrationStep,
  ): LegacyStateMigrationStep[] => [
    createStateSchemaMigrationStep({
      stateDir: snapshot.stateDir,
      env,
      mode: params.mode,
      requiredness: "conditional",
    }),
    pluginInstallIndexStep,
    createConfigMachineStateStep(stepContext),
    discovery,
    ...buildUnresolvedBlockedPreludeSteps(params.mode, invocationPurpose),
    detection,
    ...buildUnresolvedBlockedMigrationSteps({
      mode: params.mode,
      stateDir: snapshot.stateDir,
      env,
      skipAgentScopedMigrations: hasCustomAgentDirOverride(env),
      pluginStateMigrationInventory,
    }),
  ];
  // Live Doctor honors the selected auth owner. Copied planning must refuse an
  // unbound source before discovery, not silently substitute the standard root.
  const outsideSharedAuthSources =
    params.mode === "doctor"
      ? listMigrationEndpointsOutsideRoot(
          [
            {
              kind: "sqlite",
              path: path.join(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite"),
            },
          ],
          snapshot.stateDir,
        )
      : [];
  if ((callerOAuthDir && oauthDirOutsideSnapshot) || outsideSharedAuthSources.length > 0) {
    const refusal =
      callerOAuthDir && oauthDirOutsideSnapshot
        ? {
            code: "oauth-dir-outside-snapshot",
            message: `Configured OAuth migration directory is outside the copied state snapshot: ${callerOAuthDir}`,
          }
        : {
            code: "shared-auth-source-outside-snapshot",
            message: "Selected shared-auth migration source is outside the copied state snapshot.",
          };
    const detectionStep = createMigrationDetectionStep({
      ...stepContext,
      refusal,
      run: () => ({ changes: [], warnings: [refusal.message] }),
    });
    detectionStep.source = uniqueMigrationEndpoints([
      ...detectionStep.source,
      ...(callerOAuthDir && oauthDirOutsideSnapshot
        ? [{ kind: "path" as const, path: callerOAuthDir }]
        : []),
      ...outsideSharedAuthSources,
    ]);
    const steps = unresolvedSteps(
      createAgentTargetDiscoveryStep({
        ...stepContext,
        run: () => ({ changes: [], warnings: [] }),
      }),
      detectionStep,
    );
    return refusedPlan(
      refusal,
      [...configBefore.warnings, refusal.message],
      closeMigrationPlanTail(steps, detectionStep),
    );
  }
  const configuredSessionStoreEndpoints = resolveConfiguredSessionStoreEndpoints(
    configBefore.config,
    env,
  );
  const outsideSessionStoreEndpoints = listMigrationEndpointsOutsideRoot(
    configuredSessionStoreEndpoints,
    snapshot.stateDir,
  );
  if (outsideSessionStoreEndpoints.length > 0) {
    const refusal = createSessionTargetOutsideSnapshotRefusal(outsideSessionStoreEndpoints);
    const discoveryStep = createAgentTargetDiscoveryStep({
      ...stepContext,
      refusal,
      run: () => ({ changes: [], warnings: [refusal.message] }),
    });
    discoveryStep.source = uniqueMigrationEndpoints([
      ...discoveryStep.source,
      ...outsideSessionStoreEndpoints,
    ]);
    const blockedSteps = unresolvedSteps(
      discoveryStep,
      createMigrationDetectionStep({
        ...stepContext,
        run: () => ({ changes: [], warnings: [] }),
      }),
    );
    return refusedPlan(
      refusal,
      configBefore.warnings,
      closeMigrationPlanTail(blockedSteps, discoveryStep),
    );
  }
  const doctorOnlyStateMigrations = params.mode === "doctor";
  const legacySessionSurfaces = params.legacySessionSurfaces ?? EMPTY_LEGACY_SESSION_SURFACES;
  let detected: LegacyStateDetection;
  try {
    detected = await detectLegacyStateMigrations({
      cfg: configBefore.config,
      mode: params.mode,
      env,
      homedir: () => snapshot.homeDir,
      pluginSessionStoreAgentIds: [],
      doctorOnlyStateMigrations,
      pluginPlanning: "deferred",
      artifactPreservingReadOnly: true,
      legacySessionSurfaces,
    });
  } catch (error) {
    const message = `Could not inspect copied state migrations: ${String(error)}`;
    return refusedPlan({ code: "migration-detection-failed", message }, [
      ...configBefore.warnings,
      message,
    ]);
  }
  const planningWarnings = [
    ...(params.initialWarnings ?? []),
    ...configBefore.warnings,
    ...(detected.warningDisposition === "recoverable" ? [] : detected.warnings),
  ];
  let agentDatabaseTargets: Array<{ agentId: string; path: string }> = [];
  let registeredDatabases: readonly { agentId: string; path: string }[] = [];
  let agentTargetRefusal: PreparedLegacyStateMigrationStep["refusal"];
  let agentTargetRefusalEndpoints: LegacyStateMigrationEndpoint[] = [];
  try {
    registeredDatabases = await inspectOpenClawRegisteredAgentDatabases({
      env,
      includeIncompatibleSchemaVersions: true,
    });
    agentDatabaseTargets = hasCustomAgentDirOverride(env)
      ? []
      : resolveConfiguredAgentDatabaseTargets(configBefore.config, { env, registeredDatabases });
    const boundTargets = bindAgentDatabaseTargetsToStateRoot(
      agentDatabaseTargets,
      snapshot.stateDir,
    );
    agentDatabaseTargets = boundTargets.targets;
    if (boundTargets.refusal) {
      planningWarnings.push(boundTargets.refusal.message);
      agentTargetRefusal = boundTargets.refusal;
      agentTargetRefusalEndpoints = boundTargets.outsideEndpoints;
    }
  } catch (error) {
    const message = `Could not resolve configured agent migration targets: ${String(error)}`;
    planningWarnings.push(message);
    agentTargetRefusal = { code: "agent-target-discovery-failed", message };
  }
  const pluginIds = collectRelevantDoctorPluginIds(configBefore.config);
  const deferredPluginSessionStores = createDeferredPluginSessionStoreEndpoints(
    configBefore.config,
    pluginStateMigrationInventory,
  );
  const copiedSessionStores = inspectOrphanSessionStoreEndpoints({
    config: configBefore.config,
    env,
    pluginSessionStoreAgentIds: [],
    registeredDatabases,
  });
  planningWarnings.push(...copiedSessionStores.warnings);
  const sessionTargetRefusal =
    copiedSessionStores.warnings.length > 0
      ? {
          code: "session-target-discovery-failed",
          message: copiedSessionStores.warnings.join("\n"),
        }
      : createDeferredPluginSessionStoreRefusal(deferredPluginSessionStores);
  const skipAgentScopedMigrations = hasCustomAgentDirOverride(env);
  const { preparation, remaining: remainingMainSteps } = buildLegacyStateMigrationSteps({
    mode: params.mode,
    detected,
    config: configBefore.config,
    env,
    agentDatabaseEndpoints: agentDatabaseTargets.map(({ path: databasePath }) => ({
      kind: "sqlite",
      path: databasePath,
    })),
    legacySessionStoreEndpoints: uniqueMigrationEndpoints([
      ...copiedSessionStores.endpoints,
      ...deferredPluginSessionStores,
    ]),
    legacySessionStoreRefusal: sessionTargetRefusal,
    skipAgentScopedMigrations,
    pluginStateMigrationInventory,
    legacySessionSurfaces,
  });
  for (const step of remainingMainSteps) {
    if (step.id === "skill-workshop") {
      // Draft exports target agent directories that can lie outside copied state.
      // Keep the owner visible without inspecting or granting those paths.
      step.refusal = {
        code: "skill-workshop-planning-deferred",
        message: "Skill Workshop proposal export requires separately bound agent directories.",
      };
    }
  }
  const pluginPreparationRefusal = createPluginMigrationPreparationRefusal({
    inventory: pluginStateMigrationInventory,
    deferredSessionStoreEndpoints: deferredPluginSessionStores,
  });
  const plannedAgentTargetDiscoveryStep = createAgentTargetDiscoveryStep({
    ...stepContext,
    refusal: agentTargetRefusal,
    run: () => ({
      changes: [],
      warnings: agentTargetRefusal ? [agentTargetRefusal.message] : [],
    }),
  });
  plannedAgentTargetDiscoveryStep.source = uniqueMigrationEndpoints([
    ...plannedAgentTargetDiscoveryStep.source,
    ...agentTargetRefusalEndpoints,
  ]);
  const migrationDetectionStep = createMigrationDetectionStep({
    ...stepContext,
    refusal:
      detected.warnings.length > 0 && detected.warningDisposition !== "recoverable"
        ? {
            code: "migration-detection-warning",
            message: detected.warnings.join("\n"),
          }
        : undefined,
    run: () => ({ changes: [], warnings: detected.warnings }),
  });
  const executionSteps = [
    ...preparation,
    createConfigMachineStateStep(stepContext),
    plannedAgentTargetDiscoveryStep,
    ...buildLegacyStateMigrationPreludeSteps({
      mode: params.mode,
      invocationPurpose,
      ...stepContext,
      homedir: () => snapshot.homeDir,
      agentDatabaseTargets,
      orphanSessionStores: copiedSessionStores,
      pluginSessionStoreAgentIds: [],
      legacySessionSurfaces,
      deferredPluginSessionStoreEndpoints: deferredPluginSessionStores,
      readOnlyPlanning: true,
      ...(params.mode === "doctor"
        ? {
            pluginPreparation: createPluginMigrationPreparationStep({
              ...stepContext,
              pluginIds,
              refusal: pluginPreparationRefusal,
              run: () => ({
                changes: [],
                warnings: pluginPreparationRefusal ? [pluginPreparationRefusal.message] : [],
              }),
            }),
          }
        : {}),
    }),
    migrationDetectionStep,
    ...remainingMainSteps,
  ];
  let steps = executionSteps.map(migrationStepPlan);
  if (detected.stateSchema.hasLegacy) {
    const sharedAuthStep = steps.find((step) => step.id === "shared-auth-store");
    if (sharedAuthStep) {
      sharedAuthStep.requiredness = "conditional";
      sharedAuthStep.refusal = {
        code: "state-schema-planning-deferred",
        message:
          "Shared auth migration inspection is deferred until the copied state schema is repaired.",
      };
    }
  }
  if (sessionTargetRefusal) {
    for (const step of steps) {
      if (step.id === "acp-session-metadata") {
        step.refusal = sessionTargetRefusal;
      }
    }
  }
  const channelPairingStep = steps.find((step) => step.id === "channel-pairing");
  if (channelPairingStep && detected.channelPairing.accountDiscoveryDeferred) {
    channelPairingStep.requiredness = "conditional";
    channelPairingStep.refusal = {
      code: "plugin-planning-deferred",
      message: "Channel pairing accounts will be checked with the updated plugins.",
    };
  }
  const firstRefusal = steps.find((step) => step.refusal !== undefined);
  if (firstRefusal) {
    steps = closeMigrationPlanTail(steps, firstRefusal);
  }
  const stateDirRefusal = pendingStateDirMigration
    ? {
        code: "state-dir-planning-deferred",
        message:
          "Legacy state-root relocation must complete before copied-state migrations are planned.",
      }
    : undefined;
  const plannedSteps = pendingStateDirMigration
    ? [
        {
          id: "state-dir",
          phase: "shared" as const,
          source: [{ kind: "path" as const, path: pendingStateDirMigration.source }],
          target: [{ kind: "path" as const, path: pendingStateDirMigration.target }],
          requiredness: "required" as const,
          reversibility: "checkpoint-required" as const,
          refusal: stateDirRefusal,
        },
        ...steps.map((step) => ({
          ...step,
          source: step.source.map((endpoint) =>
            remapMigrationEndpointRoot(
              endpoint,
              pendingStateDirMigration.source,
              pendingStateDirMigration.target,
            ),
          ),
          target: step.target.map((endpoint) =>
            remapMigrationEndpointRoot(
              endpoint,
              pendingStateDirMigration.source,
              pendingStateDirMigration.target,
            ),
          ),
          refusal: {
            code: "blocked-by-prior-refusal",
            message: `Migration step "${step.id}" is deferred until legacy state-root relocation is complete.`,
          },
        })),
      ]
    : steps;
  const plan = createLegacyStateMigrationPlan({
    mode: params.mode,
    candidate: params.candidate,
    snapshot,
    steps: plannedSteps,
    warnings: planningWarnings,
    advisoryWarnings: detected.warningDisposition === "recoverable" ? detected.warnings : [],
    ...(stateDirRefusal ? { refusal: stateDirRefusal } : {}),
  });
  // Validate the config owner's exact inputs and state at one final boundary;
  // a separate concurrent config read can finish before the state traversal.
  const identityAfter = await captureLegacyStateSnapshotIdentity({
    ...requestedSnapshot,
    configInputHashes: configBefore.configInputHashes,
  });
  if (identityAfter.warnings.length > 0) {
    const message = identityAfter.warnings.join("\n");
    return refuseLegacyStateMigrationPlan(plan, {
      code: "snapshot-identity-unavailable",
      message,
    });
  }
  if (
    identityAfter.configDigest !== configBefore.rootDigest ||
    identityBefore.stateDigest !== identityAfter.stateDigest
  ) {
    return refuseLegacyStateMigrationPlan(plan, {
      code: "snapshot-identity-changed",
      message: "Copied config or state changed while migration planning was in progress.",
    });
  }
  return plan;
}

function completedPluginMigrationFields(
  sources: readonly MigrationMessages[],
): Pick<MigrationMessages, "completedPluginIds" | "requiredPluginIds" | "statelessPluginIds"> {
  const completedPluginIds = sortUniqueStrings(
    sources.flatMap((source) => source.completedPluginIds ?? []),
  );
  const requiredPluginIds = sortUniqueStrings(
    sources.flatMap((source) => source.requiredPluginIds ?? []),
  );
  const statelessPluginIds = sortUniqueStrings(
    sources.flatMap((source) => source.statelessPluginIds ?? []),
  );
  return {
    ...(completedPluginIds.length > 0 ? { completedPluginIds } : {}),
    ...(requiredPluginIds.length > 0 ? { requiredPluginIds } : {}),
    ...(statelessPluginIds.length > 0 ? { statelessPluginIds } : {}),
  };
}

/** Admit preflight's shared-state writers through the same schema step as later migrations. */
export async function prepareLegacyStateDatabaseSchema(
  env: NodeJS.ProcessEnv,
): Promise<LegacyStateMigrationStepReceipt> {
  const { receipts } = await runLegacyStateMigrationSteps([
    createStateSchemaMigrationStep({
      stateDir: resolveStateDir(env),
      env,
      mode: "doctor-preparation",
      requiredness: "conditional",
    }),
  ]);
  return receipts[0]!;
}

export async function runLegacyStateMigrations(params: {
  detected: LegacyStateDetection;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  doctorOnlyStateMigrations?: boolean;
  onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void;
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
}): Promise<
  MigrationMessages & {
    mode: "doctor";
    stepReceipts: LegacyStateMigrationStepReceipt[];
  }
> {
  const signal = resolveSqliteInspectionSignal();
  let failure: { error: unknown } | undefined;
  const executionOptions = {
    onUnexpectedFailure: (error: unknown) => {
      failure ??= { error };
    },
  };
  const detected = params.detected;
  assertNoRetiredRuntimeStateFiles(detected.stateDir, params.env);
  assertNoRetiredStateFiles(
    "JSON delivery queues",
    listRetiredDeliveryQueueFiles(detected.stateDir),
  );
  const env = params.env ?? process.env;
  const config = params.config ?? ({} as OpenClawConfig);
  assertNoRetiredStateFiles("OAuth credential sidecars", [
    ...listReferencedLegacyOAuthSidecarPaths(env, config, detected.stateDir),
    ...listReferencedLegacyOAuthSidecarPaths(
      { ...env, OPENCLAW_OAUTH_DIR: detected.oauthDir },
      config,
      detected.stateDir,
    ),
  ]);
  const legacySessionSurfaces = params.legacySessionSurfaces;
  const buildSteps = (pluginStateMigrationInventory?: PluginDoctorStateMigrationInventory) =>
    buildLegacyStateMigrationSteps({
      mode: "doctor",
      detected,
      config,
      env,
      now: params.now,
      pluginStateMigrationInventory,
      // The health contribution's later session repair consumes preflight's handoff.
      // This migration pass does not own that separate phase.
      deferPostSessionPluginMigrations: false,
      legacySessionSurfaces,
    });
  const { preparation: preparationSteps, remaining: remainingSteps } = buildSteps();
  const preparation = await runLegacyStateMigrationSteps(
    preparationSteps,
    params.onStepReceipt,
    undefined,
    executionOptions,
  );
  if (preparation.haltedBy) {
    const notices = mergeNotices(preparation.sources);
    const stepReceipts = [
      ...preparation.receipts,
      ...createBlockedLegacyStateMigrationStepReceipts({
        steps: remainingSteps,
        blocker: preparation.haltedBy,
        onStepReceipt: params.onStepReceipt,
      }),
    ];
    if (failure && signal?.aborted && failure.error === signal.reason) {
      throw failure.error;
    }
    return {
      changes: preparation.sources.flatMap((source) => source.changes),
      warnings: preparation.sources.flatMap((source) => source.warnings),
      ...(notices.length > 0 ? { notices } : {}),
      mode: "doctor",
      stepReceipts,
    };
  }

  // Schema repair can expose installed plugin owners. Freeze their full live action
  // inventory before the writer, rather than receipting the earlier pending-only preview.
  const inventory = resolveLivePluginDoctorStateMigrationInventory({ config, env });
  const migrations = await runLegacyStateMigrationSteps(
    buildSteps(inventory).remaining,
    params.onStepReceipt,
    undefined,
    executionOptions,
  );
  const notices = mergeNotices([
    ...preparation.sources,
    ...migrations.sharedNoticeSources,
    ...migrations.finalNoticeSources,
  ]);
  if (failure && signal?.aborted && failure.error === signal.reason) {
    throw failure.error;
  }
  return {
    mode: "doctor",
    ...completedPluginMigrationFields(migrations.sources),
    stepReceipts: [...preparation.receipts, ...migrations.receipts],
    changes: [...preparation.sources, ...migrations.sources].flatMap((source) => source.changes),
    warnings: [
      ...new Set([
        ...preparation.sources.flatMap((source) => source.warnings),
        ...detected.warnings,
        ...migrations.sources.flatMap((source) => source.warnings),
      ]),
    ],
    ...(notices.length > 0 ? { notices } : {}),
  };
}

/** Run canonical startup migrations and explicit Doctor-owned file repairs. */
export async function autoMigrateLegacyState(params: {
  cfg: OpenClawConfigWithLegacyRoster;
  sourceConfigBeforeMigrations?: OpenClawConfigWithLegacyRoster;
  invocationPurpose?: LegacyStateMigrationInvocationPurpose;
  agentDatabaseMigrationDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
  pluginDoctorConfig?: OpenClawConfig;
  /** Include inputs captured by the config snapshot that produced cfg. */
  configIncludedPaths?: readonly string[];
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  now?: () => number;
  doctorOnlyStateMigrations?: boolean;
  legacySessionSurfaces?: PreparedLegacySessionSurfaces;
  onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void;
  beforeWorkspaceStateMigration?: (config: OpenClawConfig) => Promise<void>;
}): Promise<{
  mode: LegacyStateMigrationMode;
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
  completedPluginIds?: readonly string[];
  requiredPluginIds?: readonly string[];
  statelessPluginIds?: readonly string[];
  stepReceipts: LegacyStateMigrationStepReceipt[];
  postSessionPluginMigration?: PreparedPostSessionPluginMigration;
}> {
  const signal = resolveSqliteInspectionSignal();
  let failure: { error: unknown } | undefined;
  const result = await executeLegacyStateMigrations(params, (error) => {
    failure ??= { error };
  });
  // Settle all receipts before forwarding cancellation to Doctor's service restoration.
  if (
    failure &&
    (params.doctorOnlyStateMigrations !== true ||
      (signal?.aborted && failure.error === signal.reason))
  ) {
    throw failure.error;
  }
  return result;
}

async function executeLegacyStateMigrations(
  params: Parameters<typeof autoMigrateLegacyState>[0],
  onUnexpectedFailure: (error: unknown) => void,
): ReturnType<typeof autoMigrateLegacyState> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  // Detection, planning, and execution share this one mode latch. Splitting it lets
  // Doctor detect owner-only work and then silently build an automatic-only plan.
  const mode: LegacyStateMigrationMode =
    params.doctorOnlyStateMigrations === true ? "doctor" : "automatic";
  const invocationPurpose = params.invocationPurpose ?? (mode === "doctor" ? "doctor" : "startup");
  const useStartupOnceCache = mode === "automatic" && invocationPurpose === "startup";
  const executionOptions = {
    onUnexpectedFailure,
    refusedAgentDatabasePaths: new Set<string>(
      mode === "automatic"
        ? listAgentDatabaseAdmissionRefusals({ env }).flatMap((refusal) =>
            refusal.paths.map((pathname) => path.resolve(pathname)),
          )
        : [],
    ),
  };
  const runSteps = (
    steps: readonly LegacyStateMigrationStep[],
    shouldRun?: (step: LegacyStateMigrationStep) => boolean,
  ) => runLegacyStateMigrationSteps(steps, params.onStepReceipt, shouldRun, executionOptions);
  const initialStateDir = resolveStateDir(env, homedir);
  assertNoRetiredRuntimeStateFiles(initialStateDir, env, homedir);
  assertNoRetiredStateFiles("JSON delivery queues", listRetiredDeliveryQueueFiles(initialStateDir));
  assertNoRetiredStateFiles(
    "OAuth credential sidecars",
    listReferencedLegacyOAuthSidecarPaths(env, params.cfg, initialStateDir),
  );
  const checkKey = `${path.resolve(initialStateDir)}\0${mode}`;
  // An earlier attempt may leave post-session work or a refusal unresolved.
  // Explicit Doctor calls need fresh receipts and handoffs, not startup's once-cache.
  if (useStartupOnceCache && autoMigrateChecked.has(checkKey)) {
    return {
      mode,
      migrated: false,
      skipped: true,
      changes: [],
      warnings: [],
      stepReceipts: [],
    };
  }
  if (useStartupOnceCache) {
    autoMigrateChecked.add(checkKey);
  }
  const pluginDoctorConfig = params.pluginDoctorConfig ?? params.cfg;
  const configIncludedPaths = params.configIncludedPaths ?? [];
  const configuredPluginIds = collectRelevantDoctorPluginIds(pluginDoctorConfig);
  // Retain a pre-preparation snapshot for refusal closure. Root relocation or schema repair
  // can expose installed owners, whose actions are frozen before later writers.
  let pluginStateMigrationInventory = resolveLivePluginDoctorStateMigrationInventory({
    config: pluginDoctorConfig,
    env,
  });
  let pluginInstallIndexStep = createPluginInstallIndexStep({
    stateDir: initialStateDir,
    env,
    hasLegacy: migrationFileExists(
      resolveLegacyInstalledPluginIndexStorePath({ stateDir: initialStateDir }),
    ),
  });

  // Preflight normally owns this relocation. Direct callers must retain the same
  // state-root contract, so run the canonical owner as an explicit first step.
  const pendingStateDirMigration = resolvePendingLegacyStateDirMigrationPaths({ env, homedir });
  const stateDirStep: LegacyStateMigrationStep | undefined = pendingStateDirMigration
    ? {
        id: "state-dir",
        phase: "shared",
        source: [{ kind: "path", path: pendingStateDirMigration.source }],
        target: [{ kind: "path", path: pendingStateDirMigration.target }],
        requiredness: "required",
        reversibility: "checkpoint-required",
        run: async () => {
          const result = await autoMigrateLegacyStateDir({ env, homedir });
          const stillPending = resolvePendingLegacyStateDirMigrationPaths({ env, homedir });
          return stillPending
            ? {
                ...result,
                warnings: [
                  ...result.warnings,
                  `State directory migration remains pending (${stillPending.source} → ${stillPending.target}).`,
                ],
              }
            : result;
        },
      }
    : undefined;
  const stateDirMigration = stateDirStep ? await runSteps([stateDirStep]) : undefined;
  const stateDirResult = stateDirMigration?.entries[0]?.result ?? {
    changes: [],
    warnings: [],
  };
  const stateDir = resolveStateDir(env, homedir);
  if (useStartupOnceCache) {
    autoMigrateChecked.add(`${path.resolve(stateDir)}\0${mode}`);
  }
  const stateEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
  let agentDatabaseMigrationDiscovery = params.agentDatabaseMigrationDiscovery;
  const stateSchemaOptions = { env: stateEnv };
  const configPath = resolveConfigPath(env, stateDir, homedir);
  let agentDatabaseTargets: Array<{ agentId: string; path: string }> = [];
  let preparedSessionStores: ReturnType<typeof inspectOrphanSessionStoreEndpoints> | undefined;
  let pluginSessionStoreAgentIds: readonly string[] = [];
  let legacySessionSurfaces = EMPTY_LEGACY_SESSION_SURFACES;
  let sessionStoreOwnership: SessionStoreOwnership | undefined;
  let detected: LegacyStateDetection | undefined;
  const pluginPreparation = createPluginMigrationPreparationStep({
    configPath,
    configIncludedPaths,
    pluginIds: configuredPluginIds,
    run: async () => {
      if (pluginStateMigrationInventory.resolutionFailure) {
        pluginPreparation.refusal = pluginStateMigrationInventory.resolutionFailure;
        return { changes: [], warnings: [pluginPreparation.refusal.message] };
      }
      pluginSessionStoreAgentIds = listPluginDoctorSessionStoreAgentIds({
        config: pluginDoctorConfig,
        env,
        pluginIds: configuredPluginIds,
      });
      legacySessionSurfaces =
        params.legacySessionSurfaces ??
        (await import("../plugins/legacy-session-surfaces.js")).prepareLegacySessionSurfaces({
          config: params.cfg,
          env,
        });
      // Capture ownership before orphan-key rewrites. Atomic replacement can split
      // a configured filesystem alias from the standard target pathname.
      const { sessionMigrationAgentId: ownershipAgentId } = resolveLegacyStateMigrationOwner({
        cfg: params.cfg,
        locatorConfig: params.sourceConfigBeforeMigrations ?? params.cfg,
        env,
        homedir,
      });
      sessionStoreOwnership = ownershipAgentId
        ? resolveSessionStoreOwnership({
            cfg: params.cfg,
            env,
            stateDir,
            targetAgentId: ownershipAgentId,
            pluginSessionStoreAgentIds,
          })
        : undefined;
      return { changes: [], warnings: [...legacySessionSurfaces.failures] };
    },
  });
  const buildPreludeSteps = (overrides?: {
    pluginSessionStoreAgentIds?: readonly string[];
    legacySessionSurfaces?: PreparedLegacySessionSurfaces;
    orphanSessionStores?: ReturnType<typeof inspectOrphanSessionStoreEndpoints>;
  }) =>
    buildLegacyStateMigrationPreludeSteps({
      mode,
      invocationPurpose,
      config: params.cfg,
      configPath,
      configIncludedPaths,
      stateDir,
      env,
      homedir,
      agentDatabaseTargets,
      agentDatabaseMigrationDiscovery,
      orphanSessionStores: overrides?.orphanSessionStores,
      pluginSessionStoreAgentIds:
        overrides?.pluginSessionStoreAgentIds ?? pluginSessionStoreAgentIds,
      legacySessionSurfaces: overrides?.legacySessionSurfaces ?? legacySessionSurfaces,
      ...(mode === "doctor" ? { pluginPreparation } : {}),
    });
  const createDetectionStep = (): LegacyStateMigrationStep =>
    createMigrationDetectionStep({
      configPath,
      configIncludedPaths,
      stateDir,
      run: async () => {
        detected = await detectLegacyStateMigrations({
          cfg: params.cfg,
          sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations,
          mode,
          pluginDoctorConfig: params.pluginDoctorConfig,
          ...(mode === "doctor" ? { pluginSessionStoreAgentIds } : {}),
          sessionStoreOwnership,
          env,
          homedir: params.homedir,
          doctorOnlyStateMigrations: mode === "doctor",
          legacySessionSurfaces,
        });
        return {
          changes: [],
          warnings: detected.warnings,
          warningDisposition: detected.warningDisposition,
          outcome: detected.outcome,
          ...(detected.notices.length > 0 ? { notices: detected.notices } : {}),
        };
      },
    });
  const buildDetectedMigrationSteps = (migrationDetection: LegacyStateDetection) => {
    const hasCustomAgentDir = hasCustomAgentDirOverride(env);
    const discoveredSessionStores =
      preparedSessionStores ??
      inspectOrphanSessionStoreEndpoints({
        config: params.cfg,
        env: stateEnv,
        pluginSessionStoreAgentIds: migrationDetection.pluginSessionStoreAgentIds,
      });
    const legacySessionStoreRefusal =
      discoveredSessionStores.warnings.length > 0
        ? {
            code: "session-target-discovery-failed",
            message: discoveredSessionStores.warnings.join("\n"),
          }
        : undefined;
    return buildLegacyStateMigrationSteps({
      mode,
      detected: migrationDetection,
      config: pluginDoctorConfig,
      sessionConfig: params.cfg,
      env,
      now: params.now,
      agentDatabaseEndpoints: agentDatabaseTargets.map(({ path: databasePath }) => ({
        kind: "sqlite",
        path: databasePath,
      })),
      legacySessionStoreEndpoints: discoveredSessionStores.endpoints,
      legacySessionStoreRefusal,
      skipAgentScopedMigrations: hasCustomAgentDir,
      pluginStateMigrationInventory,
      legacySessionSurfaces,
      beforeWorkspaceStateMigration: params.beforeWorkspaceStateMigration,
    }).remaining;
  };
  const finishBlockedPlan = (blocked: {
    completed: readonly MigrationMessages[];
    warnings?: readonly string[];
    notices?: string[];
    log?: boolean;
    receipts: readonly LegacyStateMigrationStepReceipt[];
    blocker: LegacyStateMigrationStepReceipt;
    pendingPreludeSteps: readonly LegacyStateMigrationStep[];
  }): Awaited<ReturnType<typeof autoMigrateLegacyState>> => {
    const changes = blocked.completed.flatMap((result) => result.changes);
    const warnings = [
      ...blocked.completed.flatMap((result) => result.warnings),
      ...(blocked.warnings ?? []),
    ];
    const notices = blocked.notices ?? [];
    if (blocked.log) {
      logStateMigrationResult({ changes, warnings, notices }, params.log);
    }
    const receipts = [
      ...blocked.receipts,
      ...createBlockedLegacyStateMigrationStepReceipts({
        steps: blocked.pendingPreludeSteps,
        blocker: blocked.blocker,
        onStepReceipt: params.onStepReceipt,
      }),
    ];
    const blockedSteps = [
      createMigrationDetectionStep({
        configPath,
        configIncludedPaths,
        stateDir,
        run: () => ({ changes: [], warnings: [] }),
      }),
      ...buildUnresolvedBlockedMigrationSteps({
        mode,
        stateDir,
        env,
        skipAgentScopedMigrations: hasCustomAgentDirOverride(env),
        pluginStateMigrationInventory,
      }),
    ];
    receipts.push(
      ...createBlockedLegacyStateMigrationStepReceipts({
        steps: blockedSteps,
        blocker: blocked.blocker,
        onStepReceipt: params.onStepReceipt,
      }),
    );
    return {
      mode,
      migrated: changes.length > 0,
      skipped: false,
      changes,
      warnings,
      stepReceipts: receipts,
      ...(notices.length > 0 ? { notices } : {}),
    };
  };
  let stateSchemaStep = createStateSchemaMigrationStep({
    stateDir,
    env,
    mode,
    requiredness: "conditional",
  });
  const configMachineStateStep = createConfigMachineStateStep({
    config: pluginDoctorConfig,
    configPath,
    configIncludedPaths,
    stateDir,
    env,
  });
  const agentTargetDiscoveryStep = createAgentTargetDiscoveryStep({
    configPath,
    configIncludedPaths,
    stateDir,
    env,
    run: async () => {
      try {
        agentDatabaseMigrationDiscovery ??= await prepareDoctorAgentDatabaseDiscovery(
          params.cfg,
          stateEnv,
        );
        // Preflight inspects custom session stores without binding their migration owners.
        agentDatabaseTargets = hasCustomAgentDirOverride(env)
          ? []
          : resolveConfiguredAgentDatabaseTargets(params.cfg, {
              env: stateEnv,
              registeredDatabases: agentDatabaseMigrationDiscovery.registeredAgentDatabases,
            });
        return { changes: [], warnings: [] };
      } catch (error) {
        if (mode === "automatic") {
          throw error;
        }
        const message = `Could not resolve configured agent migration targets: ${String(error)}`;
        agentTargetDiscoveryStep.refusal = {
          code: "agent-target-discovery-failed",
          message,
        };
        return {
          changes: [],
          warnings: [message],
        };
      }
    },
  });
  if (stateDirMigration?.haltedBy && stateDirStep) {
    return finishBlockedPlan({
      completed: [stateDirResult],
      notices: mergeNotices([stateDirResult]),
      log: true,
      receipts: stateDirMigration.receipts,
      blocker: stateDirMigration.haltedBy,
      pendingPreludeSteps: [
        stateSchemaStep,
        pluginInstallIndexStep,
        configMachineStateStep,
        agentTargetDiscoveryStep,
        ...buildUnresolvedBlockedPreludeSteps(mode, invocationPurpose),
      ],
    });
  }
  pluginInstallIndexStep = createPluginInstallIndexStep({
    stateDir,
    env: stateEnv,
    hasLegacy: migrationFileExists(resolveLegacyInstalledPluginIndexStorePath({ stateDir })),
  });
  try {
    if (detectOpenClawStateDatabaseSchemaMigrations(stateSchemaOptions).length > 0) {
      stateSchemaStep = createStateSchemaMigrationStep({
        stateDir,
        env,
        mode,
        requiredness: "required",
      });
    }
  } catch {
    // The repair step owns diagnostics for unreadable or unsupported schemas.
  }
  const statePreparationSteps = [stateSchemaStep, pluginInstallIndexStep];
  const stateSchemaMigration = await runSteps(statePreparationSteps);
  const stateSchemaResult = stateSchemaMigration.entries[0]?.result ?? {
    changes: [],
    warnings: [],
  };
  const stateSchema: MigrationMessages = {
    changes: [
      ...stateDirResult.changes,
      ...stateSchemaMigration.sources.flatMap((source) => source.changes),
    ],
    warnings: [
      ...stateDirResult.warnings,
      ...stateSchemaMigration.sources.flatMap((source) => source.warnings),
    ],
    notices: mergeNotices([stateDirResult, ...stateSchemaMigration.sources]),
  };
  stateSchemaMigration.receipts.unshift(...(stateDirMigration?.receipts ?? []));
  if (stateSchemaMigration.haltedBy) {
    // A failed canonical schema repair is an error: runtime cannot safely open this store.
    if (mode !== "doctor" && stateSchemaResult.warnings.length > 0) {
      onUnexpectedFailure(new Error(formatStartupMigrationFailure(stateSchemaResult.warnings)));
    }
    return finishBlockedPlan({
      completed: [stateSchema],
      notices: stateSchema.notices,
      receipts: stateSchemaMigration.receipts,
      blocker: stateSchemaMigration.haltedBy,
      pendingPreludeSteps: [
        configMachineStateStep,
        agentTargetDiscoveryStep,
        ...buildUnresolvedBlockedPreludeSteps(mode, invocationPurpose),
      ],
    });
  }
  if (stateSchema.changes.length > 0) {
    pluginStateMigrationInventory = resolveLivePluginDoctorStateMigrationInventory({
      config: pluginDoctorConfig,
      // State-root preparation must not replace config-root plugin installation authority.
      env,
    });
  }
  // Preserve retired locators before advisory returns can permit config repair.
  const preparationPreludeSteps = [configMachineStateStep, agentTargetDiscoveryStep];
  const preparationPreludeSources: MigrationMessages[] = [];
  const preludeReceipts: LegacyStateMigrationStepReceipt[] = [];
  for (const [index, step] of preparationPreludeSteps.entries()) {
    const execution = await runSteps([step]);
    const result = execution.entries[0]?.result ?? { changes: [], warnings: [] };
    preludeReceipts.push(...execution.receipts);
    if (execution.haltedBy) {
      return finishBlockedPlan({
        completed: [stateSchema, ...preparationPreludeSources],
        warnings: result.warnings,
        notices: stateSchema.notices,
        receipts: [...stateSchemaMigration.receipts, ...preludeReceipts],
        blocker: execution.haltedBy,
        pendingPreludeSteps: [
          ...preparationPreludeSteps.slice(index + 1),
          ...buildUnresolvedBlockedPreludeSteps(mode, invocationPurpose),
        ],
      });
    }
    preparationPreludeSources.push(result);
  }
  const configMachineState = preparationPreludeSources[0]!;
  const initialPreludeSteps = buildPreludeSteps({
    pluginSessionStoreAgentIds: [],
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
  const runPreludeStep = async (
    steps: readonly LegacyStateMigrationStep[],
    id: string,
  ): Promise<MigrationMessages & { haltedBy?: LegacyStateMigrationStepReceipt }> => {
    const step = steps.find((candidate) => candidate.id === id);
    if (!step) {
      return { changes: [], warnings: [] };
    }
    const execution = await runSteps([step]);
    preludeReceipts.push(...execution.receipts);
    return {
      ...(execution.entries[0]?.result ?? { changes: [], warnings: [] }),
      haltedBy: execution.haltedBy,
    };
  };
  const pendingPreludeAfter = (
    steps: readonly LegacyStateMigrationStep[],
    blockerId: string,
  ): LegacyStateMigrationStep[] => {
    const blockerIndex = steps.findIndex((step) => step.id === blockerId);
    return blockerIndex < 0 ? [] : steps.slice(blockerIndex + 1);
  };
  // The prelude owner orders persistence repair before workspace and plugin consumers.
  const profileWorkspaceIndex = initialPreludeSteps.findIndex(
    (step) => step.id === "profile-workspace",
  );
  const persistenceSteps =
    profileWorkspaceIndex < 0
      ? initialPreludeSteps
      : initialPreludeSteps.slice(0, profileWorkspaceIndex);
  const persistence = await runSteps(persistenceSteps);
  preludeReceipts.push(...persistence.receipts);
  const completedPrelude = [stateSchema, configMachineState, ...persistence.sources];
  if (persistence.haltedBy) {
    return finishBlockedPlan({
      completed: completedPrelude,
      notices: stateSchema.notices,
      receipts: [...stateSchemaMigration.receipts, ...preludeReceipts],
      blocker: persistence.haltedBy,
      pendingPreludeSteps: initialPreludeSteps.slice(persistenceSteps.length),
    });
  }
  let profileWorkspace: MigrationMessages = { changes: [], warnings: [] };
  for (const id of ["profile-workspace", "plugin-migration-preparation"]) {
    const result = await runPreludeStep(initialPreludeSteps, id);
    const isProfileWorkspace = id === "profile-workspace";
    if (result.haltedBy) {
      return finishBlockedPlan({
        completed: completedPrelude,
        warnings: result.warnings,
        notices: isProfileWorkspace ? mergeNotices(completedPrelude) : stateSchema.notices,
        log: isProfileWorkspace,
        receipts: [...stateSchemaMigration.receipts, ...preludeReceipts],
        blocker: result.haltedBy,
        pendingPreludeSteps: pendingPreludeAfter(initialPreludeSteps, result.haltedBy.id),
      });
    }
    if (isProfileWorkspace) {
      profileWorkspace = result;
      completedPrelude.push(result);
    }
  }
  if (mode === "doctor") {
    preparedSessionStores = inspectOrphanSessionStoreEndpoints({
      config: params.cfg,
      env: stateEnv,
      pluginSessionStoreAgentIds,
    });
  }
  const finalPreludeSteps = buildPreludeSteps({ orphanSessionStores: preparedSessionStores });
  const orphanKeys = await runPreludeStep(finalPreludeSteps, "orphan-session-keys");
  if (orphanKeys.changes.length > 0) {
    // Atomic store rewrites can split filesystem aliases captured by discovery.
    preparedSessionStores = undefined;
  }
  completedPrelude.push(orphanKeys);
  if (orphanKeys.haltedBy) {
    return finishBlockedPlan({
      completed: completedPrelude,
      notices: stateSchema.notices,
      receipts: [...stateSchemaMigration.receipts, ...preludeReceipts],
      blocker: orphanKeys.haltedBy,
      pendingPreludeSteps: [],
    });
  }

  const detectionStep = createDetectionStep();
  const detectionExecution = await runSteps([detectionStep]);
  preludeReceipts.push(...detectionExecution.receipts);
  if (detectionExecution.haltedBy || !detected) {
    preludeReceipts.push(
      ...createBlockedLegacyStateMigrationStepReceipts({
        steps: buildUnresolvedBlockedMigrationSteps({
          mode,
          stateDir,
          env,
          skipAgentScopedMigrations: hasCustomAgentDirOverride(env),
          pluginStateMigrationInventory,
        }),
        blocker: detectionExecution.receipts[0]!,
        onStepReceipt: params.onStepReceipt,
      }),
    );
    const completed = [...completedPrelude, ...detectionExecution.sources];
    const changes = completed.flatMap((result) => result.changes);
    const warnings = [...new Set(completed.flatMap((result) => result.warnings))];
    const notices = mergeNotices(completed);
    logStateMigrationResult({ changes, warnings, notices }, params.log);
    return {
      mode,
      migrated: changes.length > 0,
      skipped: false,
      changes,
      warnings,
      stepReceipts: [...stateSchemaMigration.receipts, ...preludeReceipts],
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
  const hasCustomAgentDir = hasCustomAgentDirOverride(env);
  const migrationSteps = buildDetectedMigrationSteps(detected);
  const eagerMigrationStepIds = new Set(["device-auth", "device-identity", "meeting-transcripts"]);
  const eagerMigrationSteps = migrationSteps.filter((step) => eagerMigrationStepIds.has(step.id));
  const remainingMigrationSteps = migrationSteps.filter(
    (step) => !eagerMigrationStepIds.has(step.id),
  );
  const eagerMigrations = await runSteps(eagerMigrationSteps);
  if (eagerMigrations.haltedBy) {
    const completed = [...completedPrelude, ...eagerMigrations.sources];
    const changes = completed.flatMap((result) => result.changes);
    const warnings = [
      ...new Set([...completed.flatMap((result) => result.warnings), ...detected.warnings]),
    ];
    const notices = mergeNotices([detected, ...completed]);
    logStateMigrationResult({ changes, warnings, notices }, params.log);
    return {
      mode,
      migrated: changes.length > 0,
      skipped: hasCustomAgentDir,
      changes,
      warnings,
      stepReceipts: [
        ...stateSchemaMigration.receipts,
        ...preludeReceipts,
        ...eagerMigrations.receipts,
        ...createBlockedLegacyStateMigrationStepReceipts({
          steps: remainingMigrationSteps,
          blocker: eagerMigrations.haltedBy,
          onStepReceipt: params.onStepReceipt,
        }),
      ],
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
  const eagerResult = (id: string): MigrationMessages =>
    eagerMigrations.entries.find((entry) => entry.id === id)?.result ?? {
      changes: [],
      warnings: [],
    };
  const deviceAuth = eagerResult("device-auth");
  const deviceIdentity = eagerResult("device-identity");
  const meetingTranscripts = eagerResult("meeting-transcripts");
  const initialMigrationSources = [
    profileWorkspace,
    stateSchema,
    ...persistence.sources,
    configMachineState,
    orphanKeys,
  ];
  const initialMigrationWarnings = [
    ...initialMigrationSources.slice(0, -1).flatMap((source) => source.warnings),
    ...detected.warnings,
    ...orphanKeys.warnings,
  ];
  const useFileDetectionFastPath =
    mode === "automatic" &&
    !hasCustomAgentDir &&
    !detected.sessions.hasLegacy &&
    !detected.agentDir.hasLegacy &&
    !detected.pluginPlans?.hasLegacy &&
    !detected.pluginInstallIndex.hasLegacy &&
    !detected.debugProxyCaptureSidecar.hasLegacy &&
    !detected.stateSchema.hasLegacy &&
    !detected.sharedAuthStore.hasLegacy &&
    !detected.worktrees.hasLegacy &&
    detected.worktrees.pathRewrites.length === 0 &&
    !detected.configHealth.hasLegacy &&
    !detected.deviceAuth.hasLegacy &&
    !detected.workspace.hasLegacy &&
    !detected.channelPairing.hasLegacy;
  // SQLite rows can still need owner repair when legacy file detectors have no work.
  const migrations = await runSteps(
    remainingMigrationSteps,
    useFileDetectionFastPath ? (step) => step.runWithoutFileDetection === true : undefined,
  );
  const deferredPostSessionStep = migrations.deferredSteps.find(
    (step) => step.deferredExecution?.kind === "post-session-plugin",
  );
  const completedSources = [
    ...initialMigrationSources,
    ...(useFileDetectionFastPath ? migrations.sources : migrations.sharedSources),
    deviceAuth,
    deviceIdentity,
    ...(hasCustomAgentDir ? [] : [meetingTranscripts]),
    ...(useFileDetectionFastPath ? [] : migrations.finalSources),
  ];
  const changes = completedSources.flatMap((source) => source.changes);
  const warnings = [
    ...new Set([
      ...initialMigrationWarnings,
      ...completedSources
        .slice(initialMigrationSources.length)
        .flatMap((source) => source.warnings),
    ]),
  ];
  const notices = mergeNotices([
    detected,
    ...initialMigrationSources,
    ...(useFileDetectionFastPath ? migrations.sources : migrations.sharedNoticeSources),
    deviceAuth,
    deviceIdentity,
    ...(useFileDetectionFastPath ? [] : [meetingTranscripts, ...migrations.finalNoticeSources]),
  ]);
  logStateMigrationResult({ changes, warnings, notices }, params.log);
  return {
    mode,
    // Custom agent roots omit transcript changes from their shared-state report.
    // Preserve the completed migration status without claiming agent ownership.
    migrated: changes.length > 0 || meetingTranscripts.changes.length > 0,
    skipped: hasCustomAgentDir,
    changes,
    warnings,
    ...completedPluginMigrationFields(completedSources),
    stepReceipts: [
      ...stateSchemaMigration.receipts,
      ...preludeReceipts,
      ...eagerMigrations.receipts,
      ...migrations.receipts,
    ],
    ...(deferredPostSessionStep?.deferredExecution
      ? {
          postSessionPluginMigration: deferredPostSessionStep.deferredExecution.migration,
        }
      : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
