import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  appendSessionTranscriptReport,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  replaceTranscriptEvents,
  resolveSessionTranscriptRuntimeTarget,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  bindOwnedSessionTranscriptWrites,
  type OwnedSessionTranscriptWriteContext,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";

const child = { agentId: "main", sessionId: "child-session", sessionKey: "agent:main:child" };
const other = { agentId: "main", sessionId: "other-session", sessionKey: "agent:main:main" };
const runId = "child-run";
const error = "request (33956 tokens) exceeds the available context size (32768 tokens)";

/**
 * A definitive terminal failure, the shape `emitResultError` publishes once provider
 * recovery is exhausted. `observe()` owns this event in production.
 */
const terminalEvent: AgentEventRuntimePayload = {
  runId,
  seq: 7,
  stream: "lifecycle",
  ts: 2_000,
  sessionId: child.sessionId,
  data: {
    phase: "error",
    startedAt: 1_000,
    endedAt: 2_000,
    error,
    executionSettled: true,
  },
};

function persistParams(event: AgentEventRuntimePayload = terminalEvent) {
  return { agentId: child.agentId, sessionKey: child.sessionKey, event };
}

async function seed(
  session: typeof child,
  options: { runId: string; lifecycleRevision?: string; assistantRunId?: string },
) {
  await upsertSessionEntryCore(session, {
    sessionId: session.sessionId,
    updatedAt: 1_000,
    startedAt: 1_000,
    status: "running",
    lifecycleRunId: options.runId,
    activeWriterRunId: options.runId,
    ...(options.lifecycleRevision ? { lifecycleRevision: options.lifecycleRevision } : {}),
  });
  await replaceTranscriptEvents(session, [
    { type: "session", id: session.sessionId, version: CURRENT_SESSION_VERSION },
    {
      type: "message",
      id: "user-turn",
      parentId: null,
      message: { role: "user", content: "Continue." },
    },
    ...(options.assistantRunId
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
              __openclaw: { runId: options.assistantRunId },
            },
          },
        ]
      : []),
  ]);
}

async function reports(session: typeof child) {
  return (await loadTranscriptEvents(session)).filter(
    (entry) => isRecord(entry) && entry.customType === "run-failed-before-reply",
  );
}

function status(session: typeof child) {
  return loadSessionEntry(session)?.status;
}

async function assistantEntries(session: typeof child) {
  return (await loadTranscriptEvents(session)).filter(
    (entry) =>
      isRecord(entry) &&
      isRecord(entry.message) &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "error",
  );
}

/**
 * Mirrors an attempt-owned context that is still installed when the Gateway handles a
 * terminal agent event. Agent events dispatch synchronously, so whichever owned context
 * the emitter held is the ambient context inside the Gateway handler.
 */
async function ambientContextFor(
  session: typeof child,
  options: { writerRunId: string; expectedLifecycleRevision?: string },
): Promise<OwnedSessionTranscriptWriteContext> {
  const scope = await resolveSessionTranscriptRuntimeTarget(session);
  return {
    sessionKey: session.sessionKey,
    sessionTarget: {
      ...scope,
      expectedWriterRunId: options.writerRunId,
      ...(options.expectedLifecycleRevision
        ? { expectedLifecycleRevision: options.expectedLifecycleRevision }
        : {}),
    },
    assertCommitAllowed: () => {},
    withTranscriptWrite: async (write) => await write(),
  };
}

describe("Gateway terminal persistence detaches inherited attempt ownership", () => {
  it("records an ordinary failed run while an unrelated session's context is ambient", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(child, { runId });
      await seed(other, { runId: "other-run" });
      const ambient = await ambientContextFor(other, { writerRunId: "other-run" });
      const owner = createSessionLifecyclePersistenceOwner();

      await withOwnedSessionTranscriptWrites(ambient, async () => {
        await owner.observe(persistParams());
      });

      expect(await reports(child)).toMatchObject([
        { customType: "run-failed-before-reply", display: true, details: { runId, error } },
      ]);
      expect(status(child)).toBe("failed");
      expect(await reports(other)).toEqual([]);
      expect(status(other)).toBe("running");
    });
  });

  it("records a failure after same-session compaction under an unchanged owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(child, { runId, lifecycleRevision: "revision-before" });
      // The attempt captured its fence before compaction committed a successor entry.
      const ambient = await ambientContextFor(child, {
        writerRunId: runId,
        expectedLifecycleRevision: "revision-before",
      });
      await patchSessionEntryCore(child, () => ({ lifecycleRevision: "revision-after" }));
      const owner = createSessionLifecyclePersistenceOwner();

      await withOwnedSessionTranscriptWrites(ambient, async () => {
        await owner.observe(persistParams());
      });

      expect(await reports(child)).toMatchObject([{ details: { runId, error } }]);
      expect(status(child)).toBe("failed");
    });
  });

  it("suppresses the notice when this run already has a durable assistant error", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(child, { runId, assistantRunId: runId });
      await seed(other, { runId: "other-run" });
      const ambient = await ambientContextFor(other, { writerRunId: "other-run" });
      const owner = createSessionLifecyclePersistenceOwner();

      await withOwnedSessionTranscriptWrites(ambient, async () => {
        await owner.observe(persistParams());
      });

      expect(await reports(child)).toEqual([]);
      // The separately persisted terminal assistant error survives untouched.
      expect(await assistantEntries(child)).toHaveLength(1);
      expect(status(child)).toBe("failed");
    });
  });

  it("keeps repeated terminal events idempotent", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(child, { runId });
      await seed(other, { runId: "other-run" });
      const ambient = await ambientContextFor(other, { writerRunId: "other-run" });
      const owner = createSessionLifecyclePersistenceOwner();

      await withOwnedSessionTranscriptWrites(ambient, async () => {
        await owner.observe(persistParams());
        // A redelivery of the same terminal event reuses the prepared write.
        await owner.observe(persistParams());
        // A later terminal event for the same run must not add a second notice.
        await owner.observe(persistParams({ ...terminalEvent, seq: 8, ts: 2_500 }));
      });

      expect(await reports(child)).toHaveLength(1);
      expect(status(child)).toBe("failed");
    });
  });

  it("records the notice from a delayed callback that reinstalls a settled context", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(child, { runId });
      await seed(other, { runId: "other-run" });
      const ambient = await ambientContextFor(other, { writerRunId: "other-run" });
      const owner = createSessionLifecyclePersistenceOwner();
      // bindOwnedSessionTranscriptWrites reinstalls its captured context whenever the
      // retained callback runs, which can be long after that attempt settled.
      const deliverLate = bindOwnedSessionTranscriptWrites(ambient, () =>
        owner.observe(persistParams()),
      );

      await deliverLate();

      expect(await reports(child)).toMatchObject([{ details: { runId, error } }]);
      expect(status(child)).toBe("failed");
    });
  });

  it("records a non-definitive lifecycle failure routed through the persist fallback", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(child, { runId });
      await seed(other, { runId: "other-run" });
      const ambient = await ambientContextFor(other, { writerRunId: "other-run" });
      const owner = createSessionLifecyclePersistenceOwner();

      await withOwnedSessionTranscriptWrites(ambient, async () => {
        await owner.persist({
          agentId: child.agentId,
          sessionKey: child.sessionKey,
          event: {
            runId,
            ts: 2_000,
            sessionId: child.sessionId,
            data: { phase: "error", startedAt: 1_000, endedAt: 2_000, error },
          },
        });
      });

      expect(await reports(child)).toMatchObject([{ details: { runId, error } }]);
      expect(status(child)).toBe("failed");
    });
  });
});

describe("writer ownership protection stays intact", () => {
  it("still refuses a transcript report aimed at a session the context does not own", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(child, { runId });
      await seed(other, { runId: "other-run" });
      const ambient = await ambientContextFor(other, { writerRunId: "other-run" });
      const childScope = await resolveSessionTranscriptRuntimeTarget(child);

      await expect(
        withOwnedSessionTranscriptWrites(ambient, async () =>
          appendSessionTranscriptReport(childScope, {
            kind: "custom",
            customTypes: ["run-failed-before-reply"],
            selectReport: () => ({
              customType: "run-failed-before-reply",
              content: "should not be written",
              display: true,
              details: { runId },
            }),
          }),
        ),
      ).rejects.toThrow("session writer claim changed before transcript persistence");
      expect(await reports(child)).toEqual([]);
    });
  });

  it("still rejects a terminal event for a replaced session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(child, { runId });
      const owner = createSessionLifecyclePersistenceOwner();

      await owner.observe(
        persistParams({
          ...terminalEvent,
          sessionId: "replaced-session",
          runId: "superseded-run",
          data: { ...terminalEvent.data, startedAt: 500 },
        }),
      );

      expect(await reports(child)).toEqual([]);
      expect(status(child)).toBe("running");
    });
  });

  it("still rejects a terminal write whose run authority expired", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(child, { runId });
      const owner = createSessionLifecyclePersistenceOwner();

      await expect(
        owner.observe({
          ...persistParams(),
          writeContext: {
            assertCurrent: () => {
              throw new Error("Terminal write owner changed before commit");
            },
            run: (write) => write(),
            track: () => {},
          },
        }),
      ).rejects.toThrow("Terminal write owner changed before commit");
      expect(await reports(child)).toEqual([]);
      expect(status(child)).toBe("running");
    });
  });
});
