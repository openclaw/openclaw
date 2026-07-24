import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { emitTrustedAISafetyDiagnosticEvent } from "./diagnostic-events.js";
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

    emitTrustedAISafetyDiagnosticEvent({
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

  it("persists host-stamped plugin provenance for authorized emissions", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-safety-provenance-"));
    tempDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    ensureSafetyEventStoreBridge();

    emitTrustedAISafetyDiagnosticEvent(
      {
        type: "ai_safety.external_content.consumed",
        sessionId: "session-provenance",
        sourceType: "mcp_tool",
        trusted: false,
      },
      { pluginId: "third-party-plugin", trusted: false },
    );

    const [event] = querySafetyEvents({ sessionId: "session-provenance" }).events;
    expect(event).toMatchObject({
      meta: { trusted: false, pluginId: "third-party-plugin" },
    });
  });

  it("bounds and redacts policy-provided block reasons before durable storage", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-safety-reason-"));
    tempDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    ensureSafetyEventStoreBridge();

    const bearerCredential = "abcdef1234567890ghijklmn";
    emitTrustedAISafetyDiagnosticEvent({
      type: "ai_safety.tool_policy.decision",
      sessionId: "session-reason",
      toolName: "exec",
      decision: "blocked",
      policySource: "plugin",
      severity: "warn",
      reason: `first line\nsecond\u0007line Authorization: Bearer ${bearerCredential} ${"x".repeat(400)}`,
    });

    const [event] = querySafetyEvents({ sessionId: "session-reason" }).events;
    expect(event).toBeDefined();
    expect(event!.message.length).toBeLessThanOrEqual(256);
    expect(event!.message).not.toContain("\n");
    expect(event!.message).not.toContain("\u0007");
    expect(event!.message).toContain("first line second line");
    expect(event!.message).not.toContain(bearerCredential);
    expect(event!.meta).toMatchObject({ trusted: true, messageTruncated: true });
  });

  it("stores the event type when a policy decision has no reason", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-safety-noreason-"));
    tempDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    ensureSafetyEventStoreBridge();

    emitTrustedAISafetyDiagnosticEvent({
      type: "ai_safety.tool_policy.decision",
      sessionId: "session-noreason",
      toolName: "exec",
      decision: "allowed",
      policySource: "static_config",
      severity: "info",
    });

    const [event] = querySafetyEvents({ sessionId: "session-noreason" }).events;
    expect(event).toMatchObject({
      message: "ai_safety.tool_policy.decision",
      meta: { trusted: true },
    });
    expect(event!.meta).not.toHaveProperty("messageTruncated");
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

    emitTrustedAISafetyDiagnosticEvent({
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
