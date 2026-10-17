import assert from "node:assert/strict";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { deferSqlitePostCommitPublication } from "./sqlite-post-commit.js";
import {
  SOURCE_FENCE_ACCEPTED,
  SQLITE_WORKER_SOURCE_FENCE,
  type SqliteSourceFence,
  type SqliteSourceFenceIdentity,
} from "./sqlite-source-fence-contract.js";
import type { SqliteWorkerPreparedBackend } from "./sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "./sqlite-worker-operation-admission.js";

export const FENCE_FIXTURE_ENV = "openclaw.test.sqliteSourceFence";

export type FenceFixtureInput = {
  destination: SqliteSourceFenceIdentity;
  source: SqliteSourceFenceIdentity;
  aliasPath?: string;
};

export type FenceFixtureCommand = {
  id: string;
  expectedRevision: number;
  barrier?: number;
  pause?: "validate" | "commit";
  sameStore?: boolean;
  alias?: boolean;
  fault?:
    | "kernel"
    | "before-commit-exit"
    | "after-commit-exit"
    | "reply"
    | "source-close"
    | "missing-receipt"
    | "host-admission"
    | "postcommit-revoke"
    | "source-rollback";
  observeRetry?: boolean;
};

export type FenceFixtureOperations = {
  persist: {
    input: FenceFixtureCommand;
    output: { id: string; revision: number; notifiedRevision?: number };
  };
};

type FixtureBackend = SqliteWorkerPreparedBackend<FenceFixtureOperations> & {
  [SQLITE_WORKER_SOURCE_FENCE](command: {
    type: "persist";
    input: FenceFixtureCommand;
  }): SqliteSourceFence;
};

export const openExistingSqliteWorkerBackend = createSqliteWorkerBackend;

function openBinding(identity: SqliteSourceFenceIdentity, path = identity.physical.canonicalPath) {
  return { identity, database: openNodeSqliteDatabase(resolveExistingSqliteFileUri(path)) };
}

function readRevision(database: ReturnType<typeof openNodeSqliteDatabase>) {
  return Number(database.prepare("SELECT revision FROM authority WHERE id = 1").get()?.revision);
}

/** Worker-only fault injection keeps barriers at the real native transaction boundary. */
export function createSqliteWorkerBackend(input: FenceFixtureInput): FixtureBackend {
  const words: unknown = getEnvironmentData(FENCE_FIXTURE_ENV);
  assert(words instanceof SharedArrayBuffer);
  const barrier = new Int32Array(words);
  const destinationBinding = openBinding(input.destination);
  const sourceBinding = openBinding(input.source);
  const aliasBinding = input.aliasPath ? openBinding(input.source, input.aliasPath) : undefined;
  const { database: destination } = destinationBinding;
  const { database: source } = sourceBinding;
  const databases = [destination, source, ...(aliasBinding ? [aliasBinding.database] : [])];
  let current: FenceFixtureCommand | undefined;
  let sourceRevision = -1;
  let validatedSource = source;
  let retryObserved = false;
  const pause = (stage: number) => {
    assert(current?.barrier !== undefined);
    const offset = current.barrier * 4;
    Atomics.store(barrier, offset, stage);
    Atomics.notify(barrier, offset);
    const release = offset + 1;
    while (Atomics.load(barrier, release) === 0) {
      Atomics.wait(barrier, release, 0);
    }
  };
  for (const db of databases) {
    db.exec("PRAGMA busy_timeout = 10000");
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql === "ROLLBACK" && db !== destination && current?.fault === "source-rollback") {
        throw new Error("Fixture source rollback failed");
      }
      if (sql === "COMMIT" && db === destination && current) {
        const grant = takeSqliteWorkerOperationAdmissionAttachment();
        assert(isRecord(grant) && grant.decision instanceof SharedArrayBuffer);
        assert.equal(Atomics.load(new Int32Array(grant.decision), 0), SOURCE_FENCE_ACCEPTED);
        if (current.pause === "commit") {
          pause(2);
        }
        if (current.fault === "before-commit-exit") {
          process.exit(31);
        }
        exec(sql);
        if (current.fault === "after-commit-exit") {
          process.exit(32);
        }
        return;
      }
      try {
        exec(sql);
      } catch (error) {
        if (sql === "BEGIN IMMEDIATE" && current?.observeRetry) {
          retryObserved = true;
        }
        throw error;
      }
      if (sql === "ROLLBACK" && retryObserved) {
        retryObserved = false;
        pause(3);
      }
    };
  }
  return {
    [SQLITE_WORKER_SOURCE_FENCE](command) {
      current = command.input;
      const selected = current.sameStore ? destinationBinding : sourceBinding;
      return {
        destination: destinationBinding,
        sources: [selected, ...(current.alias && aliasBinding ? [aliasBinding] : [])],
        validate(resolve) {
          const db = resolve(selected);
          validatedSource = db;
          sourceRevision = readRevision(db);
          if (sourceRevision !== current?.expectedRevision) {
            throw new Error("Fixture source authority was revoked");
          }
          if (current.pause === "validate") {
            pause(1);
          }
          if (current.fault === "source-close") {
            db.close();
          }
        },
      };
    },
    execute(command) {
      const { id, fault } = command.input;
      destination
        .prepare("INSERT INTO requests (id, revision) VALUES (?, ?)")
        .run(id, sourceRevision);
      if (fault === "kernel") {
        throw new Error("Fixture mutation failed between destination rows");
      }
      destination.prepare("INSERT INTO lifecycles (id) VALUES (?)").run(id);
      const result: FenceFixtureOperations["persist"]["output"] = { id, revision: sourceRevision };
      if (fault === "host-admission") {
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: "fixture-reentrancy" });
      }
      if (fault !== "missing-receipt") {
        deferSqliteWorkerCommitReceipt(destination, result);
      }
      if (fault === "postcommit-revoke") {
        assert(
          deferSqlitePostCommitPublication(destination, () => {
            validatedSource.prepare("UPDATE authority SET revision = 2 WHERE id = 1").run();
            result.notifiedRevision = readRevision(validatedSource);
          }),
        );
      }
      if (fault === "reply") {
        return Object.assign(result, { unserializable: Symbol("lost ordinary reply") });
      }
      return result;
    },
    assertSettled() {
      for (const db of databases) {
        if (db.isOpen && db.isTransaction) {
          throw new Error("Fixture native transaction did not settle");
        }
      }
    },
    close() {
      for (const db of databases) {
        if (db.isOpen) {
          db.close();
        }
      }
    },
  };
}
