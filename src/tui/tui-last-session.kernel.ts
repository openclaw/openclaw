import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import {
  readConfigMachineStateRowInDatabase,
  type ConfigMachineStateDatabase,
} from "../state/config-machine-state.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
} from "../state/openclaw-state-read.types.js";
import { TUI_LAST_SESSION_STATE_KEY_PREFIX } from "./tui-last-session.contract.js";

function listRetiredTuiPointersInDatabase(
  database: DatabaseSync,
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
  database: DatabaseSync,
  command: Extract<OpenClawStateReadCommand, { type: "tui.lastSession.read" }>,
): Extract<OpenClawStateReadReply, { type: "tui.lastSession.read" }> {
  return {
    ok: true,
    type: command.type,
    sourceAdmitted: true,
    row: readConfigMachineStateRowInDatabase(database, command.stateKey),
  };
}
