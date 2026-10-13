import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import type { SqliteSourceFence } from "../infra/sqlite-source-fence-contract.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import type {
  GitHubPublicationSourcePredicate,
  GitHubPublicationSourceRead,
} from "./github-publication-source-contract.js";
import {
  assertGitHubPublicationSourceFacts,
  readGitHubPublicationSourceFacts,
} from "./github-publication-source.kernel.js";

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
    if (current !== input || !source?.isOpen || !destination?.isOpen) {
      throw new Error("GitHub publication source was not prepared.");
    }
    return { source, destination };
  };
  return {
    prepare(input: GitHubPublicationSourceRead, db: DatabaseSync) {
      close();
      const { physical } = input.source;
      assertExistingDatabaseIdentity(physical.canonicalPath, physical.key, physical.birthtime);
      source = openNodeSqliteDatabase(resolveExistingSqliteFileUri(physical.canonicalPath));
      current = input;
      destination = db;
    },
    read(input: GitHubPublicationSourceRead) {
      const handles = assertPrepared(input);
      return readGitHubPublicationSourceFacts(handles.source, handles.destination, input.selector);
    },
    fence(input: GitHubPublicationSourcePredicate): SqliteSourceFence {
      const handles = assertPrepared(input);
      let reservedSource: DatabaseSync | undefined;
      const destinationBinding = { database: handles.destination, identity: input.destination };
      const sourceBinding = { database: handles.source, identity: input.source };
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
