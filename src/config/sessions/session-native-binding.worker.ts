import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import {
  preparePluginStateNativeBindingCodec,
  readPreparedPluginStateNativeBinding,
} from "../../plugin-state/plugin-state-native-binding-codec.js";
import { wrapPluginStateError } from "../../plugin-state/plugin-state-store.database.js";
import {
  deletePluginStateNativeBinding,
  restorePluginStateNativeBinding,
} from "../../plugin-state/plugin-state-store.mutations.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import { withSqliteSessionDeletionWorkerParticipant } from "./session-accessor.sqlite-deletion.js";
import { assertSessionSubagentRunsCurrent } from "./session-accessor.sqlite-descendant-basis.js";
import { collectReclamationChangedSessionKeys } from "./session-accessor.sqlite-reclamation-publication.js";
import { reclaimSqliteSessionInTransaction } from "./session-accessor.sqlite-reclamation.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import type { SessionEntryPatchReceipt } from "./session-entry-patch.types.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import type {
  SessionNativeBindingCandidate,
  SessionNativeBindingDeletion,
  SessionNativeBindingParticipants,
  SessionNativeBindingReceipt,
} from "./session-native-binding.types.js";
import type { SessionEntry } from "./types.js";

export async function prepareSessionNativeBindingDeletion(
  input: SessionNativeBindingParticipants,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  for (const { binding } of input.participants) {
    if (binding) {
      await preparePluginStateNativeBindingCodec(binding, env);
    }
  }
}

export function deleteSessionWithNativeBindings(
  input: SessionNativeBindingDeletion,
  context: AgentWorkerOperationContext,
): SessionNativeBindingReceipt {
  return runSessionNativeBindingTransaction(
    input,
    context,
    "session.reclaim.entry",
    "Native binding deletion",
    (current, wrapReceipt) => {
      const result = reclaimSqliteSessionInTransaction({
        ...input.plan,
        databaseOptions: { ...input.plan.databaseOptions, ...context.options },
      });
      if (result.kind !== "entry") {
        throw new Error("Native binding deletion returned another reclamation operation");
      }
      const changedKeys = collectReclamationChangedSessionKeys(input.plan, result);
      const publication = result.value.deleted
        ? prepareSessionEntryReplacementPublication(
            {
              previous: new Map(
                input.plan.preparedTargetSnapshot.map(({ sessionKey, entry }) => [
                  sessionKey,
                  entry,
                ]),
              ),
              current: new Map(),
              pendingArchiveRecovery: false,
              membershipInvalidatedKeys: changedKeys,
              maintenancePlans: [],
            },
            current,
          )
        : undefined;
      if (publication) {
        publication.changedKeys = changedKeys;
      }
      const candidate: SessionNativeBindingCandidate = {
        kind: "session-native-binding-deletion",
        result,
        publication,
      };
      return transferSessionEntryWorkerCandidate(
        current,
        (stage, facts) => {
          context.admit(stage, facts);
          if (stage === "commit") {
            assertSessionSubagentRunsCurrent(input.plan, input.plan.databaseOptions.env);
          }
        },
        candidate,
        wrapReceipt,
      );
    },
  );
}

/** The caller's whole A transaction retains the same reversible S veto and settlement owner. */
export function runSessionNativeBindingTransaction(
  input: SessionNativeBindingParticipants,
  context: AgentWorkerOperationContext,
  operationLabel: string,
  owner: string,
  mutate: (
    database: OpenClawAgentDatabase,
    wrapReceipt: (receipt: SessionEntryPatchReceipt) => SessionNativeBindingReceipt,
  ) => SessionNativeBindingReceipt,
): SessionNativeBindingReceipt {
  const database = context.open();
  const writeSharedTransaction = context.writeSharedTransaction;
  if (!writeSharedTransaction || database.db.isTransaction) {
    throw new Error("Native binding settlement requires its reserved durable executor");
  }
  const writeShared = <T>(
    operation: "delete" | "register",
    write: (shared: OpenClawStateDatabase) => T,
    refusal?: Error,
  ): T => {
    try {
      return writeSharedTransaction(input.sharedSource, write);
    } catch (error) {
      if (error === refusal) {
        throw error;
      }
      throw wrapPluginStateError(
        error,
        operation,
        "PLUGIN_STATE_WRITE_FAILED",
        operation === "delete"
          ? "Failed to conditionally delete plugin state entry."
          : "Failed to register plugin state entry.",
        input.sharedSource.canonicalPath,
      );
    }
  };
  context.admit("transaction", { kind: "native-binding-ready", operationId: input.operationId });
  let agent: SessionNativeBindingReceipt["agent"] = "pending";
  let agentCommitted = false;
  let bindings: SessionNativeBindingReceipt["bindings"] = input.participants.map(() => "pending");
  let compensationFailure: SessionNativeBindingReceipt["compensationFailure"];
  const removed = new Map<number, Record<string, unknown>>();
  const receipt = (nextAgent = agent, nextBindings = bindings): SessionNativeBindingReceipt => ({
    kind: "session-native-binding",
    operationId: input.operationId,
    agent: nextAgent,
    bindings: [...nextBindings],
    ...(compensationFailure ? { compensationFailure } : {}),
  });
  const recordSharedCommit = (
    shared: OpenClawStateDatabase,
    nextBindings: SessionNativeBindingReceipt["bindings"],
  ) => {
    stageSqliteTransactionState(shared.db, {
      stage() {},
      commit: () => {
        bindings = nextBindings;
      },
      rollback() {},
    });
    deferSqliteWorkerCommitReceipt(shared.db, receipt(agent, nextBindings));
  };
  const admitShared = (
    index: number,
    phase: "delete" | "restore",
    stage: "transaction" | "commit",
  ) =>
    context.admit("transaction", {
      kind: "native-binding-storage",
      operationId: input.operationId,
      index,
      phase,
      stage,
    });
  const commitParticipant = (sessionKey: string, entry: SessionEntry) => {
    const selected = input.participants.flatMap((participant, index) =>
      participant.sessionKey === sessionKey ? [{ participant, index }] : [],
    );
    for (const { participant, index } of selected) {
      if (
        participant.entry.sessionId !== entry.sessionId ||
        participant.entry.lifecycleRevision !== entry.lifecycleRevision ||
        participant.entry.previousSessionId !== entry.previousSessionId
      ) {
        throw new Error(`Session changed before native binding deletion: ${sessionKey}`);
      }
      if (bindings[index] !== "pending") {
        continue;
      }
      const plan = participant.binding;
      if (!plan) {
        bindings[index] = "absent";
        continue;
      }
      const expired = new Error(plan.deletionChanged);
      const deleted = writeShared(
        "delete",
        (shared) => {
          admitShared(index, "delete", "transaction");
          const result = deletePluginStateNativeBinding(shared, plan);
          if (result.status === "deleted") {
            removed.set(index, result.value);
          }
          const next = [...bindings];
          next[index] = result.status === "conflict" ? "pending" : result.status;
          recordSharedCommit(shared, next);
          admitShared(index, "delete", "commit");
          if (result.status === "deleted") {
            const lease = readPreparedPluginStateNativeBinding(plan, result.value)?.lease;
            if (!lease || lease.expiresAt <= Date.now()) {
              throw expired;
            }
          }
          return result.status;
        },
        expired,
      );
      if (deleted === "conflict") {
        throw new Error(plan.deletionChanged);
      }
    }
  };
  try {
    return withSqliteSessionDeletionWorkerParticipant(commitParticipant, () =>
      context.writeTransaction(operationLabel, owner, (current) => {
        stageSqliteTransactionState(current.db, {
          stage() {},
          commit: () => {
            agent = "committed";
            agentCommitted = true;
          },
          rollback() {},
        });
        return mutate(current, (transferred) => ({
          ...receipt("committed"),
          receipt: transferred,
        }));
      }),
    );
  } catch (error) {
    if (agentCommitted) {
      throw error;
    }
    try {
      assertTransactionUsable(database.db);
      if (!database.db.isOpen || database.db.isTransaction) {
        throw new Error("Agent transaction did not confirm its rollback", { cause: error });
      }
    } catch (cause) {
      const unknown = new SqliteWorkerError(
        "Native binding agent outcome is unknown",
        "outcome-unknown",
      );
      unknown.cause = createSqliteLifecycleAggregateError(
        [error, cause],
        "Native binding rollback is unconfirmed",
        error,
      );
      throw unknown;
    }
    agent = "rolled-back";
    const failures: unknown[] = [error];
    for (const [index, value] of [...removed].toReversed()) {
      if (bindings[index] !== "deleted") {
        continue;
      }
      const plan = input.participants[index]!.binding!;
      try {
        const restored = writeShared("register", (shared) => {
          admitShared(index, "restore", "transaction");
          const applied = restorePluginStateNativeBinding(shared, plan, value);
          const next = [...bindings];
          if (applied) {
            next[index] = "restored";
          }
          recordSharedCommit(shared, next);
          admitShared(index, "restore", "commit");
          return applied;
        });
        if (!restored) {
          throw new Error(plan.rollbackChanged, { cause: error });
        }
      } catch (failure) {
        failures.push(failure);
      }
    }
    // Even a failed predicate needs a separate, acknowledged A-rollback fact.
    if (failures.length > 1) {
      // Admission retains the original host error; the receipt also retains reverse-settlement failures.
      compensationFailure = encodeOpenClawStateWorkerError(
        new AggregateError(failures.slice(1), "Native binding compensation failed"),
        { includeOrdinary: true },
      );
    }
    try {
      writeShared("register", (shared) => recordSharedCommit(shared, bindings));
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length > 1) {
      throw createSqliteLifecycleAggregateError(
        failures,
        "Native binding deletion settlement failed",
        error,
      );
    }
    throw error;
  }
}
