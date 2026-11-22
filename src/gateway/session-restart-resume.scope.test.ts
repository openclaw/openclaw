import { expect, it, vi } from "vitest";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadExactSessionEntry,
} from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { retainSessionColdNavigationInTransaction } from "../config/sessions/session-cold-storage-navigation.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { readSessionPendingInput } from "../config/sessions/session-pending-input-history.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as gatewayDispatch from "./server-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { resumeMarkedSessions } from "./session-restart-resume.js";
import * as systemTurnAuthority from "./session-system-turn-authority.js";

const cfg = { agents: { entries: { main: {} } } };
const setScope = (scope: string | undefined) =>
  vi.stubEnv("OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE", scope);

/** A session whose process was lost (no graceful marker) with a message queued behind its work. */
async function crashSession(
  name: string,
  run: "chat" | "requester-settle" | "ended" | "none",
  written: string | undefined,
) {
  const target = { agentId: "main", sessionKey: `agent:main:${name}`, sessionId: name };
  // Database workers copy the environment when they start: set the scope before the first write.
  setScope(written);
  replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 100 });
  const runId =
    run === "requester-settle"
      ? `announce:requester-settle:main:${target.sessionKey}:child-run`
      : `${name}-run`;
  if (run === "requester-settle") {
    // A committed child result: restart recovery resumes this requester turn as orphaned work.
    await appendTranscriptMessage(target, {
      message: {
        role: "user",
        content: "Captured child result",
        timestamp: 105,
        idempotencyKey: `${runId}:user`,
        provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
      },
    });
  }
  const events =
    run === "none"
      ? []
      : [
          { ts: 110, data: { phase: "start", startedAt: 110 } },
          ...(run === "ended" ? [{ ts: 120, data: { phase: "end", stopReason: "end_turn" } }] : []),
        ];
  for (const event of events) {
    await persistGatewaySessionLifecycleEvent({
      sessionKey: target.sessionKey,
      event: { ...event, runId, sessionId: target.sessionId },
    });
  }
  expect(loadExactSessionEntry(target)?.entry.lifecycleRestartScope).toBe(
    run === "none" ? undefined : written,
  );
  const queued = await stageSessionPendingInput(target, {
    runId: `${name}-queued`,
    message: {
      role: "user",
      content: "Queued before process loss",
      timestamp: 111,
      idempotencyKey: `${name}-queued:user`,
    },
    assertCurrent() {},
  });
  expect(queued).toBeDefined();
  queued!.finish("interrupted", "failed");
  await queued!.settled?.();
  openOpenClawAgentDatabase({ agentId: "main" })
    .db.prepare(
      "UPDATE session_pending_inputs SET state = 'queued', lifecycle_generation = 'previous-process' WHERE input_id = ?",
    )
    .run(queued!.inputId);
  return { target, inputId: queued!.inputId };
}

function observeAdmission() {
  // Restart admission starts with the session principal's authority. Stop there: reaching it
  // is the resume decision under test.
  const admission = vi
    .spyOn(systemTurnAuthority, "prepareSessionSystemTurnAuthority")
    .mockRejectedValue(new Error("Stop after observing crash recovery admission"));
  const dispatch = vi
    .spyOn(gatewayDispatch, "dispatchGatewayRequestInProcess")
    .mockResolvedValue({});
  return { admission, dispatch };
}

// Crash recovery (no graceful marker) compares the scope the interrupted run started under.
// Queued input of a session whose work is out of scope, or that has no scope evidence while a
// token is set, ends without a replay attempt. No token on either side behaves as before.
it.for([
  { run: "chat", written: "token-a", startup: "token-a", resumes: true },
  { run: "chat", written: "token-a", startup: "token-b", resumes: false },
  { run: "chat", written: undefined, startup: "token-b", resumes: false },
  { run: "chat", written: "token-a", startup: undefined, resumes: false },
  { run: "chat", written: undefined, startup: undefined, resumes: true },
  { run: "requester-settle", written: "token-a", startup: "token-a", resumes: true },
  { run: "requester-settle", written: "token-a", startup: "token-b", resumes: false },
  { run: "ended", written: "token-a", startup: "token-a", resumes: true },
  { run: "ended", written: "token-a", startup: "token-b", resumes: false },
  { run: "none", written: undefined, startup: "token-b", resumes: false },
  { run: "none", written: undefined, startup: undefined, resumes: true },
] as const)(
  "recovers a $run crash interrupted under scope $written only at startup scope $startup",
  ({ run, written, startup, resumes }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      const name = `crash-${run}-${written ?? "none"}-${startup ?? "none"}`;
      const { target, inputId } = await crashSession(name, run, written);
      const { admission, dispatch } = observeAdmission();
      try {
        setScope(startup);
        const context = createContext([], () => cfg);
        context.restartResumeWindows = { main: [{ startedAt: 100, endedAt: 200 }] };
        await resumeMarkedSessions({
          context,
          signal: new AbortController().signal,
          log: { warn: vi.fn() },
        });
        const interrupted = run === "chat" || run === "requester-settle";
        expect(admission.mock.calls.length > 0).toBe(resumes && interrupted);
        expect(dispatch).not.toHaveBeenCalled();
        expect(loadExactSessionEntry(target)?.entry.lifecycleRunId).toBeUndefined();
        expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();
        // In scope, startup replays the queued input (which fails here without a sender);
        // out of scope, it ends without a replay attempt.
        expect(
          vi
            .mocked(context.logGateway.warn)
            .mock.calls.some(([line]) => line.includes("was not sent after restart")),
        ).toBe(resumes);
        expect(await readSessionPendingInput(target, inputId)).toMatchObject({
          state: "cancelled",
          endCause: "restart-unrecoverable",
          message: { content: "Queued before process loss" },
        });
      } finally {
        admission.mockRestore();
        dispatch.mockRestore();
      }
    }),
);

it("keeps a recovered crash marker in scope across a second restart", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    const { target } = await crashSession("crash-twice", "chat", "token-a");
    const { admission, dispatch } = observeAdmission();
    try {
      // The first start recovers the crashed run, then stops before the resume is accepted.
      const first = new AbortController();
      admission.mockImplementationOnce(async () => {
        first.abort(new Error("Gateway stopped during restart admission"));
        throw new Error("Stopped");
      });
      const context = createContext([], () => cfg);
      context.restartResumeWindows = { main: [{ startedAt: 100, endedAt: 200 }] };
      await expect(
        resumeMarkedSessions({ context, signal: first.signal, log: { warn: vi.fn() } }),
      ).rejects.toThrow();
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual({
        scope: "token-a",
      });
      await resumeMarkedSessions({
        context: createContext([], () => cfg),
        signal: new AbortController().signal,
        log: { warn: vi.fn() },
      });
      expect(admission).toHaveBeenCalledTimes(2);
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();
    } finally {
      admission.mockRestore();
      dispatch.mockRestore();
    }
  }));

it.for(["archived", "done", "killed", "failed", "unset"] as const)(
  "settles a cold %s restart marker once without restoring its transcript",
  (kind) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:cold-restart" };
      const sessionId = "cold-restart";
      replaceSessionEntrySync(target, {
        sessionId,
        updatedAt: 1,
        ...(kind === "archived"
          ? { archivedAt: 2, status: "done" as const }
          : kind === "unset"
            ? {}
            : { status: kind }),
        lastRunId: "announce:requester-settle:old-child",
      });
      await appendTranscriptMessage(
        { ...target, sessionId },
        {
          message: {
            role: "user",
            content: "Old child result",
            timestamp: 1,
            idempotencyKey: "announce:requester-settle:old-child:user",
            provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
          },
        },
      );
      const marker =
        kind === "archived"
          ? { resumeAfterRestart: {} }
          : { mainRestartRecovery: { cycleId: "old-cycle" } };
      // Persist the stale historical shape: current writers already clear markers on archive.
      runOpenClawAgentWriteTransaction(
        (database) => {
          const { db } = database;
          db.prepare(
            "UPDATE session_nodes SET entry_json = json_patch(entry_json, ?) WHERE session_key = ?",
          ).run(JSON.stringify(marker), target.sessionKey);
          db.prepare(`INSERT INTO session_transcript_cold_archives
        (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
         archive_bytes, last_seq, archived_at, storage, archive_blob)
        VALUES (?, 'generation', 'unavailable.zst', ?, 1, 1, 1, 0, 1, 'file', NULL)`).run(
            sessionId,
            "0".repeat(64),
          );
          retainSessionColdNavigationInTransaction(database, sessionId, -1, 100);
        },
        { agentId: "main" },
      );
      const warn = vi.fn();
      const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost");
      try {
        expect(await readSessionEntryReadOnlyInWorker(target)).toMatchObject(marker);
        for (let restart = 0; restart < 2; restart++) {
          await resumeMarkedSessions({
            context: createContext([], () => cfg),
            signal: new AbortController().signal,
            log: { warn },
          });
          const entry = (await readSessionEntryReadOnlyInWorker(target))!;
          expect(entry.resumeAfterRestart).toBeUndefined();
          expect(entry.mainRestartRecovery).toBeUndefined();
          expect(resume).not.toHaveBeenCalled();
          expect(
            warn.mock.calls.some(([message]) => message.includes("SessionTranscriptColdError")),
          ).toBe(false);
          if (restart === 0) {
            warn.mockClear();
          }
        }
        expect(warn).not.toHaveBeenCalled();
        expect(
          openOpenClawAgentDatabase({ agentId: "main" })
            .db.prepare(
              "SELECT archive_name FROM session_transcript_cold_archives WHERE session_id = ?",
            )
            .get(sessionId),
        ).toEqual({ archive_name: "unavailable.zst" });
      } finally {
        resume.mockRestore();
      }
    }),
);
