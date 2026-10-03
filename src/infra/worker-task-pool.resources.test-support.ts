import assert from "node:assert/strict";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readAuthProfileJsonCellText } from "../agents/auth-profiles/sqlite-json.js";
import { withScopedOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-scope.js";
import { serveOwnedWorkerTasks } from "./worker-task-server.js";

export type ResourceFixtureInput = {
  retain?: string;
  wait?: SharedArrayBuffer;
  database?: { agentId: string; path: string; readAuthStore?: boolean };
};
export type ResourceFixtureReply = {
  keys: string[];
  threadId: number;
  databaseFound?: boolean;
  authStore?: string;
};
const resources = new Set<string>();
serveOwnedWorkerTasks<ResourceFixtureReply>(
  async (input) => {
    assert.ok(isRecord(input));
    if (input.retain !== undefined) {
      assert.ok(typeof input.retain === "string");
      resources.add(input.retain);
    }
    if (input.wait) {
      assert.ok(input.wait instanceof SharedArrayBuffer);
      const barrier = new Int32Array(input.wait);
      Atomics.store(barrier, 0, 1);
      await Atomics.waitAsync(barrier, 1, 0).value;
    }
    let databaseFound: boolean | undefined;
    let authStore: string | undefined;
    if (input.database) {
      assert.ok(isRecord(input.database));
      assert.ok(typeof input.database.agentId === "string");
      assert.ok(typeof input.database.path === "string");
      const readAuthStore = input.database.readAuthStore === true;
      const result = withScopedOpenClawAgentDatabaseReadOnly(
        (database) =>
          readAuthStore ? readAuthProfileJsonCellText(database.db, "store", "agent") : undefined,
        {
          agentId: input.database.agentId,
          path: input.database.path,
        },
      );
      databaseFound = result.found;
      authStore = result.found ? result.value : undefined;
    }
    return {
      keys: [...resources],
      threadId,
      ...(databaseFound !== undefined ? { databaseFound } : {}),
      ...(authStore !== undefined ? { authStore } : {}),
    };
  },
  {
    closeResource(key) {
      if (key === "fail-once" && resources.delete(key)) {
        throw new Error("Retained resource close refused");
      }
      if (key === undefined) {
        resources.clear();
      } else {
        resources.delete(key);
      }
    },
  },
);
