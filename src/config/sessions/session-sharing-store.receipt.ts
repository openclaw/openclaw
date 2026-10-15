import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasSqliteCommitReceiptCoverage } from "../../infra/sqlite-commit-receipt.js";
import { SqliteWorkerError, type SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  SessionSharingCommitReceipt,
  SessionSharingWorkerOperations,
} from "./session-sharing-store.types.js";

function requireReceipt(condition: unknown): asserts condition {
  if (!condition) {
    throw new SqliteWorkerError(
      "Session collaboration receipt is incomplete or conflicting",
      "outcome-unknown",
    );
  }
}

/** The native commit grant pins this candidate and its committing connection. */
export function readSessionCollaborationCandidate(
  value: unknown,
  command: SqliteWorkerCommand<SessionSharingWorkerOperations>,
  keys: readonly string[],
  databaseIdentity: string,
): SessionSharingCommitReceipt {
  requireReceipt(
    isRecord(value) &&
      value.kind === "session-collaboration-committed" &&
      value.type === command.type &&
      command.type !== "category.prepare" &&
      Object.hasOwn(value, "result") &&
      isRecord(value.publication) &&
      isRecord(value.publication.source) &&
      value.publication.source.identity === databaseIdentity &&
      typeof value.publication.source.incarnation === "string" &&
      value.publication.source.incarnation.length > 0,
  );
  requireReceipt(
    hasSqliteCommitReceiptCoverage(value.publication, {
      source: { identity: databaseIdentity, incarnation: value.publication.source.incarnation },
      domain: "session-collaboration",
      keys,
    }),
  );
  if (command.type !== "category.apply") {
    requireReceipt(keys.length === 1 && keys[0] === command.input.scope.sessionKey);
  }
  // SAFETY: The paired typed worker constructs this scoped candidate; native commit equality confirms it.
  return value as SessionSharingCommitReceipt;
}
