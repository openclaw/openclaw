// Trajectory export storage tests cover the SQLite lifecycle the exporter joins.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { assertNoOpenClawAgentDatabaseLeasesReadOnly } from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
} from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { exportTrajectoryBundle } from "./export.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-storage-"));

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("trajectory export storage", () => {
  it("exports SQLite-backed sessions without joining the writable database lifecycle", async () => {
    const storePath = path.join(tempRoot, "agents", "main", "agent", "openclaw-agent.sqlite");
    const sessionId = "session-read-only";
    const sessionKey = "agent:main:session-read-only";
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-04-01T05:46:39.000Z",
        cwd: tempRoot,
      },
      {
        type: "message",
        id: "entry-user",
        parentId: null,
        timestamp: "2026-04-01T05:46:40.000Z",
        message: { role: "user", content: "hello from a closed store", timestamp: 1 },
      },
    ]);
    await closeOpenClawAgentDatabasesAsync();
    // Windows has no distinct group/other permission bits to preserve.
    const checkMode = process.platform !== "win32";
    if (checkMode) {
      fs.chmodSync(storePath, 0o640);
    }

    // The complete target and the legacy marker cover every session-entry lookup.
    for (const [name, source] of [
      ["target", { sessionTarget: scope }],
      [
        "marker",
        { sessionFile: formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath }) },
      ],
    ] as const) {
      const bundle = await exportTrajectoryBundle({
        outputDir: path.join(tempRoot, `bundle-${name}`),
        ...source,
        sessionId,
        sessionKey,
        workspaceDir: tempRoot,
      });

      expect(bundle.events.map((event) => event.type)).toEqual(["user.message"]);
      expect(getOpenClawAgentDatabaseIfOpen({ agentId: "main", path: storePath })).toBeUndefined();
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly()).not.toThrow();
      if (checkMode) {
        expect(fs.statSync(storePath).mode & 0o777).toBe(0o640);
      }
    }
  });
});
