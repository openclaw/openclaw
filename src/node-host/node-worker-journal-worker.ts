import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { NodeWorkerJournalAuthority } from "./node-worker-journal.types.js";
import type { NodeWorkerJournalWorkerOperations } from "./node-worker-journal.worker-contract.js";

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

  constructor(private readonly options: { env?: NodeJS.ProcessEnv }) {}

  execute<Key extends keyof NodeWorkerJournalWorkerOperations>(
    command: {
      type: Key;
      input: OpenClawStateWorkerOperations[Key]["input"];
    },
    authority?: NodeWorkerJournalAuthority,
  ): Promise<OpenClawStateWorkerOperations[Key]["output"]> {
    const prepared = structuredClone(command);
    // Orderly shutdown seals mutations, but durable receipts remain queryable.
    if (prepared.type === "nodeWorker.turn.get") {
      return this.runAdmitted((scope) => scope.execute(prepared), authority);
    }
    return this.run((scope) => scope.execute(prepared), authority);
  }

  run<T>(
    operation: (scope: JournalScope) => Promise<T>,
    authority?: NodeWorkerJournalAuthority,
  ): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(this.uncertain ?? new Error("Node worker journal admission is closed"));
    }
    return this.runAdmitted(operation, authority);
  }

  private runAdmitted<T>(
    operation: (scope: JournalScope) => Promise<T>,
    authority?: NodeWorkerJournalAuthority,
  ): Promise<T> {
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
      return {
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          assertCurrent();
          if (
            request.stage !== "transaction" ||
            !isRecord(request.facts) ||
            request.facts.kind !== "node-worker-journal"
          ) {
            throw new Error("Node worker journal transaction admission was refused");
          }
          grant();
        }),
      };
    };
    const result = runOpenClawStateWorkerOperation(context, operation, {
      assertCurrent,
      createAdmission,
    }).finally(() => {
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
