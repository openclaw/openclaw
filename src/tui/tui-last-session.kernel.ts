import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  updateConfigMachineState,
  writeConfigMachineState,
} from "../state/config-machine-state-write.js";
import {
  readConfigMachineStateRowInDatabase,
  type ConfigMachineStateDatabase,
} from "../state/config-machine-state.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateReadCommand } from "../state/openclaw-state-read.types.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import {
  TUI_LAST_SESSION_STATE_KEY_PREFIX,
  type TuiLastSessionWorkerOperations,
} from "./tui-last-session.contract.js";

export const tuiLastSessionOperations = {
  "tui.lastSession.write": (
    input: TuiLastSessionWorkerOperations["tui.lastSession.write"]["input"],
    context: WorkerWriteOperationContext,
  ) =>
    writeConfigMachineState(
      `${TUI_LAST_SESSION_STATE_KEY_PREFIX}${input.scopeKey}`,
      input.sessionKey,
      { ...context.stateOptions(), database: context.open() },
    ),
  "tui.lastSession.clear": (
    input: TuiLastSessionWorkerOperations["tui.lastSession.clear"]["input"],
    context: WorkerWriteOperationContext,
  ) =>
    clearRetiredTuiPointers(
      new Set(input.retiredSessionKeys),
      context.stateOptions(),
      context.open,
    ),
};

function listRetiredTuiPointersInDatabase(
  database: EngineConnection,
  retiredSessionKeys: ReadonlySet<string>,
): string[] {
  const rows = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<ConfigMachineStateDatabase>(database)
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json"])
      .where("state_key", "like", `${TUI_LAST_SESSION_STATE_KEY_PREFIX}%`),
  ).rows;
  return rows.flatMap((row) => {
    const sessionKey: unknown = JSON.parse(row.value_json);
    return typeof sessionKey === "string" && retiredSessionKeys.has(sessionKey)
      ? [row.state_key]
      : [];
  });
}

export function clearRetiredTuiPointers(
  retiredSessionKeys: ReadonlySet<string>,
  options: OpenClawStateDatabaseOptions,
  open: () => OpenClawStateDatabase,
): number {
  const stateKeys = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => listRetiredTuiPointersInDatabase(db, retiredSessionKeys),
    options,
  );
  if (!stateKeys?.length) {
    return 0;
  }
  const writeOptions = { ...options, database: open() };
  let cleared = 0;
  for (const stateKey of stateKeys) {
    // Recheck inside each write transaction: a replacement after the scan must survive.
    updateConfigMachineState<string>(
      stateKey,
      (current) => {
        if (typeof current === "string" && retiredSessionKeys.has(current)) {
          cleared += 1;
          return undefined;
        }
        return current;
      },
      writeOptions,
    );
  }
  return cleared;
}

export function readTuiLastSessionCommand(
  database: EngineConnection,
  command: Extract<OpenClawStateReadCommand, { type: "tui.lastSession.read" }>,
) {
  return {
    ok: true as const,
    type: command.type,
    sourceAdmitted: true as const,
    row: readConfigMachineStateRowInDatabase(database, command.stateKey),
  };
}
