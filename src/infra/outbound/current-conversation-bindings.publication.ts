import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { readTrackedStateDatabaseIdentity } from "../../state/openclaw-state-db-handle.js";
import {
  createSqliteCommitReceipt,
  hasSqliteCommitReceiptCoverage,
  type SqliteCommitReceipt,
  type SqliteCommitSource,
  type SqliteCommittedFact,
} from "../sqlite-commit-receipt.js";
import {
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
} from "../sqlite-post-commit.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../sqlite-worker-operation-admission.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

type CurrentConversationBindingPublication = {
  receipt: SqliteCommitReceipt<SessionBindingRecord>;
  /** Exact reverse-index scopes touched; these are invalidations, not complete set postimages. */
  sessionKeys: readonly string[];
};

type CurrentConversationBindingFactChange =
  | CurrentConversationBindingPublication
  | { kind: "unknown"; identity: string | symbol }
  | {
      kind: "pending" | "settled";
      identity: string;
      operation: object;
      outcome?: "published" | "unchanged" | "unknown";
    };

type BindingChange = {
  key: string;
  current: SessionBindingRecord | null;
  previousTargetSessionKey?: string;
  currentTargetSessionKey?: string;
};

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.currentConversationBindingPublication"),
  () => ({
    sources: new WeakMap<DatabaseSync, SqliteCommitSource>(),
    capture: new AsyncLocalStorage<BindingChange[]>(),
    installingFacts: 0,
    facts: new Set<(publication: CurrentConversationBindingFactChange) => void>(),
    observers: new Set<(publication: CurrentConversationBindingPublication) => void>(),
  }),
);

function sourceFor(database: DatabaseSync): SqliteCommitSource {
  let source = state.sources.get(database);
  if (!source) {
    source = {
      identity:
        readTrackedStateDatabaseIdentity(database)?.key ?? Symbol("untracked-binding-database"),
      incarnation: randomUUID(),
    };
    state.sources.set(database, source);
  }
  return source;
}

function capturePublication(database: DatabaseSync, changes: readonly BindingChange[]) {
  const current = new Map(changes.map((change) => [change.key, change.current]));
  const receipt = createSqliteCommitReceipt({
    source: sourceFor(database),
    domain: "current-conversation-bindings",
    keys: [...current.keys()],
    readFact(key): SqliteCommittedFact<SessionBindingRecord> {
      const record = current.get(key);
      return record ? { kind: "postimage", value: structuredClone(record) } : { kind: "absent" };
    },
  });
  return {
    receipt,
    sessionKeys: [
      ...new Set(
        changes.flatMap((change) =>
          [
            change.previousTargetSessionKey,
            change.currentTargetSessionKey ?? change.current?.targetSessionKey,
          ].filter((key): key is string => key !== undefined),
        ),
      ),
    ],
  };
}

function unknownPublication(publication: CurrentConversationBindingPublication) {
  return {
    ...publication,
    receipt: {
      ...publication.receipt,
      facts: new Map(
        [...publication.receipt.facts.keys()].map((key) => [key, { kind: "unknown" } as const]),
      ),
    },
  };
}

function installFacts(change: CurrentConversationBindingFactChange): void {
  const failures: unknown[] = [];
  state.installingFacts++;
  try {
    notifyListeners(state.facts, change, (error) => failures.push(error));
  } finally {
    state.installingFacts--;
  }
  if (failures.length) {
    throw new AggregateError(failures, "Conversation binding fact installation failed");
  }
}

function publicationState(publication: CurrentConversationBindingPublication) {
  let installed = publication;
  return {
    installFacts: () => installFacts(installed),
    invalidate() {
      installed = unknownPublication(publication);
      installFacts(installed);
    },
    notify: () => notifyListeners(state.observers, installed),
  };
}

/** Owns binding-fact staging and observation; callers retain native/foreign authority guards. */
export const currentConversationBindingPublication = {
  stage: stageCurrentConversationBindingChanges,
  /** Install/invalidate prepared facts only; storage mutations belong in postcommit observers. */
  subscribeFacts(listener: (publication: CurrentConversationBindingFactChange) => void) {
    return registerListener(state.facts, listener);
  },
  subscribe(listener: (publication: CurrentConversationBindingPublication) => void) {
    return registerListener(state.observers, listener);
  },
};

/** Called inside the owning write transaction using rows already read by its kernel. */
function stageCurrentConversationBindingChanges(
  database: DatabaseSync,
  changes: readonly BindingChange[],
): void {
  if (!changes.length) {
    return;
  }
  if (state.installingFacts) {
    throw new Error("Conversation bindings cannot mutate during fact installation");
  }
  state.capture.getStore()?.push(...changes);
  const publication = capturePublication(database, changes);
  if (
    !stageSqliteCommittedPublication(database, publicationState(publication)) &&
    !database.isTransaction
  ) {
    publishSqliteCommittedState(publicationState(publication));
  }
}

/** One receipt covers every changed row in this worker transaction, including mutating reads. */
export function withCurrentConversationBindingWorkerReceipt<T>(
  database: DatabaseSync,
  update: () => T,
): T {
  return state.capture.run([], () => {
    const result = update();
    const changes = state.capture.getStore()!;
    if (changes.length) {
      const publication = capturePublication(database, changes);
      // Even tombstone keys can exceed IPC limits; transport must not roll back a valid prune.
      deferSqliteWorkerCommitReceipt(
        database,
        serialize(publication).byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
          ? publication
          : { kind: "unknown", identity: publication.receipt.source.identity },
      );
    }
    return result;
  });
}

function readPublication(value: unknown): CurrentConversationBindingPublication {
  if (
    !isRecord(value) ||
    !isRecord(value.receipt) ||
    !isRecord(value.receipt.source) ||
    typeof value.receipt.source.identity !== "string" ||
    typeof value.receipt.source.incarnation !== "string" ||
    !(value.receipt.facts instanceof Map) ||
    !Array.isArray(value.sessionKeys) ||
    !value.sessionKeys.every((key) => typeof key === "string")
  ) {
    throw new Error("Conversation binding receipt is invalid");
  }
  const source = {
    identity: value.receipt.source.identity,
    incarnation: value.receipt.source.incarnation,
  };
  if (
    !hasSqliteCommitReceiptCoverage(value.receipt, {
      source,
      domain: "current-conversation-bindings",
      keys: [...value.receipt.facts.keys()],
    }) ||
    ![...value.receipt.facts].every(
      ([key, fact]) =>
        typeof key === "string" &&
        (fact.kind === "absent" ||
          (fact.kind === "postimage" &&
            isRecord(fact.value) &&
            typeof fact.value.bindingId === "string" &&
            typeof fact.value.targetSessionKey === "string" &&
            isRecord(fact.value.conversation))),
    )
  ) {
    throw new Error("Conversation binding receipt has incomplete facts");
  }
  // SAFETY: The private worker owns this shape; envelope, source, and routing fields were checked above.
  return value as CurrentConversationBindingPublication;
}

/** Retain supersession until native settlement, independent of ordinary reply delivery. */
export function withCurrentConversationBindingPublication(
  createAdmission: SqliteWorkerAdmissionFactory,
  identity: () => string,
  assertPublicationCurrent: () => void,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const pendingFailures: unknown[] = [];
    notifyListeners(state.facts, { kind: "pending", identity: identity(), operation }, (error) =>
      pendingFailures.push(error),
    );
    let owner: ReturnType<SqliteWorkerAdmissionFactory>;
    try {
      if (pendingFailures.length) {
        throw new AggregateError(
          pendingFailures,
          "Conversation binding pending installation failed",
        );
      }
      owner = createAdmission(operation);
    } catch (error) {
      notifyListeners(state.facts, {
        kind: "settled",
        identity: identity(),
        operation,
        outcome: "unknown",
      });
      throw error;
    }
    const superseded = new Set<string>();
    let installing = false;
    let published = false;
    let unknown = false;
    const unsubscribe = currentConversationBindingPublication.subscribeFacts((change) => {
      if (installing) {
        return;
      }
      if (!("receipt" in change)) {
        if (
          change.identity === identity() &&
          (change.kind === "unknown" || (change.kind === "settled" && change.outcome === "unknown"))
        ) {
          unknown = true;
        }
        return;
      }
      const { receipt } = change;
      if (receipt.source.identity === identity()) {
        for (const key of receipt.facts.keys()) {
          superseded.add(key);
        }
      }
    });
    let finished = false;
    const finish = owner.admission.finish.bind(owner.admission);
    owner.admission.finish = () => {
      try {
        finish();
      } finally {
        if (!finished) {
          finished = true;
          unsubscribe();
          notifyListeners(state.facts, {
            kind: "settled",
            identity: identity(),
            operation,
            outcome:
              !unknown && owner.admission.settlement?.kind === "completed"
                ? published
                  ? "published"
                  : "unchanged"
                : "unknown",
          });
        }
      }
    };
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      assertPublicationCurrent();
      if (isRecord(facts) && facts.kind === "unknown" && facts.identity === identity()) {
        unknown = true;
        installing = true;
        try {
          installFacts({ kind: "unknown", identity: identity() });
          published = true;
        } finally {
          installing = false;
        }
        return;
      }
      const publication = readPublication(facts);
      if (publication.receipt.source.identity !== identity()) {
        throw new Error("Conversation binding receipt changed its physical owner");
      }
      const installation: CurrentConversationBindingPublication = {
        ...publication,
        receipt: {
          ...publication.receipt,
          facts: new Map(
            [...publication.receipt.facts].map(([key, fact]) => [
              key,
              unknown || superseded.has(key) ? { kind: "unknown" } : fact,
            ]),
          ),
        },
      };
      installing = true;
      try {
        publishSqliteCommittedState(publicationState(installation));
        published = true;
      } finally {
        installing = false;
      }
    });
    return owner;
  };
}
