import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { prepareCliHistoryBoundary } from "../agents/cli-runner/history-boundary.js";
import { loadCliSessionPromptContext } from "../agents/cli-runner/session-history.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { runWithCliHistoryWriter } from "../config/sessions/cli-history-boundary.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  resolveSessionTranscriptRuntimeTarget,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import {
  captureAgentRunTerminalWriteContext,
  clearAgentRunTerminalWriteContext,
  drainAgentRunTerminalWrites,
} from "../infra/agent-run-terminal-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { abortChatRunById, registerChatAbortController, type ChatAbortOps } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
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

async function seed(assistantBranch?: "active" | "inactive" | "other-run") {
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1_000,
    startedAt: 1_000,
    status: "running",
    lifecycleRunId: runId,
    goal: {
      schemaVersion: 1,
      id: "failure-goal",
      objective: "Finish the requested work",
      status: "active",
      createdAt: 1_000,
      updatedAt: 1_000,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    },
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
              content: [],
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
  it.each(["timeout", "rpc", "auth-revoked", undefined])(
    "preserves the active turn when a queued follow-up ends with %s",
    async (stopReason) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await seed();
        const before = structuredClone(loadSessionEntry(target));
        assert(before);
        const transcriptBefore = await loadTranscriptEvents(target);
        const chatRunState = createChatRunState();
        const ops: ChatAbortOps = {
          chatAbortControllers: new Map(),
          chatRunState,
          removeChatRun: () => undefined,
          agentRunSeq: new Map(),
          broadcast: vi.fn(),
          nodeSendToSession: vi.fn(),
        };
        const active = registerChatAbortController({
          ...target,
          chatAbortControllers: ops.chatAbortControllers,
          runId,
          timeoutMs: 60_000,
          kind: "agent",
        });
        active.markExecutionStarted();
        const queuedRunId = "queued-follow-up";
        const queued = registerChatAbortController({
          ...target,
          chatAbortControllers: ops.chatAbortControllers,
          runId: queuedRunId,
          timeoutMs: 60_000,
          kind: "agent",
        });
        const events: AgentEventPayload[] = [];
        const unsubscribe = onAgentEvent((queuedEvent) => {
          if (queuedEvent.runId === queuedRunId && queuedEvent.stream === "lifecycle") {
            events.push(queuedEvent);
          }
        });
        try {
          expect(
            abortChatRunById(ops, {
              runId: queuedRunId,
              sessionKey: target.sessionKey,
              stopReason,
            }),
          ).toEqual({ aborted: true });
          expect(queued.controller.signal.aborted).toBe(true);
          expect(ops.chatAbortControllers.has(queuedRunId)).toBe(false);
          expect(active.controller.signal.aborted).toBe(false);
          expect(ops.chatAbortControllers.get(runId)?.controller).toBe(active.controller);
          expect(events).toHaveLength(1);
          for (const queuedEvent of events) {
            expect(
              classifyAgentRunTerminalOutcome(
                buildAgentRunTerminalOutcomeFromLifecycleEvent({
                  phase: "end",
                  data: queuedEvent.data,
                }),
              ),
            ).toBe(stopReason === "timeout" ? "timeout" : "cancellation");
            expect(
              buildGatewaySessionSnapshot({
                sessionRow: {
                  key: target.sessionKey,
                  sessionId: target.sessionId,
                  kind: "direct",
                  status: "running",
                  updatedAt: before.updatedAt,
                  startedAt: before.startedAt,
                  goal: before.goal,
                },
                lifecycleRunId: runId,
                event: queuedEvent,
                includeSession: true,
                lifecycle: true,
              }),
            ).toMatchObject({
              status: "running",
              session: { status: "running", goal: { status: "active" } },
            });
            await persistGatewaySessionLifecycleEvent({ ...target, event: queuedEvent });
          }
          expect(loadSessionEntry(target)).toEqual(before);
          expect(await loadTranscriptEvents(target)).toEqual(transcriptBefore);
          expect(events[0]?.data).toMatchObject({
            executionStarted: false,
            providerStarted: false,
            startedAt: undefined,
          });
          expect(events[0]?.data.timeoutPhase).toBe(stopReason === "timeout" ? "queue" : undefined);
          await persistGatewaySessionLifecycleEvent({
            ...target,
            event: { ...event, data: { phase: "end", startedAt: 1_000, endedAt: 3_000 } },
          });
          expect(loadSessionEntry(target)).toMatchObject({ status: "done", lastRunId: runId });
          expect(await reports()).toEqual([]);
        } finally {
          unsubscribe();
          queued.cleanup();
          active.cleanup();
          chatRunState.clear();
        }
      });
    },
  );

  it("records one displayed failure per run and retains it after the next run starts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      await persistGatewaySessionLifecycleEvent({ ...target, event });
      const pausedGoal = loadSessionEntry(target)?.goal;
      expect(pausedGoal).toMatchObject({
        id: "failure-goal",
        status: "paused",
        pausedAt: 2_000,
        lastStatusNote: `Paused after an error. Resume to continue. ${error}`,
      });
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
      expect(loadSessionEntry(target)?.goal).toEqual(pausedGoal);
    });
  });

  it("records provider authentication failures as operator copy, not raw provider text", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      const providerError =
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, request id: req_401";
      await persistGatewaySessionLifecycleEvent({
        ...target,
        event: { ...event, data: { ...event.data, error: providerError } },
      });
      const [report] = await reports();
      expect(report).toMatchObject({
        content: expect.stringMatching(
          /^This turn ended before a reply: ⚠️ Authentication failed \(provider returned HTTP 401\)/,
        ),
        details: { runId, error: expect.stringMatching(/^⚠️ Authentication failed/) },
      });
      expect(JSON.stringify(report)).not.toContain("Missing bearer");
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
    {
      phase: "end",
      error: undefined,
      reason: "Run timed out",
      timeoutPhase: "queue",
      providerStarted: false,
    },
  ] as const)(
    "records a run-timeout kill delivered as an aborted $phase event",
    async ({ phase, error: timeoutError, reason, ...timeoutFields }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await seed();
        await persistGatewaySessionLifecycleEvent({
          ...target,
          event: {
            ...event,
            data: {
              ...event.data,
              ...timeoutFields,
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
            content: `This turn ended before a reply: ${reason}`,
            details: { runId, error: reason },
          },
        ]);
      });
    },
  );

  it.each([
    { phase: "start" },
    { phase: "end" },
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
            error: `Worker rejected token=${secret}\n${"detail ".repeat(150)}token=${secret}: upload failed`,
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
      const lastRunError = loadSessionEntry(target)?.lastRunError;
      expect(lastRunError).not.toContain(secret);
      expect(lastRunError).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(lastRunError).toMatch(/^Worker rejected token=/);
      expect(lastRunError).toMatch(/upload failed$/);
      expect(lastRunError?.length).toBeLessThanOrEqual(160);
      const goal = loadSessionEntry(target)?.goal;
      expect(goal?.status).toBe("paused");
      expect(goal?.lastStatusNote).toContain(lastRunError);
      expect(goal?.lastStatusNote).not.toContain(secret);
    });
  });

  it.each([
    {
      name: "nested workspace transfer failure",
      prefix:
        "Cloud worker finished, but its workspace result could not be reconciled: workspace-transfer-failed: operation=upload stage=capture: ",
      context: "Cloud worker finished",
    },
    {
      name: "Unicode diagnostic context",
      prefix: `Worker: ${"🦞".repeat(200)}: `,
      context: "Worker:",
    },
  ])("retains the terminal cause of a bounded $name", async ({ prefix, context }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      const cause = "Cloud workspace reconciliation exceeds the 25000 entry limit.";
      await persistGatewaySessionLifecycleEvent({
        ...target,
        event: { ...event, data: { ...event.data, error: `${prefix}${cause}` } },
      });
      const failed = loadSessionEntry(target);
      expect(failed?.status).toBe("failed");
      expect(failed?.lastRunError).toContain(context);
      expect(failed?.lastRunError).toContain(cause);
      expect(failed?.lastRunError?.length).toBeLessThanOrEqual(160);
      expect(failed?.lastRunError).not.toMatch(/[\uD800-\uDFFF]/u);
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
        expect(context.durableContext).toContain("This turn ended before a reply: Run timed out");
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
      expect((await f.laterContext("account-a")).durableContext).toContain("Run timed out");
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
