import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import {
  createSqliteCommitReceipt,
  hasSqliteCommitReceiptCoverage,
  type SqliteCommittedFact,
  type SqliteCommitReceipt,
  type SqliteCommitSource,
} from "../../infra/sqlite-commit-receipt.js";
import {
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
} from "../../infra/sqlite-post-commit.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

type ConversationCatalogRow = Selectable<DB["conversations"]>;
export type ConversationAssociationRow = Selectable<DB["session_conversations"]>;
type ConversationFact =
  | { kind: "catalogue"; row: ConversationCatalogRow }
  | { kind: "association"; row: ConversationAssociationRow };
export type ConversationPublication = SqliteCommitReceipt<ConversationFact>;
type ConversationFactChange =
  | ConversationPublication
  | { kind: "unknown"; source: SqliteCommitSource }
  | {
      kind: "pending" | "settled";
      operation: object;
      outcome?: "published" | "unknown";
    };

const listeners = resolveGlobalSingleton(Symbol.for("openclaw.conversationPublication"), () => ({
  installingFacts: 0,
  facts: new Set<(receipt: ConversationFactChange) => void>(),
  observers: new Set<(receipt: ConversationPublication) => void>(),
}));

function installFacts(receipt: ConversationFactChange) {
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

/** Native/catalogue operation facts; session-worker link sets and raw writers remain incomplete. */
export const conversationPublication = {
  stageRows: stageConversationRows,
  /** Install/invalidate prepared facts only; storage mutations belong in postcommit observers. */
  subscribeFacts(listener: (receipt: ConversationFactChange) => void) {
    return registerListener(listeners.facts, listener);
  },
  subscribe(listener: (receipt: ConversationPublication) => void) {
    return registerListener(listeners.observers, listener);
  },
};

function stageConversationRows(
  database: { db: DatabaseSync },
  rows: {
    catalogues?: readonly ConversationCatalogRow[];
    associations?: readonly ConversationAssociationRow[];
    removedAssociations?: readonly ConversationAssociationRow[];
  },
): ConversationPublication {
  if (listeners.installingFacts) {
    throw new Error("Conversations cannot mutate during fact installation");
  }
  const facts = new Map<string, SqliteCommittedFact<ConversationFact>>();
  for (const row of rows.removedAssociations ?? []) {
    facts.set(JSON.stringify(["association", row.session_id, row.conversation_id, row.role]), {
      kind: "absent",
    });
  }
  for (const row of rows.catalogues ?? []) {
    facts.set(JSON.stringify(["catalogue", row.conversation_id]), {
      kind: "postimage",
      value: { kind: "catalogue", row },
    });
  }
  for (const row of rows.associations ?? []) {
    facts.set(JSON.stringify(["association", row.session_id, row.conversation_id, row.role]), {
      kind: "postimage",
      value: { kind: "association", row },
    });
  }
  const receipt = createSqliteCommitReceipt({
    source: readOpenClawAgentDatabaseIdentity(database),
    domain: "conversation-catalogue-associations",
    keys: [...facts.keys()],
    readFact: (key) => facts.get(key)!,
  });
  if (
    !stageSqliteCommittedPublication(database.db, publicationState(receipt)) &&
    !database.db.isTransaction
  ) {
    publishSqliteCommittedState(publicationState(receipt));
  }
  return receipt;
}

/** Large JSON postimages may outgrow a valid input; retain the commit and retire coverage. */
export function deferConversationWorkerReceipt(
  database: DatabaseSync,
  receipt: ConversationPublication,
): void {
  deferSqliteWorkerCommitReceipt(
    database,
    serialize(receipt).byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
      ? receipt
      : { kind: "unknown", source: receipt.source },
  );
}

function isConversationPublication(
  value: unknown,
  keys: readonly string[],
): value is ConversationPublication {
  if (
    !isRecord(value) ||
    !isRecord(value.source) ||
    typeof value.source.identity !== "string" ||
    typeof value.source.incarnation !== "string" ||
    !(value.facts instanceof Map)
  ) {
    return false;
  }
  return (
    hasSqliteCommitReceiptCoverage(value, {
      source: { identity: value.source.identity, incarnation: value.source.incarnation },
      domain: "conversation-catalogue-associations",
      keys,
    }) &&
    [...value.facts].every(
      ([key, fact]) =>
        typeof key === "string" &&
        isRecord(fact) &&
        fact.kind === "postimage" &&
        isRecord(fact.value) &&
        fact.value.kind === "catalogue" &&
        isRecord(fact.value.row) &&
        typeof fact.value.row.conversation_id === "string",
    )
  );
}

/** Direct registration is worker-owned; entry workers retain their separate session receipt. */
export function withConversationPublication(
  factory: SqliteWorkerAdmissionFactory,
  assertCurrent: () => void,
  expectedSource: () => { identity: string; incarnation: string },
  expectedKeys: () => readonly string[],
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const superseded = new Set<string>();
    let published = false;
    let unknown = false;
    let installing = false;
    let owner: ReturnType<SqliteWorkerAdmissionFactory>;
    try {
      installFacts({ kind: "pending", operation });
      owner = factory(operation);
    } catch (error) {
      notifyListeners(listeners.facts, { kind: "settled", operation, outcome: "unknown" });
      throw error;
    }
    const unsubscribe = conversationPublication.subscribeFacts((change) => {
      if (installing) {
        return;
      }
      if ("facts" in change) {
        for (const key of change.facts.keys()) {
          superseded.add(key);
        }
      } else if (
        change.kind === "unknown" ||
        (change.kind === "settled" && change.outcome === "unknown")
      ) {
        unknown = true;
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
          notifyListeners(listeners.facts, {
            kind: "settled",
            operation,
            outcome:
              published && !unknown && owner.admission.settlement?.kind === "completed"
                ? "published"
                : "unknown",
          });
        }
      }
    };
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      assertCurrent();
      const expected = expectedSource();
      if (
        isRecord(facts) &&
        facts.kind === "unknown" &&
        isRecord(facts.source) &&
        facts.source.identity === expected.identity &&
        facts.source.incarnation === expected.incarnation
      ) {
        unknown = true;
        installing = true;
        try {
          installFacts({ kind: "unknown", source: expected });
          published = true;
        } finally {
          installing = false;
        }
        return;
      }
      if (
        !isConversationPublication(facts, expectedKeys()) ||
        facts.source.identity !== expected.identity ||
        facts.source.incarnation !== expected.incarnation
      ) {
        throw new Error("Conversation registration receipt is invalid");
      }
      const installed = {
        ...facts,
        facts: new Map(
          [...facts.facts].map(([key, fact]) => [
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
