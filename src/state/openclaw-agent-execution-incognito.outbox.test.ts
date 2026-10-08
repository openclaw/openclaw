import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ContextEngineLogicalTurnLease } from "../agents/harness/context-engine-logical-turn.js";
import {
  drainPendingContextEngineTurnsBeforeRun,
  finalizeAcceptedContextEngineTurn,
} from "../agents/harness/context-engine-turn-attempt.js";
import { openContextEngineTurnOutboxWorkerStore } from "../agents/harness/context-engine-turn-outbox-store.js";
import { drainContextEngineTurnOutbox } from "../agents/harness/context-engine-turn-outbox.js";
import {
  appendSessionTranscriptReport,
  readLatestSessionTranscriptReport,
} from "../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { prepareCustomTranscriptReport } from "../config/sessions/session-accessor.sqlite-transcript-reports.kernel.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { IncognitoTranscriptOperations } from "../config/sessions/session-incognito-transcript-contract.js";
import type { TranscriptTurnBoundary } from "../config/sessions/transcript-entry-anchor.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import type { ContextEngine } from "../context-engine/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

describe("outbox", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  const authority: IncognitoSessionAuthority = { assertCurrent() {} };
  const engineId = "actor-test";
  let actor: IncognitoAgentDatabaseExecution;
  let lossActor: IncognitoAgentDatabaseExecution;
  let lossWorker: Worker;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-outbox-") };
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

  function next(turn: Turn) {
    return outbox(turn).readNextPending({ ...turn, engineId });
  }

  function engine(commitTurn: NonNullable<ContextEngine["commitTurn"]>): ContextEngine {
    return {
      info: {
        id: engineId,
        name: "Synthetic outbox engine",
        transcriptSemantics: {
          currentTurnFence: "before-current-turn-entry-v1",
          turnAdvancementIdempotency: "atomic-idempotent-v1",
        },
      },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      commitTurn,
    };
  }

  it("composes run admission and accepted outbox finalization from the shared binding without caller SQL", async () => {
    const turn = await createTurn("entry-composition");
    const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
      status: "committed",
    }));
    const selected = engine(commitTurn);
    const lease = {
      engine: selected,
      effectiveEngine: selected,
      effectiveEngineId: engineId,
      degraded: false,
      disposed: false,
      selectForHost: vi.fn(),
      degradeBeforeStart: vi.fn(),
      begin: vi.fn(),
      deferDisposalUntil: vi.fn(),
      onDispose: vi.fn(),
      dispose: async () => undefined,
    } satisfies ContextEngineLogicalTurnLease;
    const warn = vi.fn();
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const sql = observeHostDataSql();
    try {
      await withIncognitoSessionActor(actor, async () => {
        await drainPendingContextEngineTurnsBeforeRun({
          admission: turn.boundary.admission,
          lease,
          warn,
        });
        await finalizeAcceptedContextEngineTurn({
          facts: {
            ...turn,
            sessionIdUsed: turn.sessionId,
            promptError: false,
            aborted: false,
            yieldAborted: false,
          },
          lease,
          warn,
        });
      });
      expect(commitTurn).toHaveBeenCalledOnce();
      expect(commitTurn.mock.calls[0]?.[0]).toMatchObject({
        sessionId: turn.sessionId,
        sessionKey: turn.sessionKey,
        messages: [
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
        ],
      });
      expect(await next(turn)).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(lease.degradeBeforeStart).not.toHaveBeenCalled();
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      vi.unstubAllEnvs();
    }
  });

  it("joins accepted outbox acknowledgment after its borrower releases without disclosing another row", async () => {
    const turn = await createTurn("retained-drain");
    await accept(turn);
    expect(await publish(turn)).toBe("ok");
    const borrowed = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: actor.agentId,
      env,
      authority,
      existingOnly: true,
    });
    assert(borrowed);
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const store = withIncognitoSessionBinding({ actor: borrowed }, () =>
      openContextEngineTurnOutboxWorkerStore({
        agentId: borrowed.agentId,
        path: borrowed.path,
        sessionKey: turn.sessionKey,
        sessionId: turn.sessionId,
      }),
    );
    let released: Promise<void> | undefined;
    const onCommitted = vi.fn();
    try {
      await expect(
        drainContextEngineTurnOutbox({
          store,
          engine: engine(async () => {
            released = borrowed.release();
            return { status: "committed" };
          }),
          engineId,
          sessionId: turn.sessionId,
          onCommitted,
          warn: vi.fn(),
        }),
      ).rejects.toThrow("reference is released");
      await released;
      expect(await next(turn)).toBeUndefined();
      expect(onCommitted).not.toHaveBeenCalled();
    } finally {
      await borrowed.release();
      vi.unstubAllEnvs();
    }
  });

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
});

describe("reports", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  const authority: IncognitoSessionAuthority = { assertCurrent() {} };
  type IncognitoTranscriptTarget = Omit<
    IncognitoTranscriptOperations["session.report.prepare"]["input"],
    "selection"
  >;
  let actor: IncognitoAgentDatabaseExecution;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-reports-") };
    const opened = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env,
      authority,
    });
    assert(opened);
    actor = opened;
  });

  it("captures the shared actor for report selection and append without caller SQL", async () => {
    const target = await create("shared-composition");
    const scope = {
      ...target,
      ...target.fence,
      agentId: actor.agentId,
      storePath: actor.path,
      env,
    };
    const sql = observeHostDataSql();
    try {
      await withIncognitoSessionActor(actor, async () => {
        expect(
          await appendSessionTranscriptReport(scope, {
            kind: "custom",
            customTypes: ["status"],
            selectReport: () => ({
              customType: "status",
              content: "private report",
              display: true,
            }),
          }),
        ).toEqual({ ok: true, value: undefined });
        expect(await readLatestSessionTranscriptReport(scope, ["status"])).toMatchObject({
          ok: true,
          value: { content: "private report" },
        });
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it("retains the report writer assertion across actor FIFO waits", async () => {
    const target = await create("composition-revoked");
    const scope = {
      ...target,
      ...target.fence,
      agentId: actor.agentId,
      storePath: actor.path,
      env,
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const held = actor.run(authority, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let allowed = true;
    const pending = withIncognitoSessionActor(actor, () =>
      withSessionTranscriptWriteAssertion(
        scope,
        () => {
          if (!allowed) {
            throw new Error("report writer revoked");
          }
        },
        () =>
          appendSessionTranscriptReport(scope, {
            kind: "custom",
            customTypes: ["status"],
            selectReport: () => ({ customType: "status", content: "refused", display: true }),
          }),
      ),
    );
    const refused = expect(pending).rejects.toThrow("report writer revoked");
    await Promise.resolve();
    allowed = false;
    release.resolve();
    await Promise.all([held, refused]);
    expect(await latest(target)).toEqual({ ok: true, value: undefined });
  });
  afterAll(async () => {
    await actor?.close();
  });

  async function create(name: string): Promise<IncognitoTranscriptTarget> {
    const sessionKey = `agent:main:dashboard:incognito-${name}`;
    await actor.sessions.create(authority, {
      sessionKey,
      entry: {
        sessionId: name,
        updatedAt: 10_000,
        createdAt: 10_000,
        lifecycleRevision: "initial",
        incognito: true,
      },
    });
    return { sessionKey, sessionId: name, fence: { expectedLifecycleRevision: "initial" } };
  }

  async function prepare(target: IncognitoTranscriptTarget, content: string) {
    const result = await actor.sessions.transcript(authority, {
      type: "session.report.prepare",
      input: { ...target, selection: { kind: "custom", customTypes: ["status"] } },
    });
    assert(result.ok);
    return {
      ...target,
      prepared: result.value.prepared,
      report: prepareCustomTranscriptReport(
        { customType: "status", content, display: true },
        result.value.facts.appendParentId,
      ),
    };
  }

  function latest(target: IncognitoTranscriptTarget) {
    return actor.sessions.transcript(authority, {
      type: "session.report.latestCustomReport",
      input: { ...target, customTypes: ["status"] },
    });
  }

  it("orders competing report and message appends in the same FIFO and rejects stale selection", async () => {
    const target = await create("fifo");
    const input = await prepare(target, "first report");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const held = actor.run(authority, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const order: string[] = [];
    const report = actor.sessions
      .transcript(authority, { type: "session.report.append", input })
      .then((value) => {
        order.push("report");
        return value;
      });
    const message = actor.sessions
      .transcript(authority, {
        type: "session.message.append",
        input: { ...target, message: { role: "user", content: "after report", timestamp: 1 } },
      })
      .then((value) => {
        order.push("message");
        return value;
      });
    const stale = actor.sessions.transcript(authority, { type: "session.report.append", input });
    release.resolve();
    const [reported, appended, refused] = await Promise.all([report, message, stale, held]);
    expect(order).toEqual(["report", "message"]);
    expect(reported).toMatchObject({ ok: true, value: { committed: true } });
    assert(appended.ok && appended.value.append);
    expect(appended.value.append.effectiveParentId).toBe(JSON.parse(input.report.eventJson).id);
    expect(refused).toMatchObject({ ok: true, value: { committed: false } });
    expect(await latest(target)).toMatchObject({ ok: true, value: { content: "first report" } });
    const next = await prepare(target, "after message");
    expect(JSON.parse(next.report.eventJson).parentId).toBe(appended.value.append.messageId);
    expect(
      await actor.sessions.transcript(authority, { type: "session.report.append", input: next }),
    ).toMatchObject({ ok: true, value: { committed: true } });
    expect(await latest(target)).toMatchObject({ ok: true, value: { content: "after message" } });
  });

  it("refuses report authority revoked at commit without appending", async () => {
    const target = await create("revoked-commit");
    const input = await prepare(target, "must not commit");
    let allowed = true;
    const stages: string[] = [];
    const source: IncognitoSessionAuthority = {
      assertCurrent() {
        if (!allowed) {
          throw new Error("report authority revoked");
        }
      },
      authorize(phase) {
        stages.push(phase);
        expect(() =>
          actor.sessions.transcript(authority, {
            type: "session.report.latestCustomReport",
            input: { ...target, customTypes: ["status"] },
          }),
        ).toThrow("authority callbacks cannot call their actor");
        if (phase === "commit") {
          allowed = false;
        }
      },
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const held = actor.run(authority, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const rejected = expect(
      actor.sessions.transcript(source, { type: "session.report.append", input }),
    ).rejects.toThrow("report authority revoked");
    release.resolve();
    await Promise.all([held, rejected]);
    expect(stages).toEqual(["transaction", "commit"]);
    expect(await latest(target)).toEqual({ ok: true, value: undefined });
    expect(
      await actor.sessions.transcript(authority, { type: "session.report.append", input }),
    ).toMatchObject({ ok: true, value: { committed: true } });
  });
});
