import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import type { SqliteSourceFence } from "../infra/sqlite-source-fence-contract.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type {
  GitHubPublicationSourcePredicate,
  GitHubPublicationSourceRead,
} from "./github-publication-source-contract.js";
import {
  assertGitHubPublicationSourceFacts,
  readGitHubPublicationSourceFacts,
} from "./github-publication-source.kernel.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";

const reservations = new WeakMap<DatabaseSync, () => void>();

/** The command's durable predicates have been checked while every source is reserved. */
export function assertGitHubPublicationWorkerSourceCurrent(db: DatabaseSync): void {
  const assertCurrent = reservations.get(db);
  if (!assertCurrent) {
    throw new Error("GitHub publication requires its reserved source authority.");
  }
  assertCurrent();
}

/** Source handles belong to one command and close only after its reservations settle. */
export function createGitHubPublicationSourceWorker() {
  let source: DatabaseSync | undefined;
  let current: GitHubPublicationSourceRead | undefined;
  let destination: DatabaseSync | undefined;
  let validated = false;
  const close = () => {
    if (destination) {
      reservations.delete(destination);
    }
    if (source?.isOpen) {
      if (source.isTransaction) {
        throw new Error("GitHub publication source remains reserved.");
      }
      source.close();
    }
    source = undefined;
    current = undefined;
    destination = undefined;
    validated = false;
  };
  const assertPrepared = (input: GitHubPublicationSourceRead) => {
    if (current !== input || (!input.memory && !source?.isOpen) || !destination?.isOpen) {
      throw new Error("GitHub publication source was not prepared.");
    }
    return { source: input.memory ?? source!, destination };
  };
  return {
    prepare(input: GitHubPublicationSourceRead, db: DatabaseSync) {
      close();
      if (input.source) {
        const { physical } = input.source;
        assertExistingDatabaseIdentity(physical.canonicalPath, physical.key, physical.birthtime);
        source = openNodeSqliteDatabase(resolveExistingSqliteFileUri(physical.canonicalPath));
      }
      current = input;
      destination = db;
    },
    read(input: GitHubPublicationSourceRead) {
      const handles = assertPrepared(input);
      return readGitHubPublicationSourceFacts(handles.source, handles.destination, input.selector);
    },
    fence(input: GitHubPublicationSourcePredicate): SqliteSourceFence | undefined {
      if (input.memory) {
        return undefined;
      }
      const handles = assertPrepared(input);
      if (!source) {
        throw new Error("GitHub publication source was not prepared.");
      }
      let reservedSource: DatabaseSync | undefined;
      const destinationBinding = { database: handles.destination, identity: input.destination };
      const sourceBinding = { database: source, identity: input.source };
      reservations.set(handles.destination, () => {
        if (!validated || !reservedSource?.isTransaction || !handles.destination.isTransaction) {
          throw new Error("GitHub publication source reservation is no longer current.");
        }
      });
      return {
        destination: destinationBinding,
        sources: [sourceBinding],
        validate(resolve) {
          reservedSource = resolve(sourceBinding);
          assertGitHubPublicationSourceFacts(
            reservedSource,
            handles.destination,
            input.selector,
            input.expected,
          );
          validated = true;
        },
      };
    },
    close,
  };
}

/** Policy callbacks run before the destination transaction because they may write SQLite. */
export function withGitHubPublicationSourceTransaction<T>(
  database: OpenClawStateDatabase,
  source: GitHubPublicationSourcePredicate,
  run: () => T,
): T {
  const memory = source.memory;
  if (!memory) {
    return run();
  }
  requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: undefined });
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertGitHubPublicationSourceFacts(memory, db, source.selector, source.expected);
      reservations.set(db, () => {
        if (!db.isTransaction) {
          throw new Error("GitHub publication destination transaction is no longer current.");
        }
      });
      try {
        return run();
      } finally {
        reservations.delete(db);
      }
    },
    { database },
  );
}
