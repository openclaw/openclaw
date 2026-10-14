import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionId = "legacy-pending-delivery";
const sessionKey = "agent:ops:legacy-pending-delivery";
const pending = {
  kind: "replayable",
  text: "Saved July reply",
  createdAt: 1710000000000,
  context: { channel: "telegram", to: "synthetic-recipient" },
  intentId: "legacy-pending-intent",
};

function fixture() {
  const root = tempDirs.make("legacy-delivery-proof-");
  const state = path.join(root, "state");
  const artifacts = path.join(root, "artifacts");
  const database = path.join(state, "agents/ops/agent/openclaw-agent.sqlite");
  const archive = path.join(state, "sessions.archived.json");
  const metadata = path.join(artifacts, "legacy-operator-pending-delivery.json");
  const witness = path.join(artifacts, "legacy-operator-pending-delivery-before-start.json");
  mkdirSync(path.dirname(database), { recursive: true });
  mkdirSync(artifacts);
  const original = JSON.stringify({
    [sessionKey]: {
      sessionId,
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: pending.text,
      pendingFinalDeliveryCreatedAt: pending.createdAt,
      pendingFinalDeliveryContext: pending.context,
      pendingFinalDeliveryIntentId: pending.intentId,
    },
  });
  const storePath = path.join(state, "agents/ops/sessions/sessions.json");
  writeFileSync(metadata, JSON.stringify({ storePath, original }));
  writeFileSync(archive, original);
  mkdirSync(path.join(state, "session-sqlite-migration-runs"));
  writeFileSync(
    path.join(state, "session-sqlite-migration-runs/import.json"),
    JSON.stringify({
      completedAt: 1,
      targets: [
        { completedMoves: [{ kind: "legacy-store", sourcePath: storePath, archivePath: archive }] },
      ],
    }),
  );
  const seedDb = new DatabaseSync(database);
  seedDb.exec(`
    CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, entry_json TEXT);
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER);
  `);
  seedDb
    .prepare("INSERT INTO session_nodes VALUES (?, ?, ?)")
    .run(sessionKey, sessionId, JSON.stringify({ sessionId, pendingFinalDelivery: pending }));
  seedDb.close();
  const updateJson = path.join(artifacts, "update.json");
  const updateErr = path.join(artifacts, "update.err");
  writeFileSync(updateJson, "{}");
  writeFileSync(updateErr, "");
  const invoke = (command: string, args: string[], mode = "auto-auth") =>
    spawnSync(
      process.execPath,
      ["scripts/e2e/lib/upgrade-survivor/assertions.mjs", command, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
          OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: mode,
        },
      },
    );
  return {
    archive,
    database,
    metadata,
    witness,
    capture: () => invoke("capture-legacy-operator-pending-delivery", [state, artifacts]),
    verify: (mode = "auto-auth") =>
      invoke("assert-legacy-operator-pending-delivery", [updateJson, updateErr], mode),
    setPending(value: Record<string, unknown>) {
      const db = new DatabaseSync(database);
      try {
        db.prepare("UPDATE session_nodes SET entry_json = ?").run(
          JSON.stringify({ sessionId, pendingFinalDelivery: value }),
        );
      } finally {
        db.close();
      }
    },
    recover(text = pending.text, sourceSessionKey = sessionKey, targetSessionId = sessionId) {
      this.setPending({ ...pending, text: "OPENCLAW_E2E_OK", intentId: "new-recovery-intent" });
      const payload = Buffer.from(
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            provenance: {
              kind: "internal_system",
              sourceTool: "main_session_restart_recovery",
              sourceSessionKey,
            },
            content: [
              { type: "text", text: `Note: The interrupted final reply was captured: "${text}"` },
            ],
          },
        }),
      );
      const db = new DatabaseSync(database);
      try {
        db.prepare("INSERT INTO transcript_events VALUES (?, 1, NULL, ?, ?)").run(
          targetSessionId,
          zstdCompressSync(payload),
          payload.byteLength,
        );
      } finally {
        db.close();
      }
    },
  };
}

it("keeps exact migration proof before restart recovery adopts the saved final", () => {
  const f = fixture();
  const manual = f.verify("manual");
  expect(manual.status, manual.stderr).toBe(0);
  renameSync(f.metadata, `${f.metadata}.parked`);
  expect(f.capture().status).toBe(0);
  expect(existsSync(f.witness)).toBe(false);
  renameSync(`${f.metadata}.parked`, f.metadata);
  const capture = f.capture();
  expect(capture.status, capture.stderr).toBe(0);
  const saved = readFileSync(f.witness, "utf8");
  const retained = f.verify();
  expect(retained.status, retained.stderr).toBe(0);
  f.recover();
  expect(f.capture().status).toBe(0);
  expect(readFileSync(f.witness, "utf8")).toBe(saved);
  const recovered = f.verify();
  expect(recovered.status, recovered.stderr).toBe(0);
});

it.each([
  ["missing witness", "legacy-operator-pending-delivery-before-start.json"],
  ["observation failure", "pre-start legacy delivery observation failed"],
  ["changed imported intent", "legacy-pending-intent"],
  ["changed archive", "did not archive the original legacy session bytes"],
  ["lost reply", "without retaining its saved reply"],
  ["wrong recovery provenance", "without retaining its saved reply"],
  ["foreign transcript", "without retaining its saved reply"],
])("rejects %s instead of accepting a replacement marker", (fault, reason) => {
  const f = fixture();
  if (fault === "changed imported intent") {
    f.setPending({ ...pending, intentId: "wrong-intent" });
  }
  if (fault === "observation failure") {
    renameSync(f.database, `${f.database}.parked`);
  }
  if (fault !== "missing witness") {
    const capture = f.capture();
    expect(capture.status, capture.stderr).toBe(0);
  }
  if (fault === "observation failure") {
    renameSync(`${f.database}.parked`, f.database);
  }
  if (fault === "changed archive") {
    writeFileSync(f.archive, "changed");
  }
  if (fault === "lost reply") {
    f.recover("a different reply");
  }
  if (fault === "wrong recovery provenance") {
    f.recover(pending.text, "agent:ops:another");
  }
  if (fault === "foreign transcript") {
    f.recover(pending.text, sessionKey, "another-session");
  }
  const result = f.verify();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(reason);
});
