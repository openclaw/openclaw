import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "../infra/state-migrations.media-persistence-targets.js";
import type {
  DoctorMaintenancePending,
  DoctorMaintenancePendingCheck,
} from "./doctor-maintenance-pending.js";

export type DoctorConfigFlowPendingParams = {
  env: NodeJS.ProcessEnv;
  integrityCheck: "quick" | "full";
  /** The database preflight's discovery, which the flow hands to its agent database pass. */
  agentDatabaseMigrationDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
};

type DoctorConfigFlowPendingInput = { id: string; check?: DoctorMaintenancePendingCheck };

const decided = (work: boolean): DoctorMaintenancePending => (work ? "work" : "none");

/**
 * The owners whose work `doctor.config-flow` runs inside the stop, in the order the flow
 * reaches them. Each check calls its owner's own predicate on a config snapshot read once
 * without observation; an input without a check has work.
 */
function doctorConfigFlowPendingInputs(
  params: DoctorConfigFlowPendingParams,
): ReadonlyArray<DoctorConfigFlowPendingInput> {
  const env = params.env;
  let snapshotRead: Promise<ConfigFileSnapshot> | undefined;
  const readSnapshot = () =>
    (snapshotRead ??= import("../config/io.factory.js").then(({ createConfigIO }) =>
      createConfigIO({ env, observe: false }).readConfigFileSnapshot({ observe: false }),
    ));
  // The configs the preflight passes to its state migrations, or undefined when it cannot.
  const readMigrationInput = async () => {
    const snapshot = await readSnapshot();
    const { resolveStateMigrationConfigInput } =
      await import("./doctor/shared/legacy-config-state-migration-input.js");
    const input = resolveStateMigrationConfigInput({
      snapshot,
      baseConfig: snapshot.sourceConfig ?? snapshot.config ?? {},
    });
    return input?.cfg ? { ...input, cfg: input.cfg, snapshot } : undefined;
  };
  const stateDatabase = async () =>
    (await import("../state/openclaw-state-db.paths.js")).resolveOpenClawStateSqlitePath(env);
  const agentDatabases = () =>
    params.agentDatabaseMigrationDiscovery?.discovery.targets.map((target) => target.realPath) ??
    [];
  // Every SQLite read decides only while a connection holds each store it reads.
  const decideLive = async (
    stores: readonly string[],
    decide: () => DoctorMaintenancePending | Promise<DoctorMaintenancePending>,
  ) => {
    const { decideDoctorPendingFromLiveStores } = await import("./doctor-live-store-pending.js");
    return decideDoctorPendingFromLiveStores([await stateDatabase(), ...stores], decide);
  };
  // Beside the agent stores a config's session scanners open; listing them reads the
  // registry, so it runs inside the state database's guard.
  const decideWithAgentStores = (
    cfg: OpenClawConfig,
    stores: readonly string[],
    decide: () => DoctorMaintenancePending | Promise<DoctorMaintenancePending>,
  ) =>
    decideLive(agentDatabases(), async () => {
      const [{ listExistingAgentDatabaseTargets }, { decideDoctorPendingFromLiveStores }] =
        await Promise.all([
          import("../infra/session-sqlite-migration-readers.js"),
          import("./doctor-live-store-pending.js"),
        ]);
      return decideDoctorPendingFromLiveStores(
        [
          ...stores,
          ...listExistingAgentDatabaseTargets(cfg, env).map((target) => target.sqlitePath),
        ],
        decide,
      );
    });
  const withMigrationConfig = async (
    decide: (
      input: NonNullable<Awaited<ReturnType<typeof readMigrationInput>>>,
    ) => Promise<DoctorMaintenancePending>,
  ) => {
    const input = await readMigrationInput();
    // Config the state migrations cannot use takes the preflight's other paths.
    return input ? decide(input) : "undecidable";
  };
  return [
    {
      // The `r+` writability probe writes nothing; orphaned sidecars are quarantined and an
      // existing database's modes are hardened.
      id: "state-write-admission",
      check: async () => {
        const [{ existsSync }, { hasOrphanedSqliteSidecars }, { hasOpenClawStatePermissionDrift }] =
          await Promise.all([
            import("node:fs"),
            import("../infra/sqlite-files.js"),
            import("../state/openclaw-state-db-permissions.js"),
          ]);
        const databasePath = await stateDatabase();
        return decided(
          hasOrphanedSqliteSidecars(databasePath) ||
            (existsSync(databasePath) && hasOpenClawStatePermissionDrift(databasePath, env)),
        );
      },
    },
    {
      id: "legacy-state-dir",
      check: async () => {
        const { resolvePendingLegacyStateDirMigrationPaths } =
          await import("../infra/state-migrations.state-dir.js");
        return decided(Boolean(resolvePendingLegacyStateDirMigrationPaths({ env })));
      },
    },
    {
      // The legacy file name, legacy or invalid shapes, and the automatic repair the
      // preflight commits to `openclaw.json`.
      id: "legacy-config",
      check: async () => {
        const { hasDoctorConfigRecoveryWork, hasPendingLegacyDoctorConfigFile } =
          await import("./doctor-config-preflight-legacy-config.js");
        if (await hasPendingLegacyDoctorConfigFile(env)) {
          return "work";
        }
        const snapshot = await readSnapshot();
        if (!snapshot.exists) {
          return "none";
        }
        if (!snapshot.valid || snapshot.legacyIssues.length > 0) {
          return "work";
        }
        const { canPlanAutomaticConfigRepair, planAutomaticConfigRepair } =
          await import("./doctor/shared/automatic-config-repair.js");
        if (
          canPlanAutomaticConfigRepair(snapshot) &&
          (await planAutomaticConfigRepair(snapshot)) !== null
        ) {
          return "work";
        }
        // A suspicious valid config is restored from its backup before any other repair.
        return decideLive([], async () => decided(await hasDoctorConfigRecoveryWork(snapshot)));
      },
    },
    {
      id: "state-schema",
      check: async () => {
        const { planOpenClawStateDatabaseDoctorRepair } =
          await import("../state/openclaw-state-db-doctor-repair-plan.js");
        return (await planOpenClawStateDatabaseDoctorRepair(params)).decision;
      },
    },
    {
      id: "retired-state",
      check: async () => {
        const { hasRetiredDoctorStateWork } = await import("./doctor-retired-state-repair.js");
        return decided(hasRetiredDoctorStateWork(env));
      },
    },
    {
      id: "session-entry-state",
      check: () =>
        withMigrationConfig(async ({ cfg }) => {
          const { repairLegacySessionEntryStates } =
            await import("./doctor-session-delivery-state.js");
          return decideWithAgentStores(cfg, [], async () => {
            const report = await repairLegacySessionEntryStates({ apply: false, cfg, env });
            return report.warnings?.length ? "undecidable" : decided(report.found > 0);
          });
        }),
    },
    {
      // Package installs, repairs and payload checks run whenever the plan requires them.
      id: "plugin-convergence",
      check: async () => {
        const snapshot = await readSnapshot();
        const { planStartupPluginConvergence } =
          await import("./doctor/shared/startup-plugin-convergence-plan.js");
        return decideLive([], async () =>
          decided(
            (
              await planStartupPluginConvergence({
                config: snapshot.sourceConfig ?? snapshot.config ?? {},
                env,
              })
            ).required,
          ),
        );
      },
    },
    {
      id: "plugin-obligations",
      check: async () => {
        const snapshot = await readSnapshot();
        const { checkDeferredPluginObligationsPending } =
          await import("./doctor-config-preflight-plugin-migrations.js");
        return decideLive([], () =>
          checkDeferredPluginObligationsPending({
            // Without a config file only the recorded obligations decide.
            cfg: snapshot.exists ? (snapshot.sourceConfig ?? {}) : undefined,
            env,
          }),
        );
      },
    },
    {
      id: "cron",
      check: () =>
        withMigrationConfig(async ({ cfg, pluginDoctorConfig, snapshot }) => {
          const [{ checkDoctorPreflightCronPending }, { withLegacyConfig }] = await Promise.all([
            import("./doctor/cron/legacy-repair.js"),
            import("./doctor-config-preflight.cron.js"),
          ]);
          const selectionConfig: OpenClawConfig =
            snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig ?? cfg;
          return decideWithAgentStores(cfg, [], () =>
            checkDoctorPreflightCronPending({
              selectionConfig,
              repairConfig: withLegacyConfig(cfg, pluginDoctorConfig),
              migrationConfig: cfg,
              env,
            }),
          );
        }),
    },
    {
      // The migration graph's own detection, including plugin `detectLegacyState` previews
      // and the legacy exec approvals.
      id: "legacy-state-detection",
      check: () =>
        withMigrationConfig(async (input) => {
          const [
            { detectLegacyStateMigrations },
            { prepareLegacySessionSurfaces },
            { resolveClientCredentialStorePath },
          ] = await Promise.all([
            import("../infra/state-migrations.doctor.js"),
            import("../plugins/legacy-session-surfaces.js"),
            import("../infra/client-credential-paths.js"),
          ]);
          return decideWithAgentStores(
            input.cfg,
            [resolveClientCredentialStorePath(env)],
            async () => {
              const legacySessionSurfaces = await prepareLegacySessionSurfaces({
                config: input.cfg,
                env,
              });
              if (legacySessionSurfaces.failures.length > 0) {
                return "undecidable";
              }
              const detected = await detectLegacyStateMigrations({
                cfg: input.cfg,
                sourceConfigBeforeMigrations: input.sourceConfigBeforeMigrations,
                ...(input.pluginDoctorConfig
                  ? { pluginDoctorConfig: input.pluginDoctorConfig }
                  : {}),
                mode: "doctor",
                env,
                doctorOnlyStateMigrations: true,
                legacySessionSurfaces,
              });
              if (detected.warnings.length > 0 && detected.warningDisposition !== "recoverable") {
                return "undecidable";
              }
              return decided(detected.preview.length > 0);
            },
          );
        }),
    },
    {
      id: "agent-databases",
      check: async () => {
        const discovery = params.agentDatabaseMigrationDiscovery;
        if (!discovery) {
          return "undecidable";
        }
        const { planAgentDatabaseMigration } =
          await import("../infra/state-migrations.agent-database-plan.js");
        return decideLive(
          agentDatabases(),
          async () =>
            (
              await planAgentDatabaseMigration({
                env,
                configuredAgentDatabaseTargets: discovery.configuredAgentDatabaseTargets,
                preparedDiscovery: discovery,
                integrityCheck: params.integrityCheck,
              })
            ).pending,
        );
      },
    },
    // Graph steps that run on every Doctor pass and decide inside their writers: delivery
    // queue entries, workspace aliases, Skill Workshop proposals, ACP session metadata,
    // orphan session keys, transcript directives, config machine state and the shared auth
    // store. They have no read-only predicate yet.
    { id: "legacy-state-steps" },
    {
      id: "a2ui-widgets",
      check: () =>
        withMigrationConfig(async ({ cfg }) => {
          const { checkDoctorA2uiWidgetsPending } = await import("./doctor-a2ui-widgets.js");
          return decideWithAgentStores(cfg, [], () => checkDoctorA2uiWidgetsPending({ cfg, env }));
        }),
    },
    {
      id: "relative-session-stores",
      check: () =>
        withMigrationConfig(async ({ cfg }) => {
          const { checkRelativeSessionStoresPending } =
            await import("./doctor-relative-session-store.js");
          return decideLive([], () =>
            checkRelativeSessionStoresPending({
              cfg,
              env,
              registeredDatabases: params.agentDatabaseMigrationDiscovery?.registeredAgentDatabases,
            }),
          );
        }),
    },
    // Interrupted update reconciliation, the config repair sequence, channel Doctor
    // sequences and the system agent's workspace files have no read-only predicate yet.
    { id: "update-history" },
    { id: "config-repairs" },
  ];
}

function combinePending(answers: readonly DoctorMaintenancePending[]): DoctorMaintenancePending {
  return answers.includes("work")
    ? "work"
    : answers.includes("undecidable")
      ? "undecidable"
      : "none";
}

/**
 * Traces each input as `config-flow.<id>` (`check=default` without a check), then the step
 * from their answers: none only when every input answers none. `trace` is Doctor's
 * maintenance tracer.
 */
export async function traceConfigFlowPendingInputs(
  trace: (step: string, check?: DoctorMaintenancePendingCheck) => Promise<boolean> | undefined,
  params: DoctorConfigFlowPendingParams,
): Promise<void> {
  const answers: DoctorMaintenancePending[] = [];
  for (const input of doctorConfigFlowPendingInputs(params)) {
    const check = input.check;
    let answer: DoctorMaintenancePending = "work";
    await trace(
      `config-flow.${input.id}`,
      check &&
        (async () => {
          try {
            answer = await check();
          } catch {
            answer = "undecidable";
          }
          return answer;
        }),
    );
    answers.push(answer);
  }
  await trace("config-flow", () => combinePending(answers));
}
