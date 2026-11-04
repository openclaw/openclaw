import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** A committed postimage describes one domain/key, never all writers of a database. */
export type SqliteCommittedFact<T> =
  | { kind: "postimage"; value: T }
  | { kind: "absent" }
  | { kind: "unchanged" }
  | { kind: "unknown" };

export type SqliteCommitSource = {
  identity: string | symbol;
  incarnation: string;
};

/**
 * Private, process-lifetime evidence. The existing domain owner still supplies
 * currentness, supersession, foreign freshness, policy, and reconciliation.
 * Operation identity is not a durable idempotency key or permission to replay.
 */
export type SqliteCommitReceipt<T, Source extends SqliteCommitSource = SqliteCommitSource> = {
  version: 1;
  operationId: string;
  source: Source;
  domain: string;
  facts: ReadonlyMap<string, SqliteCommittedFact<T>>;
};

/** Capture from the transaction's postimages, without another database read. */
export function createSqliteCommitReceipt<T, Source extends SqliteCommitSource>(params: {
  source: Source;
  domain: string;
  keys: readonly string[];
  readFact: (key: string) => SqliteCommittedFact<T>;
}): SqliteCommitReceipt<T, Source> {
  return {
    version: 1,
    operationId: randomUUID(),
    source: params.source,
    domain: params.domain,
    facts: new Map([...new Set(params.keys)].map((key) => [key, params.readFact(key)])),
  };
}

/**
 * Coverage is exact: an omitted key is unknown, never absence. Connection-local
 * revisions and data_version are deliberately not compared across receipts.
 */
export function hasSqliteCommitReceiptCoverage(
  receipt: unknown,
  expected: {
    source: SqliteCommitSource;
    domain: string;
    keys: readonly string[];
  },
): boolean {
  if (
    !isRecord(receipt) ||
    receipt.version !== 1 ||
    typeof receipt.operationId !== "string" ||
    !receipt.operationId ||
    receipt.domain !== expected.domain ||
    !isRecord(receipt.source) ||
    receipt.source.identity !== expected.source.identity ||
    receipt.source.incarnation !== expected.source.incarnation ||
    !(receipt.facts instanceof Map)
  ) {
    return false;
  }
  const keys = new Set(expected.keys);
  const facts: ReadonlyMap<unknown, unknown> = receipt.facts;
  return (
    facts.size === keys.size &&
    [...keys].every((key) => {
      const fact = facts.get(key);
      return (
        isRecord(fact) &&
        (fact.kind === "absent" ||
          fact.kind === "unchanged" ||
          fact.kind === "unknown" ||
          (fact.kind === "postimage" && "value" in fact))
      );
    })
  );
}

/** Validate a worker receipt once, leaving postimage and ownership policy with its domain. */
export function readSqliteCommitReceipt<T>(
  value: unknown,
  expected: {
    domain: string;
    isFact(this: void, key: string, fact: SqliteCommittedFact<unknown>): boolean;
    source?: SqliteCommitSource;
    keys?: readonly string[];
    invalidReceiptMessage?: string;
  },
): SqliteCommitReceipt<T> {
  if (
    !isRecord(value) ||
    !isRecord(value.source) ||
    typeof value.source.identity !== "string" ||
    typeof value.source.incarnation !== "string" ||
    !(value.facts instanceof Map) ||
    !hasSqliteCommitReceiptCoverage(value, {
      source: expected.source ?? {
        identity: value.source.identity,
        incarnation: value.source.incarnation,
      },
      domain: expected.domain,
      keys: expected.keys ?? [...value.facts.keys()],
    }) ||
    ![...value.facts].every(([key, fact]) => typeof key === "string" && expected.isFact(key, fact))
  ) {
    throw new Error(expected.invalidReceiptMessage ?? "State domain commit receipt is invalid");
  }
  // SAFETY: The envelope, exact coverage, and domain postimages were checked above.
  return value as SqliteCommitReceipt<T>;
}
