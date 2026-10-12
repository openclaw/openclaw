import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import { createSqliteWorkerTransferCollector } from "../../infra/sqlite-worker-transfer.js";
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

/** Install a detached publication without extending its existing session expiry. */
export function installIncognitoSessionFacts(
  identity: IncognitoSessionFacts["identity"],
  entries: Map<string, IncognitoSessionFacts>,
  facts: IncognitoSessionFacts,
) {
  if (!isDeepStrictEqual(facts.identity, identity)) {
    throw new Error("Incognito publication belongs to another actor");
  }
  const previous = entries.get(facts.sessionKey);
  if (previous && previous.revision > facts.revision) {
    throw new Error("Incognito publication is older than committed facts");
  }
  const next = structuredClone(facts);
  if (previous?.sharing?.entry?.sessionId === next.sharing?.entry?.sessionId && previous) {
    next.expiresAt = previous.expiresAt;
  }
  const topologyChanged =
    previous?.sharing?.entry?.sessionId !== next.sharing?.entry?.sessionId ||
    previous?.sharing?.entry?.lifecycleRevision !== next.sharing?.entry?.lifecycleRevision;
  // Misses belong to their scoped claim, not an ever-growing negative cache.
  if (next.sharing?.entry) {
    entries.set(next.sessionKey, next);
  } else {
    entries.delete(next.sessionKey);
  }
  return { revision: next.revision, topologyChanged };
}

/** Entry receipts publish the paired kernel's acknowledged result without replay. */
export function incognitoEntryPublication<Key extends IncognitoReceiptOperation>(
  type: Key,
  authorizePrepared?: IncognitoEntryPatchAuthorizer,
  authorizePublication?: (facts: unknown) => void,
) {
  let candidate: IncognitoSessionOperations[Key]["output"] | undefined;
  const transfer = createSqliteWorkerTransferCollector("patch", (value) => {
    if (
      candidate ||
      !isRecord(value) ||
      value.kind !== "incognito-entry" ||
      !Array.isArray(value.facts) ||
      !isRecord(value.value)
    ) {
      throw new Error("Incognito entry returned an invalid publication candidate");
    }
    // SAFETY: The paired kernel supplies this command's complete framed result.
    candidate = value as IncognitoSessionOperations[Key]["output"];
  });
  const finishTransfer = (facts: unknown) => {
    if (!isRecord(facts)) {
      throw new Error("Incognito entry omitted its commit facts");
    }
    transfer.accept(facts.transfer);
    if (!transfer.completed) {
      throw new Error("Incognito entry returned an incomplete transfer");
    }
  };
  return {
    factsKey: "entry" as const,
    prepare(facts: unknown) {
      if (!isRecord(facts) || facts.kind !== "session-entry-patch-transfer") {
        throw new Error("Incognito entry returned unexpected publication facts");
      }
      transfer.accept(facts.transfer);
    },
    authorize(stage: "transaction" | "commit", facts: unknown) {
      if (stage === "commit" && !transfer.completed) {
        finishTransfer(facts);
      }
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
      // The actor reads committed target facts before invoking its final authorizer.
      if (!transfer.completed && isRecord(receipt) && receipt.transfer !== undefined) {
        finishTransfer(receipt);
      }
      if (
        !transfer.completed ||
        !candidate ||
        !isRecord(receipt) ||
        receipt.kind !== "session-entry-patch-committed" ||
        receipt.transferId !== transfer.id
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
