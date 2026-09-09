import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { prepareCliHistoryBoundary } from "../agents/cli-runner/history-boundary.js";
import { loadCliSessionPromptContext } from "../agents/cli-runner/session-history.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { runWithCliHistoryWriter } from "../config/sessions/cli-history-boundary.js";
import {
  loadTranscriptEvents,
  patchSessionEntryCore,
  resolveSessionTranscriptRuntimeTarget,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import {
  captureAgentRunTerminalWriteContext,
  clearAgentRunTerminalWriteContext,
  drainAgentRunTerminalWrites,
} from "../infra/agent-run-terminal-writes.js";
import { recordGatewaySessionRunFailure } from "../sessions/session-run-error.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

const target = {
  agentId: "main",
  sessionId: "failed-turn-session",
  sessionKey: "agent:main:main",
};
const runId = "failed-turn-run";
const error = "Worker turn rejected: cloud worker unavailable";
const event = {
  sessionId: target.sessionId,
  runId,
  ts: 2_000,
  data: { phase: "error", startedAt: 1_000, endedAt: 2_000, error },
};

async function seed(assistantBranch?: "active" | "inactive" | "other-run" | "partial") {
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1_000,
    startedAt: 1_000,
    status: "running",
    lifecycleRunId: runId,
  });
  await replaceTranscriptEvents(target, [
    { type: "session", id: target.sessionId, version: CURRENT_SESSION_VERSION },
    {
      type: "message",
      id: "user-turn",
      parentId: null,
      message: { role: "user", content: "Please continue." },
    },
    ...(assistantBranch
      ? [
          {
            type: "message",
            id: "assistant-error",
            parentId: "user-turn",
            message: {
              role: "assistant",
              content:
                assistantBranch === "partial"
                  ? [{ type: "text", text: "I updated the file." }]
                  : [],
              stopReason: "error",
              errorMessage: "Provider failed",
              __openclaw: { runId: assistantBranch === "other-run" ? "previous-run" : runId },
            },
          },
        ]
      : []),
    ...(assistantBranch === "inactive"
      ? [
          {
            type: "leaf",
            id: "selected-branch",
            parentId: "assistant-error",
            targetId: "user-turn",
          },
        ]
      : []),
  ]);
}

async function reports() {
  return (await loadTranscriptEvents(target)).filter(
    (entry) => isRecord(entry) && entry.customType === "run-failed-before-reply",
  );
}

describe("durable pre-reply run failure", () => {
  it("records one displayed failure per run and retains it after the next run starts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      await persistGatewaySessionLifecycleEvent({ ...target, event });
      expect(await reports()).toMatchObject([
        {
          type: "custom_message",
          customType: "run-failed-before-reply",
          content: `This turn ended before a reply: ${error}`,
          display: true,
          details: { runId, error },
        },
      ]);
      await persistGatewaySessionLifecycleEvent({ ...target, event });
      await persistGatewaySessionLifecycleEvent({
        ...target,
        event: {
          ...event,
          runId: "next-run",
          ts: 3_000,
          data: { phase: "start", startedAt: 3_000 },
        },
      });
      expect(await reports()).toHaveLength(1);
    });
  });

  it.each(["none", "persisted", "buffered"] as const)(
    "retains one timeout outcome with %s output",
    async (partial) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await seed(partial === "persisted" ? "partial" : undefined);
        const timeoutPartialText =
          partial === "buffered"
            ? 'I updated "config.json".\nValidation is unfinished.'
            : undefined;
        const before = await loadTranscriptEvents(target);
        const timeoutEvent = {
          ...event,
          data: {
            phase: "end",
            status: "cancelled",
            aborted: true,
            stopReason: "timeout",
            startedAt: 1_000,
            endedAt: 2_000,
          },
        };
        await Promise.all([
          persistGatewaySessionLifecycleEvent({
            ...target,
            event: timeoutEvent,
            timeoutPartialText,
          }),
          persistGatewaySessionLifecycleEvent({
            ...target,
            event: timeoutEvent,
            timeoutPartialText,
          }),
        ]);
        await persistGatewaySessionLifecycleEvent({
          ...target,
          event: {
            ...timeoutEvent,
            data: { ...timeoutEvent.data, phase: "error" },
          },
          timeoutPartialText,
        });
        expect(await reports()).toMatchObject([
          {
            type: "custom_message",
            display: true,
            content: timeoutPartialText
              ? `This turn timed out and may have performed work before it stopped.\n\nUnfinished assistant output (recorded text, not a completion claim):\n${JSON.stringify(timeoutPartialText)}`
              : "This turn timed out and may have performed work before it stopped.",
            details: { runId },
          },
        ]);
        const after = await loadTranscriptEvents(target);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after.slice(before.length)).toHaveLength(1);
        await persistGatewaySessionLifecycleEvent({
          ...target,
          event: {
            ...event,
            runId: "next-run",
            ts: 3_000,
            data: { phase: "start", startedAt: 3_000 },
          },
        });
        expect(await reports()).toHaveLength(1);
      });
    },
  );

  it("writes neither timeout notice nor buffered output after queued report authority expires", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed("partial");
      const before = await loadTranscriptEvents(target);
      const started = createDeferred();
      const release = createDeferred();
      const blocker = patchSessionEntryCore(target, async () => {
        started.resolve();
        await release.promise;
        return null;
      });
      await started.promise;
      let authorized = true;
      const assertCommitAllowed = () => {
        if (!authorized) {
          throw new Error("Timeout owner expired");
        }
      };
      assertCommitAllowed();
      const persistence = recordGatewaySessionRunFailure({
        target,
        runId,
        error: "Run deadline exceeded",
        status: "timeout",
        timeoutPartialText: "Additional unfinished output",
        assertCommitAllowed,
      });
      const rejected = expect(persistence).rejects.toThrow("Timeout owner expired");
      authorized = false;
      release.resolve();
      await blocker;
      await rejected;
      expect(await reports()).toEqual([]);
      expect(await loadTranscriptEvents(target)).toEqual(before);
    });
  });

  it.each(["active", "inactive", "other-run"] as const)(
    "checks assistant output on the %s branch for this run",
    async (branch) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await seed(branch);
        await persistGatewaySessionLifecycleEvent({ ...target, event });
        expect(await reports()).toHaveLength(branch === "active" ? 0 : 1);
      });
    },
  );

  it.each([
    { phase: "end", error: undefined, reason: "Run timed out" },
    { phase: "error", error: "request timed out", reason: "request timed out" },
  ] as const)(
    "records a run-timeout kill delivered as an aborted $phase event",
    async ({ phase, error: timeoutError, reason }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await seed();
        await persistGatewaySessionLifecycleEvent({
          ...target,
          event: {
            ...event,
            data: {
              ...event.data,
              phase,
              aborted: true,
              stopReason: "timeout",
              error: timeoutError,
            },
          },
        });
        expect(await reports()).toMatchObject([
          {
            type: "custom_message",
            customType: "run-failed-before-reply",
            content: "This turn timed out and may have performed work before it stopped.",
            details: { runId, error: reason },
          },
        ]);
      });
    },
  );

  it.each([
    { phase: "start" },
    { phase: "end" },
    { phase: "end", status: "cancelled", aborted: true, stopReason: "rpc" },
    { phase: "end", aborted: true, stopReason: "restart" },
    { phase: "error", aborted: true, stopReason: "aborted" },
    { phase: "aborted" },
    { phase: "completed" },
  ])("does not report $phase / $stopReason", async (data) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      await persistGatewaySessionLifecycleEvent({ ...target, event: { ...event, data } });
      expect(await reports()).toEqual([]);
    });
  });

  it("sanitizes and bounds the stored error", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      const secret = [
        String.fromCharCode(115, 107),
        "proj",
        "failure",
        "abcdefghijklmnopqrstuvwxyz",
      ].join("-");
      await persistGatewaySessionLifecycleEvent({
        ...target,
        event: {
          ...event,
          data: {
            ...event.data,
            error: `Worker rejected token=${secret}\n${"detail ".repeat(150)}`,
          },
        },
      });
      const entries = await reports();
      expect(entries).toHaveLength(1);
      expect(JSON.stringify(entries)).not.toContain(secret);
      expect(entries[0]).toMatchObject({ details: { runId, error: expect.any(String) } });
      const report = entries[0] as { details: { error: string } };
      expect(report.details.error.length).toBeLessThanOrEqual(512);
      expect(report.details.error).not.toContain("\n");
    });
  });

  it.each(["session", "run"])("does not report a stale %s error", async (stale) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      await persistGatewaySessionLifecycleEvent({
        ...target,
        event: {
          ...event,
          sessionId: stale === "session" ? "previous-session" : target.sessionId,
          runId: "previous-run",
          data: { ...event.data, startedAt: 500 },
        },
      });
      expect(await reports()).toEqual([]);
    });
  });

  it("does not report an error whose lifecycle write was refused", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      await expect(
        persistGatewaySessionLifecycleEvent({
          ...target,
          event,
          assertCommitAllowed: () => {
            throw new Error("Run authority expired");
          },
        }),
      ).rejects.toThrow("Run authority expired");
      expect(await reports()).toEqual([]);
    });
  });
});

async function createCliHistoryFixture() {
  const cliTarget = {
    agentId: "main",
    sessionId: "cli-timeout-history",
    sessionKey: "agent:main:main",
  };
  const cliRunId = "cli-timeout-run";
  await upsertSessionEntryCore(cliTarget, {
    sessionId: cliTarget.sessionId,
    updatedAt: 1_000,
    startedAt: 1_000,
    lifecycleRunId: cliRunId,
    activeWriterRunId: cliRunId,
    status: "running",
  });
  const scope = await resolveSessionTranscriptRuntimeTarget(cliTarget);
  const admission = prepareSystemAgentRunAdmission({}, cliRunId, "main", "cli-timeout-test");
  const params: PreparedCliRunContext["params"] = {
    admittedRunContext: await admission.admit("embedded"),
    ...cliTarget,
    runId: cliRunId,
    sessionTarget: scope,
    sessionFile: cliTarget.sessionKey,
    provider: "test-cli",
    model: "test-model",
    prompt: "Continue the saved work.",
    workspaceDir: process.cwd(),
    timeoutMs: 1_000,
  };
  const credential = { type: "token" as const, provider: "test-cli", token: "account-a" };
  const writer = await prepareCliHistoryBoundary(params, { credential });
  expect(writer).toBeDefined();
  runWithCliHistoryWriter(writer, () => {
    SessionManager.open(scope).appendMessage({
      role: "user",
      content: "Prior account-owned request",
      timestamp: 1_000,
    });
  });
  const owner = createSessionLifecyclePersistenceOwner();
  const captured = captureAgentRunTerminalWriteContext(cliRunId);
  if (!captured) {
    throw new Error("Expected the admitted runtime's terminal write context");
  }
  const persist = (phase: "end" | "error") =>
    runWithoutOwnedSessionTranscriptWrites(() => {
      const pending = owner.observe({
        ...cliTarget,
        writeContext: captured,
        event: {
          ...cliTarget,
          runId: cliRunId,
          stream: "lifecycle",
          seq: phase === "end" ? 2 : 3,
          ts: 2_000,
          data: { phase, startedAt: 1_000, endedAt: 2_000, aborted: true, stopReason: "timeout" },
        },
      });
      captured.track(pending);
      return pending;
    });
  const laterContext = async (token: string) => {
    const next = prepareSystemAgentRunAdmission({}, "next-cli-run", "main", "cli-timeout-test");
    await patchSessionEntryCore(scope, () => ({ activeWriterRunId: "next-cli-run" }));
    try {
      const nextParams = {
        ...params,
        runId: "next-cli-run",
        admittedRunContext: await next.admit("embedded"),
      };
      const nextWriter = await prepareCliHistoryBoundary(nextParams, {
        credential: { ...credential, token },
      });
      return await loadCliSessionPromptContext({
        ...nextParams,
        allowRawTranscriptReseed: true,
        rawTranscriptReseedReason: nextWriter ? "missing-transcript" : "auth-unknown",
      });
    } finally {
      next.close();
    }
  };
  return { cliTarget, admission, captured, persist, laterContext };
}

describe("CLI history through Gateway terminal persistence", () => {
  it.each(["end", "error"] as const)(
    "retains same-account context after %s outside the CLI stack",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const f = await createCliHistoryFixture();
        try {
          await f.persist(phase);
          await f.persist(phase === "end" ? "error" : "end");
        } finally {
          f.admission.close();
        }
        const context = await f.laterContext("account-a");
        expect(JSON.stringify(context.reseedMessages)).toContain("Prior account-owned request");
        expect(context.durableContext).toContain(
          "This turn timed out and may have performed work before it stopped.",
        );
        const transcript = await loadTranscriptEvents(f.cliTarget);
        expect(
          transcript.filter((entry) => isRecord(entry) && entry.type === "custom_message"),
        ).toHaveLength(1);
        const otherAccount = await f.laterContext("account-b");
        expect(otherAccount.reseedMessages).toEqual([]);
        expect(otherAccount.durableContext).toBeUndefined();
      });
    },
  );

  it("keeps normal completion pending until its accepted write finishes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await createCliHistoryFixture();
      const release = createDeferred();
      const pending = release.promise.then(() => f.persist("end"));
      f.captured.track(pending);
      let completed = false;
      const finish = drainAgentRunTerminalWrites(f.admission.operationalRunInstance).finally(() => {
        f.admission.close();
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      release.resolve();
      await finish;
      expect((await f.laterContext("account-a")).durableContext).toContain(
        "This turn timed out and may have performed work before it stopped.",
      );
    });
  });

  it.each(["close", "fallback"] as const)(
    "rejects a captured writer after %s without changing history",
    async (revoke) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const f = await createCliHistoryFixture();
        const before = await loadTranscriptEvents(f.cliTarget);
        const pending = f.persist("end");
        if (revoke === "close") {
          f.admission.close();
        } else {
          clearAgentRunTerminalWriteContext(f.admission.operationalRunInstance);
        }
        try {
          await expect(pending).rejects.toThrow("Terminal write owner changed");
          expect(await loadTranscriptEvents(f.cliTarget)).toEqual(before);
        } finally {
          f.admission.close();
        }
      });
    },
  );
});
