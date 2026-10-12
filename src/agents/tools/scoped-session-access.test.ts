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
it("revalidates route authority at the final admission boundary", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const run = vi.fn(async () => "effect");
    const revalidateCurrent = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("channel authority changed"));

    await expect(
      runWithScopedSessionAccess({
        cfg: {},
        agentId: "main",
        storePath: database.path,
        targetSessionKey: "agent:main:slack:channel:c111:thread:2",
        admissionIdentities: ["agent:main:slack:channel:c111:thread:1"],
        revalidateCurrent,
        run,
      }),
    ).rejects.toThrow("channel authority changed");
    expect(revalidateCurrent).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });
});
