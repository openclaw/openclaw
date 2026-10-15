import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawAgentDatabaseReadOnlyScope } from "../state/openclaw-agent-db-readonly-scope.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "./sqlite-handle-lifecycle.js";
import { serveOwnedWorkerTasks } from "./worker-task-server.js";

export type SqliteIdleInput = { path: string } | { expire: true };
export type SqliteIdleReply = {
  threadId: number;
  retained: boolean;
  open: boolean;
  reused?: boolean;
};

// Advance only the database idle clock, preserving the async context in which
// Node creates each timer. Fake timer callbacks alone would hide stale task ALS.
const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = Object.assign((...args: Parameters<typeof setTimeout>) => {
  const timer = nativeSetTimeout(...args);
  if (args[1] === SQLITE_IDLE_HANDLE_TTL_MS) {
    timers.set(
      timer,
      AsyncResource.bind(() => args[0](...args.slice(2))),
    );
  }
  return timer;
}, nativeSetTimeout);
globalThis.clearTimeout = (...args) => {
  timers.delete(args[0] as ReturnType<typeof setTimeout>);
  nativeClearTimeout(...args);
};

let scope: OpenClawAgentDatabaseReadOnlyScope | undefined;
let connection: DatabaseSync | undefined;
serveOwnedWorkerTasks<SqliteIdleReply>(
  async (input) => {
    assert.ok(isRecord(input));
    let reused: boolean | undefined;
    if (input.expire) {
      // Failed close rearms its timer; expire only this generation so failure cannot spin.
      const expiringTimers = [...timers];
      for (const [timer, expire] of expiringTimers) {
        clearTimeout(timer);
        expire();
      }
    } else {
      assert.equal(typeof input.path, "string");
      // Keep this cold import inside the first admitted task, as transcript readers do.
      const { OpenClawAgentDatabaseReadOnlyScope, withScopedOpenClawAgentDatabaseReadOnly } =
        await import("../state/openclaw-agent-db-readonly-scope.js");
      scope ??= new OpenClawAgentDatabaseReadOnlyScope();
      const target = { agentId: "main", path: input.path as string };
      const result = scope.run(target, () =>
        withScopedOpenClawAgentDatabaseReadOnly(({ db }) => {
          reused = connection === db;
          connection = db;
        }, target),
      );
      assert.ok(result.found);
    }
    return {
      threadId,
      retained: scope?.hasRetainedConnection ?? false,
      open: connection?.isOpen ?? false,
      ...(reused === undefined ? {} : { reused }),
    };
  },
  { closeResource: () => scope?.close() },
);
