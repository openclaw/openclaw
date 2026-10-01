import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import {
  readConfigMachineStateRowInDatabase,
  type ConfigMachineStateDatabase,
} from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
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
  stateKeys: readonly string[],
  retiredSessionKeys: ReadonlySet<string>,
  options: OpenClawStateDatabaseOptions,
): number {
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
      options,
    );
  }
  return cleared;
}

export function readTuiLastSessionCommand(
  database: DatabaseSync,
  command: Extract<
    OpenClawStateReadCommand,
    { type: "tui.lastSession.read" | "tui.lastSession.retiredPointers" }
  >,
): Extract<
  OpenClawStateReadReply,
  { type: "tui.lastSession.read" | "tui.lastSession.retiredPointers" }
> {
  return command.type === "tui.lastSession.read"
    ? {
        ok: true,
        type: command.type,
        sourceAdmitted: true,
        row: readConfigMachineStateRowInDatabase(database, command.stateKey),
      }
    : {
        ok: true,
        type: command.type,
        sourceAdmitted: true,
        stateKeys: listRetiredTuiPointersInDatabase(database, new Set(command.retiredSessionKeys)),
      };
}
