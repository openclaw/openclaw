import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasFlag } from "./argv.js";
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
  // QA and database tooling select explicit fixtures or storage paths.
  "qa *",
  "database *",
  // Agent execution selects its own backend; package authoring selects a target package.
  "agent exec",
  "plugins build",
  "plugins validate",
  "plugins init",
  // Mutation parsing preserves DSN-only repair; other edits select under offline custody.
  "config set",
  "config patch",
  "config unset",
  // Doctor's explicit store and updater receipt own their target; post-upgrade probes use no DB.
  "doctor explicit-store",
  "doctor update",
  "doctor post-upgrade",
  // Updater contexts, receipts and explicit paths own admission; cleanup reads no config.
  "update admit",
  "update migrate",
  "update restore",
  "update finish",
  "update recover",
  "update adopt-immutable",
  "update cleanup",
]);

/** Select storage before stateful startup; true means Doctor completed a no-database report. */
export async function prepareCliDatabaseEngine(argv: string[]): Promise<boolean> {
  const invocation = resolveCliArgvInvocation(argv);
  let command = invocation.hasHelpOrVersion
    ? "help"
    : resolveCliDatabaseProcessRole(argv) === "gateway"
      ? "gateway"
      : invocation.commandPath.slice(0, 2).join(" ");
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
  const { createConfigReadError, isConfigReadFailure } =
    await import("../config/io.invalid-config.js");
  if (
    invocation.primary === "doctor" &&
    snapshot.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID")
  ) {
    const { parseConfigJson5 } = await import("../config/io.js");
    if (typeof snapshot.raw === "string" && !parseConfigJson5(snapshot.raw).ok) {
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
  }
  if (
    isConfigReadFailure(snapshot) ||
    snapshot.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID")
  ) {
    throw createConfigReadError(snapshot);
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
