import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadTranscriptEvents, readTranscriptStatsAsync } from "./session-store-runtime.js";

it("reads committed transcript events and stats off the host through the SDK", async () => {
  await withOpenClawTestState({ label: "sdk-transcript-reads" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "sdk-transcript",
      sessionKey: "agent:main:sdk-transcript",
      storePath: state.statePath("transcript.sqlite"),
    };
    const events = [
      { type: "session", id: scope.sessionId, version: 3 },
      { type: "message", id: "first", message: { role: "user", content: "first" } },
    ];
    for (const snapshot of [events, [...events, { type: "leaf", parentId: "first" }]]) {
      await replaceTranscriptEvents(scope, snapshot);
      const sql = observeHostDataSql();
      try {
        await expect(loadTranscriptEvents(scope)).resolves.toEqual(snapshot);
        await expect(readTranscriptStatsAsync(scope)).resolves.toMatchObject({
          eventCount: snapshot.length,
          maxSeq: snapshot.length - 1,
          sizeBytes: Buffer.byteLength(snapshot.map((event) => JSON.stringify(event)).join("\n")),
        });
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    }
  });
});
