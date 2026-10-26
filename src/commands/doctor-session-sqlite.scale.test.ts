import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as legacyInspection from "../config/sessions/legacy-store-inspection.js";
import * as migrationReaders from "../infra/session-sqlite-migration-readers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";
import { appendLegacyHistoricalTranscripts } from "./doctor-session-sqlite-discovery.js";
import * as retirement from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { retainedHistoryMove } from "./doctor-session-sqlite.recovery-fixtures.test-support.js";

const ENTRY_COUNT = 500_000;

afterEach(() => vi.restoreAllMocks());

it("preserves archived ownership with half a million metadata entries", async () => {
  await withOpenClawTestState({ label: "doctor-archive-scale" }, async (state) => {
    const directory = state.sessionsDir();
    fs.mkdirSync(directory, { recursive: true });
    const target = { agentId: "main", storePath: path.join(directory, "sessions.json") };
    const archivePath = path.join(directory, "sessions.json.original");
    fs.writeFileSync(archivePath, "{}");
    const transcriptPath = path.join(directory, "history.jsonl.original");
    fs.writeFileSync(transcriptPath, "{}\n");
    const entries = Array.from({ length: ENTRY_COUNT }, (_, index) => ({
      sessionKey: `agent:main:dashboard:${index}`,
      entry: { sessionId: `history-${index}`, updatedAt: 1, sessionFile: "sqlite:main:id:/unused" },
    }));
    vi.spyOn(legacyInspection, "readLegacySessionStoreEntries").mockReturnValue({ entries });
    vi.spyOn(migrationReaders, "readLegacyPrimaryTranscriptIdentity").mockReturnValue({
      sessionId: `history-${ENTRY_COUNT - 1}`,
      filenameId: `history-${ENTRY_COUNT - 1}`,
      updatedAt: 1,
    });
    const records: Parameters<typeof appendLegacyHistoricalTranscripts>[0]["allRecords"] = [];
    const issues: Parameters<typeof appendLegacyHistoricalTranscripts>[0]["issues"] = [];
    await appendLegacyHistoricalTranscripts({
      target,
      allRecords: records,
      sourceConflicts: new Map(),
      issues,
      historicalArchives: new Map([
        [
          target.storePath,
          {
            stores: [
              { ...retainedHistoryMove(target.storePath, archivePath), kind: "legacy-store" },
            ],
            transcripts: [
              retainedHistoryMove(path.join(directory, "history.jsonl"), transcriptPath),
            ],
          },
        ],
      ]),
    });
    expect(issues).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionKey: `agent:main:dashboard:${ENTRY_COUNT - 1}`,
      entry: { sessionId: `history-${ENTRY_COUNT - 1}` },
      transcriptPath,
    });
  });
});

it("reports half a million retained archive failures without aborting session repair", async () => {
  await withOpenClawTestState({ label: "doctor-settlement-scale" }, async (state) => {
    const fixture = createCanonicalRepairFixture(state.stateDir);
    const database = fixture.database();
    const target = {
      agentId: "main",
      storePath: fixture.scope().storePath,
      sqlitePath: database.path,
    };
    const issue = {
      code: "historical_transcript_deferred" as const,
      message: "Original retained.",
    };
    vi.spyOn(retirement, "settleDuplicateSessionSqliteArchives").mockResolvedValue(
      Array.from({ length: ENTRY_COUNT }, () => ({ target, issues: [issue] })),
    );
    const report = await runDoctorSessionSqlite({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "import",
      store: target.storePath,
    });
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]?.issues).toHaveLength(ENTRY_COUNT);
    expect(report.targets[0]?.issues.at(-1)).toEqual(issue);
    expect(report.totals.issues).toBe(ENTRY_COUNT);
  });
});
