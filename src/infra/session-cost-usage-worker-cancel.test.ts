import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveSqliteTranscriptScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { createUsageTranscriptEntry } from "./session-cost-usage-fixtures.test-support.js";
import { withUsageWorkerPreload } from "./session-cost-usage-worker-io.test-support.js";

it("stops a canceled refresh between bounded transcript-statistics pages", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = resolveSqliteTranscriptScope({
      agentId: "main",
      sessionKey: "agent:main:cancel-usage-stats",
      sessionId: "cancel-usage-stats",
      storePath: database.path,
    });
    runOpenClawAgentWriteTransaction(
      (owner) => {
        writeSessionEntry(owner, scope.sessionKey, {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
        });
        appendTranscriptEventsInTransaction(
          owner,
          scope,
          Array.from({ length: 512 }, (_, index) => ({
            ...createUsageTranscriptEntry(1, { content: "usage-cancel-row", cost: 1 }),
            id: `message-${index}`,
            parentId: index === 0 ? null : `message-${index - 1}`,
          })),
          { scheduleProjectionReconcile: false },
        );
        // Legacy inline rows have no recorded size; SQLite's native byte function observes each visit.
        owner.db
          .prepare("UPDATE transcript_events SET event_utf8_bytes = NULL WHERE session_id = ?")
          .run(scope.sessionId);
      },
      { agentId: "main", path: database.path },
    );
    const reached = state.path("stats-page-reached");
    const release = state.path("stats-page-release");
    const visits = state.path("stats-row-visits");
    const preload = state.path("stats-cancel.cjs");
    await fs.writeFile(
      preload,
      `
const fs = require("node:fs");
if (!require("node:worker_threads").isMainThread) {
  const { DatabaseSync } = require("node:sqlite");
  const prepare = DatabaseSync.prototype.prepare;
  const installed = new WeakSet();
  let count = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    if (!installed.has(this) && sql.includes("transcript_events") && /coalesce/i.test(sql)) {
      installed.add(this);
      this.function("octet_length", { deterministic: true }, (value) => {
        if (typeof value === "string" && value.includes("usage-cancel-row")) {
          fs.appendFileSync(${JSON.stringify(visits)}, "x");
          if (++count === 128) {
            fs.writeFileSync(${JSON.stringify(reached)}, "ready");
            const deadline = Date.now() + 10000;
            const wait = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(${JSON.stringify(release)})) {
              if (Date.now() >= deadline) throw new Error("Native stats gate was not released");
              Atomics.wait(wait, 0, 0, 10);
            }
          }
        }
        return value == null ? null : typeof value === "string" ? Buffer.byteLength(value)
          : ArrayBuffer.isView(value) ? value.byteLength : Buffer.byteLength(String(value));
      });
    }
    return Reflect.apply(prepare, this, [sql]);
  };
}
`,
    );
    await withUsageWorkerPreload(state.stateDir, preload, async () => {
      const work = new AsyncWorkScope();
      const reason = new Error("Usage client stopped waiting");
      const refreshing = work.track(() =>
        refreshCostUsageCacheForAgent({
          agentId: "main",
          sessionFiles: [formatSqliteSessionFileMarker({ ...scope, storePath: database.path })],
        }),
      );
      const outcome = refreshing.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await expect.poll(() => existsSync(reached), { timeout: 15_000 }).toBe(true);
        work.beginClose(reason);
        await fs.writeFile(release, "release");
        expect(await outcome).toBeInstanceOf(Error);
        await work.drain();
        expect((await fs.readFile(visits)).byteLength).toBe(128);
      } finally {
        work.beginClose(reason);
        await fs.writeFile(release, "release");
        await outcome;
        await work.drain();
      }
    });
  });
}, 40_000);
