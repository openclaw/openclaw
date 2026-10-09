import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import {
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
  type SqliteWorkerTransferHandle,
} from "../../infra/sqlite-worker-transfer.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionFacts,
  IncognitoSessionOperations,
} from "./session-incognito-contract.js";
import type { IncognitoEntryCreationOperations } from "./session-incognito-entry-creation-contract.js";
import type {
  IncognitoEntryPatchOperations,
  IncognitoEntryPatchResult,
} from "./session-incognito-entry-patch-contract.js";

export type IncognitoEntryOperations = IncognitoEntryCreationOperations &
  IncognitoEntryPatchOperations;

export function readIncognitoGrantFacts(
  received: unknown,
  identity: IncognitoSessionFacts["identity"],
): IncognitoSessionFacts[] {
  if (
    !Array.isArray(received) ||
    received.some(
      (facts: unknown) =>
        !isRecord(facts) ||
        !isDeepStrictEqual(facts.identity, identity) ||
        typeof facts.sessionKey !== "string" ||
        !Number.isSafeInteger(facts.revision),
    )
  ) {
    throw new Error("Incognito session grant differs from its captured target");
  }
  // SAFETY: The paired kernel supplies these actor-bound publication facts.
  return received as IncognitoSessionFacts[];
}

/** Entry receipts publish the paired kernel's acknowledged result without replay. */
export function incognitoEntryPublication<Key extends keyof IncognitoEntryOperations>(
  type: Key,
  authorizePrepared?: (refused?: IncognitoEntryPatchResult["refusedSource"]) => void,
) {
  let receiver: ReturnType<typeof createSqliteWorkerTransferReceiver> | undefined;
  let transferId: number | undefined;
  let completed = false;
  let candidate: IncognitoSessionOperations[Key]["output"] | undefined;
  return {
    factsKey: "entry" as const,
    prepare(facts: unknown) {
      if (isRecord(facts) && facts.kind === "session-entry-patch-transfer") {
        if (
          receiver ||
          !isRecord(facts.handle) ||
          typeof facts.handle.id !== "number" ||
          !Number.isSafeInteger(facts.handle.id) ||
          facts.handle.id < 1 ||
          !Array.isArray(facts.handle.kinds) ||
          facts.handle.kinds.length !== 1 ||
          facts.handle.kinds[0] !== "patch"
        ) {
          throw new Error("Incognito entry returned an invalid publication transfer");
        }
        // SAFETY: The paired kernel supplies the validated transfer descriptor.
        const handle = facts.handle as SqliteWorkerTransferHandle;
        transferId = handle.id;
        receiver = createSqliteWorkerTransferReceiver(handle, (record) => {
          if (
            candidate ||
            record.kind !== "patch" ||
            !isRecord(record.value) ||
            record.value.kind !== "incognito-entry" ||
            !Array.isArray(record.value.facts) ||
            !isRecord(record.value.value)
          ) {
            throw new Error("Incognito entry returned an invalid publication candidate");
          }
          // SAFETY: The command's paired kernel transfers its result and exact commit facts.
          candidate = record.value as IncognitoSessionOperations[Key]["output"];
        });
      } else if (isRecord(facts) && facts.kind === "session-entry-patch-frame" && receiver) {
        // SAFETY: The receiver validates frame identity, ordering, bounds, and completion.
        completed = receiver.accept(facts.frame as SqliteWorkerTransferFrame) !== undefined;
      } else {
        throw new Error("Incognito entry returned unexpected publication facts");
      }
    },
    authorize(_stage: "transaction" | "commit", facts: unknown) {
      if (candidate && "refusedSource" in candidate.value && candidate.value.refusedSource) {
        authorizePrepared?.(candidate.value.refusedSource);
        throw new Error("Session source refusal was not rejected");
      }
      if (isRecord(facts) && facts.guarded === true) {
        authorizePrepared?.();
      }
    },
    decodeReceipt(receipt: unknown): IncognitoSessionOperations[Key]["output"] {
      if (
        !completed ||
        !candidate ||
        !isRecord(receipt) ||
        receipt.kind !== "session-entry-patch-committed" ||
        receipt.transferId !== transferId
      ) {
        throw new SqliteWorkerError(
          `Incognito ${type} omitted its committed receipt`,
          "outcome-unknown",
        );
      }
      return candidate;
    },
  };
}

export function authorizeSessionFacts(
  authority: IncognitoSessionAuthority,
  stage: "transaction" | "commit",
  facts: IncognitoSessionFacts,
) {
  const authorization: unknown = authority.authorize?.(stage, structuredClone(facts));
  if (isPromiseLike(authorization)) {
    void Promise.resolve(authorization).catch(() => undefined);
    throw new Error("Incognito session grants must remain synchronous");
  }
}

/** A patch checks cancellation before its predicate, then guards the validated row before writing. */
export function isIncognitoEntryValidationGrant(
  type: string,
  phase: "prepare" | "transaction" | "commit",
  request: SqliteWorkerAdmissionRequest,
  previousGuarded: unknown,
): boolean {
  return (
    type === "session.entry.patch.commit" &&
    phase === "transaction" &&
    request.stage === "transaction" &&
    previousGuarded === false &&
    isRecord(request.facts) &&
    isRecord(request.facts.entry) &&
    request.facts.entry.guarded === true
  );
}

type Scope = Pick<SqliteWorkerStore<IncognitoSessionOperations>, "execute">;

export type IncognitoSessionRunner = <T>(
  authority: IncognitoSessionAuthority,
  operation: (scope: Scope) => Promise<T>,
  signal?: AbortSignal,
  admission?: SqliteWorkerAdmissionFactory,
  cleanup?: boolean,
) => Promise<T>;
