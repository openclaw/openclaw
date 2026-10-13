import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteCommitReceipt,
  hasSqliteCommitReceiptCoverage,
  type SqliteCommitSource,
} from "../../infra/sqlite-commit-receipt.js";
import type { WorkerEnvironmentFacts } from "./store.types.js";

type Postimage = {
  environment: WorkerEnvironmentFacts["environments"][number] | null;
  credential: WorkerEnvironmentFacts["credentials"][number] | null;
  attachment: WorkerEnvironmentFacts["attachments"][number] | null;
};

/** Each key replaces its entire environment, credential, and attachment set. */
export function createWorkerEnvironmentReceipt(
  source: SqliteCommitSource,
  facts: WorkerEnvironmentFacts,
) {
  const environments = new Map(facts.environments.map((row) => [row.environmentId, row]));
  const credentials = new Map(facts.credentials.map((row) => [row.environmentId, row]));
  const attachments = new Map(facts.attachments.map((row) => [row.environmentId, row]));
  return createSqliteCommitReceipt<Postimage, SqliteCommitSource>({
    source,
    domain: "worker-environments",
    keys: facts.ids,
    readFact: (id) => ({
      kind: "postimage",
      value: {
        environment: environments.get(id) ?? null,
        credential: credentials.get(id) ?? null,
        attachment: attachments.get(id) ?? null,
      },
    }),
  });
}

export function readWorkerEnvironmentReceipt(
  value: unknown,
  source: SqliteCommitSource,
  ids: readonly string[],
): WorkerEnvironmentFacts {
  if (
    !hasSqliteCommitReceiptCoverage(value, { source, domain: "worker-environments", keys: ids }) ||
    !isRecord(value) ||
    !(value.facts instanceof Map)
  ) {
    throw new Error("Worker environment receipt has incomplete coverage");
  }
  const facts: WorkerEnvironmentFacts = {
    ids: [...ids],
    environments: [],
    credentials: [],
    attachments: [],
  };
  for (const id of ids) {
    const fact: unknown = value.facts.get(id);
    if (!isRecord(fact) || fact.kind !== "postimage" || !isRecord(fact.value)) {
      throw new Error("Worker environment receipt has unknown facts");
    }
    for (const field of ["environment", "credential", "attachment"] as const) {
      const row: unknown = fact.value[field];
      if (row === null) {
        continue;
      }
      if (!isRecord(row) || row.environmentId !== id) {
        throw new Error("Worker environment receipt has a different row owner");
      }
    }
    // SAFETY: The private worker owns row decoding; the envelope and every exact owner were checked.
    const postimage = fact.value as Postimage;
    if (postimage.environment) {
      facts.environments.push(postimage.environment);
    }
    if (postimage.credential) {
      facts.credentials.push(postimage.credential);
    }
    if (postimage.attachment) {
      facts.attachments.push(postimage.attachment);
    }
  }
  return facts;
}
