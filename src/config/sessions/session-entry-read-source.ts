import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentity,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import {
  assertOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { captureOpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import type {
  PreparedSessionEntryWorkerRead,
  SessionEntryReadSourcePreparation,
} from "./session-entry-read-runtime.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionStoreReadCustody } from "./session-store-read-candidates.js";

/** Qualify once; the retained reader carries its physical witness to native read admission. */
export async function prepareSessionEntryReadSource(
  database: PreparedSessionEntryWorkerRead["database"],
  readCustody: SessionStoreReadCustody,
  options: {
    inspection: boolean;
    capturePhysicalSource: boolean;
    prepareSource?: SessionEntryReadSourcePreparation;
  },
) {
  const capture = options.prepareSource || options.capturePhysicalSource;
  let validation =
    !options.inspection && capture
      ? await captureOpenClawAgentDatabaseReadValidation(database)
      : undefined;
  const validationIdentity = (current: NonNullable<typeof validation>): DatabasePathIdentity => ({
    key: `file:${current.validation.identity}`,
    canonicalPath: current.canonicalPath,
    birthtime: current.validation.birthtime,
  });
  let identity =
    readCustody.candidates.find(
      (candidate) => candidate.identity && candidate.physicalPath === database.path,
    )?.identity ??
    (validation
      ? validationIdentity(validation)
      : capture
        ? await readDatabasePathIdentity(database.path)
        : undefined);
  const selected = identity && { path: database.path, physicalPath: database.path, identity };
  const custody = selected
    ? [readCustody, { sourcePath: database.path, candidates: [selected] }]
    : [readCustody];
  let prepared = false;
  return {
    get identity() {
      return identity;
    },
    readCustody: custody,
    assertCurrent: () => validation?.assertCurrent(),
    async prepareRead(this: void, current: typeof validation) {
      if (
        current &&
        identity?.key.startsWith("file:") &&
        (`file:${current.validation.identity}` !== identity.key ||
          current.validation.birthtime !== identity.birthtime)
      ) {
        throw new Error("Session entry read changed its captured physical owner");
      }
      validation ??= current;
      if (prepared || !identity) {
        return;
      }
      // An absent source binds the file created by the writer ahead of its FIFO turn.
      if (!options.inspection && identity.birthtime === undefined) {
        identity = validation
          ? validationIdentity(validation)
          : await readDatabasePathIdentity(database.path);
        if (selected) {
          selected.identity = identity;
        }
      }
      options.prepareSource?.(database, identity);
      prepared = true;
    },
  };
}

export function captureSessionEntryReadSource(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  expectedIdentity: DatabasePathIdentity | undefined,
  unavailableMessage = "Session entry read requires its current durable owner",
) {
  if (expectedIdentity) {
    assertOpenClawAgentDatabaseIdentity(database, expectedIdentity);
  }
  const identity = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity.identity !== "string" || !isOpenClawAgentDatabasePathCurrent(database)) {
    throw new Error(unavailableMessage);
  }
  return {
    agentId: database.agentId,
    path: database.path,
    databaseIdentity: identity.identity,
    databaseBirthtime: identity.birthtime,
  };
}

export function assertCapturedSessionEntryReadSource(
  source: CapturedSessionEntryReadSource,
  database?: Pick<OpenClawAgentDatabase, "agentId" | "path" | "db">,
): void {
  if (typeof source.databaseIdentity === "string" && (!database || database.path !== source.path)) {
    assertExistingDatabaseIdentity(
      source.path,
      `file:${source.databaseIdentity}`,
      source.databaseBirthtime,
    );
  }
  if (!database) {
    if (typeof source.databaseIdentity === "symbol") {
      throw new Error("Captured session database is no longer open");
    }
    return;
  }
  const physical = readOpenClawAgentDatabaseIdentity(database);
  if (
    database.agentId !== source.agentId ||
    physical.identity !== source.databaseIdentity ||
    physical.birthtime !== source.databaseBirthtime ||
    !isOpenClawAgentDatabasePathCurrent(database)
  ) {
    throw new Error("Captured session database changed before read");
  }
}
