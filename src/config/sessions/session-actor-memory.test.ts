import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActor, SessionActorAuthority } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import type { SessionTurnPlan } from "./session-turn.types.js";

// A memory actor must not allocate either persistence or database-worker capacity.
vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory actor opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory actor allocated a worker");
  }),
}));

const sessionKey = "agent:main:dashboard:incognito-actor-test";
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

async function fixture() {
  const owner = createMemorySessionActorOwner({ agentId: "main", path: "/synthetic/incognito" });
  owners.push(owner);
  const target = { database: owner.identity, sessionKey };
  const actor = await owner.acquire(target, lifetime);
  const first = await actor.acceptInput(
    {
      commandId: "accept",
      phaseId: "turn",
      expectedState: buildRestartRecoveryExpectedState({ sessionId: "session-1", updatedAt: 1 }),
      lifecycle: {},
      turn: {
        agentId: "main",
        sessionKey,
        options: {
          expectedSessionId: "session-1",
          sessionFile: "/synthetic/transcript",
          cwd: "/synthetic",
          initialSessionEntry: { sessionId: "session-1", updatedAt: 1, incognito: true },
          messages: [
            {
              message: { role: "user", content: "Hello", timestamp: 1, idempotencyKey: "input-1" },
              eventId: "user-1",
              now: 1,
            },
          ],
        },
      },
    },
    authority,
  );
  expect(first.kind).toBe("committed");
  return { owner, target, actor, acquire: () => owner.acquire(target, lifetime) };
}

function activity(actor: SessionActor, updatedAt: number) {
  return actor.patch(
    {
      commandId: `activity-${updatedAt}`,
      phaseId: "turn",
      reducers: [{ kind: "activity", updatedAt }],
    },
    authority,
  );
}

describe("memory session actor", () => {
  it.each([
    { change: "unchanged", accepted: true },
    { change: "excluded-input", accepted: false },
    { change: "reset", accepted: false },
    { change: "compaction", accepted: true },
  ] as const)(
    "evaluates recovery from active history after $change",
    async ({ change, accepted }) => {
      const { actor } = await fixture();
      const turn = (eventId: string, message: unknown): SessionTurnPlan => ({
        agentId: "main",
        sessionKey,
        options: {
          expectedSessionId: "session-1",
          sessionFile: "/synthetic/transcript",
          messages: [{ eventId, message, now: 2 }],
        },
      });
      const source = await actor.adoptRun(
        {
          commandId: "source",
          phaseId: "recovery",
          sessionId: "session-1",
          expectedState: buildRestartRecoveryExpectedState({
            sessionId: "session-1",
            updatedAt: 1,
          }),
          lifecycle: {},
          runId: "recovery-run",
          turn: turn("source-input", {
            role: "user",
            content: "Task completed",
            timestamp: 2,
            idempotencyKey: "source-run:user",
            __openclaw: { runId: "source-run" },
            provenance: {
              kind: "inter_session",
              sourceChannel: "internal",
              sourceTool: "agent_harness_completion",
              sourceSessionKey: "task-run",
            },
          }),
        },
        authority,
      );
      expect(source.kind).toBe("committed");
      if (change === "excluded-input") {
        const later = await actor.acceptInput(
          {
            commandId: "later-input",
            phaseId: "recovery",
            expectedState: buildRestartRecoveryExpectedState({
              sessionId: "session-1",
              updatedAt: 1,
            }),
            lifecycle: {},
            turn: turn("later-input", {
              role: "user",
              content: "Do something else",
              timestamp: 3,
              excludeFromContext: true,
            }),
          },
          authority,
        );
        expect(later.kind).toBe("committed");
      } else if (change === "reset" || change === "compaction") {
        const boundary = await actor.appendTranscriptEvent(
          {
            commandId: "boundary",
            phaseId: "recovery",
            sessionId: "session-1",
            lifecycleRevision: null,
            eventJson: JSON.stringify({
              type: change,
              id: "boundary",
              parentId: "source-input",
              timestamp: new Date(3).toISOString(),
              firstKeptEntryId: change === "reset" ? "source-input" : "boundary",
              ...(change === "reset"
                ? { reason: "reset" }
                : { summary: "Summary", tokensBefore: 10 }),
            }),
          },
          authority,
        );
        expect(boundary.kind).toBe("committed");
      }
      const before = actor.snapshot(authority);
      const recovered = await actor.acceptInput(
        {
          commandId: "recover",
          phaseId: "recovery",
          expectedState: buildRestartRecoveryExpectedState({
            sessionId: "session-1",
            updatedAt: 1,
          }),
          lifecycle: {},
          recovery: {
            sources: [],
            expectedRunId: "recovery-run",
            harnessCompletion: {
              taskId: "task",
              taskStatus: "succeeded",
              taskRunId: "task-run",
              sourceRunId: "source-run",
              requesterSessionKey: sessionKey,
              requesterAgentId: "main",
              sessionId: "session-1",
            },
          },
          turn: turn("recovery-input", { role: "user", content: "Resume", timestamp: 4 }),
        },
        authority,
      );
      expect(recovered.kind).toBe(accepted ? "committed" : "rolled-back");
      if (accepted) {
        expect(actor.snapshot(authority)?.transcript.anchors.at(-1)?.entryId).toBe(
          "recovery-input",
        );
      } else {
        expect(recovered).toMatchObject({
          error: { message: "Session actor recovery input no longer matches its source" },
        });
        expect(actor.snapshot(authority)).toEqual(before);
      }
      await actor.release();
    },
  );

  it("shares committed facts across handles, serializes writes, and keeps data after release", async () => {
    const { actor, acquire } = await fixture();
    const second = await acquire();
    const old = actor.snapshot(authority)!;
    const [first, next] = await Promise.all([
      activity(actor, 10),
      second.patch(
        {
          commandId: "intro",
          phaseId: "turn",
          reducers: [{ kind: "group-intro", needsSystemIntro: true }],
        },
        authority,
      ),
    ]);
    expect(first.kind).toBe("committed");
    expect(next.kind).toBe("committed");
    expect(actor.snapshot(authority)?.entry).toMatchObject({
      updatedAt: 10,
      groupActivationNeedsSystemIntro: true,
    });
    expect(second.snapshot(authority)?.entry?.updatedAt).toBe(10);
    if (next.kind !== "committed") {
      throw new Error("Expected a committed receipt");
    }
    const retained = actor.snapshot(authority);
    Object.assign(next.receipt.afterVersion, { sequence: 100 });
    next.receipt.transcript.after.rawSeq = 100;
    expect(actor.snapshot(authority)).toEqual(retained);
    const stale = await actor.patch(
      {
        commandId: "stale",
        phaseId: "turn",
        expected: old.version,
        reducers: [{ kind: "activity", updatedAt: 99 }],
      },
      authority,
    );
    expect(stale).toMatchObject({ kind: "stale-version", postimage: { entry: { updatedAt: 10 } } });
    await actor.release();
    await second.release();
    const reopened = await acquire();
    expect(reopened.snapshot(authority)?.entry?.updatedAt).toBe(10);
    await reopened.release();
  });

  it.each(["transaction", "commit"] as const)(
    "rolls back refused %s admission and preserves commits when an observer fails",
    async (refusedStage) => {
      const { actor } = await fixture();
      const before = actor.snapshot(authority)!;
      const refused = await actor.patch(
        { commandId: "refused", phaseId: "turn", reducers: [{ kind: "activity", updatedAt: 50 }] },
        {
          assertCurrent() {},
          authorize(stage) {
            if (stage === refusedStage) {
              throw new Error("revoked");
            }
          },
        },
      );
      expect(refused).toMatchObject({ kind: "rolled-back", error: { message: "revoked" } });
      expect(actor.snapshot(authority)).toEqual(before);
      const committed = await actor.patch(
        { commandId: "observed", phaseId: "turn", reducers: [{ kind: "activity", updatedAt: 51 }] },
        authority,
        {
          committed() {
            throw new Error("observer failed");
          },
        },
      );
      expect(committed).toMatchObject({
        kind: "committed",
        failure: { message: "observer failed" },
        receipt: { postimage: { entry: { updatedAt: 51 } } },
      });
      expect(actor.snapshot(authority)?.entry?.updatedAt).toBe(51);
      await actor.release();
    },
  );

  it("flushes phase reducers and closes old handles without reviving them on reacquisition", async () => {
    const { owner, target, actor } = await fixture();
    await actor.withPhase("bookkeeping", authority, async (phase) => {
      phase.patch([{ kind: "activity", updatedAt: 30 }]);
    });
    expect(actor.snapshot(authority)?.entry?.updatedAt).toBe(30);
    owner.closeSession(sessionKey);
    expect(() => actor.snapshot(authority)).toThrow("closed");
    const replacement = await owner.acquire(target, lifetime);
    expect(replacement.snapshot(authority)?.entry).toBeUndefined();
    expect(() => actor.snapshot(authority)).toThrow("closed");
    await actor.release();
    await replacement.release();
  });
});
