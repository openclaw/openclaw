import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  DoctorMaintenancePending,
  DoctorMaintenancePendingCheck,
} from "./doctor-maintenance-pending.js";
import type {
  DoctorConfigFlowTransformContext,
  DoctorConfigFlowTransformId,
  DoctorConfigTransformResult,
  DoctorRepairSequenceTransformId,
} from "./doctor/shared/config-transforms.js";
import type { DoctorModelReplacement } from "./doctor/shared/model-replacement.js";

type Decide = () => DoctorMaintenancePending | Promise<DoctorMaintenancePending>;

export type DoctorConfigRepairsPendingParams = {
  env: NodeJS.ProcessEnv;
  modelReplacements?: readonly DoctorModelReplacement[];
  /** The config flow pending's one snapshot read. */
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  /** Runs reads only while a connection holds the state database (`decideDoctorPendingFromLiveStores`). */
  decideLive: (decide: Decide) => Promise<DoctorMaintenancePending>;
  /** Disposed once every input has been traced. */
  resources: AsyncDisposableStack;
};

/** The repairs' candidate as the checks carry it from stage to stage. */
type RepairsChain = {
  snapshot: ConfigFileSnapshot;
  candidate: OpenClawConfig;
  context: DoctorConfigFlowTransformContext;
  runWithPluginMetadata: <T>(config: OpenClawConfig, run: () => T) => T;
  installedPluginPreserveIds: string[];
};

/**
 * A stage's answer from its own result: a change is work; a warning or advisory the flow would
 * report is undecidable, since skipping the step would drop it.
 */
function decideResult(
  result: Pick<DoctorConfigTransformResult, "changes" | "warnings" | "advisories">,
  options: { reportsWarnings?: false } = {},
): DoctorMaintenancePending {
  if (result.changes.length > 0) {
    return "work";
  }
  const reported = [...(result.warnings ?? []), ...(result.advisories ?? [])];
  return options.reportsWarnings !== false && reported.length > 0 ? "undecidable" : "none";
}

/**
 * `doctor.config-flow`'s config repair stages after the preflight, one input each in the order the
 * flow runs them (`config-flow.config-repairs.<stage>`). A config-only stage runs its own repair on
 * a private copy of the config read once; the copy carries each stage's result to the next, as
 * the flow's candidate does. Stages that write stores or files, or call channel plugin hooks that
 * cannot say whether they have work, have no check here or answer `undecidable`.
 *
 * The copy starts from the config file as read, so these answers assume the preflight changed
 * nothing; the preflight's own inputs answer `work` when it would.
 */
export function doctorConfigRepairsPendingInputs(
  params: DoctorConfigRepairsPendingParams,
): ReadonlyArray<{ id: string; check?: DoctorMaintenancePendingCheck }> {
  const { env } = params;
  let chainRead: Promise<RepairsChain | undefined> | undefined;
  const readChain = () =>
    (chainRead ??= (async (): Promise<RepairsChain | undefined> => {
      const snapshot = await params.readSnapshot();
      if (snapshot.exists && !snapshot.valid) {
        return undefined;
      }
      const [
        { retainHeartbeatMigrationInput },
        { resolveLegacyAgentRosterOwner },
        { retainLegacyDefaultAgentId, tryGetLegacyDefaultAgentId },
        { collectBlockedLegacyOpenAICodexProviderPlan },
        { createDoctorPluginMetadataSnapshotScope },
        { tryResolveSoleAgentId },
        { resolveAgentWorkspaceDir },
        { preparePluginDoctorContractModules },
      ] = await Promise.all([
        import("./doctor/shared/config-migration-result.js"),
        import("../config/legacy.roster.js"),
        import("../config/legacy.default-agent-owner.js"),
        import("./doctor/shared/legacy-config-migrations.runtime.models.js"),
        import("./doctor/shared/plugin-metadata-snapshot-scope.js"),
        import("../agents/agent-scope-config.js"),
        import("../agents/agent-scope.js"),
        import("../plugins/doctor-contract-preparation.js"),
      ]);
      // The flow's first candidate: a copy of the config as read.
      const baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
      const candidate = await retainHeartbeatMigrationInput(baseConfig, undefined);
      const legacyDefaultAgentId =
        tryGetLegacyDefaultAgentId(candidate) ??
        resolveLegacyAgentRosterOwner(
          snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
        );
      if (legacyDefaultAgentId) {
        retainLegacyDefaultAgentId(candidate, legacyDefaultAgentId);
      }
      const scope = params.resources.use(createDoctorPluginMetadataSnapshotScope({ env }));
      const runWithPluginMetadata = <T>(config: OpenClawConfig, run: () => T): T => {
        const soleAgentId = tryResolveSoleAgentId(config);
        return scope.run(
          {
            config,
            workspaceDir: soleAgentId ? resolveAgentWorkspaceDir(config, soleAgentId) : undefined,
          },
          run,
        );
      };
      await runWithPluginMetadata(candidate, () =>
        preparePluginDoctorContractModules({ config: candidate, surfaces: ["configRepair"] }),
      );
      return {
        snapshot,
        candidate,
        context: {
          env,
          snapshot,
          blockedCodexProviderPlan: collectBlockedLegacyOpenAICodexProviderPlan(candidate),
          // Reading the audit history opens the state database for writing; a model that needs
          // it is undecided here.
          loadAuditRecords: () => {
            throw new Error("Doctor's pending check does not read the config audit history.");
          },
        },
        runWithPluginMetadata,
        installedPluginPreserveIds: [],
      };
    })());
  // A stage decided against the carried candidate; its change carries on to later stages.
  const decideStage =
    (
      decide: (chain: RepairsChain) => Promise<{
        pending: DoctorMaintenancePending;
        result?: DoctorConfigTransformResult;
      }>,
    ): DoctorMaintenancePendingCheck =>
    () =>
      params.decideLive(async () => {
        const chain = await readChain();
        if (!chain) {
          return "undecidable";
        }
        const { pending, result } = await decide(chain);
        if (result && result.changes.length > 0) {
          const { applyDoctorConfigMutation } =
            await import("./doctor/shared/config-mutation-state.js");
          chain.candidate = applyDoctorConfigMutation({
            state: {
              cfg: chain.candidate,
              candidate: chain.candidate,
              pendingChanges: false,
              fixHints: [],
            },
            mutation: result,
            shouldRepair: true,
          }).candidate;
        }
        return pending;
      });
  // Every stage runs inside the checks' own plugin metadata scope, so the caches and readers
  // its metadata reads acquire are retired with the scope.
  type TransformOptions = { reportsWarnings?: false };
  const inScope = <T>(chain: RepairsChain, run: () => T): T =>
    chain.runWithPluginMetadata(chain.candidate, run);
  const flowTransform = (id: DoctorConfigFlowTransformId, options: TransformOptions = {}) =>
    decideStage(async (chain) => {
      const { runDoctorConfigFlowTransform } = await import("./doctor/shared/config-transforms.js");
      const result = await inScope(chain, () =>
        runDoctorConfigFlowTransform(id, chain.candidate, chain.context),
      );
      return { pending: decideResult(result, options), result };
    });
  const repairTransform = (id: DoctorRepairSequenceTransformId) =>
    decideStage(async (chain) => {
      const { runDoctorRepairSequenceTransform } =
        await import("./doctor/shared/config-transforms.js");
      const result = await inScope(chain, () =>
        runDoctorRepairSequenceTransform(id, chain.candidate, chain.context),
      );
      return { pending: decideResult(result), result };
    });
  // Channel plugin hooks have no read-only "has work" contract: a channel that implements one is
  // undecidable; without one the runner does nothing.
  const channelHook = (
    hook: "runConfigSequence" | "cleanStaleConfig" | "repairConfig",
    options: { onlyWithConfiguredChannels?: true } = {},
  ) =>
    decideStage(async (chain) => {
      const [{ listChannelDoctorHookOwners }, { listDoctorConfiguredChannelIds }] =
        await Promise.all([
          import("./doctor/shared/channel-doctor.js"),
          import("./doctor/shared/configured-channel-ids.js"),
        ]);
      if (
        options.onlyWithConfiguredChannels &&
        listDoctorConfiguredChannelIds(chain.candidate, { configEntryPolicy: "raw" }).length === 0
      ) {
        return { pending: "none" };
      }
      const owners = await chain.runWithPluginMetadata(chain.candidate, () =>
        listChannelDoctorHookOwners({ cfg: chain.candidate, env }, hook),
      );
      return {
        pending: owners.unavailable || owners.channelIds.length > 0 ? "undecidable" : "none",
      };
    });
  const packageSwapGate = async (): Promise<DoctorMaintenancePending | undefined> => {
    const { isUpdatePackageSwapInProgress } = await import("./doctor/shared/update-phase.js");
    // During an update's package swap these repairs wait for plugin convergence.
    return isUpdatePackageSwapInProgress(env) ? "undecidable" : undefined;
  };

  return [
    {
      id: "config-repairs.legacy-compatibility",
      check: decideStage(async ({ snapshot }) => ({
        pending: snapshot.legacyIssues.length > 0 ? "work" : "none",
      })),
    },
    {
      id: "config-repairs.agent-roster",
      check: decideStage(async ({ snapshot }) => {
        const { needsCanonicalAgentRosterPersistence } =
          await import("./doctor/shared/agent-roster-persistence.js");
        const baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
        return {
          pending: needsCanonicalAgentRosterPersistence(snapshot, baseConfig) ? "work" : "none",
        };
      }),
    },
    // Reads config backups and can ask the operator before restoring.
    { id: "config-repairs.session-store-owner" },
    // Cron Codex runtime policy targets come from the preflight; `config-flow.cron` decides them.
    { id: "config-repairs.model-metadata", check: flowTransform("model-metadata") },
    { id: "config-repairs.compatibility-values", check: flowTransform("compatibility-values") },
    { id: "config-repairs.command-owner-targets", check: flowTransform("command-owner-targets") },
    {
      id: "config-repairs.channel-account-bindings",
      check: flowTransform("channel-account-bindings"),
    },
    // Reads retired Phone Control arm state and plugin state rows.
    { id: "config-repairs.retired-phone-control" },
    {
      // The install records the flow reads before auto-enable; the repair sequence reads them
      // again after its installs.
      id: "config-repairs.installed-plugin-ids",
      check: decideStage(async (chain) => {
        const { recoverInstalledPluginConfigIds } =
          await import("./doctor/shared/installed-plugin-id-recovery.js");
        const recovery = await inScope(chain, () =>
          recoverInstalledPluginConfigIds(chain.candidate, env),
        );
        chain.installedPluginPreserveIds = recovery.preservePluginIds;
        const result = { ...recovery, warnings: recovery.notices };
        return { pending: decideResult(result), result };
      }),
    },
    {
      id: "config-repairs.plugin-auto-enable",
      check: flowTransform("plugin-auto-enable", { reportsWarnings: false }),
    },
    {
      id: "config-repairs.channel-config-sequences",
      check: channelHook("runConfigSequence", { onlyWithConfiguredChannels: true }),
    },
    {
      id: "config-repairs.channel-stale-config",
      check: channelHook("cleanStaleConfig", { onlyWithConfiguredChannels: true }),
    },
    {
      id: "config-repairs.hooks-token-reuse",
      check: flowTransform("hooks-token-reuse", { reportsWarnings: false }),
    },
    {
      id: "config-repairs.system-agent-workspace",
      check: decideStage(async (chain) => {
        const { repairSystemAgentWorkspacePin, resolveSystemAgentWorkspaceRepairOptions } =
          await import("./doctor/shared/system-agent-workspace-repair.js");
        // Without `applyFiles` the repair only describes the files it would copy.
        const result = await inScope(chain, () =>
          repairSystemAgentWorkspacePin(chain.candidate, env, {
            ...resolveSystemAgentWorkspaceRepairOptions(chain.snapshot),
            applyFiles: false,
          }),
        );
        // A pin carries on to later stages; a pending copy leaves the config unchanged.
        return { pending: decideResult(result), result };
      }),
    },
    // The repair sequence, in its order.
    { id: "config-repairs.channel-repairs", check: channelHook("repairConfig") },
    {
      id: "config-repairs.bundled-plugin-load-paths",
      check: repairTransform("bundled-plugin-load-paths"),
    },
    // Rewrites managed npm packages and symlinks; neither has a read-only predicate yet.
    { id: "config-repairs.stale-managed-npm-plugins" },
    { id: "config-repairs.plugin-host-links" },
    // Auth profile store repairs write SQLite and archive JSON.
    { id: "config-repairs.legacy-auth-profile-stores" },
    { id: "config-repairs.codex-routes", check: repairTransform("codex-routes") },
    {
      id: "config-repairs.context-engine-plugin-id",
      check: repairTransform("context-engine-plugin-id"),
    },
    // Instantiates the configured context engine.
    { id: "config-repairs.context-engine-host-compat" },
    // Installs packages and takes the plugin lifecycle lease.
    { id: "config-repairs.missing-plugin-installs" },
    {
      id: "config-repairs.stale-plugin-config",
      check: decideStage(async (chain) => {
        const gate = await packageSwapGate();
        if (gate) {
          return { pending: gate };
        }
        const { repairDoctorStalePluginConfig } =
          await import("./doctor/shared/config-transforms.js");
        const result = chain.runWithPluginMetadata(chain.candidate, () =>
          repairDoctorStalePluginConfig(chain.candidate, env, chain.installedPluginPreserveIds),
        );
        return { pending: decideResult(result), result };
      }),
    },
    ...(
      [
        "invalid-plugin-config",
        "allowlist-policy-allow-from",
        "open-policy-allow-from",
        "group-allow-from-fallback",
        "stale-subagent-allowlists",
        "exec-safe-bins",
      ] as const
    ).map((id) => ({ id: `config-repairs.${id}`, check: repairTransform(id) })),
    // State and auth store repairs without a read-only predicate yet.
    { id: "config-repairs.tailscale-profile-identities" },
    { id: "config-repairs.gateway-owner-profile" },
    { id: "config-repairs.plugin-runtime-symlinks" },
    { id: "config-repairs.oauth-profile-shadows" },
    { id: "config-repairs.auth-profile-migration" },
    { id: "config-repairs.stale-auth-orders" },
    {
      id: "config-repairs.model-replacements",
      check: decideStage(async () => ({
        pending: params.modelReplacements?.length ? "work" : "none",
      })),
    },
    // Reads the auth store and external CLI credentials.
    { id: "config-repairs.implicit-openai-primary" },
    {
      id: "config-repairs.stale-agent-model-refs",
      check: decideStage(async (chain) => {
        const gate = await packageSwapGate();
        if (gate) {
          return { pending: gate };
        }
        const { repairStaleAgentModelRefs } =
          await import("./doctor/shared/stale-agent-model-ref-repair.js");
        const result = inScope(chain, () =>
          repairStaleAgentModelRefs(chain.candidate, {
            modelReplacements: params.modelReplacements,
            env,
          }),
        );
        return { pending: decideResult(result), result };
      }),
    },
    {
      // Records a deferred model retirement in the update run during a package swap.
      id: "config-repairs.model-retirement-deferral",
      check: decideStage(async () => ({ pending: (await packageSwapGate()) ?? "none" })),
    },
    // Retires heartbeat data in the cron store and agent databases on every pass.
    { id: "config-repairs.heartbeat-retirement" },
    {
      id: "config-repairs.unknown-config-keys",
      check: decideStage(async (chain) => {
        const { stripDoctorUnknownConfigKeys } =
          await import("./doctor/shared/config-flow-steps.js");
        const unknown = stripDoctorUnknownConfigKeys(chain.candidate, chain.snapshot.sourceConfig);
        return { pending: unknown.removed.length > 0 ? "work" : "none" };
      }),
    },
  ];
}
