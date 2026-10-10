import "../../test-utils/prepare-compiled-subprocesses.js";
import { existsSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { bindUserTurnInputActor } from "../../sessions/user-turn-transcript-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
} from "../../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readSessionPendingInputByKey } from "./session-accessor.sqlite-pending-inputs.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import type { SessionActorAuthority, SessionActorReducer } from "./session-actor-contract.js";
import { createSessionActorFactory } from "./session-actor-durable.js";
import {
  captureNativeIncognitoSessionActorSources,
  captureNativeIncognitoSessionActorTarget,
} from "./session-actor-native-incognito.js";
import { acquireSessionInputActor } from "./session-input-actor.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import { withSessionTranscriptSourcePublication } from "./transcript-write-context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const usage: SessionActorReducer = {
  kind: "usage",
  updatedAt: 50,
  update: {
    usage: { input: 120, output: 8 },
    modelSelection: {},
    hasUsage: true,
    hasBilling: false,
    hasContextUpdate: false,
    hasFreshContextSnapshot: false,
    hasCurrentContextSnapshot: false,
    preserveSessionModelState: true,
    preserveUserFacingRunState: false,
  },
};

function nativeDatabase(env: NodeJS.ProcessEnv) {
  const database = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    env,
  };
  const scope = {
    agentId: database.agentId,
    storePath: database.path,
    sessionKey: "agent:main:dashboard:incognito-native-completion",
    env,
  };
  replaceSessionEntrySync(scope, {
    sessionId: "native-session",
    updatedAt: 1,
    incognito: true,
    activeWriterRunId: "native-run",
  });
  const owner = expectDefined(getOpenClawAgentDatabaseIfOpen(database), "native owner");
  const target = expectDefined(
    captureNativeIncognitoSessionActorTarget({ database, sessionKey: scope.sessionKey }),
    "native actor target",
  );
  return { database, owner, scope, target };
}

async function nativeSession(env: NodeJS.ProcessEnv) {
  const { database, owner, scope, target } = nativeDatabase(env);
  const factory = createSessionActorFactory(database);
  const actor = await factory.acquire(target, lifetime);
  return { actor, database, factory, owner, scope, target };
}

async function nativeInputSession(env: NodeJS.ProcessEnv) {
  const fixture = nativeDatabase(env);
  const input = await acquireSessionInputActor(
    {
      ...fixture.scope,
      target: { canonicalKey: fixture.scope.sessionKey, storeKeys: [fixture.scope.sessionKey] },
    },
    lifetime,
  );
  const entry = expectDefined((await input.actor.read(authority)).entry, "input session entry");
  return {
    ...fixture,
    input,
    recorderTarget: {
      ...fixture.scope,
      sessionId: entry.sessionId,
      expectedSessionId: entry.sessionId,
      sessionEntry: entry,
    },
  };
}

it.each(["direct", "destructured"] as const)(
  "retains native input custody before ACK and adopts it once through %s recorder methods",
  async (invocation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const { input, database, owner, scope, recorderTarget } = await nativeInputSession(env);
      let approvals = 0;
      const createRecorder = () => {
        const recorder = createUserTurnTranscriptRecorder({
          input: { text: "original input", timestamp: 1, idempotencyKey: "native-input:user" },
          target: recorderTarget,
          trackInputCompletion: true,
          beforeMessageWrite: ({ message }) => {
            approvals += 1;
            return { ...message, content: "approved input" };
          },
          updateMode: "none",
          onPersistenceError() {},
        });
        bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
        return recorder;
      };
      const recorder = createRecorder();
      const accept = vi.spyOn(input.actor, "acceptInput");
      const adopt = vi.spyOn(input.actor, "adoptRun");
      try {
        await expect(
          recorder.stageApproved?.({ runId: "native-run", assertCurrent() {} }),
        ).resolves.toBe(true);
        expect(approvals).toBe(1);
        const pending = expectDefined(
          readSessionPendingInputByKey(owner, recorderTarget, "native-input:user"),
          "custody before ACK",
        );
        expect(JSON.parse(pending.message_json)).toMatchObject({ content: "approved input" });
        expect(readTranscriptEventRows(owner, recorderTarget.sessionId)).toEqual([]);
        expect(recorder.getPendingInputMessage?.()).toMatchObject({ content: "approved input" });
        expect(input.actor.snapshot(authority)?.pendingInputs).toMatchObject([
          { input_id: pending.input_id, consumed_event_id: null },
        ]);
        expect(accept).toHaveBeenCalledOnce();

        bindUserTurnInputActor(recorder, { phase: "adoptRun", acquire: async () => input });
        const { persistApproved } = recorder;
        const persisted = await (invocation === "direct"
          ? recorder.persistApproved()
          : persistApproved());
        expect(persisted).toMatchObject({ appended: true, message: { content: "approved input" } });
        expect(approvals).toBe(1);
        expect(recorder.isPendingInputConsumed?.()).toBe(true);
        expect(
          readSessionPendingInputByKey(owner, recorderTarget, "native-input:user"),
        ).toBeUndefined();
        expect(adopt).toHaveBeenCalledOnce();
        expect(accept).toHaveBeenCalledOnce();
        await recorder.persistFallback();
        expect(adopt).toHaveBeenCalledOnce();
        expect(input.actor.snapshot(authority)?.transcript.idempotency).toEqual([
          expect.objectContaining({ key: "native-input:user", eventId: persisted?.messageId }),
        ]);

        const retry = createRecorder();
        await expect(
          retry.stageApproved?.({ runId: "native-run", assertCurrent() {} }),
        ).resolves.toBe(true);
        // Consumption retires the raw receipt; completion-tracked retries must
        // revalidate their approved bytes against the committed transcript.
        expect(approvals).toBe(2);
        expect(retry.getPendingInputMessage?.()).toMatchObject({ content: "approved input" });
        bindUserTurnInputActor(retry, { phase: "adoptRun", acquire: async () => input });
        await expect(retry.persistApproved()).resolves.toMatchObject({
          appended: false,
          messageId: persisted?.messageId,
          message: { content: "approved input", timestamp: 1 },
        });
        retry.finishPendingInput?.("interrupted");
        await retry.waitForPendingInputSettlement?.();
        expect(approvals).toBe(2);
        expect(
          readTranscriptEventRows(owner, recorderTarget.sessionId)
            .map((row) => JSON.parse(row.eventJson))
            .filter((event) => event.type === "message"),
        ).toHaveLength(1);
        expect(getOpenClawAgentDatabaseIfOpen(database)).toBe(owner);
        expect(input.target.readSource?.databaseIdentity).toBe(
          readOpenClawAgentDatabaseIdentity(owner).identity,
        );
        expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
        expect(existsSync(scope.storePath)).toBe(false);
        expect(existsSync(resolveOpenClawAgentSqlitePath({ agentId: scope.agentId, env }))).toBe(
          false,
        );
      } finally {
        recorder.finishPendingInput?.("interrupted");
        await recorder.waitForPendingInputSettlement?.();
        await input.actor.release();
      }
    });
  },
);

it("retains staged custody when authority ends during committed publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { input, owner, recorderTarget } = await nativeInputSession(env);
    let live = true;
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "accepted before revocation",
        timestamp: 1,
        idempotencyKey: "staged-revoked:user",
      },
      target: recorderTarget,
      updateMode: "none",
      onPersistenceError() {},
    });
    bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
    const accept = input.actor.acceptInput;
    vi.spyOn(input.actor, "acceptInput").mockImplementation((command, current, observer) =>
      accept(command, current, {
        committed(outcome) {
          live = false;
          observer?.committed(outcome);
        },
      }),
    );
    try {
      await expect(
        recorder.stageApproved?.({
          runId: "native-run",
          assertCurrent() {
            if (!live) throw new Error("staged authority ended");
          },
        }),
      ).rejects.toThrow("staged authority ended");
      expect(recorder.getPendingInputMessage?.()).toMatchObject({
        content: "accepted before revocation",
      });
      expect(
        readSessionPendingInputByKey(owner, recorderTarget, "staged-revoked:user"),
      ).toMatchObject({
        state: "queued",
      });
      recorder.finishPendingInput?.("interrupted");
      await expect(recorder.waitForPendingInputSettlement?.()).rejects.toThrow(
        "staged authority ended",
      );
      expect(
        readSessionPendingInputByKey(owner, recorderTarget, "staged-revoked:user"),
      ).toMatchObject({
        state: "interrupted",
      });
    } finally {
      recorder.finishPendingInput?.("interrupted");
      try {
        await expect(recorder.waitForPendingInputSettlement?.()).rejects.toThrow(
          "staged authority ended",
        );
      } finally {
        await input.actor.release();
      }
    }
  });
});

it("refuses staging when custody authority ends at the final actor commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { input, owner, recorderTarget } = await nativeInputSession(env);
    let live = true;
    let commits = 0;
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "must not be accepted", timestamp: 1, idempotencyKey: "stage-final:user" },
      target: recorderTarget,
      updateMode: "none",
      onPersistenceError() {},
    });
    bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
    const accept = input.actor.acceptInput;
    vi.spyOn(input.actor, "acceptInput").mockImplementation((command, current, observer) =>
      accept(
        command,
        {
          ...current,
          authorize(stage, snapshot, publication) {
            if (stage === "commit" && owner.db.isTransaction && ++commits === 2) live = false;
            current.authorize(stage, snapshot, publication);
          },
        },
        observer,
      ),
    );
    try {
      await expect(
        recorder.stageApproved?.({
          runId: "native-run",
          assertCurrent() {
            if (!live) throw new Error("final custody authority ended");
          },
        }),
      ).rejects.toThrow("final custody authority ended");
      expect(commits).toBe(2);
      expect(
        readSessionPendingInputByKey(owner, recorderTarget, "stage-final:user"),
      ).toBeUndefined();
      expect(recorder.getPendingInputMessage?.()).toBeUndefined();
      expect(readTranscriptEventRows(owner, recorderTarget.sessionId)).toEqual([]);
    } finally {
      live = true;
      recorder.finishPendingInput?.("interrupted");
      await recorder.waitForPendingInputSettlement?.();
      await input.actor.release();
    }
  });
});

it("retains recorder custody when the native actor's committed publication fails", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { input, owner, scope, recorderTarget } = await nativeInputSession(env);
    const failure = new Error("native input publication failed");
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "accepted input", timestamp: 1, idempotencyKey: "native-publication:user" },
      target: recorderTarget,
      updateMode: "none",
      onPersistenceError() {},
    });
    bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
    try {
      await expect(
        recorder.stageApproved?.({ runId: "native-run", assertCurrent() {} }),
      ).resolves.toBe(true);
      bindUserTurnInputActor(recorder, { phase: "adoptRun", acquire: async () => input });
      const publish = vi.fn(() => {
        expect(recorder.hasPersisted()).toBe(true);
        expect(recorder.getAdmissionReceipt()).toMatchObject({ sessionId: "native-session" });
        throw failure;
      });
      await expect(
        withSessionTranscriptSourcePublication(recorderTarget, publish, () =>
          recorder.persistApproved(),
        ),
      ).rejects.toThrow(failure.message);
      expect(publish).toHaveBeenCalledOnce();
      expect(recorder.isPendingInputConsumed?.()).toBe(true);
      expect(recorder.getPersistedMessage()).toMatchObject({ content: "accepted input" });
      const admission = expectDefined(recorder.getAdmissionReceipt(), "committed admission");
      const { persistFallback } = recorder;
      await expect(persistFallback()).resolves.toMatchObject({
        appended: true,
        messageId: admission.entryId,
        message: { content: "accepted input" },
      });
      expect(
        readSessionPendingInputByKey(owner, recorderTarget, "native-publication:user"),
      ).toBeUndefined();
      expect(
        readTranscriptEventRows(owner, recorderTarget.sessionId)
          .map((row) => JSON.parse(row.eventJson))
          .filter((event) => event.type === "message"),
      ).toHaveLength(1);
      expect(publish).toHaveBeenCalledOnce();
      expect(existsSync(scope.storePath)).toBe(false);
    } finally {
      recorder.finishPendingInput?.("interrupted");
      await recorder.waitForPendingInputSettlement?.();
      await input.actor.release();
    }
  });
});

it("rolls back recorder adoption when accepted input authority is revoked at COMMIT", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { input, owner, recorderTarget } = await nativeInputSession(env);
    let live = true;
    let commitReached = false;
    const failure = new Error("accepted input authority revoked");
    const assertCurrent = () => {
      if (!live) throw failure;
    };
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "must remain pending", timestamp: 1, idempotencyKey: "native-revoked:user" },
      target: recorderTarget,
      updateMode: "none",
      onPersistenceError() {},
    });
    bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
    try {
      await expect(recorder.stageApproved?.({ runId: "native-run", assertCurrent })).resolves.toBe(
        true,
      );
      bindUserTurnInputActor(recorder, { phase: "adoptRun", acquire: async () => input });
      const adopt = input.actor.adoptRun;
      vi.spyOn(input.actor, "adoptRun").mockImplementation((command, current, observer) =>
        adopt(
          command,
          {
            ...current,
            authorize(stage, snapshot, publication) {
              if (stage === "commit") {
                commitReached = true;
                expect(owner.db.isTransaction).toBe(true);
                live = false;
              }
              current.authorize(stage, snapshot, publication);
            },
          },
          observer,
        ),
      );
      await expect(recorder.persistApproved()).rejects.toBe(failure);
      expect(commitReached).toBe(true);
      expect(recorder.hasPersisted()).toBe(false);
      expect(recorder.isPendingInputConsumed?.()).toBe(false);
      expect(recorder.getAdmissionReceipt()).toBeUndefined();
      expect(readTranscriptEventRows(owner, recorderTarget.sessionId)).toEqual([]);
      expect(
        readSessionPendingInputByKey(owner, recorderTarget, "native-revoked:user"),
      ).toMatchObject({ state: "queued", consumed_event_id: null });
    } finally {
      recorder.finishPendingInput?.("interrupted");
      await recorder.waitForPendingInputSettlement?.();
      await input.actor.release();
    }
  });
});

it("completes usage through the existing unbound native incognito owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { actor, database, owner, scope, target } = await nativeSession(env);
    let callbackCount = 0;
    try {
      expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
      const before = await actor.read(authority);
      const entry = expectDefined(before.entry, "native session entry");
      const source = {
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: readOpenClawAgentDatabaseIdentity(owner).identity,
      };
      const ownerSources = captureNativeIncognitoSessionActorSources({
        database,
        target,
        sources: [
          {
            source,
            sessionKey: scope.sessionKey,
            fields: ["sessionId"],
            expected: { sessionId: entry.sessionId },
          },
        ],
      });
      expect(() =>
        captureNativeIncognitoSessionActorSources({
          database,
          target,
          sources: [
            {
              source: { ...source, databaseIdentity: Symbol("other-owner") },
              sessionKey: scope.sessionKey,
              fields: [],
              expected: undefined,
            },
          ],
        }),
      ).toThrow("another database");
      const outcome = await actor.withPhase("terminal", authority, async (phase) => {
        callbackCount += 1;
        phase.patch([usage]);
        return phase.actor.completeTurn(
          {
            commandId: "native-complete",
            phaseId: "terminal",
            expected: before.version,
            turn: {
              agentId: scope.agentId,
              sessionKey: scope.sessionKey,
              ownerSources,
              options: {
                expectedSessionId: entry.sessionId,
                expectedWriterRunId: "native-run",
                expectedSessionState: buildRestartRecoveryExpectedState(entry),
                sessionLifecyclePatch: { status: "done", endedAt: 50 },
                sessionFile: "native-session.jsonl",
                messages: [],
              },
            },
          },
          authority,
        );
      });
      expect(callbackCount).toBe(1);
      expect(outcome.kind).toBe("committed");
      if (outcome.kind !== "committed") {
        throw new Error("Native completion did not commit");
      }
      expect(outcome.failure).toBeUndefined();
      expect(outcome.receipt).toMatchObject({
        commandId: "native-complete",
        phase: "completeTurn",
        beforeVersion: before.version,
        afterVersion: { epoch: before.version.epoch, sequence: before.version.sequence + 1 },
        reducers: [{ index: 0, kind: "usage", changed: true }],
        transcript: { appendedMessages: [] },
      });
      expect(actor.snapshot(authority)).toEqual(outcome.receipt.postimage);
      expect(readExactSessionEntryRow(owner, scope.sessionKey)?.entry).toMatchObject({
        incognito: true,
        inputTokens: 120,
        outputTokens: 8,
        status: "done",
        endedAt: 50,
      });
      expect(getOpenClawAgentDatabaseIfOpen(database)).toBe(owner);
      expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
      expect(existsSync(scope.storePath)).toBe(false);
      expect(existsSync(resolveOpenClawAgentSqlitePath({ agentId: scope.agentId, env }))).toBe(
        false,
      );
    } finally {
      await actor.release();
    }
  });
});

it("preserves the native committed receipt and replica when a commit observer fails", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { actor, owner, scope } = await nativeSession(env);
    try {
      const before = await actor.read(authority);
      const committed = vi.fn(() => {
        throw new Error("native publication failed");
      });
      const outcome = await actor.patch(
        {
          commandId: "native-observer",
          phaseId: "terminal",
          expected: before.version,
          reducers: [usage],
        },
        authority,
        { committed },
      );
      expect(committed).toHaveBeenCalledOnce();
      expect(outcome.kind).toBe("committed");
      if (outcome.kind !== "committed") {
        throw new Error("Native usage did not commit");
      }
      expect(outcome.failure).toEqual({ name: "Error", message: "native publication failed" });
      expect(outcome.receipt.beforeVersion).toEqual(before.version);
      expect(actor.snapshot(authority)).toEqual(outcome.receipt.postimage);
      expect(readExactSessionEntryRow(owner, scope.sessionKey)?.entry).toMatchObject({
        inputTokens: 120,
        outputTokens: 8,
      });
    } finally {
      await actor.release();
    }
  });
});

it("refuses a captured native owner after closure instead of adopting its replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { actor, database, factory, owner, scope, target } = await nativeSession(env);
    try {
      await actor.read(authority);
      await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
      expect(owner.db.isOpen).toBe(false);
      replaceSessionEntrySync(scope, {
        sessionId: "replacement-session",
        updatedAt: 2,
        incognito: true,
      });
      const replacement = expectDefined(
        getOpenClawAgentDatabaseIfOpen(database),
        "replacement owner",
      );
      expect(replacement).not.toBe(owner);
      expect(() => actor.snapshot(authority)).toThrow();
      await expect(factory.acquire(target, lifetime)).rejects.toThrow("captured owner");
      expect(readExactSessionEntryRow(replacement, scope.sessionKey)?.entry).toMatchObject({
        sessionId: "replacement-session",
        updatedAt: 2,
      });
      expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
      expect(existsSync(database.path)).toBe(false);
    } finally {
      await actor.release();
    }
  });
});
