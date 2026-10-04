import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";

it("checks scoped incarnations in the reader worker before allowing effects", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:scoped-worker-read";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const run = vi.fn(async () => "effect");
    const access = () =>
      runWithScopedSessionAccess({
        cfg: {},
        agentId: "main",
        storePath: database.path,
        targetSessionKey: sessionKey,
        expectedSessionId: "original",
        run,
      });
    const queries = trackSqliteStatementExecutions(database.db, ["session"], (sql) =>
      sql.includes("session_nodes") ? "session" : null,
    );
    try {
      await expect(access()).resolves.toBe("effect");
      expect(queries.counts.session).toBe(0);
    } finally {
      queries.restore();
    }
    writeSessionEntry(database, sessionKey, { sessionId: "replacement", updatedAt: 2 });
    await expect(access()).rejects.toThrow("changed after access was granted");
    expect(run).toHaveBeenCalledOnce();
  });
});
