import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openContextEngineTurnOutboxWorkerStore } from "../agents/harness/context-engine-turn-outbox-store.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { TranscriptTurnBoundary } from "../config/sessions/transcript-entry-anchor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
const engineId = "actor-test";
let actor: IncognitoAgentDatabaseExecution;
let lossActor: IncognitoAgentDatabaseExecution;
let lossWorker: Worker;

beforeAll(async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-outbox-") };
  const posted = vi.spyOn(Worker.prototype, "postMessage");
  try {
    const opened = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env,
      authority,
    });
    assert(opened);
    actor = opened;
    const loss = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "loss",
      env,
      authority,
    });
    assert(loss);
    lossActor = loss;
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "loss", env });
    const index = posted.mock.calls.findIndex(
      ([message]) =>
        isRecord(message) && message.type === "open" && message.databasePath === sentinel,
    );
    const worker: unknown = posted.mock.contexts[index];
    assert(worker instanceof Worker);
    lossWorker = worker;
  } finally {
    posted.mockRestore();
  }
});

afterAll(async () => {
  await Promise.all([actor?.close(), lossActor?.close()]);
});

type Turn = { sessionKey: string; sessionId: string; boundary: TranscriptTurnBoundary };

async function createTurn(name: string, owner = actor, agentId = "main"): Promise<Turn> {
  const target = { sessionKey: `agent:${agentId}:dashboard:incognito-${name}`, sessionId: name };
  await owner.sessions.create(authority, {
    sessionKey: target.sessionKey,
    entry: {
      sessionId: name,
      updatedAt: 10_000,
      createdAt: 10_000,
      lifecycleRevision: "initial",
      incognito: true,
    },
  });
  const append = async (role: "user" | "assistant", parentId?: string) => {
    const result = await owner.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        ...target,
        fence: {},
        parentId,
        message: {
          role,
          content: [{ type: "text", text: role === "user" ? "question" : "answer" }],
          timestamp: 10_000,
        },
      },
    });
    assert(result.ok);
    assert(result.value.append?.anchor);
    return result.value.append.anchor;
  };
  const admission = await append("user");
  const terminal = await append("assistant", admission.entryId);
  return {
    ...target,
    boundary: {
      admission: { ...admission, logicalTurnId: `turn:${name}`, role: "user" },
      terminal,
    },
  };
}

async function accept(turn: Turn, owner = actor) {
  const store = outbox(turn, authority, owner);
  await store.enqueueIntent({
    ...turn,
    engineId,
    isHeartbeat: false,
    admission: turn.boundary.admission,
  });
  await store.acceptIntent({ ...turn, engineId, isHeartbeat: false });
}

function outbox(turn: Turn, source = authority, owner = actor) {
  return openContextEngineTurnOutboxWorkerStore({
    agentId: owner.agentId,
    path: owner.path,
    incognito: {
      actor: owner,
      authority: source,
      sessionKey: turn.sessionKey,
      sessionId: turn.sessionId,
    },
  });
}

function publish(turn: Turn, source = authority, owner = actor) {
  return outbox(turn, source, owner).publishClosedTurn({
    ...turn,
    engineId,
    isHeartbeat: false,
    maxBytes: 10_000,
    maxEvents: 10,
  });
}

function recover(turn: Turn) {
  return outbox(turn).prepareRun({ ...turn, engineId, isHeartbeat: false });
}

function next(turn: Turn) {
  return outbox(turn).readNextPending({ ...turn, engineId });
}

it.each(["publish", "recover"] as const)(
  "%s is idempotent on the actor and cannot resurrect a completed turn",
  async (operation) => {
    const turn = await createTurn(operation);
    const sql = observeHostDataSql();
    try {
      expect(
        await actor.sessions.transcript(authority, {
          type: "session.turn.read",
          input: { ...turn, fence: {}, maxBytes: 10_000, maxEvents: 10 },
        }),
      ).toMatchObject({ kind: "ok", messages: [{ role: "user" }, { role: "assistant" }] });
      await accept(turn);
      if (operation === "publish") {
        expect(await publish(turn)).toBe("ok");
        expect(await publish(turn)).toBe("ok");
      } else {
        expect(await recover(turn)).toEqual({ warnings: [], pending: true, admitted: false });
        expect(await recover(turn)).toEqual({ warnings: [], pending: true, admitted: false });
      }
      const row = await next(turn);
      assert(row);
      expect(JSON.parse(row.payload_json)).toMatchObject({
        state: "ready",
        boundary: turn.boundary,
        messages: [
          { role: "user", content: [{ type: "text", text: "question" }] },
          { role: "assistant", content: [{ type: "text", text: "answer" }] },
        ],
      });
      await outbox(turn).complete(row.advancement_key);
      expect(await publish(turn)).toBe("ok");
      expect(await recover(turn)).toEqual({ warnings: [], pending: false, admitted: false });
      expect(
        await actor.sessions.outbox(authority, {
          type: "session.outbox.listPendingSessions",
          input: { ...turn, engineId, limit: 10 },
        }),
      ).toEqual([]);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  },
);

it("refuses foreign anchors and advancement keys without changing the owning session", async () => {
  const turn = await createTurn("target-owner");
  const other = await createTurn("target-other");
  await accept(turn);
  for (const changed of [
    { agentId: "foreign" },
    { storePath: "/foreign.sqlite" },
    { sessionKey: other.sessionKey },
    { sessionId: other.sessionId },
  ]) {
    await expect(
      publish({
        ...turn,
        boundary: { ...turn.boundary, terminal: { ...turn.boundary.terminal, ...changed } },
      }),
    ).rejects.toThrow("anchor belongs to another session");
  }
  const advancementKey = turn.boundary.admission.logicalTurnId;
  await expect(
    actor.sessions.outbox(authority, {
      type: "session.outbox.complete",
      input: { ...other, advancementKey },
    }),
  ).rejects.toThrow("advancement belongs to another session");
  await expect(
    actor.sessions.outbox(authority, {
      type: "session.outbox.recordFailure",
      input: { ...other, advancementKey, message: "foreign", attemptedAt: 20_000 },
    }),
  ).rejects.toThrow("advancement belongs to another session");
  await expect(
    actor.sessions.outbox(authority, {
      type: "session.outbox.discardIntent",
      input: {
        ...other,
        engineId,
        admission: { ...other.boundary.admission, logicalTurnId: advancementKey },
      },
    }),
  ).rejects.toThrow("advancement belongs to another session");
  await expect(publish({ ...turn, sessionId: other.sessionId })).rejects.toThrow(
    "generation is no longer current",
  );
  expect(JSON.parse((await next(turn))!.payload_json).state).toBe("accepted");
  expect(await next(other)).toBeUndefined();
});

it("rolls back outbox publication when authority is revoked before commit", async () => {
  const turn = await createTurn("commit-refused");
  await accept(turn);
  let current = true;
  const stages: string[] = [];
  await expect(
    publish(turn, {
      assertCurrent() {
        if (!current) {
          throw new Error("outbox authority revoked");
        }
      },
      authorize(stage) {
        stages.push(stage);
        current = stage !== "commit";
      },
    }),
  ).rejects.toThrow("outbox authority revoked");
  expect(stages).toEqual(["transaction", "commit"]);
  expect(JSON.parse((await next(turn))!.payload_json).state).toBe("accepted");
  expect(await publish(turn)).toBe("ok");
});

it("refuses outbox publication after revocation while waiting in the actor FIFO", async () => {
  const turn = await createTurn("queue-refused");
  await accept(turn);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = actor.run(authority, async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await awaitGateBeforeSettlement(entered.promise, held, "actor FIFO holder did not enter");
    let current = true;
    const rejected = expect(
      publish(turn, {
        assertCurrent() {
          if (!current) {
            throw new Error("queued outbox authority revoked");
          }
        },
      }),
    ).rejects.toThrow("queued outbox authority revoked");
    current = false;
    release.resolve();
    await Promise.all([held, rejected]);
  } finally {
    release.resolve();
    await held;
  }
  expect(JSON.parse((await next(turn))!.payload_json).state).toBe("accepted");
});

it("returns the typed ended error when the actor dies during outbox publication", async () => {
  const turn = await createTurn("lost-outbox", lossActor, "loss");
  await accept(turn, lossActor);
  let stopped: Promise<number> | undefined;
  const stages: string[] = [];
  await expect(
    publish(
      turn,
      {
        assertCurrent() {},
        authorize(stage) {
          stages.push(stage);
          if (stage === "commit") {
            stopped = lossWorker.terminate();
            throw new Error("worker termination requested at outbox commit");
          }
        },
      },
      lossActor,
    ),
  ).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
  assert(stopped);
  await stopped;
  expect(stages).toEqual(["transaction", "commit"]);
  expect(() => lossActor.assertCurrent()).toThrow("Incognito session ended");
});
