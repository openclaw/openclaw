import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { emitTrustedAISafetyEvent } from "./diagnostic-ai-safety-events.js";
import { ensureSafetyEventStoreBridge, querySafetyEvents } from "./safety-event-store.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("safety event store", () => {
  it("adds its table when reopening a pre-feature state database", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-safety-upgrade-"));
    tempDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const beforeUpgrade = openOpenClawStateDatabase();
    const schemaVersion = beforeUpgrade.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    beforeUpgrade.db.exec("DROP TABLE ai_safety_events");
    closeOpenClawStateDatabaseForTest();

    expect(querySafetyEvents({}).events).toEqual([]);
    const afterUpgrade = openOpenClawStateDatabase();
    expect(afterUpgrade.db.prepare("PRAGMA user_version").get()).toEqual(schemaVersion);
    expect(
      afterUpgrade.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("ai_safety_events"),
    ).toMatchObject({ name: "ai_safety_events" });
  });

  it("retains metadata-only history across state database reopen", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-safety-events-"));
    tempDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    ensureSafetyEventStoreBridge();

    emitTrustedAISafetyEvent({
      type: "ai_safety.external_content.consumed",
      sessionId: "session-durable",
      sourceType: "web_fetch",
      trusted: false,
    });

    expect(querySafetyEvents({ sessionId: "session-durable" }).events).toHaveLength(1);
    closeOpenClawStateDatabaseForTest();
    const afterReopen = querySafetyEvents({ sessionId: "session-durable" }).events;
    expect(afterReopen).toHaveLength(1);
    expect(afterReopen[0]).toMatchObject({
      type: "ai_safety.external_content.consumed",
      sessionId: "session-durable",
      meta: { trusted: true },
    });
  });

  it("caps durable history at 10,000 records", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-safety-retention-"));
    tempDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    ensureSafetyEventStoreBridge();

    const database = openOpenClawStateDatabase().db;
    database.exec(`
      WITH RECURSIVE generated(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM generated WHERE value < 10000
      )
      INSERT INTO ai_safety_events (
        event_type, severity, message, meta_json, recorded_at_ms
      )
      SELECT 'ai_safety.eval.result', 'info', 'seed', '{}', value
      FROM generated
    `);

    emitTrustedAISafetyEvent({
      type: "ai_safety.eval.result",
      sessionId: "session-retention",
      evalName: "retention-proof",
      score: 1,
      passed: true,
      severity: "info",
    });

    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count, MIN(sequence) AS minimum, MAX(sequence) AS maximum FROM ai_safety_events",
        )
        .get(),
    ).toEqual({ count: 10_000, minimum: 2, maximum: 10_001 });
  });
});
