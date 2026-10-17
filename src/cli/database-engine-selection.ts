import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { getFlagValue, hasFlag } from "./argv.js";
import { resolveCliDatabaseProcessRole } from "./database-process-role.js";

const OWNED_DATABASE_SELECTION = new Set([
  // The process role includes embedded Gateways; final-target admission owns selection.
  "gateway",
  // These commands use no operator database.
  "help",
  "completion *",
  "docs *",
  "logs *",
  "channels logs",
  "config file",
  // Source validation owns its parse report before selecting installed-plugin state.
  "config validate",
  // RPC owners defer local state until device auth or config fallback needs it.
  "gateway call",
  "gateway health",
  "gateway suspend",
  "gateway resume",
  "gateway usage-cost",
  "gateway stability",
  "channels status",
  "agent remote",
  "cron *",
  "automations *",
  "devices *",
  "nodes status",
  "nodes list",
  "nodes describe",
  "nodes pending",
  "nodes approve",
  "nodes reject",
  "nodes remove",
  "nodes rename",
  "nodes invoke",
  "nodes notify",
  "nodes push",
  "nodes camera",
  "nodes screen",
  "nodes location",
  "secrets reload",
  "approvals pending",
  "exec-approvals pending",
  // Bundled memory commands select under their configured offline/Gateway owner.
  "memory",
  "memory status",
  "memory index",
  "memory reset",
  "memory search",
  "memory forget",
  "memory promote",
  "memory promote-explain",
  "memory rem-harness",
  "memory rem-backfill",
  "memory session-backfill",
  // Installed-service control retains its lifecycle owner's invalid-config recovery.
  "gateway restart",
  "daemon restart",
  "node restart",
  "gateway stop",
  "daemon stop",
  "gateway uninstall",
  "daemon uninstall",
  "node stop",
  "node uninstall",
  "node status",
  // Discovery and runtime-intent status inspect configuration/services without state.
  "gateway discover",
  "gateway runtime-intent",
  "daemon runtime-intent",
  // QA and database tooling select explicit fixtures or storage paths.
  "qa *",
  "database *",
  // Agent execution selects its own backend; package authoring selects a target package.
  "agent exec",
  "plugins build",
  "plugins validate",
  "plugins init",
  "claws create",
  "claws validate",
  "claws build",
  "claws dev",
  // Mutation parsing preserves DSN-only repair; other edits select under offline custody.
  "config set",
  "config patch",
  "config unset",
  // Explicit config-free cleanup leaves destructive scope selection with its owner.
  "reset config",
  "uninstall service",
  // Doctor's explicit store and updater receipt own their target; post-upgrade probes use no DB.
  "doctor explicit-store",
  "doctor update",
  "doctor post-upgrade",
  // Updater contexts, receipts and explicit paths own admission; cleanup reads no config.
  "update *",
]);

/** Select storage before stateful startup; true means Doctor completed a no-database report. */
export async function prepareCliDatabaseEngine(argv: string[]): Promise<boolean> {
  const invocation = resolveCliArgvInvocation(argv);
  let command = invocation.hasHelpOrVersion
    ? "help"
    : resolveCliDatabaseProcessRole(argv) === "gateway"
      ? "gateway"
      : invocation.commandPath.slice(0, 2).join(" ");
  if (
    invocation.primary === "agent" &&
    invocation.commandPath[1] !== "exec" &&
    !hasFlag(argv, "--local")
  ) {
    command = "agent remote";
  }
  if (
    ["gateway status", "daemon status"].includes(command) &&
    hasFlag(argv, "--runtime-intent-only")
  ) {
    command = `${invocation.primary} runtime-intent`;
  }
  if (invocation.primary === "reset" && getFlagValue(argv, "--scope") === "config") {
    command = "reset config";
  }
  if (
    invocation.primary === "uninstall" &&
    hasFlag(argv, "--service") &&
    !["--all", "--state", "--workspace"].some((flag) => hasFlag(argv, flag))
  ) {
    command = "uninstall service";
  }
  if (invocation.primary === "doctor" && !invocation.hasHelpOrVersion) {
    if (hasFlag(argv, "--session-sqlite-store")) {
      command = "doctor explicit-store";
    } else if (process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH?.trim()) {
      command = "doctor update";
    } else if (hasFlag(argv, "--post-upgrade")) {
      command = "doctor post-upgrade";
    }
  }
  if (
    OWNED_DATABASE_SELECTION.has(command) ||
    OWNED_DATABASE_SELECTION.has(`${invocation.primary} *`)
  ) {
    return false;
  }
  const { readConfigSnapshotBeforeEngineSelection } =
    await import("../commands/config-preflight-snapshot.js");
  const readSnapshot = () =>
    readConfigSnapshotBeforeEngineSelection(process.env, { isolateEnv: false });
  let snapshot = await readSnapshot();
  let doctorRecovery = false;
  const {
    createConfigReadError,
    createInvalidConfigError,
    formatInvalidConfigDetails,
    isConfigReadFailure,
  } = await import("../config/io.invalid-config.js");
  if (
    invocation.primary === "doctor" &&
    snapshot.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID")
  ) {
    doctorRecovery = true;
    const { prepareDoctorEngineSelection, reportDoctorUnresolvedEngine } =
      await import("../commands/doctor-engine-selection.js");
    try {
      snapshot = await prepareDoctorEngineSelection({ argv, snapshot, readSnapshot });
    } catch (error) {
      reportDoctorUnresolvedEngine(snapshot, argv, error);
      return true;
    }
    if (
      isConfigReadFailure(snapshot) ||
      snapshot.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID")
    ) {
      reportDoctorUnresolvedEngine(snapshot, argv);
      return true;
    }
  }
  if (isConfigReadFailure(snapshot)) {
    throw createConfigReadError(snapshot);
  }
  // Keep malformed source classified so the root CLI prints its unreported diagnostics.
  if (snapshot.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID")) {
    throw createInvalidConfigError(snapshot.path, formatInvalidConfigDetails(snapshot.issues));
  }
  const [{ resolveDatabaseEngineSelection }, { installDatabaseEngineSelection }] =
    await Promise.all([
      import("../infra/database-engine/config.js"),
      import("../infra/database-engine/context.js"),
    ]);
  try {
    installDatabaseEngineSelection(
      await resolveDatabaseEngineSelection(snapshot.config, process.env),
    );
  } catch (error) {
    if (!doctorRecovery) {
      throw error;
    }
    const { reportDoctorUnresolvedEngine } = await import("../commands/doctor-engine-selection.js");
    reportDoctorUnresolvedEngine(snapshot, argv, error);
    return true;
  }
  const [{ pinRuntimePaths }, { pinConfigDir }] = await Promise.all([
    import("../config/paths.js"),
    import("../utils.js"),
  ]);
  pinRuntimePaths(process.env);
  pinConfigDir(process.env);
  return false;
}
