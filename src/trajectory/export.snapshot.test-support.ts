import assert from "node:assert/strict";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { exportTrajectoryBundle } from "./export.js";
import { assistantText, userMessage, sessionHeader, messageEntry } from "./export.test-helpers.js";
import { TRAJECTORY_RUNTIME_EVENT_MAX_BYTES } from "./paths.js";
import { loadSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

assert.equal(isMainThread, true, "snapshot capture requires its native database host");
await withOpenClawTestState({ layout: "state-only" }, async (state) => {
  const tmpDir = state.root;
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
  const recorder = await createTrajectoryRuntimeRecorder({
    sessionId: sessionTarget.sessionId,
    sessionKey: sessionTarget.sessionKey,
    sessionTarget,
    runId: "large-snapshot",
    workspaceDir: tmpDir,
  });
  assert.ok(recorder, "trajectory recorder");
  recorder.recordEvent("model.completed", { messagesSnapshot: snapshot, stopReason: "stop" });
  await recorder.flush();
  const stored = await loadSqliteTrajectoryRuntimeEvents(sessionTarget);
  for (const event of stored) {
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES);
  }
  const bundle = await exportTrajectoryBundle({
    outputDir: path.join(tmpDir, "bundle"),
    workspaceDir: tmpDir,
    sessionId: sessionTarget.sessionId,
    sessionTarget,
  });
  const completed = bundle.events.find((event) => event.type === "model.completed");
  assert.deepEqual(
    completed?.data?.messagesSnapshot,
    snapshot,
    "snapshot payload was not preserved",
  );
  assert.equal(completed?.data?.truncated, undefined);
  assert.equal(bundle.manifest.runtimeEventCount, 1);
});
