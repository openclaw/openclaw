import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createShouldEmitVerboseProgress } from "./dispatch-from-config.harness-defaults.js";

it("reads committed verbose policy without main-thread SQL and retains caller revocation", async () => {
  await withOpenClawTestState({ label: "dispatch-verbose-worker" }, async ({ env }) => {
    const sessionKey = "agent:main:verbose-worker";
    const scope = { agentId: "main", sessionKey, env };
    await upsertSessionEntryCore(scope, {
      sessionId: "verbose-worker",
      updatedAt: 1,
      verboseLevel: "off",
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    let current = true;
    const progress = await createShouldEmitVerboseProgress({
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
    for (const level of ["full", "off"] as const) {
      await upsertSessionEntryCore(scope, {
        sessionId: "verbose-worker",
        updatedAt: 2,
        verboseLevel: level,
      });
      const sql = observeHostDataSql();
      try {
        expect(progress.shouldEmit()).toBe(level === "full");
        expect(progress.shouldEmitFull()).toBe(level === "full");
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
    expect(await progress.shouldEmitAsync()).toBe(true);
    progress.noteRunVerbosity({ resolvedVerboseLevel: "on" });
    expect(await progress.shouldEmitAsync()).toBe(false);
    current = false;
    await expect(progress.shouldEmitAsync()).rejects.toThrow("dispatch owner retired");
  });
});
