import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSessionSqliteMigrationRunsDir } from "../infra/session-sqlite-migration-manifest.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readSessionSqliteMigrationWarnings } from "./doctor-session-sqlite-warnings.js";

const PRUNED_KEY = "agent:main:pruned";
const LIVE_KEY = "agent:main:live";
const CASED_LIVE_KEY = "agent:main:discord:channel:AbC123";
const NON_CANONICAL_KEYS = [
  "legacy-bare",
  "agent:main:main",
  "agent:ops:pruned",
  "agent:main:Mixed",
];

function writeCompletedManifest(state: OpenClawTestState, sqlitePath: string): string {
  const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
  const issue = (code: string, sessionKey: string, message = `${code} for ${sessionKey}`) => ({
    code,
    message,
    sessionKey,
  });
  const manifestPath = path.join(
    resolveSessionSqliteMigrationRunsDir(state.env),
    "session-sqlite-1-fixture.json",
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      completedAt: "2026-09-11T00:00:00.000Z",
      manifestVersion: 3,
      openClawVersion: "2026.9.6",
      runId: "session-sqlite-1-fixture",
      startedAt: "2026-09-11T00:00:00.000Z",
      targets: [
        {
          agentId: "main",
          completedMoves: [],
          issues: [
            issue("transcript_missing", PRUNED_KEY, "Transcript file is missing: /gone/pruned"),
            issue("transcript_missing", LIVE_KEY, "Transcript file is missing: /gone/live"),
            issue(
              "transcript_missing",
              CASED_LIVE_KEY.toLowerCase(),
              "Transcript file is missing: /gone/cased",
            ),
            // Canonical-key repair may have renamed these rows, so absence proves nothing.
            ...NON_CANONICAL_KEYS.map((sessionKey) =>
              issue("transcript_missing", sessionKey, `Transcript file is missing: ${sessionKey}`),
            ),
            issue("transcript_malformed", PRUNED_KEY),
            issue("historical_transcript_deferred", PRUNED_KEY),
          ],
          plannedMoves: [],
          sqlitePath,
          storePath,
          validationBeforeArchive: "passed",
        },
      ],
    })}\n`,
  );
  return manifestPath;
}

describe("readSessionSqliteMigrationWarnings", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("hides missing-transcript warnings whose session row was pruned", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      for (const [sessionKey, sessionId] of [
        [LIVE_KEY, "live"],
        [CASED_LIVE_KEY, "cased"],
      ] as const) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          { sessionId, updatedAt: Date.now() },
        );
      }
      closeOpenClawAgentDatabasesForTest();
      const sqlitePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      const manifestPath = writeCompletedManifest(state, sqlitePath);
      const manifestBytes = fs.readFileSync(manifestPath);

      const warnings = readSessionSqliteMigrationWarnings(state.env);

      expect(warnings.map((warning) => warning.split(": [")[1])).toEqual([
        "transcript_missing] Transcript file is missing: /gone/live",
        "transcript_missing] Transcript file is missing: /gone/cased",
        ...NON_CANONICAL_KEYS.map(
          (sessionKey) => `transcript_missing] Transcript file is missing: ${sessionKey}`,
        ),
        `transcript_malformed] transcript_malformed for ${PRUNED_KEY}`,
        `historical_transcript_deferred] historical_transcript_deferred for ${PRUNED_KEY}`,
      ]);
      expect(fs.readFileSync(manifestPath)).toEqual(manifestBytes);
    });
  });

  it.each([
    ["missing", () => {}],
    [
      "unreadable",
      (sqlitePath: string) => {
        fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
        fs.writeFileSync(sqlitePath, "not a sqlite database");
      },
    ],
  ] as const)("keeps missing-transcript warnings when the store is %s", async (_, prepare) => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const sqlitePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      prepare(sqlitePath);
      const manifestPath = writeCompletedManifest(state, sqlitePath);
      const manifestBytes = fs.readFileSync(manifestPath);

      const warnings = readSessionSqliteMigrationWarnings(state.env);

      expect(warnings).toHaveLength(5 + NON_CANONICAL_KEYS.length);
      expect(warnings[0]).toContain("Transcript file is missing: /gone/pruned");
      expect(fs.readFileSync(manifestPath)).toEqual(manifestBytes);
    });
  });
});
