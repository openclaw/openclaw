import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import type { SqliteWorkerReply } from "../infra/sqlite-worker-contract.js";
import {
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseAsync,
  openClawStateDatabaseCache,
} from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { createGatewayRequest } from "./hooks-test-helpers.js";
import { handleGatewayProbeRequest } from "./server-http-probes.js";
import { createReadinessChecker } from "./server/readiness.js";

const paths = new Set<string>();
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    for (const pathname of paths) {
      clearOpenClawStateDatabaseOpenFailure(pathname);
    }
    paths.clear();
    cleanup();
  }),
);

describe("Gateway shared-state integrity readiness", () => {
  it("returns 503 with the worker admission refusal after audit index corruption, despite cached healthy channels", async () => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-readiness-integrity-") };
    const capture = () => captureOpenClawStateWorkerContext({ env });
    const pathname = capture().admission.databasePath;
    paths.add(pathname);
    const read = () =>
      executeOpenClawStateWorker(capture(), {
        type: "tasks.list",
        input: { ownerKey: "agent:main:main" },
      });
    expect(await read()).toEqual([]);
    await closeOpenClawStateDatabaseAsync();

    const database = new DatabaseSync(pathname);
    try {
      database.exec(`INSERT INTO audit_events
        (event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type, actor_id)
        VALUES ('alpha', 'source', 1, 1, 'agent_run', 'agent.run.started', 'started', 'agent', 'main')`);
    } finally {
      database.close();
    }
    corruptSqliteIndexKey(pathname, "sqlite_autoindex_audit_events_1", "alpha", "bravo");

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const channelManager = {
      getRuntimeSnapshot: vi.fn(() => ({ channels: {}, channelAccounts: {} })),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    };
    const getReadiness = createReadinessChecker({
      channelManager,
      startedAt: now - 1000,
      getStateDatabaseFailure: () =>
        openClawStateDatabaseCache.getOpenClawStateDatabaseRecordedFailure(pathname),
    });
    const probe = async (url: string, remoteAddress = "127.0.0.1", method = "GET") => {
      const response = createMockServerResponse();
      expect(
        await handleGatewayProbeRequest(
          createGatewayRequest({ path: url, remoteAddress, method }),
          response,
          url,
          { mode: "none", allowTailscale: false },
          [],
          false,
          undefined,
          getReadiness,
        ),
      ).toBe(true);
      return response;
    };
    const mainSql = observeMainThreadSql();
    try {
      expect((await probe("/readyz")).statusCode).toBe(200);
      await expect(read()).rejects.toThrow(/integrity_check.*sqlite_autoindex_audit_events_1/);

      const refused = await probe("/readyz");
      expect(refused.statusCode).toBe(503);
      expect(JSON.parse(refused.body ?? "null")).toMatchObject({
        ready: false,
        failing: ["state-database"],
        stateDatabase: {
          reason: expect.stringMatching(/integrity_check.*sqlite_autoindex_audit_events_1/),
        },
      });
      expect(channelManager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);
      expect((await probe("/healthz")).statusCode).toBe(200);
      const remote = await probe("/readyz", "203.0.113.10");
      expect(remote.statusCode).toBe(503);
      expect(JSON.parse(remote.body ?? "null")).toEqual({ ready: false });
      const head = await probe("/ready", "127.0.0.1", "HEAD");
      expect(head.statusCode).toBe(503);
      expect(head.body).toBeUndefined();
      mainSql.expectIdle();

      clearOpenClawStateDatabaseOpenFailure(pathname);
      const replyReady = createDeferred();
      let releaseReply: (() => void) | undefined;
      const originalEmit = vi.spyOn(Worker.prototype, "emit");
      originalEmit.mockRestore();
      const replies = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
        this: Worker,
        event: string | symbol,
        ...args: unknown[]
      ) {
        if (event === "message" && !(args[0] as SqliteWorkerReply).ok) {
          replies.mockRestore();
          releaseReply = () => originalEmit.call(this, event, ...args);
          replyReady.resolve();
          return true;
        }
        return originalEmit.call(this, event, ...args);
      });
      const pending = read();
      const outcome = Promise.allSettled([pending]);
      try {
        await replyReady.promise;
        // An explicit recovery invalidates the captured admission before its old reply arrives.
        clearOpenClawStateDatabaseOpenFailure(pathname);
        releaseReply?.();
        releaseReply = undefined;
        expect((await outcome)[0]?.status).toBe("rejected");
        expect(
          openClawStateDatabaseCache.getOpenClawStateDatabaseRecordedFailure(pathname),
        ).toBeUndefined();
      } finally {
        replies.mockRestore();
        releaseReply?.();
        await outcome;
      }
    } finally {
      mainSql.restore();
    }
    const preserved = new DatabaseSync(pathname, { readOnly: true });
    try {
      expect(preserved.prepare("SELECT event_id FROM audit_events NOT INDEXED").all()).toEqual([
        { event_id: "alpha" },
      ]);
      expect(preserved.prepare("PRAGMA integrity_check").get()?.integrity_check).not.toBe("ok");
    } finally {
      preserved.close();
    }
  });
});
