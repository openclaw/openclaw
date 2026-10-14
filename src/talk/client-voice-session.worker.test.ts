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
import { readSessionTranscriptMessageEvents } from "../config/sessions/session-accessor.sqlite-active-events.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { captureExternalSessionCommitGuard } from "../config/sessions/session-source-authority.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import * as agentExecution from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { prepareClientVoiceSessionClose } from "./client-voice-session-lifecycle.js";
import { assertClientVoiceSessionOpen } from "./client-voice-session-read.js";
import {
  captureClientVoiceSessionSourceOptions,
  createClientVoiceSessionSource,
} from "./client-voice-session-source.js";
import { readVoiceSessionRecord } from "./client-voice-session-store.js";
import { captureClientVoiceSessionWriter } from "./client-voice-session-write.js";
import * as voiceWriters from "./client-voice-session-write.js";
import { recordMutation, seedSession } from "./client-voice-session.fixture.test-support.js";
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

  it("persists admission, consult effects, transcript bookkeeping, and close off the caller thread", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const voiceSessionId = "voice-worker-boundary";
    const observation = observeHostDataSql();
    try {
      await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
      await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
      await recordMutation(voiceSessionId);
      await appendClientVoiceTranscript({
        ...target,
        sessionTarget: { sessionKey: target.sessionKey },
        voiceSessionId,
        entryId: "user-1",
        role: "user",
        text: "Send the update",
      });
      await closeClientVoiceSession({ ...target, voiceSessionId, config: {} });
      expect(observation.queries.filter((sql) => /\bcache_entries\b/i.test(sql))).toEqual([]);
    } finally {
      observation.restore();
    }
    expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toMatchObject({
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
      const target = { agentId: "main", sessionKey: "agent:main:main" };
      await seedSession(target.sessionKey);
      let voiceSessionId =
        operation === "consult"
          ? await createOrResumeClientVoiceSession({ ...target, origin: "client" })
          : undefined;
      const sourceError = new Error("synthetic voice source release failure");
      const writerError = new Error("synthetic voice writer release failure");
      const releaseEntered = createDeferred();
      const releaseSource = createDeferred();
      const released: string[] = [];
      const requester = Object.assign(() => {}, {
        async prepareSessionSource() {
          return {
            checks: [],
            assertCurrent() {},
            async release() {
              releaseEntered.resolve();
              await releaseSource.promise;
              released.push("source");
              throw sourceError;
            },
          };
        },
      });
      const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
      const captureSpy = vi
        .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
        .mockImplementation((...args): ReturnType<typeof capture> => {
          const execution = capture(...args);
          return {
            ...execution,
            get fileIdentity() {
              return execution.fileIdentity;
            },
            async release() {
              await execution.release();
              released.push("writer");
              throw writerError;
            },
          };
        });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const runId = "acknowledged-cleanup-consult";
      let releaseRun: (() => void) | undefined;
      let settled = false;
      const work =
        operation === "create"
          ? createOrResumeClientVoiceSession({ ...target, requester, origin: "client" }).then(
              (id) => {
                voiceSessionId = id;
              },
            )
          : registerClientVoiceConsultRun({
              ...target,
              requester,
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
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    const cleanupError = new Error("synthetic accepted voice writer cleanup failure");
    const capture = voiceWriters.captureClientVoiceSessionWriter;
    const captureSpy = vi
      .spyOn(voiceWriters, "captureClientVoiceSessionWriter")
      .mockImplementation((params) => {
        const writer = capture(params);
        const release = writer.release.bind(writer);
        vi.spyOn(writer, "release").mockImplementation(async () => {
          await release();
          throw cleanupError;
        });
        return writer;
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const close = prepareClientVoiceSessionClose();
    try {
      await expect(
        appendClientVoiceTranscript({
          ...target,
          sessionTarget: { sessionKey: target.sessionKey },
          voiceSessionId,
          entryId: "accepted-before-cleanup",
          role: "user",
          text: "Keep the committed transcript acknowledgement",
        }),
      ).resolves.toBeUndefined();
      await expect(
        flushClientVoiceSessionWrites({ ...target, voiceSessionId }),
      ).resolves.toBeUndefined();
      await expect(
        closeClientVoiceSession({ ...target, voiceSessionId, config: {} }),
      ).resolves.toBeUndefined();
      await close.drain();
      expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toMatchObject({
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
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const refusal = new Error("synthetic revoked voice authority");
    const cleanupError = new Error("synthetic refused source cleanup failure");
    const voiceSessionId = "refused-voice-cleanup";
    const requester = Object.assign(() => {}, {
      async prepareSessionSource() {
        return {
          checks: [],
          assertCurrent() {
            throw refusal;
          },
          async release() {
            throw cleanupError;
          },
        };
      },
    });
    await expect(
      createOrResumeClientVoiceSession({ ...target, requester, voiceSessionId, origin: "client" }),
    ).rejects.toMatchObject({ cause: refusal, errors: [refusal, cleanupError] });
    expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toBeUndefined();
  });

  it.each([false, true])(
    "refuses revoked admission after the FIFO wait (retained=%s)",
    async (retained) => {
      const target = { agentId: "main", sessionKey: "agent:main:main" };
      await seedSession(target.sessionKey);
      const entered = createDeferred();
      const release = createDeferred();
      releaseHeldWrites.push(() => release.resolve());
      const blocker = runOpenClawAgentWorkerWrite({ agentId: target.agentId }, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const controller = new AbortController();
      const voiceSessionId = "voice-revoked-admission";
      const writer = retained ? captureClientVoiceSessionWriter(target) : undefined;
      const prepare = vi.fn(async () => ({ assertCurrent() {}, checks: [] }));
      const creating = createOrResumeClientVoiceSession(
        {
          ...target,
          voiceSessionId,
          origin: "client",
          assertCurrent: () => controller.signal.throwIfAborted(),
          requester: Object.assign(() => {}, { prepareSessionSource: prepare }),
        },
        writer,
      );
      controller.abort(new Error("voice access revoked"));
      const rejected = expect(creating).rejects.toThrow("voice access revoked");
      release.resolve();
      try {
        await blocker;
        await rejected;
        expect(prepare).not.toHaveBeenCalled();
        expect(
          clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId),
        ).toBeUndefined();
      } finally {
        await writer?.release();
      }
    },
  );

  it("keeps a preparing resume ahead of later stale recovery", async ({ signal }) => {
    const target = { agentId: "main", sessionKey: "agent:main:main", origin: "client" as const };
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, now: 1 });
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
    const resumed = createOrResumeClientVoiceSession({
      ...target,
      voiceSessionId,
      now,
      requester: Object.assign(() => {}, {
        async prepareSessionSource() {
          preparing.resolve();
          await release.promise;
          return { assertCurrent() {}, checks: [] };
        },
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
      expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toMatchObject({
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
    { revoked: true, retained: true },
  ])(
    "guards cold SDK admission after the FIFO wait (revoked=$revoked, retained=$retained)",
    async ({ revoked, retained }) => {
      await seedSession("agent:main:main");
      const target = { agentId: "cold-sdk", sessionKey: "agent:cold-sdk:main" };
      const entered = createDeferred();
      const release = createDeferred();
      const checked = createDeferred();
      releaseHeldWrites.push(() => release.resolve());
      const blocker = runOpenClawAgentWorkerWrite(target, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let allowed = true;
      const writer = retained ? captureClientVoiceSessionWriter(target) : undefined;
      const creating = createOrResumeClientVoiceSession(
        {
          ...target,
          voiceSessionId: "cold-sdk-voice",
          origin: "client",
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
        release.resolve();
        await awaitGateBeforeSettlement(
          checked.promise,
          creating,
          "Voice creation settled without checking SDK authority",
        );
        await blocker;
        await completed;
        expect(existsSync(resolveOpenClawAgentSqlitePath(target))).toBe(!revoked);
        if (writer && !revoked) {
          await closeClientVoiceSession(
            {
              ...target,
              voiceSessionId: "cold-sdk-voice",
              config: {},
            },
            writer,
          );
          expect(
            clientVoiceSessionTesting.readRecord(target.agentId, "cold-sdk-voice"),
          ).toMatchObject({ status: "closed" });
        }
        const database = new DatabaseSync(resolveOpenClawStateSqlitePath(), { readOnly: true });
        try {
          expect(
            database
              .prepare("SELECT agent_id FROM agent_databases WHERE agent_id = ?")
              .all(target.agentId),
          ).toHaveLength(revoked ? 0 : 1);
        } finally {
          database.close();
        }
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, creating, completed]);
        await writer?.release();
      }
    },
  );

  it.each([false, true])(
    "refuses a retargeted same-file SDK source alias (requester SDK=%s)",
    async (nativeRequester) => {
      const target = { agentId: "main", sessionKey: "agent:main:main" };
      const replacement = {
        agentId: "alias-replacement",
        sessionKey: "agent:alias-replacement:main",
      };
      await seedSession(target.sessionKey);
      await createOrResumeClientVoiceSession({
        ...replacement,
        voiceSessionId: "replacement",
        origin: "client",
      });
      const originalPath = resolveOpenClawAgentSqlitePath(target);
      const alias = path.join(process.env.OPENCLAW_STATE_DIR!, "voice-source-alias");
      symlinkSync(path.dirname(originalPath), alias, "junction");
      const changed = createDeferred();
      let scheduled = false;
      const voiceSessionId = "voice-source-alias";
      await expect(
        createOrResumeClientVoiceSession({
          ...target,
          voiceSessionId,
          origin: "client",
          requester: nativeRequester ? captureExternalSessionCommitGuard(() => {}) : undefined,
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
      expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toBeUndefined();
    },
  );

  it.each([false, true])(
    "refuses a replaced separate source before invoking its SDK guard (requester SDK=%s)",
    async (nativeRequester) => {
      const target = { agentId: "main", sessionKey: "agent:main:main" };
      const source = { agentId: "source", sessionKey: "agent:source:main" };
      await seedSession(target.sessionKey);
      await createOrResumeClientVoiceSession({
        ...source,
        voiceSessionId: "source-authority",
        origin: "client",
      });
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
        const failure = await createOrResumeClientVoiceSession({
          ...target,
          voiceSessionId,
          origin: "client",
          requester: nativeRequester ? captureExternalSessionCommitGuard(() => {}) : undefined,
          source: {
            storePath: sourcePath,
            assertCurrent: captureExternalSessionCommitGuard(() => {
              if (replaced) {
                guardCallsAfterReplacement++;
              }
              if (
                readAuthority.get("talk-client-voice-sessions", "source-authority")?.status !==
                "open"
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
        expect(
          clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId),
        ).toBeUndefined();
        expect(failure).toBeInstanceOf(Error);
        expect(guardCallsAfterReplacement).toBe(0);
      } finally {
        if (existsSync(originalPath)) {
          unlinkSync(sourcePath);
          renameSync(originalPath, sourcePath);
        }
        sourceDatabase.close();
      }
    },
  );

  it("continues native creation after a retained worker preparation is refused", async () => {
    await seedSession("agent:main:main");
    const target = {
      agentId: "native-after-refusal",
      sessionKey: "agent:native-after-refusal:main",
    };
    const writer = captureClientVoiceSessionWriter(target);
    const peer = captureOpenClawAgentDatabaseExecution(target, {
      expectedCreationIdentity: writer.identity,
    });
    try {
      await expect(
        peer.prepare({
          assertCurrent() {
            throw new Error("previous preparation refused");
          },
          createAdmission() {
            throw new Error("refused preparation cannot open");
          },
        }),
      ).rejects.toThrow("previous preparation refused");
      const input = {
        ...target,
        voiceSessionId: "native-after-refusal-voice",
        origin: "client" as const,
        requester: captureExternalSessionCommitGuard(() => {}),
      };
      await createOrResumeClientVoiceSession(input, writer);
      expect(peer.fileIdentity?.physicalIdentity).toBe(
        writer.source.identity.key.slice("file:".length),
      );
      await createOrResumeClientVoiceSession(input, writer);
      await closeClientVoiceSession({ ...input, config: {} }, writer);
      expect(
        clientVoiceSessionTesting.readRecord(target.agentId, input.voiceSessionId),
      ).toMatchObject({ status: "closed" });
    } finally {
      await peer.release();
      await writer.release();
    }
  });

  it.each([false, true])(
    "keeps delayed effects with the original store and close owner (closing=%s)",
    async (closing) => {
      const target = { agentId: "main", sessionKey: "agent:main:main" };
      const voiceSessionId = "voice-original-source";
      const runId = "run-original-source";
      const originalEnv = { ...process.env };
      const originalStateDir = process.env.OPENCLAW_STATE_DIR!;
      const persistence = prepareClientVoiceSessionClose();
      const entered = createDeferred();
      const resume = createDeferred();
      let blocker: Promise<void> | undefined;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
      const release = await registerClientVoiceConsultRun({ ...target, voiceSessionId, runId });
      try {
        setTestEnvValue("OPENCLAW_STATE_DIR", path.join(originalStateDir, "successor"));
        await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
        if (closing) {
          blocker = runOpenClawAgentWorkerWrite(
            { agentId: target.agentId, env: originalEnv },
            async () => {
              entered.resolve();
              await resume.promise;
            },
          );
          await entered.promise;
        }
        emitTrustedDiagnosticEvent({
          type: "tool.execution.started",
          runId,
          toolCallId: "call-original-source",
          toolName: "message",
          mutatingAction: true,
        });
        emitTrustedDiagnosticEvent({
          type: "tool.execution.completed",
          runId,
          toolCallId: "call-original-source",
          toolName: "message",
          durationMs: 5,
        });
        if (closing) {
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
          await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
          resume.resolve();
          await blocker;
          await drained;
          expect(atDrain?.effects).toEqual([
            expect.objectContaining({ runId, toolName: "message", status: "succeeded" }),
          ]);
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("admission is closed"));
        }
        await runOpenClawAgentWorkerWrite(
          { agentId: target.agentId, env: originalEnv },
          async () => {},
        );
        await flushClientVoiceSessionWrites({ agentId: target.agentId, voiceSessionId });
        expect(
          clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)?.effects,
        ).toEqual([]);
        setTestEnvValue("OPENCLAW_STATE_DIR", originalStateDir);
        expect(
          clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)?.effects,
        ).toEqual([expect.objectContaining({ runId, toolName: "message", status: "succeeded" })]);
      } finally {
        resume.resolve();
        await blocker;
        await runOpenClawAgentWorkerWrite(
          { agentId: target.agentId, env: originalEnv },
          async () => {},
        );
        setTestEnvValue("OPENCLAW_STATE_DIR", originalStateDir);
        release();
        await persistence.drain();
        warn.mockRestore();
      }
    },
  );

  it("reads tool facts without freshness probes and rejects a closed call", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    const voiceSessionId = await createOrResumeClientVoiceSession({
      ...target,
      origin: "client",
      transcriptCapable: true,
    });
    const binding = { ...target, voiceSessionId };
    expect(assertClientVoiceSessionOpen(binding)).toBe("client");
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(assertClientVoiceSessionOpen(binding)).toBe("client");
      expect(
        readVoiceSessionRecord(binding.agentId, binding.voiceSessionId)?.transcriptCapable,
      ).toBe(true);
      expect(observation.queries).toHaveLength(2);
      expect(observation.queries.join("\n")).not.toMatch(/\b(?:pragma_)?data_version\b/i);
    } finally {
      observation.restore();
    }
    await closeClientVoiceSession({ ...binding, config: {} });
    expect(() => assertClientVoiceSessionOpen(binding)).toThrow("voice session is closed");
    expect(readVoiceSessionRecord(binding.agentId, binding.voiceSessionId)?.transcriptCapable).toBe(
      true,
    );
  });

  it("rejects a transcript after another connection closes the admitted call", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    expect(assertClientVoiceSessionOpen({ ...target, voiceSessionId })).toBe("client");
    const foreign = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: target.agentId }));
    try {
      foreign
        .prepare(
          "UPDATE cache_entries SET value_json = json_set(value_json, '$.status', 'closed', '$.closedAt', 42) WHERE scope = ? AND key = ?",
        )
        .run("talk-client-voice-sessions", voiceSessionId);
    } finally {
      foreign.close();
    }
    await expect(
      appendClientVoiceTranscript({
        ...target,
        sessionTarget: { sessionKey: target.sessionKey },
        voiceSessionId,
        entryId: "foreign-close",
        role: "user",
        text: "This call has already closed",
      }),
    ).rejects.toThrow("voice session is closed");
    expect(sessionTurnMocks.appendExpectedSessionTranscriptTurn).not.toHaveBeenCalled();
    expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
      transcriptFailureKeys: [],
    });
  });

  it("publishes transcripts only after their voice bookkeeping commits", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    const observed: Array<{
      transcript: ReturnType<typeof readSessionTranscriptMessageEvents>;
      voice: ReturnType<typeof clientVoiceSessionTesting.readRecord>;
    }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      if (update.sessionKey === target.sessionKey) {
        observed.push({
          transcript: readSessionTranscriptMessageEvents(update.target),
          voice: clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId),
        });
      }
    });
    try {
      await appendClientVoiceTranscript({
        ...target,
        sessionTarget: { sessionKey: target.sessionKey },
        voiceSessionId,
        entryId: "committed-together",
        role: "user",
        text: "Confirm both records before notifying observers",
      });
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

  it.each(["missing", "unrelated", "same-source", "default-missing", "default-unrelated"] as const)(
    "resolves the conversation store before atomic append (%s)",
    async (selection) => {
      const defaultTarget = selection === "default-missing" || selection === "default-unrelated";
      const target = { agentId: "main", sessionKey: "agent:main:selector" };
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
        ? resolveOpenClawAgentSqlitePath({ agentId: target.agentId, env: options.env })
        : selection === "same-source"
          ? options.path
          : suffix;
      const sessionId = "selected-conversation";
      replaceSessionEntrySync({ ...target, storePath: selectedPath }, { sessionId, updatedAt: 1 });
      if (selection === "unrelated" || selection === "default-unrelated") {
        replaceSessionEntrySync(
          { ...target, storePath: options.path },
          { sessionId: "unrelated-conversation", updatedAt: 1 },
        );
      }
      if (!defaultTarget) {
        expect(await prepareSqliteTargetFromSessionStorePath(selector, target)).toMatchObject({
          agentId: "main",
          path: selectedPath,
        });
      }
      const writer = captureClientVoiceSessionWriter({
        agentId: target.agentId,
        physicalSource: createClientVoiceSessionSource(
          options,
          readDatabasePathIdentitySync(options.path),
        ),
      });
      const voiceSessionId = "selector-voice";
      const published: Array<ReturnType<typeof readVoiceSessionRecord>> = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        if (update.sessionKey === target.sessionKey) {
          published.push(readVoiceSessionRecord(options.agentId, voiceSessionId, options));
        }
      });
      try {
        await createOrResumeClientVoiceSession(
          { ...target, voiceSessionId, origin: "client" },
          writer,
        );
        await appendClientVoiceTranscript(
          {
            ...target,
            sessionTarget: {
              sessionKey: target.sessionKey,
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
          readSessionTranscriptMessageEvents({ ...target, storePath: selectedPath, sessionId }),
        ).toHaveLength(1);
        if (selection === "same-source") {
          expect(published).toEqual([
            expect.objectContaining({ hasUserTranscript: true, transcriptFailureKeys: [] }),
          ]);
        } else {
          expect(
            readSessionTranscriptMessageEvents({
              ...target,
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
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey);
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    const actualAppend = sessionTurnMocks.actualAppendSessionTranscriptTurn;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    let reserved: ReturnType<typeof clientVoiceSessionTesting.readRecord>;
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce(async (...args) => {
      reserved = clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId);
      const foreign = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: target.agentId }));
      try {
        foreign
          .prepare(
            "UPDATE cache_entries SET value_json = json_set(value_json, '$.sessionKey', ?) WHERE scope = ? AND key = ?",
          )
          .run("agent:main:replacement", "talk-client-voice-sessions", voiceSessionId);
      } finally {
        foreign.close();
      }
      return actualAppend(...args);
    });
    const notified = vi.fn();
    const unsubscribe = onSessionTranscriptUpdate(notified);
    try {
      await expect(
        appendClientVoiceTranscript({
          ...target,
          sessionTarget: { sessionKey: target.sessionKey },
          voiceSessionId,
          entryId: "ownership-replaced",
          role: "user",
          text: "Must not outlive the voice owner",
        }),
      ).rejects.toThrow("voice session does not belong to this agent session");
      expect(reserved?.transcriptFailureKeys).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
      expect(notified).not.toHaveBeenCalled();
      expect(
        readSessionTranscriptMessageEvents({ ...target, sessionId: "session-agent-main-main" }),
      ).toEqual([]);
      expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toMatchObject({
        sessionKey: "agent:main:replacement",
        transcriptFailureKeys: reserved?.transcriptFailureKeys,
      });
      expect(
        clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)?.hasUserTranscript,
      ).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
