import { homedir } from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentEntries, tryResolveSoleAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import { configIncludeOwnsAgentRoster } from "../config/agent-roster-provenance.js";
import { readRecentConfigAuditRecords } from "../config/io.audit.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../config/legacy.default-agent-owner.js";
import { resolveLegacyAgentRosterOwner } from "../config/legacy.roster.js";
import { findLegacyConfigRuleIssues } from "../config/legacy.shared.js";
import { CONFIG_PATH } from "../config/paths.js";
import { setAppliedRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withDoctorProgress } from "../flows/doctor-health-startup.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "../infra/state-migrations.media-persistence-targets.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import { resolvePluginDoctorProviderRenames } from "../plugins/doctor-contract-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import type { AutomaticHeartbeatRepairAdmission } from "./doctor-automatic-heartbeat-repair.js";
import {
  noteDoctorHookConfigWarnings,
  noteImplicitFallbackClobberWarnings,
  noteMcpOriginWarning,
  noteMediaCliModelWarnings,
  noteMissingDefaultAgentOwner,
  noteOpencodeProviderOverrides,
  noteSandboxOriginProxyWarning,
} from "./doctor-config-analysis.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { createWorkspaceAliasMigrationRepair } from "./doctor-workspace-alias.js";
import { createDoctorChangesPanelSink } from "./doctor/changes-panel-sink.js";
import { cronCodexRuntimePolicyTargetKey } from "./doctor/cron/store-migration.js";
import * as notes from "./doctor/emit-notes.js";
import { finalizeDoctorConfigFlow } from "./doctor/finalize-config-flow.js";
import {
  applyLegacyCompatibilityStep,
  applyRetiredConfigStep,
  prepareDoctorConfigReferenceSource,
} from "./doctor/shared/config-flow-steps.js";
import {
  prepareDoctorConfigMigrationResult,
  retainHeartbeatMigrationInput,
} from "./doctor/shared/config-migration-result.js";
import {
  applyDoctorConfigMutation,
  type DoctorConfigMutationResult,
  type DoctorConfigMutationState,
} from "./doctor/shared/config-mutation-state.js";
import { listDoctorConfiguredChannelIds } from "./doctor/shared/configured-channel-ids.js";
import { normalizeCompatibilityConfigValues } from "./doctor/shared/legacy-config-core-migrate.js";
import { LEGACY_AGENT_ROSTER_RULES } from "./doctor/shared/legacy-config-migrations.runtime.entries.js";
import type { DoctorPluginMetadataSnapshotState } from "./doctor/shared/plugin-metadata-snapshot-scope.js";
import { planProviderRenames } from "./doctor/shared/provider-rename.js";
import { canWriteDoctorInclude } from "./doctor/shared/roster-include-write.js";

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  retiredStateAdmitted?: boolean;
  stateSchemaPreparation?: LegacyStateMigrationStepReceipt;
  agentDatabaseMigrationDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
  automaticHeartbeatRepair?: AutomaticHeartbeatRepairAdmission;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  runtime?: RuntimeEnv;
  prompter?: DoctorPrompter;
  reportFindings?: notes.DoctorFindingReporter;
}) {
  await using preparingResources = new AsyncDisposableStack();
  const shouldRepair = params.options.repair === true || params.options.yes === true;
  const preflight = await runDoctorConfigPreflight({
    retiredStateAdmitted: params.retiredStateAdmitted,
    stateSchemaPreparation: params.stateSchemaPreparation,
    integrityCheck: params.options.fullIntegrityCheck ? "full" : "quick",
    observe: false,
    invocationPurpose: "doctor",
    repairPrefixedConfig: shouldRepair,
    doctorOnlyStateMigrations: shouldRepair,
    preparePluginMetadataSnapshot: true,
    ...(params.automaticHeartbeatRepair
      ? { automaticHeartbeatRepair: params.automaticHeartbeatRepair }
      : {}),
    agentDatabaseMigrationDiscovery: params.agentDatabaseMigrationDiscovery,
    beforeWorkspaceStateMigration: createWorkspaceAliasMigrationRepair(params.prompter),
    cronStoreSelection: { options: params.options, prompter: params.prompter },
    measure: (name, run) =>
      withDoctorProgress(
        name.slice(name.lastIndexOf(".") + 1).replaceAll("-", " "),
        run,
        params.options.json !== true,
      ),
  });
  const { snapshot, baseConfig: baseCfg, heartbeatMigrationDeferred: deferHeartbeat } = preflight;
  if (!shouldRepair && !params.options.json) {
    const { collectRecoveryDiskUsage, formatRecoveryDiskUsage } =
      await import("./recovery-disk-usage.js");
    note(
      formatRecoveryDiskUsage(collectRecoveryDiskUsage({ cfg: baseCfg, env: process.env })),
      "Recovery copies (read-only)",
    );
  }
  preparingResources.use(preflight.pluginCache);
  if (!snapshot.exists || snapshot.valid) {
    await setAppliedRuntimeConfigSnapshot(snapshot.runtimeConfig, snapshot.sourceConfig);
  }
  const referenceSource = prepareDoctorConfigReferenceSource(snapshot);
  const pluginMetadataSnapshotState: DoctorPluginMetadataSnapshotState = {
    current: preflight.pluginMetadataSnapshot,
  };
  const { createDoctorPluginMetadataSnapshotScope } =
    await import("./doctor/shared/plugin-metadata-snapshot-scope.js");
  const pluginMetadataSnapshotScope = preparingResources.use(
    createDoctorPluginMetadataSnapshotScope({
      getBaseSnapshot: () => pluginMetadataSnapshotState.current,
      env: process.env,
      getDeferredPluginIds: () =>
        preflight.deferredPluginMigrations?.map((pending) => pending.pluginId) ?? [],
    }),
  );
  const runWithPluginMetadataSnapshot = pluginMetadataSnapshotScope.run;
  const runWithCurrentPluginMetadata = <T>(config: OpenClawConfig, run: () => T): T => {
    const soleAgentId = tryResolveSoleAgentId(config);
    return runWithPluginMetadataSnapshot(
      {
        config,
        workspaceDir: soleAgentId ? resolveAgentWorkspaceDir(config, soleAgentId) : undefined,
      },
      run,
    );
  };
  let state: DoctorConfigMutationState = {
    cfg: baseCfg,
    candidate: await retainHeartbeatMigrationInput(baseCfg, preflight.heartbeatMigrationSource),
    pendingChanges: false,
    fixHints: [],
  };
  const explicitSetPaths: string[][] = [];
  let shouldRepairCronCodexModelRefsAfterConfigWrite = false;
  let openAICodexAuthProfileIdMap: ReadonlyMap<string, string> | undefined;
  let modelRetirementRepairRan = false;
  let retiredModelRefConfig: Pick<OpenClawConfig, "agents" | "models"> | undefined;
  const doctorFixCommand = formatCliCommand("openclaw doctor --fix");
  const changesPanelSink = createDoctorChangesPanelSink(shouldRepair);
  const configRepairWarnings: string[] = [...(preflight.warnings ?? [])];
  const applyConfigMutation = (
    mutation: DoctorConfigMutationResult & { warnings?: string[] },
    fixHint: string,
    options: { sanitize?: boolean; emitWarnings?: boolean } = {},
  ): void => {
    changesPanelSink.emit(mutation.changes, options.sanitize ? { sanitize: true } : {});
    if (options.emitWarnings !== false && mutation.warnings?.length) {
      notes.emitDoctorNotes({ note, warningNotes: mutation.warnings });
      configRepairWarnings.push(...mutation.warnings);
    }
    state = applyDoctorConfigMutation({
      state,
      mutation,
      shouldRepair,
      fixHint,
    });
  };
  const finalizeMigrationResult = prepareDoctorConfigMigrationResult(preflight, snapshot);
  const plannedProviderRenames = runWithCurrentPluginMetadata(state.candidate, () =>
    planProviderRenames(
      snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
      resolvePluginDoctorProviderRenames({ config: state.candidate }),
    ),
  );

  const sourceRosterConfig = snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const rosterMigrationNeeded =
    findLegacyConfigRuleIssues(sourceRosterConfig, LEGACY_AGENT_ROSTER_RULES).length > 0 ||
    listAgentEntries(sourceRosterConfig).length === 0 ||
    (baseCfg.agents?.ownership === undefined && listAgentEntries(baseCfg).length > 1);
  const legacyStep = runWithCurrentPluginMetadata(state.candidate, () =>
    applyLegacyCompatibilityStep({
      snapshot,
      state,
      shouldRepair,
      doctorFixCommand,
    }),
  );
  state = legacyStep.state;
  const legacyDefaultAgentId =
    preflight.rosterMigrationOwnerId ??
    tryGetLegacyDefaultAgentId(state.candidate) ??
    resolveLegacyAgentRosterOwner(preflight.rosterMigrationSource ?? sourceRosterConfig);
  if (legacyDefaultAgentId) {
    retainLegacyDefaultAgentId(state.cfg, legacyDefaultAgentId);
    retainLegacyDefaultAgentId(state.candidate, legacyDefaultAgentId);
  }
  const persistCanonicalAgentRoster =
    snapshot.exists && rosterMigrationNeeded && !configIncludeOwnsAgentRoster(snapshot);
  if (persistCanonicalAgentRoster) {
    applyConfigMutation(
      {
        config: state.candidate,
        changes: ["Prepared the agent roster for persistence."],
      },
      `Run "${doctorFixCommand}" to persist the explicit agent roster.`,
      { emitWarnings: false },
    );
    if (state.candidate.agents?.ownership === "explicit") {
      explicitSetPaths.push(["agents", "ownership"]);
    }
  }
  const { prepareSessionStoreOwnerRecovery } = await import("./doctor-session-store-owner.js");
  const sessionStoreOwnerRecovery = await prepareSessionStoreOwnerRecovery({
    config: state.candidate,
    snapshot,
    prompter: params.prompter,
  });
  applyConfigMutation(
    sessionStoreOwnerRecovery,
    `Run "${doctorFixCommand}" to review session-store ownership recovery.`,
    { sanitize: true },
  );

  const { collectBlockedLegacyOpenAICodexProviderPlan } =
    await import("./doctor/shared/legacy-config-migrations.runtime.models.js");
  const blockedCodexProviderPlan = collectBlockedLegacyOpenAICodexProviderPlan(state.candidate);
  const blockedCodexModelIdentities = new Set(blockedCodexProviderPlan.blockedModelIdentities);
  if (preflight.cronCodexRuntimePolicyTargets?.length) {
    const { repairCronCodexRuntimePolicies } =
      await import("./doctor/cron/runtime-policy-migration.js");
    const cronRuntimeRepair = repairCronCodexRuntimePolicies({
      cfg: state.candidate,
      targets: preflight.cronCodexRuntimePolicyTargets,
      blockedModelIdentities: blockedCodexModelIdentities,
    });
    applyConfigMutation(
      cronRuntimeRepair,
      `Run "${doctorFixCommand}" to preserve migrated cron runtime policy.`,
    );
    const blockedTargets = new Set(
      cronRuntimeRepair.blockedTargets.map(cronCodexRuntimePolicyTargetKey),
    );
    shouldRepairCronCodexModelRefsAfterConfigWrite = preflight.cronCodexRuntimePolicyTargets.some(
      (target) => !blockedTargets.has(cronCodexRuntimePolicyTargetKey(target)),
    );
  }
  const pluginLegacyIssues = await (async () => {
    if (snapshot.parsed === snapshot.sourceConfig) {
      return [];
    }
    const { findDoctorLegacyConfigIssues } =
      await import("./doctor/shared/legacy-config-issues.js");
    return runWithCurrentPluginMetadata(state.candidate, () =>
      findDoctorLegacyConfigIssues(snapshot.parsed, snapshot.parsed),
    );
  })();
  const seenLegacyIssues = new Set(
    snapshot.legacyIssues.map((issue) => `${issue.path}:${issue.message}`),
  );
  const pluginIssueLines = pluginLegacyIssues
    .filter((issue) => {
      const key = `${issue.path}:${issue.message}`;
      if (seenLegacyIssues.has(key)) {
        return false;
      }
      seenLegacyIssues.add(key);
      return true;
    })
    .map((issue) => `- ${issue.path}: ${issue.message}`);
  const legacyIssueLines = [...legacyStep.issueLines, ...pluginIssueLines];
  if (
    pluginIssueLines.length > 0 &&
    !shouldRepair &&
    !state.fixHints.includes(`Run "${doctorFixCommand}" to migrate legacy config keys.`)
  ) {
    state.fixHints.push(`Run "${doctorFixCommand}" to migrate legacy config keys.`);
  }
  if (legacyIssueLines.length > 0) {
    note(legacyIssueLines.join("\n"), "Legacy config keys detected");
  }
  changesPanelSink.emit(legacyStep.changeLines);

  const { repairGeneratedModelMetadataCorruption } =
    await import("./doctor/shared/model-metadata-corruption-repair.js");
  const modelMetadataRepair = runWithCurrentPluginMetadata(state.candidate, () =>
    repairGeneratedModelMetadataCorruption({
      config: state.candidate,
      authoredRoot: snapshot.parsed,
      configPath: snapshot.path,
      currentHash: hashConfigRaw(snapshot.raw),
      loadAuditRecords: () =>
        readRecentConfigAuditRecords({ env: process.env, homedir, limit: 2048 }),
    }),
  );
  applyConfigMutation(
    modelMetadataRepair,
    `Run "${doctorFixCommand}" to remove audit-proven generated model metadata.`,
  );

  noteDoctorHookConfigWarnings(state.cfg, snapshot.path);

  // Parsed config supplies invalid-key evidence only; migrations still mutate the
  // include/env-resolved candidate so doctor never writes unresolved source values.
  const normalized = runWithCurrentPluginMetadata(state.candidate, () =>
    normalizeCompatibilityConfigValues(state.candidate, {
      blockedModelIdentities: blockedCodexModelIdentities,
      sourceRaw: snapshot.parsed,
    }),
  );
  applyConfigMutation(normalized, `Run "${doctorFixCommand}" to apply these changes.`);

  const { recoverCommandOwnerTargetKinds } = await import("./doctor-command-owner-recovery.js");
  applyConfigMutation(
    runWithCurrentPluginMetadata(state.candidate, () =>
      recoverCommandOwnerTargetKinds({ config: state.candidate, snapshot }),
    ),
    `Run "${doctorFixCommand}" to restore recorded command-owner target kinds.`,
    { sanitize: true },
  );

  const { repairUnownedChannelAccountBindings } =
    await import("./doctor/shared/legacy-config-binding-repair.js");
  applyConfigMutation(
    runWithCurrentPluginMetadata(state.candidate, () =>
      repairUnownedChannelAccountBindings({
        config: state.candidate,
        sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
      }),
    ),
    `Run "${doctorFixCommand}" to preserve channel account ownership.`,
  );

  const { collectTailscaleConfigWarnings } = await import("./doctor-tailscale.js");
  const tailscaleWarnings = await collectTailscaleConfigWarnings({
    cfg: state.candidate,
    env: process.env,
  });
  notes.emitDoctorNotes({ note, warningNotes: tailscaleWarnings });
  configRepairWarnings.push(...tailscaleWarnings);

  const { prepareRetiredPhoneControlCleanup } = await import("./doctor-retired-phone-control.js");
  const retiredPhoneControlCleanup = await prepareRetiredPhoneControlCleanup({
    cfg: state.candidate,
    env: process.env,
  });
  applyConfigMutation(
    {
      config: retiredPhoneControlCleanup.config,
      changes: retiredPhoneControlCleanup.configChanges,
      warnings: retiredPhoneControlCleanup.warnings,
    },
    `Run "${doctorFixCommand}" to retire Phone Control lease configuration.`,
  );
  if (retiredPhoneControlCleanup.cleanupPending && !shouldRepair) {
    note(
      `Retired Phone Control lease state remains. Run "${doctorFixCommand}" to archive it.`,
      "Legacy state detected",
    );
  }

  const { recoverInstalledPluginConfigIds } =
    await import("./doctor/shared/installed-plugin-id-recovery.js");
  const installedPluginRecovery = await recoverInstalledPluginConfigIds(
    state.candidate,
    process.env,
  );
  applyConfigMutation(
    { ...installedPluginRecovery, warnings: installedPluginRecovery.notices },
    `Run "${doctorFixCommand}" to apply these changes.`,
  );
  if (referenceSource) {
    referenceSource.installedPluginIdRecovery = installedPluginRecovery.recovery;
  }
  // Preserve authored legacy disable policy before auto-enable can generate a
  // canonical entry that would otherwise win the migration's shallow merge.
  const pluginActivationSourceConfig = state.candidate;
  const { collectCodexPluginActivationWarnings } =
    await import("./doctor/shared/codex-plugin-activation-warning.js");
  notes.emitDoctorNotes({
    note,
    warningNotes: collectCodexPluginActivationWarnings(pluginActivationSourceConfig),
  });
  const { applyPluginAutoEnable } = await import("../config/plugin-auto-enable.js");
  applyConfigMutation(
    runWithCurrentPluginMetadata(state.candidate, () =>
      applyPluginAutoEnable({
        config: state.candidate,
        env: process.env,
      }),
    ),
    `Run "${doctorFixCommand}" to apply these changes.`,
    { emitWarnings: false },
  );

  if (!shouldRepair) {
    const { repairStaleAgentModelRefs } =
      await import("./doctor/shared/stale-agent-model-ref-repair.js");
    const staleAgentModelRepair = runWithCurrentPluginMetadata(state.candidate, () =>
      repairStaleAgentModelRefs(state.candidate, { env: process.env }),
    );
    retiredModelRefConfig = staleAgentModelRepair.retiredModelRefConfig;
    applyConfigMutation(
      staleAgentModelRepair,
      `Run "${doctorFixCommand}" to remove stale agent model references.`,
      { sanitize: true },
    );
  }

  const [
    { collectPluginToolAllowlistWarnings },
    { collectGitHubUpgradeWarnings },
    { normalizePluginsConfig },
  ] = await Promise.all([
    import("./doctor/shared/plugin-tool-allowlist-warnings.js"),
    import("./doctor/shared/github-preview-upgrade.js"),
    import("../plugins/config-state.js"),
  ]);
  const pluginToolAllowlistWarnings = runWithCurrentPluginMetadata(state.candidate, () =>
    collectPluginToolAllowlistWarnings({
      cfg: state.candidate,
      env: process.env,
    }),
  );
  const pluginWarnings = [
    ...pluginToolAllowlistWarnings,
    ...collectGitHubUpgradeWarnings(normalizePluginsConfig(state.candidate.plugins)),
  ];
  if (pluginWarnings.length > 0) {
    note(notes.sanitizeDoctorNote(pluginWarnings.join("\n")), "Doctor warnings");
  }

  const hasConfiguredChannels =
    listDoctorConfiguredChannelIds(state.candidate, { configEntryPolicy: "raw" }).length > 0;
  let collectMutableAllowlistWarnings:
    | typeof import("./doctor/shared/channel-doctor.js").collectChannelDoctorMutableAllowlistWarnings
    | undefined;
  if (hasConfiguredChannels) {
    const channelDoctor = await import("./doctor/shared/channel-doctor.js");
    collectMutableAllowlistWarnings = channelDoctor.collectChannelDoctorMutableAllowlistWarnings;
    const channelDoctorSequence = await runWithCurrentPluginMetadata(state.candidate, () =>
      channelDoctor.runChannelDoctorConfigSequences({
        cfg: state.candidate,
        env: process.env,
        shouldRepair,
      }),
    );
    notes.emitDoctorNotes({
      note,
      changeNotes: channelDoctorSequence.changeNotes,
      infoNotes: channelDoctorSequence.infoNotes,
      warningNotes: channelDoctorSequence.warningNotes,
    });

    const staleChannelCleanups = await runWithCurrentPluginMetadata(state.candidate, () =>
      channelDoctor.collectChannelDoctorStaleConfigMutations(state.candidate, {
        env: process.env,
      }),
    );
    for (const staleCleanup of staleChannelCleanups) {
      applyConfigMutation(
        staleCleanup,
        `Run "${doctorFixCommand}" to remove stale channel plugin references.`,
        { sanitize: true },
      );
    }
  }

  const { repairHooksTokenReuseGatewayAuth } =
    await import("./doctor/shared/hooks-token-reuse-repair.js");
  applyConfigMutation(
    await repairHooksTokenReuseGatewayAuth(state.candidate, process.env),
    `Run "${doctorFixCommand}" to rotate hooks.token away from Gateway auth.`,
    { emitWarnings: false },
  );

  const { repairSystemAgentWorkspacePin } =
    await import("./doctor/shared/system-agent-workspace-repair.js");
  // authoredConfig keeps include-resolved authored values (env refs intact); parsed only has the
  // root file, so an agents.defaults $include would otherwise freeze the resolved absolute path.
  const parsedAgents = isRecord(snapshot.parsed) ? snapshot.parsed.agents : undefined;
  const parsedDefaults = isRecord(parsedAgents) ? parsedAgents.defaults : undefined;
  const authoredDefaultWorkspace =
    snapshot.authoredConfig?.agents?.defaults?.workspace ??
    (isRecord(parsedDefaults) ? parsedDefaults.workspace : undefined);
  const systemAgentWorkspaceOptions = {
    includeOwnsRoster: configIncludeOwnsAgentRoster(snapshot),
    authoredDefaultWorkspace:
      typeof authoredDefaultWorkspace === "string" ? authoredDefaultWorkspace : undefined,
  };
  const systemAgentWorkspace = await repairSystemAgentWorkspacePin(state.candidate, process.env, {
    ...systemAgentWorkspaceOptions,
    applyFiles: shouldRepair,
  });
  explicitSetPaths.push(...(systemAgentWorkspace.explicitSetPaths ?? []));
  applyConfigMutation(
    systemAgentWorkspace,
    `Run "${doctorFixCommand}" to pin the system agent's workspace.`,
  );

  if (shouldRepair) {
    const { runDoctorRepairSequence } = await import("./doctor/repair-sequencing.js");
    const prompter = params.prompter;
    const repairSequence = await withDoctorProgress(
      "Config repairs",
      () =>
        runDoctorRepairSequence({
          state,
          installedPluginIdRecovery: installedPluginRecovery.recovery,
          doctorFixCommand,
          modelReplacements: params.options.modelReplacements,
          reportFindings: params.reportFindings,
          env: process.env,
          blockedCodexProviderPlan,
          pluginMetadataSnapshotState,
          runWithPluginMetadataSnapshot,
          ...(prompter
            ? {
                onCapabilityConsent: createPluginCapabilityConsentPrompter({
                  note: async (message, title) => note(message, title),
                  confirm: (confirmation) =>
                    prompter.confirmRuntimeRepair({
                      ...confirmation,
                      requiresInteractiveConfirmation: true,
                    }),
                }),
              }
            : {}),
        }),
      params.options.json !== true,
    );
    state = repairSequence.state;
    configRepairWarnings.push(...repairSequence.warningNotes);
    if (referenceSource) {
      referenceSource.installedPluginIdRecovery = new Map([
        ...installedPluginRecovery.recovery,
        ...repairSequence.installedPluginIdRecovery,
      ]);
    }
    pluginMetadataSnapshotState.current = repairSequence.pluginMetadataSnapshot;
    openAICodexAuthProfileIdMap = repairSequence.openAICodexAuthProfileIdMap;
    retiredModelRefConfig = repairSequence.retiredModelRefConfig;
    modelRetirementRepairRan = repairSequence.modelRetirementRepairRan;
    if (repairSequence.authProfilesRepaired) {
      const { refreshGatewayAuthStateAfterAuthProfileRepair } =
        await import("./doctor/auth-profile-repair.js");
      await refreshGatewayAuthStateAfterAuthProfileRepair();
    }
    // Committed side-effect repairs (SQLite/filesystem) already happened; report now.
    // Candidate-config mutations stay queued until the atomic write commits.
    notes.emitDoctorRepairSequenceNotes({
      note,
      repairSequence,
      structuredWarnings: Boolean(params.reportFindings),
      emitConfigChange: (change) => changesPanelSink.emit([change]),
    });
  } else {
    const { collectDoctorPreviewNotes } = await import("./doctor/shared/preview-warnings.js");
    const previewNotes = await runWithCurrentPluginMetadata(state.candidate, () =>
      collectDoctorPreviewNotes({
        cfg: state.candidate,
        activationSourceConfig: pluginActivationSourceConfig,
        doctorFixCommand,
        env: process.env,
        allowExec: params.options.allowExec === true,
        blockedCodexProviderPlan,
      }),
    );
    notes.emitDoctorNotes({
      note,
      infoNotes: previewNotes.infoNotes,
      warningNotes: previewNotes.warningNotes,
    });
  }

  const mutableAllowlistWarnings = collectMutableAllowlistWarnings
    ? await runWithCurrentPluginMetadata(state.candidate, () =>
        collectMutableAllowlistWarnings({
          cfg: state.candidate,
          env: process.env,
        }),
      )
    : [];
  if (mutableAllowlistWarnings.length > 0) {
    note(notes.sanitizeDoctorNote(mutableAllowlistWarnings.join("\n")), "Doctor warnings");
  }

  // Retain normalized source facts before retirement removes heartbeat settings.
  const modelBillingRouteConfig = state.candidate;
  state = await applyRetiredConfigStep({
    state,
    shouldRepair,
    doctorFixCommand,
    sourceConfig: snapshot.sourceConfig,
    emitChanges: changesPanelSink.emit,
    preflight,
  });

  const finalized = await finalizeDoctorConfigFlow({
    ...state,
    snapshot,
    shouldRepair,
    confirm: params.confirm,
    note,
  });
  const shouldWriteConfig =
    finalized.shouldWriteConfig && !legacyStep.blocksWrite && !deferHeartbeat;
  // An accepted preview copies the system agent's files before its workspace pin joins the write.
  const confirmedWorkspace =
    !shouldRepair && shouldWriteConfig && systemAgentWorkspace.restorePending
      ? await repairSystemAgentWorkspacePin(finalized.cfg, process.env, {
          ...systemAgentWorkspaceOptions,
          applyFiles: true,
        })
      : undefined;
  if (confirmedWorkspace) {
    explicitSetPaths.push(...(confirmedWorkspace.explicitSetPaths ?? []));
    if (confirmedWorkspace.warnings?.length) {
      notes.emitDoctorNotes({ note, warningNotes: confirmedWorkspace.warnings });
      configRepairWarnings.push(...confirmedWorkspace.warnings);
    }
  }
  const cfg = confirmedWorkspace?.config ?? finalized.cfg;
  const includeBoundaryWrite =
    shouldWriteConfig &&
    canWriteDoctorInclude(
      snapshot,
      cfg,
      { persistCanonicalAgentRoster, explicitSetPaths },
      referenceSource?.installedPluginIdRecovery,
    );

  const configuredOpencodePluginIds = [
    cfg.models?.providers?.opencode || cfg.models?.providers?.["opencode-zen"]
      ? "opencode"
      : undefined,
    cfg.models?.providers?.["opencode-go"] ? "opencode-go" : undefined,
  ].filter((pluginId): pluginId is string => pluginId !== undefined);
  let activeOpencodePluginIds: string[] = [];
  if (configuredOpencodePluginIds.length > 0) {
    const { resolveEnabledProviderPluginIds } = await import("../plugins/providers.js");
    activeOpencodePluginIds = runWithCurrentPluginMetadata(cfg, () =>
      resolveEnabledProviderPluginIds({ config: cfg, onlyPluginIds: configuredOpencodePluginIds }),
    );
  }
  noteOpencodeProviderOverrides(cfg, {
    opencodePluginActive: activeOpencodePluginIds.includes("opencode"),
    opencodeGoPluginActive: activeOpencodePluginIds.includes("opencode-go"),
  });
  noteImplicitFallbackClobberWarnings(cfg);
  noteSandboxOriginProxyWarning(cfg);
  noteMcpOriginWarning(cfg);
  noteMediaCliModelWarnings(cfg);
  noteMissingDefaultAgentOwner(cfg);

  const migrationResult = await finalizeMigrationResult({
    cfg,
    modelBillingRouteConfig,
    shouldWriteConfig,
    pluginInventoryChanged: pluginMetadataSnapshotState.inventoryChanged,
    metadataSnapshot: pluginMetadataSnapshotState.current,
    runWithCurrentPluginMetadata,
  });
  const invalidatePluginMetadataSnapshot = () => {
    // Filesystem/install repairs replace the authoritative plugin generation.
    delete configResult.preflightLegacyStateConfig;
    pluginMetadataSnapshotState.current = undefined;
    pluginMetadataSnapshotScope.invalidate();
  };

  // Queued repair panels describe candidate mutations; the write runner prints
  // them as "Doctor changes" only after the atomic write commits. A blocked
  // write drops them — its blocking note already states nothing was changed.
  // The accepted preview already printed; its applied lines print once the write commits.
  const pendingChangePanels = changesPanelSink.drain(confirmedWorkspace?.changes);
  const providerRenames = legacyStep.blocksWrite ? [] : plannedProviderRenames;
  await setAppliedRuntimeConfigSnapshot(cfg, cfg);
  // Later Doctor contributions and service finalization consume these callbacks.
  const resources = preparingResources.move();

  const configResult = {
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
    ...finalized,
    cfg,
    heartbeatMigrationSource: modelBillingRouteConfig,
    ...(shouldWriteConfig && sessionStoreOwnerRecovery.changes.length > 0
      ? {
          confirmedConfigSource: {
            path: snapshot.path,
            hash: snapshot.hash ?? hashConfigRaw(snapshot.raw),
          },
        }
      : {}),
    ...(referenceSource ? { referenceSource } : {}),
    path: snapshot.path ?? CONFIG_PATH,
    shouldWriteConfig,
    ...(configRepairWarnings.length ? { warnings: [...new Set(configRepairWarnings)] } : {}),
    ...(shouldWriteConfig && pendingChangePanels.length > 0 ? { pendingChangePanels } : {}),
    sourceConfigValid: snapshot.valid,
    ...(legacyStep.partiallyValid === true ? { skipPluginValidationOnWrite: true } : {}),
    ...(shouldWriteConfig && explicitSetPaths.length > 0 ? { explicitSetPaths } : {}),
    ...(shouldWriteConfig && persistCanonicalAgentRoster
      ? { persistCanonicalAgentRoster: true }
      : {}),
    ...(includeBoundaryWrite ? { skipWizardMetadataForIncludeWrite: true } : {}),
    ...(shouldRepairCronCodexModelRefsAfterConfigWrite
      ? { shouldRepairCronCodexModelRefsAfterConfigWrite: true }
      : {}),
    ...(shouldRepair &&
    retiredPhoneControlCleanup.cleanupPending &&
    retiredPhoneControlCleanup.cleanupSafe
      ? { retiredPhoneControlStateCleanupPending: true }
      : {}),
    ...(blockedCodexProviderPlan.blockedModelIdentities.length > 0
      ? { blockedCodexModelIdentities: blockedCodexProviderPlan.blockedModelIdentities }
      : {}),
    ...(openAICodexAuthProfileIdMap ? { openAICodexAuthProfileIdMap } : {}),
    ...(retiredModelRefConfig ? { retiredModelRefConfig } : {}),
    ...(providerRenames.length > 0 ? { providerRenames } : {}),
    modelRetirementRepairRan:
      modelRetirementRepairRan && !legacyStep.blocksWrite && (shouldWriteConfig || snapshot.valid),
    ...migrationResult,
    runWithPluginMetadataSnapshot,
    invalidatePluginMetadataSnapshot,
  };
  return configResult;
}
