import "../test-utils/prepare-compiled-subprocesses.js";
import { existsSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptEvent } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { readTranscriptStatsBatchReadOnlyAsync } from "./memory-core-host-engine-sessions.js";
import { readTranscriptStatsAsync } from "./session-store-runtime.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "sdk-transcript-stats-");

it("reads current ordered statistics off the host after transcript writes without creating missing stores", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make() };
  const scope = {
    agentId: "main",
    env,
    sessionKey: "agent:main:stats",
    sessionId: "stats",
  };
  const absent = { ...scope, agentId: "absent", sessionKey: "agent:absent:stats" };
  await expect(readTranscriptStatsBatchReadOnlyAsync([absent])).resolves.toEqual([null]);
  expect(existsSync(resolveOpenClawAgentSqlitePath(absent))).toBe(false);
  replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const first = { type: "custom", id: "stats-first", timestamp: 1 };
  await appendTranscriptEvent(scope, first);
  const scopes = [
    scope,
    ...Array.from({ length: 10 }, (_, index) => ({ ...scope, sessionId: `missing-${index}` })),
    scope,
    absent,
  ];
  const read = async () => {
    const sql = observeHostDataSql();
    try {
      const batch = await readTranscriptStatsBatchReadOnlyAsync(scopes);
      const single = await readTranscriptStatsAsync(scope);
      expect(sql.queries).toEqual([]);
      expect(batch[0]).toEqual(single);
      expect(batch[11]).toEqual(single);
      expect(batch[12]).toBeNull();
      expect(batch.slice(1, 11)).toEqual(
        Array.from({ length: 10 }, () => ({ eventCount: 0, maxSeq: 0, sizeBytes: 0 })),
      );
      return single;
    } finally {
      sql.restore();
    }
  };
  expect(await read()).toMatchObject({
    eventCount: 1,
    maxSeq: 0,
    sizeBytes: Buffer.byteLength(JSON.stringify(first)),
  });
  const second = { type: "custom", id: "stats-second", timestamp: 2 };
  await appendTranscriptEvent(scope, second);
  expect(await read()).toMatchObject({
    eventCount: 2,
    maxSeq: 1,
    sizeBytes: Buffer.byteLength([first, second].map((event) => JSON.stringify(event)).join("\n")),
  });
  expect(existsSync(resolveOpenClawAgentSqlitePath(absent))).toBe(false);
});
