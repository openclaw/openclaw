import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { IncognitoSessionActor } from "../config/sessions/session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as workerStores from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

export async function openIncognitoTestActor(
  env: NodeJS.ProcessEnv,
  authority: IncognitoSessionAuthority,
  agentId = "main",
) {
  const actor = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId,
    env,
    authority,
  });
  assert(actor);
  return actor;
}

export function useIncognitoNoHostSql() {
  let sql: ReturnType<typeof observeHostDataSql>;
  beforeEach(() => {
    sql = observeHostDataSql();
  });
  afterEach(() => {
    try {
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });
}

export function useIncognitoActorProbe() {
  type Observer = (type: PropertyKey, input: unknown) => void | Promise<void>;
  const observers = new Set<Observer>();
  let restore: (() => void) | undefined;
  let readId = 0;
  const observe = (observer: Observer) => {
    if (!restore) {
      const run = workerStores.runSqliteWorkerStoreOperation;
      const spy = vi
        .spyOn(workerStores, "runSqliteWorkerStoreOperation")
        .mockImplementation(
          <Operations extends SqliteWorkerOperations, T>(
            store: SqliteWorkerStore<Operations>,
            operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
            stateContext?: Parameters<typeof run>[2],
            assertCurrent?: Parameters<typeof run>[3],
            createAdmission?: Parameters<typeof run>[4],
          ) =>
            run(
              store,
              (scope) =>
                operation({
                  execute: async (command, options) => {
                    const result = await scope.execute(command, options);
                    const pendingObservers = [...observers];
                    for (const onReply of pendingObservers) {
                      await onReply(command.type, command.input);
                    }
                    return result;
                  },
                }),
              stateContext,
              assertCurrent,
              createAdmission,
            ),
        );
      restore = () => spy.mockRestore();
    }
    observers.add(observer);
    return () => {
      observers.delete(observer);
    };
  };
  afterEach(() => {
    observers.clear();
    restore?.();
    restore = undefined;
  });

  // Keep admission and FIFO reservation synchronous; only the real worker reply is delayed.
  const read = (
    actor: IncognitoSessionActor,
    authority: IncognitoSessionAuthority,
    afterReply?: () => void | Promise<void>,
  ) => {
    const sessionKey = `agent:${actor.agentId}:dashboard:incognito-test-read-${++readId}`;
    const stop = afterReply
      ? observe((type, input) => {
          if (type === "session.entry.read" && isRecord(input) && input.sessionKey === sessionKey) {
            stop?.();
            return afterReply();
          }
        })
      : undefined;
    try {
      const reading = actor.sessions.read(authority, { sessionKey });
      return stop ? reading.finally(stop) : reading;
    } catch (error) {
      stop?.();
      throw error;
    }
  };
  return {
    read,
    observe,
    hold(actor: IncognitoSessionActor, authority: IncognitoSessionAuthority) {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const held = read(actor, authority, async () => {
        entered.resolve();
        await release.promise;
      });
      void held.catch(entered.reject);
      return { entered, release, held };
    },
  };
}

export type IncognitoActorProbe = ReturnType<typeof useIncognitoActorProbe>;
