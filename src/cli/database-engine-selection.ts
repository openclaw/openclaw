import { resolveCliArgvInvocation } from "./argv-invocation.js";
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
  // Updater contexts, receipts and explicit paths own admission; cleanup reads no config.
  "update admit",
  "update migrate",
  "update restore",
  "update finish",
  "update recover",
  "update adopt-immutable",
  "update cleanup",
]);

/** Select operator storage after CLI routing and dotenv, before stateful startup. */
export async function prepareCliDatabaseEngine(argv: string[]): Promise<void> {
  const invocation = resolveCliArgvInvocation(argv);
  const command = invocation.hasHelpOrVersion
    ? "help"
    : resolveCliDatabaseProcessRole(argv) === "gateway"
      ? "gateway"
      : invocation.commandPath.slice(0, 2).join(" ");
  if (
    OWNED_DATABASE_SELECTION.has(command) ||
    OWNED_DATABASE_SELECTION.has(`${invocation.primary} *`)
  ) {
    return;
  }
  const { readConfigSnapshotForEngineSelection } =
    await import("../commands/config-preflight-snapshot.js");
  const snapshot = await readConfigSnapshotForEngineSelection(process.env, { isolateEnv: false });
  const { createConfigReadError, isConfigReadFailure } =
    await import("../config/io.invalid-config.js");
  if (
    isConfigReadFailure(snapshot) ||
    snapshot.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID")
  ) {
    throw createConfigReadError(snapshot);
  }
  const [{ pinRuntimePaths }, { pinConfigDir }] = await Promise.all([
    import("../config/paths.js"),
    import("../utils.js"),
  ]);
  pinRuntimePaths(process.env);
  pinConfigDir(process.env);
}
