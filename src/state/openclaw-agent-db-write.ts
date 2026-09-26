import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { retainAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "./openclaw-agent-write-admission.js";

/** Admit a synchronous mutation without blocking a reclamation worker's parent callback. */
export function withOpenClawAgentDatabaseWrite<T>(
  inputOptions: OpenClawAgentDatabaseOptions,
  operation: (database: OpenClawAgentDatabase) => T,
  expectedDatabase?: DatabaseSync,
): Promise<T> {
  const options = {
    ...inputOptions,
    env: cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env),
  };
  // Relative paths and legacy-root discovery must not retarget a queued operation.
  options.env.OPENCLAW_STATE_DIR = resolveStateDir(options.env);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  options.path = pathname;
  const run = async (database: OpenClawAgentDatabase): Promise<T> => {
    const { identity, birthtime } = readOpenClawAgentDatabaseIdentity(database);
    if (typeof identity === "string") {
      assertExistingDatabaseIdentity(pathname, `file:${identity}`, birthtime);
    }
    const result = operation(database);
    if (isPromiseLike(result)) {
      // A malformed callback must not leave an admitted tail writing after the
      // queue is released, even though asynchronous mutations are unsupported.
      await result;
      throw new Error("Agent database write callbacks must remain synchronous");
    }
    return result;
  };
  return runOpenClawAgentWriteAdmission(
    options,
    async (_identity, assertCurrent) => {
      if (!expectedDatabase) {
        return await withOpenClawAgentDatabaseAsync(options, run, assertCurrent);
      }
      const database = getOpenClawAgentDatabaseIfOpen(options);
      if (!database || database.db !== expectedDatabase || !expectedDatabase.isOpen) {
        throw new Error("Borrowed agent database closed or changed before write admission");
      }
      const release = retainAgentDatabase(expectedDatabase);
      try {
        // Handle identity is not permission: the caller checks its live manager
        // and run authority in operation, after this wait and before mutation.
        return await run(database);
      } finally {
        release();
      }
    },
    true,
  );
}
