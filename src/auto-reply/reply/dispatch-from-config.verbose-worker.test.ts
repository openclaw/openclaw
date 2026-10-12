import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createShouldEmitVerboseProgress } from "./dispatch-from-config.harness-defaults.js";

it("reads current verbose policy off-thread across foreign commits and caller revocation", async () => {
  await withOpenClawTestState({ label: "dispatch-verbose-worker" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:verbose-worker";
    writeSessionEntry(database, sessionKey, {
      sessionId: "verbose-worker",
      updatedAt: 1,
      verboseLevel: "off",
    });
    let current = true;
    const progress = createShouldEmitVerboseProgress({
      agentId: "main",
      storePath: database.path,
      sessionKey,
      fallbackLevel: "on",
      assertCurrent: () => {
        if (!current) {
          throw new Error("dispatch owner retired");
        }
      },
    });
    expect(await progress.shouldEmitAsync()).toBe(false);
    const peer = new (requireNodeSqlite().DatabaseSync)(database.path);
    try {
      for (const level of ["full", "off"] as const) {
        peer
          .prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.verboseLevel', ?) WHERE session_key = ?",
          )
          .run(level, sessionKey);
        peer
          .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
          .run(sessionKey);
        const sql = observeHostDataSql();
        try {
          expect(await progress.shouldEmitAsync()).toBe(level === "full");
          expect(await progress.shouldEmitFullAsync()).toBe(level === "full");
          expect(
            sql.queries.filter((query) =>
              /\bsession_(?:nodes|participants)\b|PRAGMA\s+query_only/i.test(query),
            ),
          ).toEqual([]);
        } finally {
          sql.restore();
        }
      }
      progress.noteRunVerbosity({ verboseLevelOverride: "full", resolvedVerboseLevel: "on" });
      const changedVerbosity = progress.shouldEmitAsync();
      progress.noteRunVerbosity({ resolvedVerboseLevel: "on" });
      expect(await changedVerbosity).toBe(false);
      const pending = progress.shouldEmitAsync();
      current = false;
      await expect(pending).rejects.toThrow("dispatch owner retired");
    } finally {
      peer.close();
    }
  });
});
