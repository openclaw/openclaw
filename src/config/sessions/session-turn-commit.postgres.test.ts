import { channel } from "node:diagnostics_channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  runSessionTurnCountTests,
  runSessionTurnPostimageTests,
} from "./session-turn-commit.test-support.js";
import { promptReport } from "./system-prompt-report.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL transcript turn commits", () => {
  useMixedAgentPair("postgres", "postgres");
  afterEach(() => vi.restoreAllMocks());
  const harness = {
    engine: "postgres" as const,
    storePath: () => openOpenClawAgentDatabase({ agentId: "main" }).path,
    run: withEngineStoreAdmission,
  };
  it("binds only the changed report in the fused node and snapshots statement", () =>
    harness.run(() => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        storePath: database.path,
        agentId: "main",
        sessionKey: "agent:main:fused-report",
      };
      const entry = {
        sessionId: "fused-report",
        updatedAt: 1,
        skillsSnapshot: { prompt: "saved", skills: [] },
      };
      replaceSessionEntrySync(scope, { ...entry, systemPromptReport: promptReport(1, 1, 0) });
      const statements: string[] = [];
      const events = channel("openclaw.database.statement");
      const observe = (value: unknown) => {
        const event = value as { engine: string; sql?: string; outcome: string };
        if (
          event.engine === "postgres" &&
          event.outcome === "ok" &&
          event.sql?.includes('"written_snapshots"')
        ) {
          statements.push(event.sql);
        }
      };
      events.subscribe(observe);
      try {
        replaceSessionEntrySync(scope, {
          ...entry,
          updatedAt: 2,
          systemPromptReport: promptReport(2, 1, 0),
        });
      } finally {
        events.unsubscribe(observe);
      }
      expect(statements).toHaveLength(1);
      expect(statements[0]!.match(/from "written_node"/g)).toHaveLength(1);
      expect(
        database.db
          .prepare(
            "SELECT field, value_json FROM session_entry_snapshots WHERE session_key = ? ORDER BY field",
          )
          .all(scope.sessionKey),
      ).toEqual([
        { field: "skillsSnapshot", value_json: JSON.stringify(entry.skillsSnapshot) },
        { field: "systemPromptReport", value_json: JSON.stringify(promptReport(2, 1, 0)) },
      ]);
    }));
  runSessionTurnCountTests(harness);
  runSessionTurnPostimageTests(harness);
});
