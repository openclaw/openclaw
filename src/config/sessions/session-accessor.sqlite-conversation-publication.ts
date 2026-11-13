import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import {
  createSqliteCommitReceipt,
  readSqliteCommitReceipt,
  type SqliteCommittedFact,
  type SqliteCommitReceipt,
  type SqliteCommitSource,
} from "../../infra/sqlite-commit-receipt.js";
import {
  hasSqlitePostCommitScope,
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
  stageSqliteTransactionState,
} from "../../infra/sqlite-post-commit.js";
import { resolveDatabasePathKey } from "../../infra/sqlite-worker-identity.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../../infra/sqlite-worker-operation-admission.js";
import { observeSqliteWorkerAdmissionFinish } from "../../infra/sqlite-worker-operation-settlement.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type {
  ConversationBindingNode,
  ConversationBindingWindow,
} from "./conversation-binding-facts.types.js";

type ConversationCatalogRow = Selectable<DB["conversations"]>;
export type ConversationAssociationRow = Selectable<DB["session_conversations"]>;
export type ConversationFact =
  | {
      kind: "catalogue";
      row: Pick<ConversationCatalogRow, "conversation_id" | "kind">;
    }
  | {
      kind: "association";
      row: Pick<
        ConversationAssociationRow,
        "session_id" | "conversation_id" | "role" | "last_seen_at"
      >;
    }
  | { kind: "node"; row: ConversationBindingNode }
  | { kind: "window"; row: ConversationBindingWindow }
  | { kind: "rehome"; sessionKey: string; sessionId?: string; previousKeys?: readonly string[] };
type ConversationPublicationSource = SqliteCommitSource & { canonicalPath: string };
export type ConversationPublication = SqliteCommitReceipt<
  ConversationFact,
  ConversationPublicationSource
>;
export type ConversationFactChange =
  | ConversationPublication
  | { kind: "unknown"; source: ConversationPublicationSource }
  | {
      kind: "pending" | "settled";
      operation: object;
      databaseIdentity: string;
      databasePath: string;
      receipts?: readonly ConversationPublication[];
      outcome?: "published" | "unknown";
    };

const listeners = resolveGlobalSingleton(Symbol.for("openclaw.conversationPublication"), () => ({
  installingFacts: 0,
  pending: new Map<object, Extract<ConversationFactChange, { operation: object }>>(),
  facts: new Set<(receipt: ConversationFactChange) => void>(),
  observers: new Set<(receipt: ConversationPublication) => void>(),
}));

const staged = resolveGlobalSingleton(
  Symbol.for("openclaw.conversationStaged"),
  () => new Map<EngineConnection, ConversationPublication[]>(),
);

function installFacts(receipt: ConversationFactChange) {
  if ("kind" in receipt && receipt.kind === "pending") {
    listeners.pending.set(receipt.operation, receipt);
  } else if ("kind" in receipt && receipt.kind === "settled") {
    listeners.pending.delete(receipt.operation);
  }
  const failures: unknown[] = [];
  listeners.installingFacts++;
  try {
    notifyListeners(listeners.facts, receipt, (error) => failures.push(error));
  } finally {
    listeners.installingFacts--;
  }
  if (failures.length) {
    throw new AggregateError(failures, "Conversation fact installation failed");
  }
}

function publicationState(receipt: ConversationPublication) {
  let installed = receipt;
  return {
    installFacts: () => installFacts(installed),
    invalidate() {
      installed = {
        ...receipt,
        facts: new Map([...receipt.facts.keys()].map((key) => [key, { kind: "unknown" } as const])),
      };
      installFacts(installed);
    },
    notify: () => notifyListeners(listeners.observers, installed),
  };
}

/** One publication owner for catalogue, binding, and session-writer postimages. */
export const conversationPublication = {
  stageRows: stageConversationRows,
  /** Install/invalidate prepared facts only; storage mutations belong in postcommit observers. */
  subscribeFacts(listener: (receipt: ConversationFactChange) => void) {
    const unsubscribe = registerListener(listeners.facts, listener);
    try {
      // A reader can acquire its snapshot while an earlier writer awaits settlement.
      for (const pending of listeners.pending.values()) {
        listener(pending);
      }
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  },
  subscribe(listener: (receipt: ConversationPublication) => void) {
    return registerListener(listeners.observers, listener);
  },
};

function stageConversationRows(
  database: { db: EngineConnection },
  rows: {
    catalogues?: readonly ConversationCatalogRow[];
    associations?: readonly ConversationAssociationRow[];
    removedAssociations?: readonly ConversationAssociationRow[];
    nodes?: readonly ConversationBindingNode[];
    windows?: readonly ConversationBindingWindow[];
    removedNodes?: readonly string[];
    removedWindows?: readonly string[];
    rehomes?: readonly Extract<ConversationFact, { kind: "rehome" }>[];
  },
): ConversationPublication {
  if (listeners.installingFacts) {
    throw new Error("Conversations cannot mutate during fact installation");
  }
  const facts = new Map<string, SqliteCommittedFact<ConversationFact>>();
  for (const key of rows.removedNodes ?? []) {
    facts.set(JSON.stringify(["node", key]), { kind: "absent" });
  }
  for (const key of rows.removedWindows ?? []) {
    facts.set(JSON.stringify(["window", key]), { kind: "absent" });
  }
  for (const row of rows.nodes ?? []) {
    facts.set(JSON.stringify(["node", row.session_key]), {
      kind: "postimage",
      value: { kind: "node", row },
    });
  }
  for (const row of rows.windows ?? []) {
    facts.set(JSON.stringify(["window", row.session_id]), {
      kind: "postimage",
      value: { kind: "window", row },
    });
  }
  for (const rehome of rows.rehomes ?? []) {
    facts.set(
      JSON.stringify(["rehome", rehome.sessionKey, rehome.sessionId, rehome.previousKeys]),
      { kind: "postimage", value: rehome },
    );
  }
  for (const row of rows.removedAssociations ?? []) {
    facts.set(JSON.stringify(["association", row.session_id, row.conversation_id, row.role]), {
      kind: "absent",
    });
  }
  for (const row of rows.catalogues ?? []) {
    facts.set(JSON.stringify(["catalogue", row.conversation_id]), {
      kind: "postimage",
      value: {
        kind: "catalogue",
        row: { conversation_id: row.conversation_id, kind: row.kind },
      },
    });
  }
  for (const row of rows.associations ?? []) {
    facts.set(JSON.stringify(["association", row.session_id, row.conversation_id, row.role]), {
      kind: "postimage",
      value: {
        kind: "association",
        row: {
          session_id: row.session_id,
          conversation_id: row.conversation_id,
          role: row.role,
          last_seen_at: row.last_seen_at,
        },
      },
    });
  }
  const receipt = createSqliteCommitReceipt({
    source: readOpenClawAgentDatabaseIdentity(database),
    domain: "conversation-catalogue-associations",
    keys: [...facts.keys()],
    readFact: (key) => facts.get(key)!,
  });
  if (hasSqlitePostCommitScope(database.db)) {
    const anchor = sqlPublicationAnchor(database.db);
    const pending = staged.get(anchor) ?? [];
    const remove = () => {
      const index = pending.indexOf(receipt);
      if (index >= 0) {
        pending.splice(index, 1);
      }
      if (!pending.length) {
        staged.delete(anchor);
      }
    };
    stageSqliteTransactionState(database.db, {
      stage() {
        staged.set(anchor, pending);
        pending.push(receipt);
      },
      commit() {},
      // Keep the entire transaction available while its individual facts install.
      prepareObservers: remove,
      rollback: remove,
      invalidate: remove,
    });
  }
  if (
    !stageSqliteCommittedPublication(
      sqlPublicationAnchor(database.db),
      publicationState(receipt),
    ) &&
    !database.db.isTransaction
  ) {
    publishSqliteCommittedState(publicationState(receipt));
  }
  return receipt;
}

/** Reuse the transaction's held rows; no read or extra worker request. */
export function readStagedConversationPublications(database?: {
  db: EngineConnection;
}): readonly ConversationPublication[] {
  return database
    ? [...(staged.get(sqlPublicationAnchor(database.db)) ?? [])]
    : [...staged.values()].flat();
}

export function parseConversationPublications(
  publications: unknown,
): readonly ConversationPublication[] | undefined {
  if (!Array.isArray(publications)) {
    return undefined;
  }
  try {
    return publications.map((publication) => {
      const receipt = readSqliteCommitReceipt<ConversationFact>(publication, {
        domain: "conversation-catalogue-associations",
        isFact: (_key, fact) => {
          if (fact.kind === "absent") {
            return true;
          }
          if (fact.kind !== "postimage" || !isRecord(fact.value)) {
            return false;
          }
          const value = fact.value;
          if (value.kind === "rehome") {
            return (
              typeof value.sessionKey === "string" &&
              (typeof value.sessionId === "string" ||
                (Array.isArray(value.previousKeys) &&
                  value.previousKeys.every((key) => typeof key === "string")))
            );
          }
          if (!isRecord(value.row)) {
            return false;
          }
          const row = value.row;
          switch (value.kind) {
            case "catalogue":
              return typeof row.conversation_id === "string" && typeof row.kind === "string";
            case "association":
              return (
                typeof row.conversation_id === "string" &&
                typeof row.session_id === "string" &&
                typeof row.role === "string" &&
                typeof row.last_seen_at === "number"
              );
            case "window":
              return (
                typeof row.session_id === "string" &&
                typeof row.session_key === "string" &&
                (row.primary_conversation_id === null ||
                  typeof row.primary_conversation_id === "string")
              );
            case "node":
              return (
                typeof row.session_key === "string" &&
                typeof row.current_session_id === "string" &&
                typeof row.entry_valid === "number" &&
                typeof row.updated_at === "number" &&
                (row.entry_session_id === null || typeof row.entry_session_id === "string")
              );
            default:
              return false;
          }
        },
      });
      const canonicalPath =
        isRecord(publication) && isRecord(publication.source)
          ? publication.source.canonicalPath
          : undefined;
      if (typeof canonicalPath !== "string") {
        throw new Error("Conversation receipt omitted its database path");
      }
      return { ...receipt, source: { ...receipt.source, canonicalPath } };
    });
  } catch {
    return undefined;
  }
}

/** The existing commit grant owns the unavailable interval through native settlement. */
export function retainConversationWorkerPublication(
  databaseIdentity: string,
  databasePath: string,
) {
  const operation = {};
  let pending = false;
  let overtaken = false;
  let unsubscribe: (() => void) | undefined;
  return {
    begin(receipts?: readonly ConversationPublication[]) {
      if (pending || receipts?.length === 0) {
        return;
      }
      pending = true;
      installFacts({
        kind: "pending",
        operation,
        databaseIdentity,
        databasePath: receipts?.[0]?.source.canonicalPath ?? resolveDatabasePathKey(databasePath),
        receipts,
      });
      unsubscribe = conversationPublication.subscribeFacts((change) => {
        if ("facts" in change && change.source.identity === databaseIdentity) {
          overtaken = true;
        }
      });
    },
    settle(receipts: readonly ConversationPublication[] = [], unknown = false) {
      if (!pending && !receipts.length) {
        return;
      }
      unsubscribe?.();
      // Native SDK writes can commit before a queued worker result is delivered.
      // Retire this request's view instead of replaying an older rehome over that write.
      const unavailable = unknown || overtaken;
      const invalidate = () =>
        installFacts({
          kind: "unknown",
          source: { identity: databaseIdentity, incarnation: "", canonicalPath: databasePath },
        });
      const finish = () => {
        if (!pending) {
          return;
        }
        pending = false;
        installFacts({
          kind: "settled",
          operation,
          databaseIdentity,
          databasePath,
          outcome: unavailable ? "unknown" : "published",
        });
      };
      if (unavailable) {
        try {
          invalidate();
        } finally {
          finish();
        }
      } else {
        publishSqliteCommittedState([
          ...receipts.map(publicationState),
          { installFacts() {}, installProjection: finish, invalidate, notify() {} },
        ]);
      }
    },
  };
}

/** Direct registration is worker-owned; entry workers retain their separate session receipt. */
export function withConversationPublication(
  factory: SqliteWorkerAdmissionFactory,
  assertCurrent: () => void,
  expectedSource: () => ConversationPublicationSource & { identity: string },
  expectedKeys: () => readonly string[],
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const superseded = new Set<string>();
    let published = false;
    let unknown = false;
    let installing = false;
    let owner: ReturnType<SqliteWorkerAdmissionFactory>;
    const source = expectedSource();
    try {
      installFacts({
        kind: "pending",
        operation,
        databaseIdentity: source.identity,
        databasePath: source.canonicalPath,
      });
      owner = factory(operation);
    } catch (error) {
      listeners.pending.delete(operation);
      notifyListeners(listeners.facts, {
        kind: "settled",
        operation,
        databaseIdentity: source.identity,
        databasePath: source.canonicalPath,
        outcome: "unknown",
      });
      throw error;
    }
    const unsubscribe = conversationPublication.subscribeFacts((change) => {
      if (installing) {
        return;
      }
      if ("facts" in change && change.source.identity === source.identity) {
        for (const key of change.facts.keys()) {
          superseded.add(key);
        }
      } else if (
        ("kind" in change &&
          change.kind === "unknown" &&
          change.source.identity === source.identity) ||
        ("kind" in change &&
          change.kind === "settled" &&
          change.databaseIdentity === source.identity &&
          change.outcome === "unknown")
      ) {
        unknown = true;
      }
    });
    let finished = false;
    observeSqliteWorkerAdmissionFinish(owner.admission, () => {
      if (!finished) {
        finished = true;
        unsubscribe();
        listeners.pending.delete(operation);
        notifyListeners(listeners.facts, {
          kind: "settled",
          operation,
          databaseIdentity: source.identity,
          databasePath: source.canonicalPath,
          outcome:
            published && !unknown && owner.admission.settlement?.kind === "completed"
              ? "published"
              : "unknown",
        });
      }
    });
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      assertCurrent();
      const receipt = readSqliteCommitReceipt<ConversationFact>(facts, {
        domain: "conversation-catalogue-associations",
        source,
        keys: expectedKeys(),
        invalidReceiptMessage: "Conversation registration receipt is invalid",
        isFact: (_key, fact) =>
          fact.kind === "postimage" &&
          isRecord(fact.value) &&
          fact.value.kind === "catalogue" &&
          isRecord(fact.value.row) &&
          typeof fact.value.row.conversation_id === "string",
      });
      const installed = {
        ...receipt,
        source,
        facts: new Map(
          [...receipt.facts].map(([key, fact]) => [
            key,
            unknown || superseded.has(key) ? ({ kind: "unknown" } as const) : fact,
          ]),
        ),
      };
      installing = true;
      try {
        publishSqliteCommittedState(publicationState(installed));
        published = true;
      } finally {
        installing = false;
      }
    });
    return owner;
  };
}
