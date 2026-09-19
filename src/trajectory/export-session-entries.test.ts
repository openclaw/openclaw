// Trajectory session entry reader tests cover SQLite storage lifecycle during export.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { assertNoOpenClawAgentDatabaseLeasesReadOnly } from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { exportTrajectoryBundle } from "./export.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-session-"));
let tempDirId = 0;

function makeTempDir(): string {
  const dir = path.join(tempRoot, `case-${tempDirId++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("trajectory session export reads", () => {
  it("exports SQLite-backed sessions without joining the writable database lifecycle", async () => {
    const tmpDir = makeTempDir();
    const storePath = path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite");
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
        cwd: tmpDir,
      },
      {
        type: "message",
        id: "entry-user",
        parentId: null,
        timestamp: "2026-04-01T05:46:40.000Z",
        message: { role: "user", content: "hello from a closed store", timestamp: 1 },
      },
    ]);
    closeOpenClawAgentDatabasesForTest();
    // Windows has no distinct group/other permission bits to preserve.
    const checkMode = process.platform !== "win32";
    if (checkMode) {
      fs.chmodSync(storePath, 0o640);
    }

    for (const [name, source] of [
      ["target", { sessionTarget: scope }],
      [
        "marker",
        { sessionFile: formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath }) },
      ],
    ] as const) {
      const bundle = await exportTrajectoryBundle({
        outputDir: path.join(tmpDir, `bundle-${name}`),
        ...source,
        sessionId,
        sessionKey,
        workspaceDir: tmpDir,
      });

      expect(bundle.events.map((event) => event.type)).toEqual(["user.message"]);
      expect(getOpenClawAgentDatabaseIfOpen({ agentId: "main", path: storePath })).toBeUndefined();
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly()).not.toThrow();
      if (checkMode) {
        expect(fs.statSync(storePath).mode & 0o777).toBe(0o640);
      }
    }
  });

  it("restores a cold-archived transcript before exporting it", async () => {
    const tmpDir = makeTempDir();
    const storePath = path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await createSessionColdStorageFixture(storePath);
    await expect(
      runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });

    const bundle = await exportTrajectoryBundle({
      outputDir: path.join(tmpDir, "bundle"),
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: historicalId,
        storePath,
      }),
      sessionId: historicalId,
      workspaceDir: tmpDir,
    });

    expect(bundle.events.map((event) => event.type)).toEqual(["user.message", "assistant.message"]);
  });
});
