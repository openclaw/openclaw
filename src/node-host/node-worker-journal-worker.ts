import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { NodeWorkerJournalAuthority } from "./node-worker-journal.types.js";
import type { NodeWorkerJournalWorkerOperations } from "./node-worker-journal.worker-contract.js";
import { nodePreparedWorkspacePublication } from "./node-worker-prepared-workspace-publication.js";

type JournalScope = {
  execute<Key extends keyof NodeWorkerJournalWorkerOperations>(command: {
    type: Key;
    input: OpenClawStateWorkerOperations[Key]["input"];
  }): Promise<OpenClawStateWorkerOperations[Key]["output"]>;
};

/** Host custody lasts through delivery and native transaction settlement. */
export class NodeWorkerJournalWorker {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly settlements = new Set<Promise<unknown>>();
  private accepting = true;
  private uncertain: SqliteWorkerError | undefined;

  constructor(private readonly options: { env?: NodeJS.ProcessEnv; path?: string }) {}

  operation<Key extends keyof NodeWorkerJournalWorkerOperations>(type: Key) {
    return (...input: OpenClawStateWorkerOperations[Key]["input"]) => this.execute({ type, input });
  }

  execute<Key extends keyof NodeWorkerJournalWorkerOperations>(
    command: {
      type: Key;
      input: OpenClawStateWorkerOperations[Key]["input"];
    },
    authority?: NodeWorkerJournalAuthority,
  ): Promise<OpenClawStateWorkerOperations[Key]["output"]> {
    const prepared = structuredClone(command);
    if (
      prepared.type === "nodeWorker.prepared.register" ||
      prepared.type === "nodeWorker.prepared.bind" ||
      prepared.type === "nodeWorker.prepared.retire" ||
      prepared.type === "nodeWorker.prepared.completeMutation"
    ) {
      if (!this.accepting) {
        return Promise.reject(
          this.uncertain ?? new Error("Node worker journal admission is closed"),
        );
      }
      return this.runAdmitted((scope) => scope.execute(prepared), authority, undefined, true);
    }
    // Orderly shutdown seals mutations, but durable receipts remain queryable.
    if (
      prepared.type === "nodeWorker.turn.get" ||
      prepared.type === "nodeWorker.launch.nonterminalCount"
    ) {
      return this.runAdmitted((scope) => scope.execute(prepared), authority);
    }
    return this.run((scope) => scope.execute(prepared), authority);
  }

  run<T>(
    operation: (scope: JournalScope) => Promise<T>,
    authority: NodeWorkerJournalAuthority | undefined,
    options: { existingOnly: true },
  ): Promise<T | undefined>;
  run<T>(
    operation: (scope: JournalScope) => Promise<T>,
    authority?: NodeWorkerJournalAuthority,
  ): Promise<T>;
  run<T>(
    operation: (scope: JournalScope) => Promise<T>,
    authority?: NodeWorkerJournalAuthority,
    options?: { existingOnly: true },
  ): Promise<T | undefined> {
    if (!this.accepting) {
      return Promise.reject(this.uncertain ?? new Error("Node worker journal admission is closed"));
    }
    return options?.existingOnly
      ? this.runAdmitted(operation, authority, options)
      : this.runAdmitted(operation, authority);
  }

  private runAdmitted<T>(
    operation: (scope: JournalScope) => Promise<T>,
    authority: NodeWorkerJournalAuthority | undefined,
    options: { existingOnly: true },
    preparedMutation?: boolean,
  ): Promise<T | undefined>;
  private runAdmitted<T>(
    operation: (scope: JournalScope) => Promise<T>,
    authority?: NodeWorkerJournalAuthority,
    options?: undefined,
    preparedMutation?: boolean,
  ): Promise<T>;
  private runAdmitted<T>(
    operation: (scope: JournalScope) => Promise<T>,
    authority?: NodeWorkerJournalAuthority,
    options?: { existingOnly: true },
    preparedMutation?: boolean,
  ): Promise<T | undefined> {
    if (this.uncertain) {
      return Promise.reject(this.uncertain);
    }
    const context = captureOpenClawStateWorkerContext(this.options);
    let active = true;
    const assertCurrent = () => {
      if (this.uncertain) {
        throw this.uncertain;
      }
      if (!active) {
        throw new Error("Node worker journal operation has settled");
      }
      authority?.assertCurrent();
    };
    const createAdmission: SqliteWorkerAdmissionFactory = (retained) => {
      assertCurrent();
      this.settlements.add(retained.settled);
      void retained.settled.then((settlement) => {
        if (settlement.kind === "unknown") {
          this.uncertain ??= Object.assign(
            new SqliteWorkerError(
              "Node worker journal transaction outcome is unknown",
              "outcome-unknown",
            ),
            { cause: settlement.error },
          );
          this.accepting = false;
        }
        this.settlements.delete(retained.settled);
      });
      const admission = createSqliteWorkerOperationAdmission((request, grant) => {
        assertCurrent();
        if (
          request.stage !== "transaction" ||
          !isRecord(request.facts) ||
          request.facts.kind !== "node-worker-journal"
        ) {
          throw new Error("Node worker journal transaction admission was refused");
        }
        grant();
      });
      const publication = preparedMutation
        ? nodePreparedWorkspacePublication.begin({
            get identity() {
              return context.admission.identity.key;
            },
            assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
          })
        : undefined;
      observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
        if (publication) {
          if (!isRecord(facts) || facts.kind !== "node-prepared-workspace") {
            throw new Error("Prepared workspace has no committed receipt");
          }
          publication.committed(facts.receipt);
        }
      });
      void retained.settled.then((settlement) =>
        publication?.finish(settlement.kind === "completed"),
      );
      return {
        nativeLocations: [context.admission.databasePath],
        admission,
      };
    };
    const admitted = options?.existingOnly
      ? runOpenClawStateWorkerOperation(context, operation, {
          assertCurrent,
          createAdmission,
          existingOnly: true,
        })
      : runOpenClawStateWorkerOperation(context, operation, { assertCurrent, createAdmission });
    const result = admitted.finally(() => {
      active = false;
    });
    this.pending.add(result);
    void result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result),
    );
    return result;
  }

  async drain(options: { close?: boolean } = {}): Promise<void> {
    if (options.close !== false) {
      this.accepting = false;
    }
    do {
      await Promise.allSettled(this.pending);
      await Promise.allSettled(this.settlements);
    } while (this.pending.size > 0 || this.settlements.size > 0);
    if (this.uncertain) {
      throw this.uncertain;
    }
  }
}
