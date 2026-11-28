import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptEvent,
  loadExactSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { runSessionStartupMigration } from "./startup-migration-runtime.js";

it("repairs the missing count of a rotated cut once, from the selected reset window", async () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const key = (name: string) => ({
      agentId: "main",
      env: state.env,
      sessionKey: `agent:main:${name}`,
      sessionId: name,
    });
    for (const name of ["cut", "known", "fork", "rollover"]) {
      const scope = key(name);
      replaceSessionEntrySync(scope, {
        sessionId: name,
        updatedAt: 17,
        label: name,
        ...(name !== "fork" ? { previousSessionId: "old-id" } : {}),
        ...(name === "known" ? { compactionCount: 7 } : {}),
      });
      for (const [type, id, parentId] of [
        ["compaction", "old", null],
        ["reset", "reset", "old"],
        ["compaction", "kept", "reset"],
        ["compaction", "displaced", "kept"],
      ] as const) {
        await appendTranscriptEvent(scope, {
          type,
          id,
          parentId,
          timestamp: new Date(1).toISOString(),
        });
      }
      if (name !== "rollover") {
        await appendTranscriptEvent(scope, {
          type: "leaf",
          id: "cut-marker",
          parentId: "displaced",
          targetId: "kept",
        });
      }
    }
    const entry = (name: string) => loadExactSessionEntry(key(name))?.entry;
    const untouched = ["fork", "rollover", "known"].map(entry);
    const run = () =>
      runSessionStartupMigration({ cfg, env: state.env, log: { info() {}, warn() {} } });
    await run();
    expect(entry("cut")).toMatchObject({ sessionId: "cut", label: "cut", compactionCount: 1 });
    expect(["fork", "rollover", "known"].map(entry)).toEqual(untouched);
    database.db.exec(
      "CREATE TEMP TRIGGER no_second_count_repair BEFORE UPDATE OF entry_json ON session_nodes WHEN OLD.session_key = 'agent:main:cut' BEGIN SELECT RAISE(ABORT, 'count repair repeated'); END",
    );
    await run();
    expect(entry("cut")?.compactionCount).toBe(1);
  }));
