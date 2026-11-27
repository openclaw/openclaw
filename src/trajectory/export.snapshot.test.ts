import { hash } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sanitizeTrajectoryExportPayload } from "../agents/payload-redaction.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { exportTrajectoryBundle } from "./export.js";
import { assistantText, userMessage, sessionHeader, messageEntry } from "./export.test-helpers.js";
import { TRAJECTORY_RUNTIME_EVENT_MAX_BYTES } from "./paths.js";
import { loadSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  tempDirs.cleanup();
});

it("exports a complete large snapshot through the recorder and bounded SQLite rows", async () => {
  const tmpDir = tempDirs.make("trajectory-snapshot-");
  const sessionTarget = {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    storePath: path.join(tmpDir, "sessions.json"),
  };
  const snapshot = Array.from({ length: 12 }, (_, index) => {
    const text = `message-${index}: ${"日本語 snapshot ".repeat(2500)}`;
    return index % 2 === 0 ? userMessage(text) : assistantText(text);
  });
  await replaceTranscriptEvents(sessionTarget, [
    sessionHeader(tmpDir),
    ...snapshot.map((message, index) =>
      messageEntry(`entry-${index}`, index ? `entry-${index - 1}` : null, message),
    ),
  ]);
  const recorder = expectDefined(
    await createTrajectoryRuntimeRecorder({
      sessionId: sessionTarget.sessionId,
      sessionKey: sessionTarget.sessionKey,
      sessionTarget,
      runId: "large-snapshot",
      workspaceDir: tmpDir,
    }),
    "trajectory recorder",
  );
  recorder.recordEvent("model.completed", { messagesSnapshot: snapshot, stopReason: "stop" });
  await recorder.flush();
  const stored = await loadSqliteTrajectoryRuntimeEvents(sessionTarget);
  for (const event of stored) {
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
    );
  }
  const bundle = await exportTrajectoryBundle({
    outputDir: path.join(tmpDir, "bundle"),
    workspaceDir: tmpDir,
    sessionId: sessionTarget.sessionId,
    sessionTarget,
  });
  const completed = bundle.events.find((event) => event.type === "model.completed");
  expect(completed?.data?.messagesSnapshot, "snapshot payload was not preserved").toEqual(snapshot);
  expect(completed?.data?.truncated).toBeUndefined();
  expect(bundle.manifest.runtimeEventCount).toBe(1);
  const privateChecksum = hash("sha256", JSON.stringify(snapshot));
  expect(JSON.stringify(stored)).toContain(privateChecksum);
  expect(
    JSON.stringify(sanitizeTrajectoryExportPayload(stored)),
    "legacy export exposed snapshot checksum",
  ).not.toContain(privateChecksum);
});
