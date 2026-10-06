import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-store.js";
import type { AgentDatabaseIncognitoIdentity } from "../../state/openclaw-agent-execution-contract.js";
import {
  authorizeSessionFacts,
  incognitoEntryPublication,
  isIncognitoEntryValidationGrant,
  readIncognitoGrantFacts,
  type IncognitoEntryOperations,
  type IncognitoSessionRunner,
} from "./session-incognito-admission.js";
import {
  createIncognitoSessionClaims,
  type IncognitoSessionClaim,
} from "./session-incognito-authority.js";
import {
  isIncognitoComputeWrite,
  type IncognitoComputeTarget,
} from "./session-incognito-compute-contract.js";
import { withIncognitoCompute, type IncognitoComputeScope } from "./session-incognito-compute.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionCreate,
  IncognitoSessionFacts,
  IncognitoSessionRead,
  IncognitoSessionOperations,
} from "./session-incognito-contract.js";
import type { IncognitoEntryPatchResult } from "./session-incognito-entry-patch-contract.js";
import {
  incognitoHistoryKeys,
  isIncognitoHistoryCommand,
  type IncognitoHistoryOperations,
} from "./session-incognito-history-contract.js";
import {
  captureIncognitoLifecycleSettlement,
  incognitoLifecycleKeys,
  isIncognitoLifecycleCommand,
  isIncognitoLifecycleWrite,
  type IncognitoLifecycleEntry,
  type IncognitoLifecycleOperations,
  type IncognitoLifecycleSettlement as LifecycleSettlement,
} from "./session-incognito-lifecycle-contract.js";
import type { IncognitoOutboxOperations } from "./session-incognito-outbox-contract.js";
import {
  createIncognitoPendingInputHistorySettlement,
  createIncognitoPendingInputSettlement,
  type IncognitoPendingInputOperations,
} from "./session-incognito-pending-input-contract.js";
import {
  isIncognitoSideDataWrite,
  type IncognitoSideDataOperations,
} from "./session-incognito-side-data-contract.js";
import {
  isIncognitoTranscriptWrite,
  type IncognitoTranscriptOperations,
} from "./session-incognito-transcript-contract.js";
import type { PendingInputHistoryGrant } from "./session-pending-input-history.types.js";
import type {
  PendingInputCustodyGrant,
  PendingInputMutation,
  PendingInputRead,
} from "./session-pending-input-operations.types.js";

export type { IncognitoSessionRunner } from "./session-incognito-admission.js";

export type { IncognitoSessionClaim } from "./session-incognito-authority.js";

/** Borrowed session operations; execution lifetime and ACP orchestration stay with their owner. */
export type IncognitoSessionActor = {
  readonly agentId: string;
  readonly path: string;
  readonly identity: AgentDatabaseIncognitoIdentity;
  readonly sessions: ReturnType<ReturnType<typeof createIncognitoSessionFacts>["bind"]>;
  assertCurrent(): void;
  /** Refuse new disclosure even while accepted work retains the actor for settlement. */
  assertReadable(): void;
};

/** Actor-local projection owned by its lifetime, never a roster or full-entry cache. */
export function createIncognitoSessionFacts(
  identity: AgentDatabaseIncognitoIdentity,
  assertActorCurrent: () => void,
  withGrant: <T>(operation: () => T) => T,
  assertOutsideGrant: () => void,
  assertAdmittedCurrent: () => void = assertActorCurrent,
) {
  const entries = new Map<string, IncognitoSessionFacts>();
  const pending = new Set<string>();
  const unavailable = new Set<string>();
  let topologyRevision = 0;
  let snapshotRevision = 0;
  const current = (sessionKey: string) => {
    assertActorCurrent();
    if (pending.has(sessionKey) || unavailable.has(sessionKey)) {
      throw new Error("Incognito session facts are pending or unavailable");
    }
    return entries.get(sessionKey);
  };
  const install = (facts: IncognitoSessionFacts) => {
    assertActorCurrent();
    if (!isDeepStrictEqual(facts.identity, identity)) {
      throw new Error("Incognito publication belongs to another actor");
    }
    const previous = entries.get(facts.sessionKey);
    if (previous && previous.revision > facts.revision) {
      throw new Error("Incognito publication is older than committed facts");
    }
    const next = structuredClone(facts);
    snapshotRevision = Math.max(snapshotRevision, next.revision);
    if (previous?.sharing?.entry?.sessionId === next.sharing?.entry?.sessionId && previous) {
      next.expiresAt = previous.expiresAt;
    }
    if (
      previous?.sharing?.entry?.sessionId !== next.sharing?.entry?.sessionId ||
      previous?.sharing?.entry?.lifecycleRevision !== next.sharing?.entry?.lifecycleRevision
    ) {
      topologyRevision += 1;
    }
    // Misses belong to their scoped claim, not an ever-growing negative cache.
    if (next.sharing?.entry) {
      entries.set(next.sessionKey, next);
    } else {
      entries.delete(next.sessionKey);
    }
    unavailable.delete(facts.sessionKey);
  };
  const { claim, captureSnapshot } = createIncognitoSessionClaims({
    identity,
    current,
    readTopologyRevision: () => topologyRevision,
    withGrant,
  });
  return {
    clear() {
      entries.clear();
      pending.clear();
      unavailable.clear();
      topologyRevision += 1;
      snapshotRevision += 1;
    },
    bind(
      run: IncognitoSessionRunner,
      assertBorrowed: () => void,
      retain: <T>(operation: () => Promise<T>) => Promise<T>,
    ) {
      const perform = <Key extends keyof IncognitoSessionOperations, Result>(
        authority: IncognitoSessionAuthority,
        command: { type: Key; input: IncognitoSessionOperations[Key]["input"] },
        changing: boolean,
        receive: (value: IncognitoSessionOperations[Key]["output"]) => Result,
        signal?: AbortSignal,
        companion?: LifecycleSettlement,
        cleanup = false,
        publication?: {
          factsKey?: "entry";
          prepare?(facts: unknown): void;
          authorize(stage: "transaction" | "commit", facts: unknown): void;
          decodeReceipt(facts: unknown): IncognitoSessionOperations[Key]["output"];
        },
        restrict?: (request: SqliteWorkerAdmissionRequest) => SqliteWorkerAdmissionRequest,
        onCommitted?: (value: IncognitoSessionOperations[Key]["output"]) => void,
        onCommittedWithoutReply?: (facts: readonly IncognitoSessionFacts[]) => void,
      ) => {
        // Capture caller-owned input before queue waits.
        const captured = structuredClone(command);
        const targets = new Set<string>();
        let native:
          | {
              retained: RetainedWorkerTransactionAdmission;
              admission: SqliteWorkerOperationAdmission;
            }
          | undefined;
        let postimage: IncognitoSessionFacts[] | undefined;
        let commitGranted = false;
        function unknownOutcome(message: string): never {
          for (const key of targets) {
            unavailable.add(key);
          }
          throw new SqliteWorkerError(message, "outcome-unknown");
        }
        return run(
          authority,
          async (scope) => {
            assertActorCurrent();
            let outcome:
              | { ok: true; value: IncognitoSessionOperations[Key]["output"] }
              | { ok: false; error: unknown };
            try {
              const value = await scope.execute(captured);
              outcome = { ok: true, value };
            } catch (error) {
              outcome = { ok: false, error };
            }
            try {
              if (native) {
                const settlement = await native.retained.settled;
                const committed = native.admission.committed?.facts;
                const recovered =
                  committed !== undefined ? publication?.decodeReceipt(committed) : undefined;
                const receipt = recovered?.facts ?? committed;
                // Native callbacks stay with the lifecycle owner. Only its SQL receipt
                // decides compensation, even when disclosure or publication subsequently fails.
                const receiptMatches =
                  receipt !== undefined &&
                  postimage !== undefined &&
                  isDeepStrictEqual(receipt, postimage);
                const companionOutcome = receiptMatches
                  ? "committed"
                  : receipt === undefined &&
                      (settlement.kind === "not-entered" ||
                        (native.admission.settlement?.kind === "completed" &&
                          !commitGranted &&
                          !outcome.ok))
                    ? "rolled-back"
                    : "unknown";
                try {
                  if (receipt !== undefined) {
                    if (!postimage || !isDeepStrictEqual(receipt, postimage)) {
                      unknownOutcome("Incognito commit receipt differs from its grant");
                    }
                    // Revocation cannot undo COMMIT. Publish while FIFO custody is still held.
                    postimage.forEach(install);
                    for (const key of targets) {
                      pending.delete(key);
                    }
                    if (native.admission.settlement?.kind === "completed") {
                      const committedValue = recovered ?? (outcome.ok ? outcome.value : undefined);
                      if (committedValue) {
                        onCommitted?.(committedValue);
                      } else {
                        onCommittedWithoutReply?.(postimage);
                      }
                    }
                  } else if (changing && (commitGranted || outcome.ok)) {
                    unknownOutcome("Incognito mutation has no confirmed commit receipt");
                  }
                  if (
                    settlement.kind !== "not-entered" &&
                    native.admission.settlement?.kind !== "completed"
                  ) {
                    unknownOutcome("Incognito session native settlement is unknown");
                  }
                  if (recovered && receiptMatches) {
                    outcome = { ok: true, value: recovered };
                  }
                } finally {
                  companion?.settle(companionOutcome);
                }
              }
              if (!outcome.ok) {
                throw outcome.error;
              }
              const value = outcome.value;
              if (!changing) {
                // Read results carry current worker facts, never authority captured before a wait.
                withGrant(() => {
                  authority.assertCurrent();
                  assertActorCurrent();
                  for (const facts of value.facts) {
                    authorizeSessionFacts(authority, "commit", facts);
                  }
                  authority.assertCurrent();
                  assertActorCurrent();
                });
                value.facts.forEach(install);
              }
              for (const key of targets) {
                pending.delete(key);
              }
              authority.assertCurrent();
              assertActorCurrent();
              return receive(value);
            } finally {
              for (const key of targets) {
                pending.delete(key);
              }
            }
          },
          signal,
          (retained) => {
            let phase: "prepare" | "transaction" | "commit" = "prepare";
            let entryGuarded: unknown;
            const admission = createSqliteWorkerOperationAdmission((requested, grant) =>
              withGrant(() => {
                const request = restrict ? restrict(requested) : requested;
                authority.assertCurrent();
                assertActorCurrent();
                signal?.throwIfAborted();
                if (
                  request.stage === "open" ||
                  !isRecord(request.facts) ||
                  !isDeepStrictEqual(request.facts.identity, identity)
                ) {
                  throw new Error("Incognito session operation belongs to another actor");
                }
                if (request.stage === "prepare" && request.facts.entry !== undefined) {
                  if (phase !== "transaction" || !publication?.prepare) {
                    throw new Error("Incognito entry publication requested out of order");
                  }
                  publication.prepare(request.facts.entry);
                }
                if (
                  request.stage !== "prepare" ||
                  (!changing && request.facts.sessions !== undefined)
                ) {
                  if (
                    changing
                      ? !(
                          (phase === "prepare" && request.stage === "transaction") ||
                          (phase === "transaction" && request.stage === "commit") ||
                          isIncognitoEntryValidationGrant(
                            captured.type,
                            phase,
                            request,
                            entryGuarded,
                          )
                        )
                      : request.stage !== "prepare"
                  ) {
                    throw new Error("Incognito session authority requested out of order");
                  }
                  const received =
                    request.facts.sessions ??
                    (request.stage === "commit" && publication?.factsKey === "entry"
                      ? publication.decodeReceipt(request.facts.entry).facts
                      : undefined);
                  const facts = readIncognitoGrantFacts(received, identity);
                  const keys = facts.map((entry) => entry.sessionKey);
                  const lifecycleKeys = isIncognitoLifecycleCommand(captured)
                    ? incognitoLifecycleKeys(captured, identity)
                    : undefined;
                  const historyKeys = isIncognitoHistoryCommand(captured)
                    ? incognitoHistoryKeys(captured)
                    : undefined;
                  if (
                    new Set(keys).size !== keys.length ||
                    (historyKeys && !isDeepStrictEqual(keys, historyKeys)) ||
                    (lifecycleKeys && !isDeepStrictEqual(keys, lifecycleKeys)) ||
                    (!historyKeys &&
                      "sessionKey" in captured.input &&
                      (keys.length !== 1 || keys[0] !== captured.input.sessionKey)) ||
                    (request.stage === "commit" && !isDeepStrictEqual(keys, [...targets]))
                  ) {
                    throw new Error("Incognito session grant changed its target set");
                  }
                  for (const entry of facts) {
                    targets.add(entry.sessionKey);
                    if (changing) {
                      pending.add(entry.sessionKey);
                    }
                  }
                  for (const entry of facts) {
                    authorizeSessionFacts(
                      authority,
                      request.stage === "prepare" ? "transaction" : request.stage,
                      entry,
                    );
                  }
                  publication?.authorize(
                    request.stage === "prepare" ? "transaction" : request.stage,
                    publication.factsKey === "entry"
                      ? request.facts.entry
                      : request.facts.pendingInput,
                  );
                  if (request.stage === "commit") {
                    postimage = facts;
                    companion?.beforeCommit();
                  }
                  phase = request.stage;
                  entryGuarded = isRecord(request.facts.entry)
                    ? request.facts.entry.guarded
                    : undefined;
                }
                authority.assertCurrent();
                assertActorCurrent();
                signal?.throwIfAborted();
                if (!grant()) {
                  throw new Error("Incognito session authority expired");
                }
                commitGranted ||= request.stage === "commit";
              }),
            );
            native = { retained, admission };
            return { nativeLocations: [], admission };
          },
          cleanup,
        );
      };
      return {
        entry: <Key extends keyof IncognitoEntryOperations>(
          authority: IncognitoSessionAuthority,
          command: { type: Key; input: IncognitoEntryOperations[Key]["input"] },
          signal?: AbortSignal,
          onCommitted?: (value: IncognitoEntryOperations[Key]["output"]) => void,
          onRead?: (value: IncognitoEntryOperations[Key]["output"]) => void,
          authorizePrepared?: (refused?: IncognitoEntryPatchResult["refusedSource"]) => void,
        ): Promise<IncognitoEntryOperations[Key]["output"]> =>
          perform(
            authority,
            command,
            command.type.endsWith(".commit"),
            (result) => {
              onRead?.(result.value);
              return result.value;
            },
            signal,
            undefined,
            false,
            incognitoEntryPublication(command.type, authorizePrepared),
            undefined,
            onCommitted ? (result) => onCommitted(result.value) : undefined,
          ),
        /** Join a shared-owner composition without holding this actor's FIFO turn. */
        withSharedState<T>(operation: () => Promise<T>): Promise<T> {
          assertOutsideGrant();
          assertBorrowed();
          return retain(operation);
        },
        captureSnapshot: (sessionKey: string) => captureSnapshot(sessionKey, assertBorrowed),
        withCompute: <T>(
          authority: IncognitoSessionAuthority,
          target: IncognitoComputeTarget | undefined,
          operation: (scope: IncognitoComputeScope) => Promise<T>,
          signal?: AbortSignal,
        ): Promise<T> => {
          assertOutsideGrant();
          assertBorrowed();
          const capturedTarget = structuredClone(target);
          return retain(() =>
            withIncognitoCompute<T, IncognitoSessionClaim>({
              target: capturedTarget,
              assertAuthority: () => authority.assertCurrent(),
              assertBorrowed,
              captureClaim: (sessionKey, facts) => claim(sessionKey, assertBorrowed, facts),
              authorize: (held) => held.authorize(authority, "commit"),
              operation,
              execute: (command, observeFacts) =>
                perform(
                  authority,
                  command,
                  isIncognitoComputeWrite(command.type),
                  (result) => {
                    // Capture claims before the next FIFO turn can publish new facts.
                    observeFacts(result.facts);
                    return result.value;
                  },
                  signal,
                ),
              cleanup: (command) =>
                perform(
                  { assertCurrent: assertActorCurrent },
                  command,
                  isIncognitoComputeWrite(command.type),
                  (result) => result.value,
                  undefined,
                  undefined,
                  true,
                ),
            }),
          );
        },
        read: (
          authority: IncognitoSessionAuthority,
          input: IncognitoSessionRead,
          signal?: AbortSignal,
        ) => {
          const sessionKey = input.sessionKey;
          return perform(
            authority,
            { type: "session.entry.read", input },
            false,
            (value) => ({
              entry: value.entry,
              claim: claim(sessionKey, assertBorrowed, value.facts[0]),
              snapshot: captureSnapshot(sessionKey, assertBorrowed),
            }),
            signal,
          );
        },
        create: (
          authority: IncognitoSessionAuthority,
          input: IncognitoSessionCreate,
          signal?: AbortSignal,
        ) => {
          const sessionKey = input.sessionKey;
          return perform(
            authority,
            { type: "session.entry.create", input },
            true,
            (value) => ({
              entry: value.entry,
              claim: claim(sessionKey, assertBorrowed, value.facts[0]),
            }),
            signal,
          );
        },
        readRow(authority: IncognitoSessionAuthority, sessionKey: string) {
          return perform(
            authority,
            { type: "session.row.read", input: { sessionKey } },
            false,
            (result) => {
              const observed = snapshotRevision;
              return {
                value: result.value,
                snapshot: {
                  assertCurrent(this: void) {
                    assertBorrowed();
                    if (snapshotRevision !== observed || pending.size || unavailable.size) {
                      throw new Error("Incognito session snapshot changed; prepare it again");
                    }
                  },
                },
              };
            },
          );
        },
        acpSource(authority: IncognitoSessionAuthority, sessionKey: string) {
          return perform(
            authority,
            { type: "session.acp.source", input: { sessionKey } },
            false,
            (result) => ({
              snapshot: result.value,
              claim: claim(sessionKey, assertBorrowed, result.facts[0]),
            }),
          );
        },
        sideData: <Key extends keyof IncognitoSideDataOperations>(
          authority: IncognitoSessionAuthority,
          command: { type: Key; input: IncognitoSideDataOperations[Key]["input"] },
          signal?: AbortSignal,
          publish?: (value: IncognitoSideDataOperations[Key]["output"]) => void,
          invalidate?: (facts: readonly IncognitoSessionFacts[]) => void,
        ): Promise<IncognitoSideDataOperations[Key]["output"]> =>
          perform(
            authority,
            command,
            isIncognitoSideDataWrite(command.type),
            (result) => result.value,
            signal,
            undefined,
            false,
            undefined,
            undefined,
            publish ? (result) => publish(result.value) : undefined,
            invalidate,
          ),
        history: <Key extends keyof IncognitoHistoryOperations>(
          authority: IncognitoSessionAuthority,
          command: { type: Key; input: IncognitoHistoryOperations[Key]["input"] },
          signal?: AbortSignal,
          onRead?: (value: IncognitoHistoryOperations[Key]["output"]) => void,
        ): Promise<IncognitoHistoryOperations[Key]["output"]> =>
          perform(
            authority,
            command,
            false,
            (result) => {
              // Synchronous publication remains inside the read's original FIFO turn.
              onRead?.(result.value);
              return result.value;
            },
            signal,
          ),
        readPendingInput(authority: IncognitoSessionAuthority, input: PendingInputRead) {
          return perform(
            authority,
            { type: "session.pendingInputs.read", input },
            false,
            (result) => result.value,
          );
        },
        mutatePendingInput(
          authority: IncognitoSessionAuthority,
          input: PendingInputMutation,
          admitCustody: (stage: "transaction" | "commit", facts: PendingInputCustodyGrant) => void,
          publish?: () => void,
        ) {
          const captured = structuredClone(input);
          return perform(
            authority,
            { type: "session.pendingInputs.mutate", input: captured },
            true,
            (result) => result.value,
            undefined,
            undefined,
            false,
            createIncognitoPendingInputSettlement(captured, admitCustody),
            undefined,
            publish,
          );
        },
        interruptPendingInputHistory(
          authority: IncognitoSessionAuthority,
          input: IncognitoPendingInputOperations["session.pendingInputs.interruptHistory"]["input"],
          admitCustody: (stage: "transaction" | "commit", facts: PendingInputHistoryGrant) => void,
        ) {
          const captured = structuredClone(input);
          return perform(
            authority,
            { type: "session.pendingInputs.interruptHistory", input: captured },
            true,
            (result) => result.value,
            undefined,
            undefined,
            false,
            createIncognitoPendingInputHistorySettlement(captured, admitCustody),
          );
        },
        transcript: <Key extends keyof IncognitoTranscriptOperations>(
          authority: IncognitoSessionAuthority,
          command: { type: Key; input: IncognitoTranscriptOperations[Key]["input"] },
          signal?: AbortSignal,
          restrict?: (request: SqliteWorkerAdmissionRequest) => SqliteWorkerAdmissionRequest,
          onCommitted?: (value: IncognitoTranscriptOperations[Key]["output"]) => void,
        ): Promise<IncognitoTranscriptOperations[Key]["output"]> =>
          perform(
            authority,
            command,
            isIncognitoTranscriptWrite(command.type),
            (result) => result.value,
            signal,
            undefined,
            false,
            undefined,
            restrict,
            onCommitted ? (result) => onCommitted(result.value) : undefined,
          ),
        outbox: <Key extends keyof IncognitoOutboxOperations>(
          authority: IncognitoSessionAuthority,
          command: { type: Key; input: IncognitoOutboxOperations[Key]["input"] },
          signal?: AbortSignal,
        ): Promise<IncognitoOutboxOperations[Key]["output"]> =>
          perform(authority, command, true, (result) => result.value, signal),
        lifecycle: <Key extends keyof IncognitoLifecycleOperations>(
          authority: IncognitoSessionAuthority,
          command: { type: Key; input: IncognitoLifecycleOperations[Key]["input"] },
          signal?: AbortSignal,
          captureLifecycle?: (entries: readonly IncognitoLifecycleEntry[]) => LifecycleSettlement,
        ): Promise<IncognitoLifecycleOperations[Key]["output"]> => {
          assertBorrowed();
          authority.assertCurrent();
          const captured = structuredClone(command);
          return perform(
            authority,
            captured,
            isIncognitoLifecycleWrite(command.type),
            (result) => result.value,
            signal,
            captureIncognitoLifecycleSettlement(captured.input, captureLifecycle),
          );
        },
        captureCurrent(sessionKey: string) {
          assertBorrowed();
          return claim(sessionKey, assertBorrowed);
        },
        readSharing(sessionKey: string) {
          assertBorrowed();
          return structuredClone(current(sessionKey)?.sharing);
        },
        deadlines() {
          assertBorrowed();
          return [...entries].flatMap(([sessionKey, facts]) => {
            const entry = facts.sharing?.entry;
            return entry && facts.expiresAt !== undefined
              ? [
                  {
                    sessionKey,
                    sessionId: entry.sessionId,
                    expiresAt: facts.expiresAt,
                    source: {
                      identity: identity.incarnation,
                      assertSettlingCurrent() {
                        assertBorrowed();
                        const currentId = entries.get(sessionKey)?.sharing?.entry?.sessionId;
                        if (currentId !== undefined && currentId !== entry.sessionId) {
                          throw new Error("Incognito deadline no longer owns this session");
                        }
                      },
                      assertCurrent() {
                        assertAdmittedCurrent();
                        // Pending sharing cannot retire a lifetime. Deletion checks its session ID.
                        if (
                          entries.get(sessionKey)?.sharing?.entry?.sessionId !== entry.sessionId
                        ) {
                          throw new Error("Incognito deadline no longer owns this session");
                        }
                      },
                    },
                  },
                ]
              : [];
          });
        },
      };
    },
  };
}
