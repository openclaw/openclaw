import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import { getSession, waitForExecSession } from "../agents/bash-process-registry.js";
import { createProcessTool } from "../agents/bash-tools.process.js";
import { createShellCallAdmission } from "../agents/embedded-agent-runner/run/attempt-shell-call.js";
import { createLazyExecTool } from "../agents/lazy-exec-tool.js";
import {
  markShellCallResult,
  shellCallReceipt,
  shellCallResultKey,
} from "../agents/shell-call-receipt.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { applySessionEntryOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

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
    const db = openOpenClawAgentDatabase({ agentId: "main" });
    const runId = "original";
    const target = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "window",
      storePath: db.path,
      expectedWriterRunId: runId,
      expectedLifecycleRevision: "rev",
    };
    const seed = {
      sessionId: target.sessionId,
      lifecycleRevision: "rev",
      activeWriterRunId: runId,
      updatedAt: 1,
    };
    writeSessionEntry(db, target.sessionKey, seed);
    const admittedRunContext = createTestAdmittedRunContext(runId);
    const admit = createShellCallAdmission({
      admittedRunContext,
      runId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
    })!;
    const shell = createLazyExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      admitShellCall: admit,
    });
    const file = state.statePath("shell-effect");
    const invoke = () =>
      shell.execute("actual-call", { command: `printf ok > '${file}'; printf done` });
    const denied = createLazyExecTool({
      host: "gateway",
      security: "deny",
      ask: "off",
      admitShellCall: admit,
    });
    await expect(
      denied.execute("denied-command", { command: "printf prohibited" }),
    ).rejects.toThrow("security=deny");
    expect(
      (await applySessionEntryOperation(target, { kind: "shell-call", runId }))?.pendingShellCalls,
    ).toBeUndefined();
    const result = await invoke();
    expect(readFileSync(file, "utf8")).toBe("ok");
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("done") })]),
    );
    const key = shellCallResultKey(result, runId, "actual-call");
    expect(key).toEqual(expect.any(String));
    expect(shellCallResultKey(result, runId, "outer-controller")).toBeUndefined();
    const reconcile = () =>
      applySessionEntryOperation(
        target,
        { kind: "shell-call", runId },
        { preserveActivity: true, skipMaintenance: true },
      );
    // Successful execution alone cannot acknowledge an effect. A stale whole-row save cannot erase it.
    writeSessionEntry(db, target.sessionKey, { ...seed, label: "renamed" });
    const pending = (await reconcile())?.pendingShellCalls?.calls;
    expect(pending).toHaveLength(1);
    expect(key?.startsWith(pending![0]!.key + "/")).toBe(true);
    await expect(invoke()).rejects.toThrow("already admitted");
    await appendTranscriptMessage(target, {
      message: {
        role: "toolResult",
        toolName: "exec",
        toolCallId: "actual-call",
        content: result.content,
        details: result.details,
        idempotencyKey: key,
        timestamp: Date.now(),
      },
    });
    expect((await reconcile())?.pendingShellCalls).toBeUndefined();
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
    expect((await reconcile())?.pendingShellCalls?.calls).toHaveLength(1);
    // The second poll can settle an earlier command even if the first result never attached.
    await appendTranscriptMessage(target, {
      message: {
        role: "toolResult",
        toolName: "process",
        toolCallId: "poll-two",
        content: result2.content,
        details: result2.details,
        idempotencyKey: observation,
        timestamp: Date.now(),
      },
    });
    expect((await reconcile())?.pendingShellCalls).toBeUndefined();
    // Unacknowledged effects are bounded. Refuse before starting the next command.
    for (let index = 0; index < 64; index++) {
      await applySessionEntryOperation(
        target,
        {
          kind: "shell-call",
          runId,
          call: { callId: `pending-${index}`, key: `receipt-${index}` },
        },
        { preserveActivity: true, skipMaintenance: true },
      );
    }
    const overLimit = state.statePath("over-limit");
    await expect(
      shell.execute("overflow", { command: `printf unexpected > '${overLimit}'` }),
    ).rejects.toThrow("Too many shell commands are awaiting a saved result");
    expect(existsSync(overLimit)).toBe(false);
    const refusedFile = state.statePath("refused-effect");
    writeSessionEntry(db, target.sessionKey, { ...seed, activeWriterRunId: "replacement" });
    await expect(
      shell.execute("new-call", { command: `printf unexpected > '${refusedFile}'` }),
    ).rejects.toThrow("restart receipt could not be saved");
    expect(existsSync(refusedFile)).toBe(false);
    expect(
      createShellCallAdmission({
        admittedRunContext,
        runId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        oneShotCliRun: true,
      }),
    ).toBeUndefined();
  }));
