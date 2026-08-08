import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptEventSync,
  branchSessionTranscriptSync,
  loadSessionEntry,
  loadTranscriptEvents,
  onSessionIdentityMutation,
  replaceTranscriptEventsSync,
  upsertSessionEntry,
} from "./session-accessor.js";
import type { InternalSessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function createSession(name: string) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make(`openclaw-branch-${name}-`) };
  const scope = {
    agentId: "main",
    env,
    sessionId: `${name}-source`,
    sessionKey: `agent:main:${name}`,
  };
  await upsertSessionEntry(scope, {
    cliSessionIds: { cli: "conversation" },
    compactionCount: 2,
    contextTokens: 100_000,
    lifecycleRunId: "run-1",
    sessionId: scope.sessionId,
    status: "running",
    totalTokens: 12_000,
    totalTokensFresh: true,
    updatedAt: 1,
  } as InternalSessionEntry);
  await appendTranscriptEvent(scope, {
    type: "session",
    id: scope.sessionId,
    timestamp: "2026-08-08T00:00:00.000Z",
    version: 3,
  });
  await appendTranscriptEvent(scope, {
    type: "custom",
    id: `${name}-entry`,
    parentId: null,
    timestamp: "2026-08-08T00:00:01.000Z",
  });
  return scope;
}

const stageBranch = (nextSessionId: string) => (events: unknown[]) =>
  events.map((event, index) =>
    index === 0 && event && typeof event === "object"
      ? { ...event, id: nextSessionId, parentSession: (event as { id?: unknown }).id }
      : event,
  );

function captureIdentityMutations<T>(run: (notify: ReturnType<typeof vi.fn>) => T) {
  const notify = vi.fn();
  const unsubscribe = onSessionIdentityMutation(notify);
  try {
    return { notify, result: run(notify) };
  } finally {
    unsubscribe();
  }
}

async function expectUnchanged(
  scope: Awaited<ReturnType<typeof createSession>>,
  nextSessionId: string,
  currentSessionId = scope.sessionId,
) {
  expect(loadSessionEntry(scope)?.sessionId).toBe(currentSessionId);
  await expect(loadTranscriptEvents({ ...scope, sessionId: nextSessionId })).resolves.toEqual([]);
}

describe("branchSessionTranscriptSync", () => {
  it("atomically commits a canonically reset identity and staged transcript", async () => {
    const scope = await createSession("success");
    const nextSessionId = "success-next";
    const { notify, result } = captureIdentityMutations(() =>
      branchSessionTranscriptSync(scope, {
        nextSessionId,
        stage: stageBranch(nextSessionId),
      }),
    );

    expect(result.status).toBe("committed");
    expect(notify).toHaveBeenCalledWith({
      kind: "replace",
      previous: { sessionId: scope.sessionId, sessionKeys: [scope.sessionKey] },
      current: { sessionId: nextSessionId, sessionKeys: [scope.sessionKey] },
    });
    const entry = loadSessionEntry(scope) as InternalSessionEntry | undefined;
    expect(entry).toMatchObject({
      abortedLastRun: false,
      previousSessionId: scope.sessionId,
      sessionId: nextSessionId,
      systemSent: false,
    });
    for (const key of [
      "cliSessionIds",
      "compactionCount",
      "contextTokens",
      "lifecycleRunId",
      "status",
      "totalTokens",
      "totalTokensFresh",
    ] as const) {
      expect(entry?.[key]).toBeUndefined();
    }
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(2);
    await expect(loadTranscriptEvents({ ...scope, sessionId: nextSessionId })).resolves.toEqual([
      expect.objectContaining({ id: nextSessionId, parentSession: scope.sessionId }),
      expect.objectContaining({ id: "success-entry" }),
    ]);
  });

  it("rejects a missing session entry without writing or publishing", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-branch-missing-") };
    const scope = {
      agentId: "main",
      env,
      sessionId: "missing-source",
      sessionKey: "agent:main:missing",
    };
    const { notify, result } = captureIdentityMutations(() =>
      branchSessionTranscriptSync(scope, {
        nextSessionId: "missing-next",
        stage: stageBranch("missing-next"),
      }),
    );

    expect(result).toEqual({ status: "conflict", reason: "missing-entry" });
    expect(notify).not.toHaveBeenCalled();
    expect(loadSessionEntry(scope)).toBeUndefined();
  });

  it.each(["rebound", "append", "row", "generation"] as const)(
    "rejects %s conflicts without partial branch state",
    async (kind) => {
      const scope = await createSession(kind);
      const nextSessionId = `${kind}-next`;
      if (kind === "rebound") {
        await upsertSessionEntry(scope, { sessionId: "different-session", updatedAt: 2 });
      }
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
      const { notify, result } = captureIdentityMutations(() =>
        branchSessionTranscriptSync(scope, {
          nextSessionId,
          stage: (events) => {
            if (kind === "append") {
              appendTranscriptEventSync(scope, {
                type: "custom",
                id: "late-entry",
                parentId: `${kind}-entry`,
                timestamp: "2026-08-08T00:00:02.000Z",
              });
            } else if (kind === "row") {
              database.db
                .prepare(
                  "UPDATE transcript_events SET event_json = json_set(event_json, '$.mutated', true) WHERE session_id = ? AND event_json LIKE ?",
                )
                .run(scope.sessionId, '%"type":"custom"%');
            } else if (kind === "generation") {
              expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
            }
            return stageBranch(nextSessionId)(events);
          },
        }),
      );

      expect(result).toEqual({
        status: "conflict",
        reason: kind === "rebound" ? "session-rebound" : "source-transcript-changed",
      });
      expect(notify).not.toHaveBeenCalled();
      await expectUnchanged(
        scope,
        nextSessionId,
        kind === "rebound" ? "different-session" : scope.sessionId,
      );
    },
  );

  it("does not write or publish when staging throws", async () => {
    const scope = await createSession("stage-throw");
    const { notify } = captureIdentityMutations(() => {
      expect(() =>
        branchSessionTranscriptSync(scope, {
          nextSessionId: "stage-throw-next",
          stage: () => {
            throw new Error("stage failed");
          },
        }),
      ).toThrow("stage failed");
    });
    expect(notify).not.toHaveBeenCalled();
    await expectUnchanged(scope, "stage-throw-next");
  });

  it("rolls back transcript and identity when the identity write fails", async () => {
    const scope = await createSession("write-rollback");
    const nextSessionId = "write-rollback-next";
    openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env }).db.exec(`
      CREATE TRIGGER reject_branch_identity
      BEFORE UPDATE OF current_session_id ON session_nodes
      WHEN NEW.current_session_id = '${nextSessionId}'
      BEGIN SELECT RAISE(ABORT, 'reject branch identity'); END;
    `);
    const { notify } = captureIdentityMutations(() => {
      expect(() =>
        branchSessionTranscriptSync(scope, {
          nextSessionId,
          stage: stageBranch(nextSessionId),
        }),
      ).toThrow("reject branch identity");
    });
    expect(notify).not.toHaveBeenCalled();
    await expectUnchanged(scope, nextSessionId);
  });

  it("publishes nothing when an outer transaction rolls back", async () => {
    const scope = await createSession("outer-rollback");
    const nextSessionId = "outer-rollback-next";
    const { notify } = captureIdentityMutations((innerNotify) => {
      expect(() =>
        runOpenClawAgentWriteTransaction(() => {
          expect(
            branchSessionTranscriptSync(scope, {
              nextSessionId,
              stage: stageBranch(nextSessionId),
            }).status,
          ).toBe("committed");
          expect(innerNotify).not.toHaveBeenCalled();
          throw new Error("outer rollback");
        }, scope),
      ).toThrow("outer rollback");
    });
    expect(notify).not.toHaveBeenCalled();
    await expectUnchanged(scope, nextSessionId);
  });
});
