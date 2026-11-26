import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import { getSession, waitForExecSession } from "../agents/bash-process-registry.js";
import { createProcessTool } from "../agents/bash-tools.process.js";
import { createShellCallAdmission } from "../agents/embedded-agent-runner/run/attempt-shell-call.js";
import { createLazyExecTool } from "../agents/lazy-exec-tool.js";
import { markShellCallResult } from "../agents/shell-call-receipt.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { applySessionEntryOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  loadTranscriptEventsSync,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  shellCallReceipt,
  shellCallResultKey,
} from "../config/sessions/transcript-shell-receipt.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const shellWriteOptions = { preserveActivity: true, skipMaintenance: true };

function seedShellSession(runId: string) {
  const db = openOpenClawAgentDatabase({ agentId: "main" });
  const target = {
    agentId: "main",
    sessionId: `${runId}-window`,
    sessionKey: "agent:main:main",
    storePath: db.path,
    expectedWriterRunId: runId,
    expectedLifecycleRevision: "rev",
  };
  const seed = {
    sessionId: target.sessionId,
    lifecycleRevision: target.expectedLifecycleRevision,
    activeWriterRunId: runId,
    updatedAt: 1,
  };
  writeSessionEntry(db, target.sessionKey, seed);
  const attempt = {
    admittedRunContext: createTestAdmittedRunContext(runId),
    runId,
    sessionKey: target.sessionKey,
    sessionTarget: target,
  };
  const admit = createShellCallAdmission(attempt)!;
  const pendingShellCalls = async () =>
    (await applySessionEntryOperation(target, { kind: "shell-call", runId }, shellWriteOptions))
      ?.pendingShellCalls;
  return { db, target, seed, attempt, admit, pendingShellCalls };
}

it.each([
  "manual-cancel",
  "signal",
  "memory-limit",
  "overall-timeout",
  "no-output-timeout",
] as const)(
  "keeps a supervisor %s uncertain even when the host reports a numeric exit code",
  (exitReason) => {
    const receipt = shellCallReceipt("run", "call");
    const result = markShellCallResult(
      { details: { status: "failed", exitCode: 137, exitReason, durationMs: 1, aggregated: "" } },
      receipt,
    );
    expect(shellCallResultKey(result, "run", "call")).toBeUndefined();
  },
);

it("launches the native shell only after a fenced write and reconciles only its saved result", async () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const runId = "original";
    const { db, target, seed, attempt, admit, pendingShellCalls } = seedShellSession(runId);
    const options = { host: "gateway", ask: "off", admitShellCall: admit } as const;
    const shell = createLazyExecTool({ ...options, security: "full" });
    const saveResult = (
      toolName: string,
      toolCallId: string,
      result: { content: unknown; details: unknown },
    ) =>
      appendTranscriptMessage(target, {
        message: {
          role: "toolResult",
          toolName,
          toolCallId,
          content: result.content,
          details: result.details,
          idempotencyKey: shellCallResultKey(result, runId, toolCallId),
          timestamp: Date.now(),
        },
      });
    const file = state.statePath("shell-effect");
    const invoke = () =>
      shell.execute("actual-call", { command: `printf ok > '${file}'; printf done` });
    const denied = createLazyExecTool({ ...options, security: "deny" });
    await expect(
      denied.execute("denied-command", { command: "printf prohibited" }),
    ).rejects.toThrow("security=deny");
    expect(await pendingShellCalls()).toBeUndefined();
    const result = await invoke();
    expect(readFileSync(file, "utf8")).toBe("ok");
    expect(result.content).toMatchObject([{ text: expect.stringContaining("done") }]);
    const key = shellCallResultKey(result, runId, "actual-call");
    expect(shellCallResultKey(result, runId, "outer-controller")).toBeUndefined();
    // Successful execution alone cannot acknowledge an effect. A stale whole-row save cannot erase it.
    writeSessionEntry(db, target.sessionKey, { ...seed, label: "renamed" });
    const pending = (await pendingShellCalls())?.calls;
    expect(pending).toHaveLength(1);
    expect(key?.startsWith(pending![0]!.key + "/")).toBe(true);
    await expect(invoke()).rejects.toThrow("already admitted");
    await saveResult("exec", "actual-call", result);
    expect(await pendingShellCalls()).toBeUndefined();
    const running = await shell.execute("background", {
      command: "sleep 0.15 && printf polled",
      background: true,
    });
    expect(running.details).toMatchObject({ status: "running" });
    expect(shellCallResultKey(running, runId, "background")).toBeUndefined();
    const sessionId = (running.details as { sessionId: string }).sessionId;
    // Poll can wake on fresh output before exit. Join the actual process owner before testing terminal observations.
    const processSession = getSession(sessionId);
    if (processSession) {
      await waitForExecSession(processSession);
    }
    const processTool = createProcessTool();
    const poll = (id: string) =>
      processTool.execute(id, { action: "poll", sessionId, timeout: 5000 });
    const result1 = await poll("poll-one");
    const result2 = await poll("poll-two");
    expect(result1.details).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: "polled",
    });
    const observation = shellCallResultKey(result2, runId, "poll-two");
    expect(observation).toEqual(expect.any(String));
    expect(observation).not.toBe(shellCallResultKey(result1, runId, "poll-one"));
    expect(shellCallResultKey(result2, "another-run", "poll-two")).toBeUndefined();
    expect((await pendingShellCalls())?.calls).toHaveLength(1);
    // The second poll can settle an earlier command even if the first result never attached.
    await saveResult("process", "poll-two", result2);
    expect(await pendingShellCalls()).toBeUndefined();
    // Unacknowledged effects are bounded. Refuse before starting the next command.
    for (let index = 0; index < 64; index++) {
      const call = { callId: `pending-${index}`, key: `receipt-${index}` };
      await applySessionEntryOperation(
        target,
        { kind: "shell-call", runId, call },
        shellWriteOptions,
      );
    }
    const expectRefused = async (callId: string, message: string) => {
      const path = state.statePath(callId);
      await expect(
        shell.execute(callId, { command: `printf unexpected > '${path}'` }),
      ).rejects.toThrow(message);
      expect(existsSync(path)).toBe(false);
    };
    await expectRefused("overflow", "Too many shell commands are awaiting a saved result");
    writeSessionEntry(db, target.sessionKey, { ...seed, activeWriterRunId: "replacement" });
    await expectRefused("new-call", "restart receipt could not be saved");
    expect(createShellCallAdmission({ ...attempt, oneShotCliRun: true })).toBeUndefined();
  }));

it("keeps pending approvals uncertain and records a deferred outcome only for its original call", async () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { db, target, seed, admit, pendingShellCalls } = seedShellSession("approval-owner");
    const pending = await admit("waiting");
    const denied = await admit("denied");
    await denied.recordDeferredOutcome({ kind: "not-dispatched" });
    await denied.recordDeferredOutcome({ kind: "not-dispatched" });
    // A settled approval releases its slot for the next command even while a sibling is pending.
    for (let index = 0; index < 65; index++) {
      const completed = await admit(`completed-${index}`);
      await completed.recordDeferredOutcome({ kind: "exited", exitCode: index === 0 ? 3 : 0 });
    }
    expect((await pendingShellCalls())?.calls).toEqual([{ callId: "waiting", key: pending.key }]);
    const observedOutcomes = () =>
      loadTranscriptEventsSync(target)
        .map(readTranscriptEventMessage)
        .filter((message) => message?.customType === "openclaw:shell-approval-outcome")
        .map((message) => message?.details);
    const outcomes = observedOutcomes();
    expect(outcomes).toHaveLength(66);
    expect(outcomes).toContainEqual({ kind: "not-dispatched", toolCallId: "denied" });
    expect(outcomes).toContainEqual({ kind: "exited", exitCode: 3, toolCallId: "completed-0" });
    // A late callback must not append a result after another turn takes custody.
    writeSessionEntry(db, target.sessionKey, { ...seed, activeWriterRunId: "replacement" });
    await applySessionEntryOperation(target, {
      kind: "shell-call",
      runId: "replacement",
      call: { callId: "new", key: "replacement-key" },
    });
    await pending.recordDeferredOutcome({ kind: "exited", exitCode: 0 });
    expect(observedOutcomes()).toHaveLength(66);
  }));
