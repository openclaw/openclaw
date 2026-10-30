import { copyFileSync, existsSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { readSessionTranscriptMessageEvents } from "../config/sessions/session-accessor.sqlite-active-events.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  captureExternalSessionCommitGuard,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createAgentCreationWitnessSource } from "../state/openclaw-agent-execution.creation-fixture.test-support.js";
import * as agentExecution from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { prepareClientVoiceSessionClose } from "./client-voice-session-lifecycle.js";
import { assertClientVoiceSessionOpen } from "./client-voice-session-read.js";
import {
  captureClientVoiceEntrySource,
  captureClientVoiceSessionSourceOptions,
  createClientVoiceSessionSource,
} from "./client-voice-session-source.js";
import { readVoiceSessionRecord } from "./client-voice-session-store.js";
import { captureClientVoiceSessionWriter } from "./client-voice-session-write.js";
import * as voiceWriters from "./client-voice-session-write.js";
import {
  recordMutation,
  recordMutationEvents,
  seedSession,
} from "./client-voice-session.fixture.test-support.js";
import {
  appendClientVoiceTranscript,
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";
import { VoiceTranscriptOperationRegistry } from "./voice-transcript.js";

// Install shared mocks before fixture imports load the voice persistence graph.
const { useClientVoiceSessionHarness } = await vi.hoisted(
  () => import("./client-voice-session.harness.test-support.js"),
);

describe("client voice session worker contract", () => {
  const { releaseHeldWrites, sessionTurnMocks } = useClientVoiceSessionHarness();
  const target = { agentId: "main", sessionKey: "agent:main:main" };
  const readRecord = (voiceSessionId: string) =>
    clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId);
  const createVoice = (
    params: Partial<Parameters<typeof createOrResumeClientVoiceSession>[0]> = {},
    writer?: Parameters<typeof createOrResumeClientVoiceSession>[1],
  ) => createOrResumeClientVoiceSession({ ...target, origin: "client", ...params }, writer);
  const appendTranscript = (voiceSessionId: string, entryId: string, text: string) =>
    appendClientVoiceTranscript({
      ...target,
      sessionTarget: { sessionKey: target.sessionKey },
      voiceSessionId,
      entryId,
      role: "user",
      text,
    });

  const requester = (
    prepareSessionSource: NonNullable<SessionSourceAssertion["prepareSessionSource"]>,
  ) => Object.assign(() => {}, { prepareSessionSource });
  function failCleanup(
    resource: { release(): Promise<void> },
    error: Error,
    onReleased = () => {},
  ) {
    const release = resource.release.bind(resource);
    resource.release = async () => {
      await release();
      onReleased();
      throw error;
    };
  }
  async function holdWorker(scope: Parameters<typeof runOpenClawAgentWorkerWrite>[0]) {
    const { entered, release, wait } = createEnteredGate();
    releaseHeldWrites.push(release);
    const blocked = runOpenClawAgentWorkerWrite(scope, wait);
    await entered;
    return { blocked, release };
  }
  function mutateForeignVoice(voiceSessionId: string, change: string, ...values: string[]) {
    const database = new DatabaseSync(resolveOpenClawAgentSqlitePath(target));
    try {
      database
        .prepare(
          "UPDATE cache_entries SET value_json = json_set(value_json, " +
            change +
            ") WHERE scope = ? AND key = ?",
        )
        .run(...values, "talk-client-voice-sessions", voiceSessionId);
    } finally {
      database.close();
    }
  }

  it.each(["metadata", "entry"] as const)(
    "joins pending agent initialization when capturing the Talk %s writer",
    async (kind) => {
      const options = captureClientVoiceSessionSourceOptions(target.agentId);
      openOpenClawStateDatabase({ env: options.env });
      const creator = agentExecution.captureOpenClawAgentDatabaseExecution(options);
      let operation: Promise<unknown> | undefined;
      let release: (() => Promise<void>) | undefined;
      const source = createAgentCreationWitnessSource((request) => {
        const facts = request.facts;
        if (
          !operation &&
          request.stage === "prepare" &&
          facts !== null &&
          typeof facts === "object" &&
          "kind" in facts &&
          facts.kind === "shared-owner"
        ) {
          operation = (async () => {
            if (kind === "metadata") {
              const writer = captureClientVoiceSessionWriter(target);
              release = () => writer.release();
              return writer.mutate({
                ...target,
                kind: "create",
                voiceSessionId: "voice-pending-agent",
                origin: "client",
                now: 1,
              });
            }
            const selected = await captureClientVoiceEntrySource(target, () => {});
            release = () => selected.execution.release();
            await selected.execution.prepare(source);
            return selected.execution.runExisting(source, (worker) =>
              worker.execute({
                type: "session.transcript.initialize",
                input: { sessionKey: target.sessionKey, sessionId: "voice-entry" },
              }),
            );
          })();
          void operation.catch(() => {});
        }
      });
      try {
        await creator.prepare(source);
        expect(operation).toBeDefined();
        await expect(operation).resolves.toMatchObject(
          kind === "metadata"
            ? { voiceSessionId: "voice-pending-agent", status: "open" }
            : { kind: "session-transcript-initialized", sessionKey: target.sessionKey },
        );
      } finally {
        await operation?.catch(() => {});
        await release?.();
        await creator.release();
      }
    },
  );

  it("persists admission, consult effects, transcript bookkeeping, and close off the caller thread", async () => {
    await seedSession(target.sessionKey);
    const voiceSessionId = "voice-worker-boundary";
    const observation = observeHostDataSql();
    try {
      await createVoice({ voiceSessionId });
      await createVoice({ voiceSessionId });
      await recordMutation(voiceSessionId);
      await appendTranscript(voiceSessionId, "user-1", "Send the update");
      await closeClientVoiceSession({ ...target, voiceSessionId, config: {} });
      expect(observation.queries.filter((sql) => /\bcache_entries\b/i.test(sql))).toEqual([]);
    } finally {
      observation.restore();
    }
    expect(readRecord(voiceSessionId)).toMatchObject({
      status: "closed",
      hasUserTranscript: true,
      transcriptFailureKeys: [],
      consultRunIds: [`run-${voiceSessionId}`],
      effects: [{ runId: `run-${voiceSessionId}`, toolName: "message", status: "succeeded" }],
    });
  });

  it.for(["create", "consult"] as const)(
    "preserves the acknowledged %s result after settling failing source and writer cleanup",
    async (operation, { signal }) => {
      await seedSession(target.sessionKey);
      let voiceSessionId = operation === "consult" ? await createVoice() : undefined;
      const sourceError = new Error("synthetic voice source release failure");
      const writerError = new Error("synthetic voice writer release failure");
      const releaseEntered = createDeferred();
      const releaseSource = createDeferred();
      const released: string[] = [];
      const sourceRequester = requester(async () => ({
        checks: [],
        assertCurrent() {},
        async release() {
          releaseEntered.resolve();
          await releaseSource.promise;
          released.push("source");
          throw sourceError;
        },
      }));
      const capture = agentExecution.captureOpenClawAgentDatabasePreparationExecution;
      const captureSpy = vi
        .spyOn(agentExecution, "captureOpenClawAgentDatabasePreparationExecution")
        .mockImplementation((...args): ReturnType<typeof capture> => {
          const execution = capture(...args);
          failCleanup(execution, writerError, () => {
            released.push("writer");
          });
          return execution;
        });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const runId = "acknowledged-cleanup-consult";
      let releaseRun: (() => void) | undefined;
      let settled = false;
      const work =
        operation === "create"
          ? createVoice({ requester: sourceRequester }).then((id) => {
              voiceSessionId = id;
            })
          : registerClientVoiceConsultRun({
              ...target,
              requester: sourceRequester,
              voiceSessionId: voiceSessionId!,
              runId,
            }).then((release) => {
              releaseRun = release;
            });
      const outcome = work.then(
        () => {
          settled = true;
          return { ok: true as const };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false as const, error };
        },
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            releaseEntered.promise,
            work,
            "Voice operation skipped its source cleanup",
          ),
          signal,
        );
        expect(settled).toBe(false);
        releaseSource.resolve();
        expect(await outcome).toEqual({ ok: true });
        expect(released).toEqual(["source", "writer"]);
        expect(voiceSessionId).toEqual(expect.any(String));
        expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId!)).toMatchObject(
          {
            status: "open",
            ...(operation === "consult" ? { consultRunIds: [runId] } : {}),
          },
        );
        if (operation === "consult") {
          expect(resolveClientVoiceRunBinding(runId)).toEqual({ ...target, voiceSessionId });
          expect(releaseRun).toEqual(expect.any(Function));
          releaseRun?.();
          expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
        }
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"), sourceError);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"), writerError);
      } finally {
        releaseSource.resolve();
        await outcome;
        releaseRun?.();
        warn.mockRestore();
        captureSpy.mockRestore();
      }
    },
  );

  it("preserves transcript, flush, and close acknowledgements when writer cleanup fails", async () => {
    await seedSession(target.sessionKey);
    const voiceSessionId = await createVoice();
    const cleanupError = new Error("synthetic accepted voice writer cleanup failure");
    const capture = voiceWriters.captureClientVoiceSessionWriter;
    const captureSpy = vi
      .spyOn(voiceWriters, "captureClientVoiceSessionWriter")
      .mockImplementation((params) => {
        const writer = capture(params);
        failCleanup(writer, cleanupError);
        return writer;
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const close = prepareClientVoiceSessionClose();
    try {
      await expect(
        appendTranscript(
          voiceSessionId,
          "accepted-before-cleanup",
          "Keep the committed transcript acknowledgement",
        ),
      ).resolves.toBeUndefined();
      await expect(
        flushClientVoiceSessionWrites({ ...target, voiceSessionId }),
      ).resolves.toBeUndefined();
      await expect(
        closeClientVoiceSession({ ...target, voiceSessionId, config: {} }),
      ).resolves.toBeUndefined();
      await close.drain();
      expect(readRecord(voiceSessionId)).toMatchObject({
        status: "closed",
        hasUserTranscript: true,
        transcriptFailureKeys: [],
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"), cleanupError);
    } finally {
      await close.drain();
      warn.mockRestore();
      captureSpy.mockRestore();
    }
  });

  it("retains a refused voice mutation and its source cleanup error", async () => {
    await seedSession(target.sessionKey);
    const refusal = new Error("synthetic revoked voice authority");
    const cleanupError = new Error("synthetic refused source cleanup failure");
    const voiceSessionId = "refused-voice-cleanup";
    const sourceRequester = requester(async () => ({
      checks: [],
      assertCurrent() {
        throw refusal;
      },
      async release() {
        throw cleanupError;
      },
    }));
    await expect(createVoice({ requester: sourceRequester, voiceSessionId })).rejects.toMatchObject(
      {
        cause: refusal,
        errors: [refusal, cleanupError],
      },
    );
    expect(readRecord(voiceSessionId)).toBeUndefined();
  });

  it("refuses revoked admission after the FIFO wait", async () => {
    await seedSession(target.sessionKey);
    const { blocked, release } = await holdWorker({ agentId: target.agentId });
    const controller = new AbortController();
    const voiceSessionId = "voice-revoked-admission";
    const prepare = vi.fn(async () => ({ assertCurrent() {}, checks: [] }));
    const creating = createVoice({
      voiceSessionId,
      assertCurrent: () => controller.signal.throwIfAborted(),
      requester: requester(prepare),
    });
    controller.abort(new Error("voice access revoked"));
    const rejected = expect(creating).rejects.toThrow("voice access revoked");
    release();
    await blocked;
    await rejected;
    expect(prepare).not.toHaveBeenCalled();
    expect(readRecord(voiceSessionId)).toBeUndefined();
  });

  it("keeps a preparing resume ahead of later stale recovery", async ({ signal }) => {
    const voiceSessionId = await createVoice({ now: 1 });
    const now = 6 * 60 * 60_000 + 2;
    const preparing = createDeferred();
    const release = createDeferred();
    const closeQueued = createDeferred();
    // oxlint-disable-next-line typescript/unbound-method -- Called with the original registry receiver.
    const close = VoiceTranscriptOperationRegistry.prototype.close;
    const observer = vi
      .spyOn(VoiceTranscriptOperationRegistry.prototype, "close")
      .mockImplementationOnce(function (this: VoiceTranscriptOperationRegistry, key, operation) {
        return close.call(this, key, () => {
          const pending = operation();
          closeQueued.resolve();
          return pending;
        });
      });
    const resumed = createVoice({
      voiceSessionId,
      now,
      requester: requester(async () => {
        preparing.resolve();
        await release.promise;
        return { assertCurrent() {}, checks: [] };
      }),
    });
    const resumeResult = resumed.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let recovery: Promise<number> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          preparing.promise,
          resumed,
          "Resume skipped authority preparation",
        ),
        signal,
      );
      recovery = closeStaleClientVoiceSessions({ agentId: target.agentId, config: {}, now });
      await withinTest(
        awaitGateBeforeSettlement(
          closeQueued.promise,
          recovery,
          "Recovery skipped its stale close",
        ),
        signal,
      );
      release.resolve();
      expect(await resumeResult).toEqual({ value: voiceSessionId });
      expect(await recovery).toBe(0);
      expect(readRecord(voiceSessionId)).toMatchObject({
        status: "open",
        updatedAt: now,
      });
    } finally {
      release.resolve();
      await Promise.allSettled([resumeResult, recovery]);
      observer.mockRestore();
    }
  });

  it.each([
    { revoked: false, retained: false },
    { revoked: true, retained: false },
    { revoked: false, retained: true },
  ])(
    "guards cold SDK admission after the FIFO wait (revoked=$revoked, retained=$retained)",
    async ({ revoked, retained }) => {
      await seedSession("agent:main:main");
      const sdkTarget = { agentId: "cold-sdk", sessionKey: "agent:cold-sdk:main" };
      const checked = createDeferred();
      const { blocked, release } = await holdWorker(sdkTarget);
      let allowed = true;
      const writer = retained ? captureClientVoiceSessionWriter(sdkTarget) : undefined;
      const creating = createVoice(
        {
          ...sdkTarget,
          voiceSessionId: "cold-sdk-voice",
          requester: captureExternalSessionCommitGuard(() => {
            checked.resolve();
            if (!allowed) {
              throw new Error("SDK authority revoked");
            }
          }),
        },
        writer,
      );
      const completed = revoked
        ? expect(creating).rejects.toThrow("SDK authority revoked")
        : expect(creating).resolves.toBe("cold-sdk-voice");
      try {
        allowed = !revoked;
        release();
        await awaitGateBeforeSettlement(
          checked.promise,
          creating,
          "Voice creation settled without checking SDK authority",
        );
        await blocked;
        await completed;
        expect(existsSync(resolveOpenClawAgentSqlitePath(sdkTarget))).toBe(!revoked);
        if (writer && !revoked) {
          await closeClientVoiceSession(
            {
              ...sdkTarget,
              voiceSessionId: "cold-sdk-voice",
              config: {},
            },
            writer,
          );
          expect(
            clientVoiceSessionTesting.readRecord(sdkTarget.agentId, "cold-sdk-voice"),
          ).toMatchObject({ status: "closed" });
        }
        const database = new DatabaseSync(resolveOpenClawStateSqlitePath(), { readOnly: true });
        try {
          expect(
            database
              .prepare("SELECT agent_id FROM agent_databases WHERE agent_id = ?")
              .all(sdkTarget.agentId),
          ).toHaveLength(revoked ? 0 : 1);
        } finally {
          database.close();
        }
      } finally {
        release();
        await Promise.allSettled([blocked, creating, completed]);
        await writer?.release();
      }
    },
  );

  it("refuses a retargeted same-file SDK source alias", async () => {
    const replacement = {
      agentId: "alias-replacement",
      sessionKey: "agent:alias-replacement:main",
    };
    await seedSession(target.sessionKey);
    await createVoice({ ...replacement, voiceSessionId: "replacement" });
    const originalPath = resolveOpenClawAgentSqlitePath(target);
    const alias = path.join(process.env.OPENCLAW_STATE_DIR!, "voice-source-alias");
    symlinkSync(path.dirname(originalPath), alias, "junction");
    const changed = createDeferred();
    let scheduled = false;
    const voiceSessionId = "voice-source-alias";
    await expect(
      createVoice({
        voiceSessionId,
        source: {
          storePath: path.join(alias, path.basename(originalPath)),
          assertCurrent: captureExternalSessionCommitGuard(() => {
            if (!scheduled) {
              scheduled = true;
              queueMicrotask(() => {
                unlinkSync(alias);
                symlinkSync(
                  path.dirname(resolveOpenClawAgentSqlitePath(replacement)),
                  alias,
                  "junction",
                );
                changed.resolve();
              });
            }
          })!,
        },
      }),
    ).rejects.toThrow("Voice session source changed");
    await changed.promise;
    expect(readRecord(voiceSessionId)).toBeUndefined();
  });

  it("refuses a replaced separate source before invoking its SDK guard", async () => {
    const source = { agentId: "source", sessionKey: "agent:source:main" };
    await seedSession(target.sessionKey);
    await createVoice({ ...source, voiceSessionId: "source-authority" });
    const sourcePath = resolveOpenClawAgentSqlitePath(source);
    const originalPath = `${sourcePath}.original`;
    const sourceDatabase = new DatabaseSync(sourcePath);
    sourceDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const readAuthority = sourceDatabase.prepare(
      "SELECT json_extract(value_json, '$.status') AS status FROM cache_entries WHERE scope = ? AND key = ?",
    );
    let scheduled = false;
    let replaced = false;
    let guardCallsAfterReplacement = 0;
    const voiceSessionId = "voice-replaced-source";
    try {
      const failure = await createVoice({
        voiceSessionId,
        source: {
          storePath: sourcePath,
          assertCurrent: captureExternalSessionCommitGuard(() => {
            if (replaced) {
              guardCallsAfterReplacement++;
            }
            if (
              readAuthority.get("talk-client-voice-sessions", "source-authority")?.status !== "open"
            ) {
              throw new Error("SDK source authority revoked");
            }
            if (!scheduled) {
              scheduled = true;
              queueMicrotask(() => {
                renameSync(sourcePath, originalPath);
                copyFileSync(originalPath, sourcePath);
                replaced = true;
              });
            }
          })!,
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(replaced).toBe(true);
      expect(readRecord(voiceSessionId)).toBeUndefined();
      expect(failure).toBeInstanceOf(Error);
      expect(guardCallsAfterReplacement).toBe(0);
    } finally {
      if (existsSync(originalPath)) {
        unlinkSync(sourcePath);
        renameSync(originalPath, sourcePath);
      }
      sourceDatabase.close();
    }
  });

  it("keeps delayed effects with the original store and close owner", async () => {
    const voiceSessionId = "voice-original-source";
    const runId = "run-original-source";
    const originalEnv = { ...process.env };
    const originalStateDir = process.env.OPENCLAW_STATE_DIR!;
    const flushOriginalWorker = () =>
      runOpenClawAgentWorkerWrite({ agentId: target.agentId, env: originalEnv }, async () => {});
    const persistence = prepareClientVoiceSessionClose();
    let gate: Awaited<ReturnType<typeof holdWorker>> | undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createVoice({ voiceSessionId });
    const release = await registerClientVoiceConsultRun({ ...target, voiceSessionId, runId });
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(originalStateDir, "successor"));
      await createVoice({ voiceSessionId });
      gate = await holdWorker({ agentId: target.agentId, env: originalEnv });
      recordMutationEvents(runId, "call-original-source");
      const expectedEffects = [
        expect.objectContaining({ runId, toolName: "message", status: "succeeded" }),
      ];
      let atDrain: ReturnType<typeof readVoiceSessionRecord>;
      const drained = persistence.drain().then(() => {
        atDrain = readVoiceSessionRecord(target.agentId, voiceSessionId, { env: originalEnv });
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId,
        toolCallId: "too-late",
        toolName: "message",
        mutatingAction: true,
      });
      // The successor worker roundtrip lets an incorrectly idle original owner settle.
      await createVoice({ voiceSessionId });
      gate.release();
      await gate.blocked;
      await drained;
      expect(atDrain?.effects).toEqual(expectedEffects);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("admission is closed"));
      await flushOriginalWorker();
      await flushClientVoiceSessionWrites({ agentId: target.agentId, voiceSessionId });
      expect(readRecord(voiceSessionId)?.effects).toEqual([]);
      setTestEnvValue("OPENCLAW_STATE_DIR", originalStateDir);
      expect(readRecord(voiceSessionId)?.effects).toEqual(expectedEffects);
    } finally {
      gate?.release();
      await gate?.blocked;
      await flushOriginalWorker();
      setTestEnvValue("OPENCLAW_STATE_DIR", originalStateDir);
      release();
      await persistence.drain();
      warn.mockRestore();
    }
  });

  it("reads tool facts without freshness probes and rejects a closed call", async () => {
    const voiceSessionId = await createVoice({ transcriptCapable: true });
    const binding = { ...target, voiceSessionId };
    expect(assertClientVoiceSessionOpen(binding)).toBe("client");
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(assertClientVoiceSessionOpen(binding)).toBe("client");
      expect(readRecord(voiceSessionId)?.transcriptCapable).toBe(true);
      expect(observation.queries).toHaveLength(2);
      expect(observation.queries.join("\n")).not.toMatch(/\b(?:pragma_)?data_version\b/i);
    } finally {
      observation.restore();
    }
    await closeClientVoiceSession({ ...binding, config: {} });
    expect(() => assertClientVoiceSessionOpen(binding)).toThrow("voice session is closed");
    expect(readRecord(voiceSessionId)?.transcriptCapable).toBe(true);
  });

  it("rejects a transcript after another connection closes the admitted call", async () => {
    await seedSession(target.sessionKey);
    const voiceSessionId = await createVoice();
    expect(assertClientVoiceSessionOpen({ ...target, voiceSessionId })).toBe("client");
    mutateForeignVoice(voiceSessionId, "'$.status', 'closed', '$.closedAt', 42");
    await expect(
      appendTranscript(voiceSessionId, "foreign-close", "This call has already closed"),
    ).rejects.toThrow("voice session is closed");
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).not.toHaveBeenCalled();
    expect(readRecord(voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
      transcriptFailureKeys: [],
    });
  });

  it("publishes transcripts only after their voice bookkeeping commits", async () => {
    await seedSession(target.sessionKey);
    const voiceSessionId = await createVoice();
    const observed: Array<{
      transcript: ReturnType<typeof readSessionTranscriptMessageEvents>;
      voice: ReturnType<typeof clientVoiceSessionTesting.readRecord>;
    }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      if (update.sessionKey === target.sessionKey) {
        observed.push({
          transcript: readSessionTranscriptMessageEvents(update.target),
          voice: readRecord(voiceSessionId),
        });
      }
    });
    try {
      await appendTranscript(
        voiceSessionId,
        "committed-together",
        "Confirm both records before notifying observers",
      );
      expect(observed).toEqual([
        {
          transcript: [
            expect.objectContaining({
              event: expect.objectContaining({
                message: expect.objectContaining({
                  content: [
                    { type: "text", text: "Confirm both records before notifying observers" },
                  ],
                }),
              }),
            }),
          ],
          voice: expect.objectContaining({
            hasUserTranscript: true,
            transcriptFailureKeys: [],
          }),
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it.each(["unrelated", "same-source", "default-unrelated"] as const)(
    "resolves the conversation store before atomic append (%s)",
    async (selection) => {
      const defaultTarget = selection === "default-unrelated";
      const selectedTarget = { agentId: "main", sessionKey: "agent:main:selector" };
      const options = {
        ...captureClientVoiceSessionSourceOptions(
          selection === "same-source" ? "main" : "physical",
        ),
        path: path.join(process.env.OPENCLAW_STATE_DIR!, "custom.sqlite"),
      };
      openOpenClawAgentDatabase(options);
      const selector = path.join(path.dirname(options.path), "custom.json");
      const suffix = path.join(path.dirname(options.path), "custom.main.sqlite");
      const selectedPath = defaultTarget
        ? resolveOpenClawAgentSqlitePath({ agentId: selectedTarget.agentId, env: options.env })
        : selection === "same-source"
          ? options.path
          : suffix;
      const sessionId = "selected-conversation";
      replaceSessionEntrySync(
        { ...selectedTarget, storePath: selectedPath },
        { sessionId, updatedAt: 1 },
      );
      if (selection === "unrelated" || selection === "default-unrelated") {
        replaceSessionEntrySync(
          { ...selectedTarget, storePath: options.path },
          { sessionId: "unrelated-conversation", updatedAt: 1 },
        );
      }
      if (!defaultTarget) {
        expect(
          await prepareSqliteTargetFromSessionStorePath(selector, selectedTarget),
        ).toMatchObject({
          agentId: "main",
          path: selectedPath,
        });
      }
      const writer = captureClientVoiceSessionWriter({
        agentId: selectedTarget.agentId,
        physicalSource: createClientVoiceSessionSource(
          options,
          readDatabasePathIdentitySync(options.path),
        ),
      });
      const voiceSessionId = "selector-voice";
      const published: Array<ReturnType<typeof readVoiceSessionRecord>> = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        if (update.sessionKey === selectedTarget.sessionKey) {
          published.push(readVoiceSessionRecord(options.agentId, voiceSessionId, options));
        }
      });
      try {
        await createVoice({ ...selectedTarget, voiceSessionId }, writer);
        await appendClientVoiceTranscript(
          {
            ...selectedTarget,
            sessionTarget: {
              sessionKey: selectedTarget.sessionKey,
              ...(defaultTarget ? {} : { storePath: selector }),
            },
            voiceSessionId,
            entryId: "selected-transcript",
            role: "user",
            text: "Keep the selected conversation",
          },
          writer,
        );
        expect(
          readSessionTranscriptMessageEvents({
            ...selectedTarget,
            storePath: selectedPath,
            sessionId,
          }),
        ).toHaveLength(1);
        if (selection === "same-source") {
          expect(published).toEqual([
            expect.objectContaining({ hasUserTranscript: true, transcriptFailureKeys: [] }),
          ]);
        } else {
          expect(
            readSessionTranscriptMessageEvents({
              ...selectedTarget,
              storePath: options.path,
              sessionId: "unrelated-conversation",
            }),
          ).toEqual([]);
        }
        expect(readVoiceSessionRecord(options.agentId, voiceSessionId, options)).toMatchObject({
          hasUserTranscript: true,
          transcriptFailureKeys: [],
        });
      } finally {
        unsubscribe();
        await writer.release();
      }
    },
  );

  it("rolls back the transcript when voice ownership changes after reservation", async () => {
    await seedSession(target.sessionKey);
    const voiceSessionId = await createVoice();
    const actualAppend = sessionTurnMocks.actualAppendSessionTranscriptTurn;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    let reserved: ReturnType<typeof clientVoiceSessionTesting.readRecord>;
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce(async (...args) => {
      reserved = readRecord(voiceSessionId);
      mutateForeignVoice(voiceSessionId, "'$.sessionKey', ?", "agent:main:replacement");
      return actualAppend(...args);
    });
    const notified = vi.fn();
    const unsubscribe = onSessionTranscriptUpdate(notified);
    try {
      await expect(
        appendTranscript(voiceSessionId, "ownership-replaced", "Must not outlive the voice owner"),
      ).rejects.toThrow("voice session does not belong to this agent session");
      expect(reserved?.transcriptFailureKeys).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
      expect(notified).not.toHaveBeenCalled();
      expect(
        readSessionTranscriptMessageEvents({ ...target, sessionId: "session-agent-main-main" }),
      ).toEqual([]);
      expect(readRecord(voiceSessionId)).toMatchObject({
        sessionKey: "agent:main:replacement",
        transcriptFailureKeys: reserved?.transcriptFailureKeys,
      });
      expect(readRecord(voiceSessionId)?.hasUserTranscript).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
