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
  IncognitoEntryPatchAuthorizer,
} from "./session-incognito-entry-patch-contract.js";
import {
  incognitoHistoryKeys,
  isIncognitoHistoryCommand,
} from "./session-incognito-history-contract.js";
import {
  incognitoLifecycleKeys,
  isIncognitoLifecycleCommand,
  type IncognitoLifecycleOperations,
} from "./session-incognito-lifecycle-contract.js";
import { isIncognitoTranscriptReceiptCommand } from "./session-incognito-transcript-contract.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import type { IncognitoSessionTurnOperations } from "./session-turn.types.js";

export type IncognitoEntryOperations = IncognitoEntryCreationOperations &
  IncognitoEntryPatchOperations &
  IncognitoSessionTurnOperations;

export type IncognitoSessionPublication<Key extends keyof IncognitoSessionOperations> = {
  factsKey?: "entry";
  prepare?(facts: unknown): void;
  authorize(stage: "transaction" | "commit", facts: unknown): void;
  decodeReceipt(facts: unknown): IncognitoSessionOperations[Key]["output"];
};

type IncognitoReceiptOperation =
  | keyof IncognitoEntryOperations
  | keyof IncognitoLifecycleOperations
  | "session.goal.mutate"
  | "session.manualCompact.commit"
  | "session.rewrite.commit"
  | "session.event.append"
  | "session.correction.commit"
  | "session.lock.replace"
  | "session.workerTranscript.commit";

export function readIncognitoGrantFacts<Key extends keyof IncognitoSessionOperations>(
  received: unknown,
  identity: IncognitoSessionFacts["identity"],
  command: { type: Key; input: IncognitoSessionOperations[Key]["input"] },
  committedTargets?: ReadonlySet<string>,
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
  const facts = received as IncognitoSessionFacts[];
  const keys = facts.map((entry) => entry.sessionKey);
  const lifecycleKeys = isIncognitoLifecycleCommand(command)
    ? incognitoLifecycleKeys(command, identity)
    : undefined;
  const historyKeys = isIncognitoHistoryCommand(command)
    ? incognitoHistoryKeys(command)
    : undefined;
  if (
    new Set(keys).size !== keys.length ||
    (historyKeys && !isDeepStrictEqual(keys, historyKeys)) ||
    (lifecycleKeys && !isDeepStrictEqual(keys, lifecycleKeys)) ||
    (!historyKeys &&
      "sessionKey" in command.input &&
      (keys.length !== 1 || keys[0] !== command.input.sessionKey)) ||
    (committedTargets && !isDeepStrictEqual(keys, [...committedTargets]))
  ) {
    throw new Error("Incognito session grant changed its target set");
  }
  return facts;
}

/** Entry receipts publish the paired kernel's acknowledged result without replay. */
export function incognitoEntryPublication<Key extends IncognitoReceiptOperation>(
  type: Key,
  authorizePrepared?: IncognitoEntryPatchAuthorizer,
  authorizePublication?: (facts: unknown) => void,
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
    authorize(stage: "transaction" | "commit", facts: unknown) {
      const value = candidate?.value;
      if (value != null && "refusedSource" in value && value.refusedSource) {
        authorizePrepared?.(value.refusedSource);
        throw new Error("Session source refusal was not rejected");
      }
      if (isRecord(facts) && facts.guarded === true) {
        authorizePrepared?.(
          undefined,
          // SAFETY: The paired entry kernel supplies the source validation for this grant.
          facts.sourceValidation as SessionSourceValidation | undefined,
        );
      }
      const publication =
        stage === "commit" ? candidate?.value : isRecord(facts) ? facts.publication : undefined;
      if (publication !== undefined) {
        authorizePublication?.(publication);
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
    (type === "session.entry.patch.commit" ||
      type === "session.turn.commit" ||
      isIncognitoTranscriptReceiptCommand(type)) &&
    phase === "transaction" &&
    request.stage === "transaction" &&
    (type !== "session.entry.patch.commit" || previousGuarded === false) &&
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
