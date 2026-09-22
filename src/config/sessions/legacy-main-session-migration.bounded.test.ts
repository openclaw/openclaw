import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as sqlite from "../../infra/kysely-sync.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";

afterEach(() => vi.restoreAllMocks());

it.each(["doctor-fix", "detect"] as const)(
  "%s completes an owner-only store without reading transcripts",
  async (mode) => {
    await withOpenClawTestState({ label: "legacy-main-bounded" }, async (state) => {
      seedSessions(state.stateDir, "ops", ["agent:ops:one", "agent:ops:two", "agent:ops:three"]);
      const reads = recordTranscriptReads();

      const result = await migrateLegacyMainSessionKeys({
        cfg: { agents: { entries: { ops: {} } } },
        env: state.env,
        mode,
      });

      expect(result).toMatchObject({
        armed: true,
        complete: true,
        ledgerComplete: mode === "doctor-fix",
        outcomes: [{ kind: "no-legacy-rows" }],
        warnings: [],
      });
      expect(reads()).toEqual([]);
    });
  },
);

it.each(["doctor-fix", "detect"] as const)(
  "%s reads only legacy-targeted transcripts across stores without materializing them",
  async (mode) => {
    await withOpenClawTestState({ label: "legacy-main-targeted" }, async (state) => {
      seedSessions(state.stateDir, "ops", ["agent:ops:one", "agent:ops:two", "agent:ops:three"]);
      seedSessions(state.stateDir, "main", ["agent:main:two"]);
      const reads = recordTranscriptReads();

      const result = await migrateLegacyMainSessionKeys({
        cfg: { agents: { entries: { ops: {} } } },
        env: state.env,
        mode,
      });

      expect(result.outcomes).toEqual([
        expect.objectContaining({ kind: "divergent-canonical", canonicalKey: "agent:ops:two" }),
      ]);
      const transcriptReads = reads();
      expect(transcriptReads.length).toBeGreaterThan(0);
      expect(new Set(transcriptReads.flatMap((read) => read.parameters))).toEqual(
        new Set(["agent:main:two", "agent:ops:two"]),
      );
      expect(transcriptReads.filter((read) => read.eager)).toEqual([]);
    });
  },
);

function seedSessions(stateDir: string, agentId: string, keys: string[]): void {
  const databasePath = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (const key of keys) {
        writeSessionEntry(
          database,
          key,
          { sessionId: key, updatedAt: 100 },
          { allowStoredAliases: true, previousEntry: null },
        );
        for (let index = 0; index < 3; index += 1) {
          appendTranscriptEventInTransaction(
            database,
            { agentId, path: databasePath, sessionId: key, sessionKey: key },
            { type: "message", id: `${key}-${index}`, text: "synthetic transcript" },
            { allowStoredAlias: true },
          );
        }
      }
    },
    { agentId, path: databasePath },
  );
}

function recordTranscriptReads() {
  const eager = vi.spyOn(sqlite, "executeSqliteQuerySync");
  const streamed = vi.spyOn(sqlite, "iterateSqliteQuerySync");
  return () =>
    [eager, streamed].flatMap((spy) =>
      spy.mock.calls.flatMap(([, query]) => {
        const compiled = query.compile();
        return /^select .* from "transcript_events"/.test(compiled.sql)
          ? [{ eager: spy === eager, parameters: compiled.parameters }]
          : [];
      }),
    );
}
