import { listAgentIds } from "../agents/agent-scope-config.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { readResidentSessionRow } from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";

type ResidentInputs = Parameters<typeof readResidentSessionRow>[0];

export function createSessionRowAcquisition(owner: {
  state: () => Omit<
    ResidentInputs,
    | "row"
    | "configuredAgentIds"
    | "links"
    | "readSourceEntry"
    | "databaseFacts"
    | "repositoryWorkspace"
  >;
  rows: ReadonlyMap<string, records.Row>;
  membership: (row: records.Row) => Iterable<string>;
  readChildLinks: (row: records.Row, prepared: boolean) => ResidentInputs["links"];
  readSourceEntry: (row: records.Row, key: string, prepared: boolean) => records.Row["storedEntry"];
  registerPlacement: (sessionId: string) => void;
  materializedRevisions: () => Pick<records.Row, "profileRevision" | "subagentRevision">;
  publish: (row: records.Row, previousBoard: records.Row["hasBoard"]) => void;
}) {
  let materializedCount = 0;
  function materialize(
    row: records.Row,
    configuredAgentIds?: Set<string>,
    readRow = readResidentSessionRow,
    databaseFacts?: records.PreparedSessionRowDatabaseFacts,
    repositoryWorkspace?: ResidentInputs["repositoryWorkspace"],
  ) {
    const agentIds = configuredAgentIds ?? new Set(listAgentIds(owner.state().cfg));
    if (!row.entry) {
      return false;
    }
    const links = owner.readChildLinks(row, databaseFacts !== undefined);
    if (!isIncognitoSessionKey(row.key)) {
      row.membership = new Set(owner.membership(row));
    }
    const prepared = readRow({
      ...owner.state(),
      row: { ...row, entry: row.entry },
      configuredAgentIds: agentIds,
      links,
      readSourceEntry: (key) => owner.readSourceEntry(row, key, databaseFacts !== undefined),
      databaseFacts,
      repositoryWorkspace,
    });
    if (!isIncognitoSessionKey(row.key) && owner.rows.get(records.identity(row)) !== row) {
      return false;
    }
    if (!isIncognitoSessionKey(row.key)) {
      owner.registerPlacement(row.entry.sessionId);
    }
    const previousBoard = row.hasBoard;
    Object.assign(row, prepared, {
      materializedSequence: ++materializedCount,
      ...owner.materializedRevisions(),
    });
    owner.publish(row, previousBoard);
    return true;
  }
  return {
    materialize,
    get materializedCount() {
      return materializedCount;
    },
  };
}
