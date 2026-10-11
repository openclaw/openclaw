import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import type { GitHubPublicationSourceRead } from "./github-publication-source-contract.js";
import { readGitHubPublicationSourceFacts } from "./github-publication-source.kernel.js";

/** Source handles belong to one command. */
export function createGitHubPublicationSourceWorker() {
  let source: DatabaseSync | undefined;
  let current: GitHubPublicationSourceRead | undefined;
  let destination: DatabaseSync | undefined;
  const close = () => {
    if (source?.isOpen) {
      if (source.isTransaction) {
        throw new Error("GitHub publication source remains reserved.");
      }
      source.close();
    }
    source = undefined;
    current = undefined;
    destination = undefined;
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
    close,
  };
}
