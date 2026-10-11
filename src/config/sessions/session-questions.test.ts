import { copyFileSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.entry.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryRow,
} from "./session-accessor.sqlite-entry-store.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSqliteScope } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { hasSessionQuestionCustodyRetiredError } from "./session-questions-custody-error.js";
import {
  executeSessionQuestionOperation,
  readSessionQuestionCustody,
} from "./session-questions.js";
import type { DurableQuestion, SessionQuestionOperation } from "./session-questions.types.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("durable question custody", () => {
  const fixture = useTempSessionsFixture("openclaw-question-custody-");
  const sessionKey = "agent:main:question-custody";
  const sessionId = "question-session";
  const lifecycleRevision = "question-generation";
  const scope = () => ({
    agentId: "main",
    sessionKey,
    storePath: fixture.storePath(),
    assertCurrent() {},
  });
  const capturedQuestions = new Map<string, DurableQuestion>();
  type TestOperation<T> = T extends { expectedQuestion: DurableQuestion }
    ? Omit<T, "expectedQuestion">
    : T;
  const operate = async (operation: TestOperation<SessionQuestionOperation>) => {
    const request =
      operation.kind === "settle" ||
      operation.kind === "claim" ||
      operation.kind === "finish" ||
      operation.kind === "block"
        ? { ...operation, expectedQuestion: capturedQuestions.get(operation.id)! }
        : operation;
    const result = await executeSessionQuestionOperation(scope(), request);
    if (operation.kind === "register" && result && !Array.isArray(result)) {
      capturedQuestions.set(operation.question.record.id, result);
    }
    return result;
  };

  async function register() {
    await upsertSessionEntryCore(scope(), { sessionId, lifecycleRevision, updatedAt: 1 });
    const target = await prepareSqliteScope(scope());
    if (!target.path) {
      throw new Error("Question fixture requires an exact existing database path.");
    }
    const identity = readDatabasePathIdentitySync(target.path);
    const question: DurableQuestion = {
      record: {
        id: "durable-question",
        agentId: "main",
        sessionKey,
        runId: "asking-run",
        questions: [
          {
            questionId: "choice",
            header: "Choice",
            question: "Choose a path",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        status: "pending",
      },
      sessionKey,
      sessionId,
      lifecycleRevision,
      provenance: { issuer: "operator", sourceRunId: "asking-run" },
      sessionBinding: {
        agentId: "main",
        sessionKey,
        sessionId,
        lifecycleRevision,
        storePath: fixture.storePath(),
        databasePath: target.path,
        databaseIdentity: {
          identity: identity.key.slice("file:".length),
          birthtime: identity.birthtime,
        },
      },
      continuation: { status: "pending" },
    };
    expect(await operate({ kind: "register", question })).toEqual(question);
    expect(loadSessionEntry(scope())?.durableQuestionOwners).toEqual([
      {
        questionId: question.record.id,
        sourceRunId: "asking-run",
        sessionId,
        lifecycleRevision,
      },
    ]);
    return question;
  }

  it("reconciles JSON-equivalent production optional fields without weakening custody identity", async () => {
    const question = await register();
    const retry = structuredClone(question);
    retry.provenance.recoverySource = undefined;
    retry.provenance.channelAuthorizationReference = undefined;
    retry.sessionBinding.profileId = undefined;
    retry.record.questions[0]!.options[0]!.description = undefined;
    retry.record.createdAtMs += 100;
    retry.record.expiresAtMs += 100;
    expect(await operate({ kind: "register", question: retry })).toEqual(question);
    retry.provenance.sourceRunId = "unrelated-source";
    await expect(operate({ kind: "register", question: retry })).rejects.toThrow(
      "immutable definition",
    );
  });

  it("keeps the first committed answer and its owed continuation after reopen and a competing answer", async () => {
    const question = await register();
    const transcriptScope = { ...scope(), sessionId };
    await replaceTranscriptEvents(
      transcriptScope,
      Array.from({ length: 512 }, (_, i) => ({
        type: "message",
        id: `history-${i}`,
        parentId: null,
        message: { role: "user", content: "unrelated history ".repeat(256) },
      })),
    );
    expect(await operate({ kind: "get", id: question.record.id })).toEqual(question);
    await replaceTranscriptEvents(transcriptScope, [
      {
        type: "message",
        id: "compacted",
        parentId: null,
        message: { role: "user", content: "Compacted history and a new unrelated message" },
      },
    ]);
    expect(await operate({ kind: "get", id: question.record.id })).toEqual(question);
    const retry = structuredClone(question);
    retry.record.createdAtMs += 100;
    retry.record.expiresAtMs += 100;
    expect(await operate({ kind: "register", question: retry })).toEqual(question);
    retry.record.expiresAtMs += 1;
    await expect(operate({ kind: "register", question: retry })).rejects.toThrow(
      "immutable definition",
    );
    await replaceSessionEntry(scope(), { sessionId, lifecycleRevision, updatedAt: 2 });
    expect(loadSessionEntry(scope())?.durableQuestionOwners).toMatchObject([
      {
        questionId: question.record.id,
        sourceRunId: "asking-run",
      },
    ]);
    const answer = {
      id: question.record.id,
      status: "answered" as const,
      answers: { answers: { choice: ["A"] } },
    };
    const settled = await operate({
      kind: "settle",
      id: question.record.id,
      outcome: answer,
      resolutionId: "first-resolution",
    });
    await closeOpenClawAgentDatabasesAsync();
    expect(await operate({ kind: "get", id: question.record.id })).toEqual(settled);
    expect(
      await operate({
        kind: "settle",
        id: question.record.id,
        outcome: { id: question.record.id, status: "cancelled" },
        resolutionId: "competing-resolution",
      }),
    ).toEqual(settled);
    expect(settled).toMatchObject({
      record: { status: "answered", answers: answer.answers },
      resolutionId: "first-resolution",
      continuation: { status: "owed" },
    });
    await operate({
      kind: "claim",
      id: question.record.id,
      runId: "settled-run",
      gatewayEpoch: "gateway",
    });
    const finished = await operate({
      kind: "finish",
      id: question.record.id,
      runId: "settled-run",
    });
    expect(finished).toMatchObject({ retainUntilMs: expect.any(Number) });
    const retainedUntil = (finished as DurableQuestion).retainUntilMs;
    await closeOpenClawAgentDatabasesAsync();
    expect(await operate({ kind: "list" })).toEqual([finished]);
    expect(
      ((await operate({ kind: "get", id: question.record.id })) as DurableQuestion).retainUntilMs,
    ).toBe(retainedUntil);
    expect(await operate({ kind: "get", id: question.record.id })).toMatchObject({
      record: { status: "answered", answers: answer.answers },
      resolutionId: "first-resolution",
      continuation: { status: "settled" },
    });
  });

  it("reads exact committed custody after caller revocation and rejects changed owner facts", async () => {
    const question = await register();
    const committed = await operate({
      kind: "settle",
      id: question.record.id,
      outcome: { id: question.record.id, status: "cancelled" },
      resolutionId: "committed-before-revocation",
    });
    const revokedCaller = () => {
      throw new Error("Caller revoked");
    };
    await expect(
      executeSessionQuestionOperation(
        { ...scope(), assertCurrent: revokedCaller },
        { kind: "get", id: question.record.id },
      ),
    ).rejects.toThrow("Caller revoked");
    expect(
      await readSessionQuestionCustody(question.sessionBinding, question.record.id, () => {}),
    ).toEqual(committed);
    const omittedOptionals = {
      ...question.sessionBinding,
      profileId: undefined,
      databaseIdentity: { ...question.sessionBinding.databaseIdentity, omitted: undefined },
    };
    expect(
      await readSessionQuestionCustody(omittedOptionals, question.record.id, () => {}),
    ).toEqual(committed);
    await expect(
      readSessionQuestionCustody(
        {
          ...question.sessionBinding,
          databaseIdentity: {
            ...question.sessionBinding.databaseIdentity,
            identity: "wrong-inode",
          },
        },
        question.record.id,
        () => {},
      ),
    ).rejects.toThrow("database identity changed");
    await expect(
      readSessionQuestionCustody(
        { ...question.sessionBinding, profileId: "different-owner" },
        question.record.id,
        () => {},
      ),
    ).rejects.toThrow("binding does not match");
    await expect(
      readSessionQuestionCustody(question.sessionBinding, question.record.id, revokedCaller),
    ).rejects.toThrow("Caller revoked");
    let ownerChecks = 0;
    await expect(
      readSessionQuestionCustody(question.sessionBinding, question.record.id, () => {
        if (++ownerChecks > 2) {
          throw new Error("Gateway incarnation retired after read");
        }
      }),
    ).rejects.toThrow("Gateway incarnation retired after read");
    await replaceSessionEntry(scope(), {
      sessionId: "replacement",
      lifecycleRevision: "replacement-generation",
      updatedAt: 5,
    });
    await expect(
      readSessionQuestionCustody(question.sessionBinding, question.record.id, () => {}),
    ).rejects.toThrow("session generation changed");
  });

  it("retains every unresolved or natively referenced recovery owner across later questions", async () => {
    const first = await register();
    const competing = await Promise.all([
      operate({
        kind: "settle",
        id: first.record.id,
        outcome: { id: first.record.id, status: "cancelled" },
        resolutionId: "cancel-first",
      }),
      operate({
        kind: "settle",
        id: first.record.id,
        outcome: {
          id: first.record.id,
          status: "answered",
          answers: { answers: { choice: ["A"] } },
        },
        resolutionId: "answer-first",
      }),
    ]);
    expect(competing[0]).toEqual(competing[1]);
    expect(await operate({ kind: "get", id: first.record.id })).toEqual(competing[0]);
    expect(competing[0]).toMatchObject({ continuation: { status: "owed" } });
    const second = structuredClone(first);
    second.record.id = "second-question";
    second.record.runId = "second-asking-run";
    second.provenance.sourceRunId = "second-asking-run";
    await operate({ kind: "register", question: second });
    expect(
      loadSessionEntry(scope())?.durableQuestionOwners?.map((owner) => owner.questionId),
    ).toEqual([first.record.id, second.record.id]);
    await operate({
      kind: "claim",
      id: first.record.id,
      runId: "first-continuation",
      gatewayEpoch: "gateway",
    });
    await operate({ kind: "finish", id: first.record.id, runId: "first-continuation" });
    await replaceSessionEntry(scope(), {
      sessionId,
      lifecycleRevision,
      updatedAt: 3,
      lifecycleRunId: "asking-run",
    });
    await operate({
      kind: "settle",
      id: second.record.id,
      outcome: { id: second.record.id, status: "cancelled" },
      resolutionId: "second",
    });
    const third = structuredClone(second);
    third.record.id = "third-question";
    third.record.runId = "third-asking-run";
    third.provenance.sourceRunId = "third-asking-run";
    await operate({ kind: "register", question: third });
    expect(
      loadSessionEntry(scope())
        ?.durableQuestionOwners?.map((owner) => owner.questionId)
        .toSorted(),
    ).toEqual([first.record.id, second.record.id, third.record.id].toSorted());
    await replaceSessionEntry(scope(), { sessionId, lifecycleRevision, updatedAt: 4 });
    await operate({ kind: "register", question: third });
    // An idempotent registration returns the original receipt without changing ownership.
    await operate({
      kind: "claim",
      id: second.record.id,
      runId: "second-continuation",
      gatewayEpoch: "gateway",
    });
    expect(
      loadSessionEntry(scope())
        ?.durableQuestionOwners?.map((owner) => owner.questionId)
        .toSorted(),
    ).toEqual([second.record.id, third.record.id].toSorted());
  });

  it("counts settled receipts toward capacity and hides expired receipts before pruning", async () => {
    const question = await register();
    await operate({
      kind: "settle",
      id: question.record.id,
      outcome: { id: question.record.id, status: "cancelled" },
      resolutionId: "retained",
    });
    await operate({
      kind: "claim",
      id: question.record.id,
      runId: "retained-run",
      gatewayEpoch: "gateway",
    });
    const finished = (await operate({
      kind: "finish",
      id: question.record.id,
      runId: "retained-run",
    })) as DurableQuestion;
    expect(finished.retainUntilMs).toBeGreaterThan(Date.now());
    await closeOpenClawAgentDatabasesAsync();
    const db = new DatabaseSync(question.sessionBinding.databasePath);
    try {
      // Isolated fixture copies canonical terminal rows; production writes remain worker-owned.
      db.exec(`WITH RECURSIVE ids(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM ids WHERE i < 4095)
        INSERT INTO session_questions SELECT 'receipt-' || i, session_key, session_id, lifecycle_revision,
          definition_json, provenance_json, session_binding_json, result_json, resolution_id,
          continuation_state, continuation_run_id, gateway_epoch, continuation_reason, terminal_at
        FROM session_questions CROSS JOIN ids WHERE question_id = 'durable-question'`);
    } finally {
      db.close();
    }
    const next = structuredClone(question);
    next.record.id = "next-question";
    await expect(operate({ kind: "register", question: next })).rejects.toThrow(
      "Too many retained questions",
    );
    expect((await operate({ kind: "list" })) as DurableQuestion[]).toHaveLength(4096);
    await closeOpenClawAgentDatabasesAsync();
    const expired = new DatabaseSync(question.sessionBinding.databasePath);
    try {
      expired
        .prepare("UPDATE session_questions SET terminal_at = ?")
        .run(Date.now() - 24 * 60 * 60 * 1000 - 1);
    } finally {
      expired.close();
    }
    expect(await operate({ kind: "get", id: question.record.id })).toBeUndefined();
    expect(await operate({ kind: "list" })).toEqual([]);
    expect(await operate({ kind: "register", question: next })).toEqual(next);
    expect(await operate({ kind: "list" })).toEqual([next]);
  });

  it.each(["blocked", "interrupted"] as const)(
    "does not renew an expired %s receipt during generation retirement",
    async (status) => {
      const question = await register();
      await operate({
        kind: "settle",
        id: question.record.id,
        outcome: { id: question.record.id, status: "cancelled" },
        resolutionId: "terminal",
      });
      if (status === "blocked") {
        await operate({
          kind: "block",
          id: question.record.id,
          reason: "Original authority unavailable",
        });
      } else {
        await operate({
          kind: "claim",
          id: question.record.id,
          runId: "terminal-run",
          gatewayEpoch: "gateway",
        });
        await operate({
          kind: "finish",
          id: question.record.id,
          runId: "terminal-run",
          interrupted: true,
        });
      }
      await closeOpenClawAgentDatabasesAsync();
      const deadlineOrigin = Date.now() - 24 * 60 * 60 * 1000 - 1;
      const expired = new DatabaseSync(question.sessionBinding.databasePath);
      try {
        expired
          .prepare("UPDATE session_questions SET terminal_at = ? WHERE question_id = ?")
          .run(deadlineOrigin, question.record.id);
      } finally {
        expired.close();
      }
      await replaceSessionEntry(scope(), {
        sessionId: "replacement",
        lifecycleRevision: "replacement-generation",
        updatedAt: 5,
      });
      expect(
        await operate({
          kind: "retire",
          sessionKey,
          sessionId,
          lifecycleRevision,
          resolutionId: "retirement",
        }),
      ).toEqual([]);
      expect(await operate({ kind: "get", id: question.record.id })).toBeUndefined();
      expect(await operate({ kind: "list" })).toEqual([]);
      await closeOpenClawAgentDatabasesAsync();
      const retained = new DatabaseSync(question.sessionBinding.databasePath);
      try {
        expect(
          retained
            .prepare(
              "SELECT continuation_state, terminal_at FROM session_questions WHERE question_id = ?",
            )
            .get(question.record.id),
        ).toEqual({ continuation_state: status, terminal_at: deadlineOrigin });
      } finally {
        retained.close();
      }
    },
  );

  it.each(["logical", "physical"] as const)(
    "refuses captured mutations against a same-ID %s successor",
    async (replacement) => {
      const original = await register();
      await closeOpenClawAgentDatabasesAsync();
      if (replacement === "physical") {
        const copied = `${original.sessionBinding.databasePath}.replacement`;
        copyFileSync(original.sessionBinding.databasePath, copied);
        renameSync(copied, original.sessionBinding.databasePath);
      }
      // Isolated successor fixture preserves current schema and replaces only old custody.
      const successorDb = new DatabaseSync(original.sessionBinding.databasePath);
      try {
        successorDb.exec("DELETE FROM session_questions");
      } finally {
        successorDb.close();
      }
      const nextSessionId = replacement === "logical" ? "successor-session" : sessionId;
      const nextRevision = replacement === "logical" ? "successor-generation" : lifecycleRevision;
      await upsertSessionEntryCore(scope(), {
        sessionId: nextSessionId,
        lifecycleRevision: nextRevision,
        updatedAt: 7,
      });
      const identity = readDatabasePathIdentitySync(original.sessionBinding.databasePath);
      const successor = structuredClone(original);
      successor.record.runId = "successor-producer";
      successor.provenance.sourceRunId = "successor-producer";
      successor.sessionId = successor.sessionBinding.sessionId = nextSessionId;
      successor.lifecycleRevision = successor.sessionBinding.lifecycleRevision = nextRevision;
      successor.sessionBinding.databaseIdentity = {
        identity: identity.key.slice("file:".length),
        birthtime: identity.birthtime,
      };
      try {
        await executeSessionQuestionOperation(scope(), { kind: "register", question: original });
        throw new Error("Expected stale registration refusal");
      } catch (error) {
        expect(hasSessionQuestionCustodyRetiredError(error)).toBe(true);
      }
      expect(await operate({ kind: "list" })).toEqual([]);
      await operate({ kind: "register", question: successor });
      const refused = async (operation: SessionQuestionOperation) => {
        try {
          await executeSessionQuestionOperation(scope(), operation);
          throw new Error("Expected retired custody refusal");
        } catch (error) {
          expect(hasSessionQuestionCustodyRetiredError(error)).toBe(true);
        }
      };
      await refused({
        kind: "settle",
        id: original.record.id,
        expectedQuestion: original,
        outcome: { id: original.record.id, status: "cancelled" },
        resolutionId: "old-observer",
      });
      expect(await operate({ kind: "get", id: successor.record.id })).toEqual(successor);
      await operate({
        kind: "settle",
        id: successor.record.id,
        outcome: { id: successor.record.id, status: "cancelled" },
        resolutionId: "successor-answer",
      });
      const owed = await operate({ kind: "get", id: successor.record.id });
      await refused({
        kind: "block",
        id: original.record.id,
        expectedQuestion: original,
        reason: "Old refusal",
      });
      await refused({
        kind: "claim",
        id: original.record.id,
        expectedQuestion: original,
        runId: "successor-native-run",
        gatewayEpoch: "gateway",
      });
      expect(await operate({ kind: "get", id: successor.record.id })).toEqual(owed);
      await operate({
        kind: "claim",
        id: successor.record.id,
        runId: "successor-native-run",
        gatewayEpoch: "gateway",
      });
      const claimed = await operate({ kind: "get", id: successor.record.id });
      await refused({
        kind: "finish",
        id: original.record.id,
        expectedQuestion: original,
        runId: "successor-native-run",
        interrupted: true,
      });
      expect(await operate({ kind: "get", id: successor.record.id })).toEqual(claimed);
    },
  );

  it("refuses reused expired IDs while exact native recovery references remain", async () => {
    const original = await register();
    await operate({
      kind: "settle",
      id: original.record.id,
      outcome: { id: original.record.id, status: "cancelled" },
      resolutionId: "old-receipt",
    });
    await operate({
      kind: "claim",
      id: original.record.id,
      runId: "old-continuation",
      gatewayEpoch: "gateway",
    });
    await operate({ kind: "finish", id: original.record.id, runId: "old-continuation" });
    await replaceSessionEntry(scope(), {
      sessionId,
      lifecycleRevision,
      updatedAt: 6,
      lifecycleRunId: "asking-run",
    });
    const owner = loadSessionEntry(scope())?.durableQuestionOwners;
    await closeOpenClawAgentDatabasesAsync();
    const expired = new DatabaseSync(original.sessionBinding.databasePath);
    try {
      expired
        .prepare("UPDATE session_questions SET terminal_at = ? WHERE question_id = ?")
        .run(Date.now() - 24 * 60 * 60 * 1000 - 1, original.record.id);
    } finally {
      expired.close();
    }
    const reused = structuredClone(original);
    reused.record.runId = "new-producer";
    reused.provenance.sourceRunId = "new-producer";
    await expect(operate({ kind: "register", question: reused })).rejects.toThrow(
      "retained by native recovery",
    );
    expect(await operate({ kind: "get", id: original.record.id })).toBeUndefined();
    expect(loadSessionEntry(scope())?.durableQuestionOwners).toEqual(owner);
    expect(owner).toMatchObject([
      { sourceRunId: "asking-run", continuationRunId: "old-continuation" },
    ]);
  });

  it("refuses synchronous durable generation retirement before mutation while preserving legacy writes", async () => {
    await upsertSessionEntryCore(scope(), { sessionId, lifecycleRevision, updatedAt: 1 });
    replaceSessionEntrySync(scope(), {
      sessionId: "legacy-next",
      lifecycleRevision: "legacy-next-generation",
      updatedAt: 2,
    });
    expect(loadSessionEntry(scope())?.sessionId).toBe("legacy-next");
    const question = await register();
    const before = loadSessionEntry(scope());
    expect(() =>
      replaceSessionEntrySync(scope(), {
        sessionId: "refused",
        lifecycleRevision: "refused-generation",
        updatedAt: 3,
      }),
    ).toThrow("owning session worker");
    expect(loadSessionEntry(scope())).toEqual(before);
    expect(await operate({ kind: "get", id: question.record.id })).toEqual(question);
    await replaceSessionEntry(scope(), {
      sessionId: "worker-next",
      lifecycleRevision: "worker-next-generation",
      updatedAt: 4,
    });
    expect(await operate({ kind: "get", id: question.record.id })).toMatchObject({
      record: { status: "cancelled" },
      continuation: { status: "interrupted" },
    });
  });

  it("preflights every alias before synchronous deletion changes an earlier safe alias", async () => {
    const question = await register();
    const safeKey = "agent:main:safe-alias";
    const targetKey = "agent:main:canonical-target";
    await upsertSessionEntryCore(
      { ...scope(), sessionKey: safeKey },
      {
        sessionId: "safe-alias-session",
        updatedAt: 1,
      },
    );
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: question.sessionBinding.databasePath,
    });
    const before = readExactSessionEntryRow(database, safeKey);
    expect(() => deleteLegacySessionEntryRows(database, [safeKey, sessionKey], targetKey)).toThrow(
      "owning session worker",
    );
    expect(readExactSessionEntryRow(database, safeKey)).toEqual(before);
    expect(
      readExactSessionEntryRow(database, sessionKey)?.entry.durableQuestionOwners,
    ).toHaveLength(1);
    expect(readExactSessionEntryRow(database, targetKey)).toBeUndefined();
    expect(await operate({ kind: "get", id: question.record.id })).toEqual(question);
  });

  it("refuses worker alias relocation before losing native question recovery fences", async () => {
    const question = await register();
    const before = loadSessionEntry(scope());
    const targetKey = "agent:main:question-canonical-target";
    await expect(
      applySessionEntryCanonicalReplacements({
        storePath: fixture.storePath(),
        sessionKeys: [sessionKey, targetKey],
        update: () => ({
          result: undefined,
          replacements: [
            {
              sessionKey: targetKey,
              previousSessionKeys: [sessionKey],
              entry: { sessionId, lifecycleRevision, updatedAt: 2 },
            },
          ],
        }),
      }),
    ).rejects.toThrow("question recovery ownership");
    expect(loadSessionEntry(scope())).toEqual(before);
    expect(loadSessionEntry({ ...scope(), sessionKey: targetKey })).toBeUndefined();
    expect(await operate({ kind: "get", id: question.record.id })).toEqual(question);
  });

  it("interrupts a prior admitted claim without replay and refuses claims after session replacement", async () => {
    const question = await register();
    await operate({
      kind: "settle",
      id: question.record.id,
      outcome: { id: question.record.id, status: "cancelled" },
      resolutionId: "cancel-resolution",
    });
    await operate({
      kind: "claim",
      id: question.record.id,
      runId: "continuation-run",
      gatewayEpoch: "old-gateway",
    });
    expect(loadSessionEntry(scope())?.durableQuestionOwners).toMatchObject([
      {
        questionId: question.record.id,
        continuationRunId: "continuation-run",
        sourceRunId: "asking-run",
      },
    ]);
    expect(await operate({ kind: "interrupt", gatewayEpoch: "new-gateway" })).toMatchObject([
      { continuation: { status: "interrupted", runId: "continuation-run" } },
    ]);
    await expect(
      operate({
        kind: "claim",
        id: question.record.id,
        runId: "duplicate-run",
        gatewayEpoch: "new-gateway",
      }),
    ).rejects.toThrow("not available for admission");
    await upsertSessionEntryCore(scope(), {
      sessionId: "replacement-session",
      lifecycleRevision: "replacement-generation",
      updatedAt: 2,
    });
    expect(loadSessionEntry(scope())?.durableQuestionOwners).toBeUndefined();
    await expect(
      operate({
        kind: "claim",
        id: question.record.id,
        runId: "replacement-run",
        gatewayEpoch: "new-gateway",
      }),
    ).rejects.toThrow(/session.*changed/u);
    expect(await operate({ kind: "get", id: question.record.id })).toMatchObject({
      continuation: { status: "interrupted" },
    });
  });
});
