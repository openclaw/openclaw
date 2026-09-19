import type { DatabaseSync } from "node:sqlite";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import {
  readOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
} from "./openclaw-agent-db-identity.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  registerOpenClawAgentDatabaseAsyncResource,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen } from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

export type OpenClawAgentSqliteWorkerStore<Operations extends SqliteWorkerOperations> = {
  run<T>(
    operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => Promise<T>,
    assertCurrent: () => void,
  ): Promise<T>;
  close(): Promise<void>;
};

/** A pooled native connection retains its agent lease even while no command is running. */
export async function openOpenClawAgentSqliteWorkerStore<Operations extends SqliteWorkerOperations>(
  inputOptions: OpenClawAgentDatabaseOptions,
  expectedDatabase: DatabaseSync,
  worker: { moduleUrl: URL; input: unknown },
): Promise<OpenClawAgentSqliteWorkerStore<Operations>> {
  const env = cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    ...inputOptions,
    env,
    path: resolveOpenClawAgentSqlitePath({ ...inputOptions, env }),
  };
  const prepared = readOpenClawAgentDatabaseIdentity({ db: expectedDatabase });
  if (typeof prepared.identity !== "string") {
    throw new Error("Agent Worker requires its existing file owner");
  }
  const identity = `file:${prepared.identity}`;
  const state = captureOpenClawStateDatabaseReadAdmission(
    resolveOpenClawStateSqlitePath(options.env),
  );
  let revoked = false;
  let store: SqliteWorkerStore<Operations> | undefined;
  let closing: Promise<void> | undefined;
  let lease: string | undefined;
  let releaseBorrow: (() => void) | undefined;
  let unregisterAgent: (() => void) | undefined;
  let unregisterState: (() => void) | undefined;
  const pending = new Set<Promise<unknown>>();
  const assertHeld = () => {
    if (revoked) {
      throw new Error("Agent database Worker owner is closed");
    }
    state.assertCurrent();
    const current = getOpenClawAgentDatabaseIfOpen(options);
    if (
      !current ||
      current.db !== expectedDatabase ||
      !expectedDatabase.isOpen ||
      !isOpenClawAgentDatabasePathCurrent(current)
    ) {
      throw new Error("Borrowed agent database closed or changed before Worker admission");
    }
    assertExistingDatabaseIdentity(options.path, identity);
  };
  assertHeld();
  let opening: Promise<void> = Promise.resolve();
  const close = (): Promise<void> => {
    revoked = true;
    closing ??= (async () => {
      await opening.catch(() => undefined);
      await Promise.allSettled(pending);
      if (store) {
        // Close may checkpoint. It owns the same native writer reservation as
        // publication and cannot overlap a foreground writer inherited from ALS.
        await runOpenClawAgentWorkerWrite(options, () => store!.close());
        store = undefined;
      }
      if (lease) {
        releaseOpenClawAgentDatabaseLease(lease, { env: options.env });
        lease = undefined;
      }
      releaseBorrow?.();
      releaseBorrow = undefined;
      unregisterAgent?.();
      unregisterState?.();
    })().catch((error: unknown) => {
      closing = undefined;
      throw error;
    });
    return closing;
  };
  try {
    unregisterAgent = registerOpenClawAgentDatabaseAsyncResource({
      agentId: options.agentId,
      path: options.path,
      revoke: () => {
        revoked = true;
      },
      close,
    });
    unregisterState = registerOpenClawStateDatabaseAsyncResource({
      close: async (closedIdentity) => {
        if (!closedIdentity || closedIdentity.key === state.identity.key) {
          await close();
        }
      },
    });
    releaseBorrow = retainAgentDatabase(expectedDatabase);
    lease = claimOpenClawAgentDatabaseLease(options);
    opening = runOpenClawAgentWorkerWrite(options, async () => {
      assertHeld();
      store = await openSqliteWorkerStore<Operations>({
        ...worker,
        databasePath: options.path,
        existingOnly: true,
        admission: { identity, assertCurrent: assertHeld },
      });
      if (!store) {
        throw new Error("Agent database disappeared before Worker open");
      }
    });
    await opening;
    assertHeld();
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Agent database Worker open and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
  return {
    run(operation, assertCurrent) {
      if (revoked) {
        return Promise.reject(new Error("Agent database Worker owner is closed"));
      }
      const result = runOpenClawAgentWorkerWrite(options, async () => {
        const assert = () => {
          assertHeld();
          assertCurrent();
        };
        assert();
        return runSqliteWorkerStoreWrite(store!, operation, assert, [options.path]);
      });
      pending.add(result);
      void result.finally(() => pending.delete(result)).catch(() => undefined);
      return result;
    },
    close,
  };
}
