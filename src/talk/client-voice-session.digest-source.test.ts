import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionEvents from "../config/sessions/session-accessor.sqlite-events.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import * as agentDatabases from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { prepareClientVoiceSessionClose } from "./client-voice-session-lifecycle.js";
import * as voiceSessionReads from "./client-voice-session-read.js";
import { createClientVoiceSessionSource } from "./client-voice-session-source.js";
import { readVoiceSessionRecord } from "./client-voice-session-store.js";
import * as voiceWriters from "./client-voice-session-write.js";
import {
  completeRun,
  createCompletedMutationSession,
  createVoiceSession,
  recordMutation,
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

// Install digest mocks before the persistence graph loads.
const { useClientVoiceDigestHarness } = await vi.hoisted(
  () => import("./client-voice-session.digest-harness.test-support.js"),
);

describe("client voice digest physical sources", () => {
  const harness = useClientVoiceDigestHarness();
  const { sendDurableMessageBatch, settleDigestAttempts } = harness;

  it("records a missing conversation instead of silently completing its digest", async () => {
    const sessionKey = "agent:main:main";
    const voiceSessionId = await createCompletedMutationSession();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const closing = prepareClientVoiceSessionClose();
      await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
      await closing.drain();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("conversation not found"));
      expect(sendDurableMessageBatch).not.toHaveBeenCalled();
      expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
        active: 0,
        retained: 1,
      });
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not retry an unknown digest marker when writer cleanup also fails", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey, { channel: "discord", to: "channel:unknown-marker" });
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    await recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);
    const unknown = new SqliteWorkerError("synthetic unknown digest marker", "outcome-unknown");
    const cleanupError = new Error("synthetic digest writer release failure");
    const capture = voiceWriters.captureClientVoiceSessionWriter;
    let attempts = 0;
    const captureSpy = vi
      .spyOn(voiceWriters, "captureClientVoiceSessionWriter")
      .mockImplementation((params) => {
        const writer = capture(params);
        if (params.physicalSource) {
          attempts += 1;
          vi.spyOn(writer, "mutate").mockRejectedValueOnce(unknown);
          const release = writer.release.bind(writer);
          vi.spyOn(writer, "release").mockImplementation(async () => {
            await release();
            throw cleanupError;
          });
        }
        return writer;
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await closeClientVoiceSession({ ...target, voiceSessionId, config: {} });
      await settleDigestAttempts();
      await closeClientVoiceSession({ ...target, voiceSessionId, config: {} });
      await settleDigestAttempts();
      expect(attempts).toBe(1);
      expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("settlement is unknown"));
      expect(clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)).toMatchObject({
        status: "closed",
      });
      expect(
        clientVoiceSessionTesting.readRecord(target.agentId, voiceSessionId)?.digestDeliveredAt,
      ).toBeUndefined();
    } finally {
      await settleDigestAttempts();
      warn.mockRestore();
      captureSpy.mockRestore();
    }
  });

  it.each(["absent", "obsolete"])(
    "delivers from a custom conversation store once through marker retry with an %s default row",
    async (defaultRow) => {
      const sessionKey = "agent:main:main";
      const storePath = path.join(harness.stateDir, "custom", "conversations.sqlite");
      const config = { session: { store: storePath } };
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "custom-conversation",
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "discord", to: "channel:custom-recipient" },
          }),
        },
      );
      if (defaultRow === "obsolete") {
        await seedSession(sessionKey, { channel: "discord", to: "channel:obsolete-recipient" });
      }
      const voiceSessionId = await createCompletedMutationSession();
      const capture = voiceWriters.captureClientVoiceSessionWriter;
      let failMarker = true;
      const marker = vi
        .spyOn(voiceWriters, "captureClientVoiceSessionWriter")
        .mockImplementation((params) => {
          const writer = capture(params);
          if (params.physicalSource && failMarker) {
            failMarker = false;
            vi.spyOn(writer, "mutate").mockRejectedValueOnce(
              new Error("synthetic delivery marker failure"),
            );
          }
          return writer;
        });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const firstClose = prepareClientVoiceSessionClose();
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config });
        await firstClose.drain();
        expect(sendDurableMessageBatch).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ to: "channel:custom-recipient" }),
        );
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining("synthetic delivery marker failure"),
        );
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toBeUndefined();

        const retryClose = prepareClientVoiceSessionClose();
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await retryClose.drain();
        expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toEqual(expect.any(Number));
        expect(readVoiceSessionRecord("main", voiceSessionId, { path: storePath })).toBeUndefined();
      } finally {
        marker.mockRestore();
        warning.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(["current", "runtime-entry", "worker-preparation"] as const)(
    "checks prepared requester authority before native bootstrap (%s)",
    async (phase) => {
      await seedSession("agent:main:main");
      const target = { agentId: "cold-prepared", sessionKey: "agent:cold-prepared:main" };
      const writer = voiceWriters.captureClientVoiceSessionWriter(target);
      const controller = new AbortController();
      const revoke = () => controller.abort(new Error("prepared requester revoked"));
      let bootstrap = false;
      let entered = false;
      const open = agentDatabases.withOpenClawAgentDatabaseRuntimeFromExecution;
      const opening = vi
        .spyOn(agentDatabases, "withOpenClawAgentDatabaseRuntimeFromExecution")
        .mockImplementationOnce((options, execution, operation, assertCurrent, signal) => {
          entered = bootstrap = true;
          if (phase === "runtime-entry") {
            revoke();
          }
          return open(
            options,
            execution,
            (database) => {
              bootstrap = false;
              return operation(database);
            },
            assertCurrent,
            signal,
          );
        });
      const prepare = writer.admissionExecution.prepare.bind(writer.admissionExecution);
      const preparing = vi
        .spyOn(writer.admissionExecution, "prepare")
        .mockImplementation((...args) => {
          if (phase === "worker-preparation") {
            revoke();
          }
          return prepare(...args);
        });
      const requester = composeSessionSourceAssertion(
        [Object.assign(() => expect(bootstrap).toBe(false), { nativeSource: true })],
        (assertSource) => {
          controller.signal.throwIfAborted();
          assertSource();
        },
      );
      try {
        const creating = createOrResumeClientVoiceSession(
          {
            ...target,
            voiceSessionId: "cold-prepared-voice",
            origin: "client",
            requester,
          },
          writer,
        );
        if (phase === "current") {
          await expect(creating).resolves.toBe("cold-prepared-voice");
        } else {
          await expect(creating).rejects.toThrow("prepared requester revoked");
        }
        expect(entered).toBe(true);
        const present = await fs.stat(resolveOpenClawAgentSqlitePath(target)).then(
          () => true,
          () => false,
        );
        expect(present).toBe(phase === "current");
        const database = new DatabaseSync(resolveOpenClawStateSqlitePath(), { readOnly: true });
        try {
          expect(
            database
              .prepare("SELECT agent_id FROM agent_databases WHERE agent_id = ?")
              .all(target.agentId),
          ).toHaveLength(phase === "current" ? 1 : 0);
        } finally {
          database.close();
        }
      } finally {
        opening.mockRestore();
        preparing.mockRestore();
        await writer.release();
      }
    },
  );

  it.each(["concurrent", "explicit", "implicit", "alias", "retargeted-alias"] as const)(
    "keeps consult publication and cleanup on their captured source (%s)",
    async (mode) => {
      const target = { agentId: "main", sessionKey: "agent:main:main" };
      const voiceSessionId = "source-collision-voice";
      const runId = "source-collision-run";
      const binding = { ...target, voiceSessionId, runId };
      const otherState = path.join(harness.stateDir, "collision-state");
      const env = captureEnv(["OPENCLAW_STATE_DIR"]);
      await seedSession(target.sessionKey);
      await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
      const writerA = voiceWriters.captureClientVoiceSessionWriter(target);
      const sourceA = writerA.source;
      setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
      await seedSession(target.sessionKey);
      await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
      const writerB = voiceWriters.captureClientVoiceSessionWriter(target);
      const sourceB = writerB.source;
      const entered = createDeferred();
      const resume = createDeferred();
      let blocker: Promise<void> | undefined;
      let pendingB: Promise<() => void> | undefined;
      let releaseA: (() => void) | undefined;
      let releaseB: (() => void) | undefined;
      try {
        if (mode === "concurrent") {
          blocker = runOpenClawAgentWorkerWrite(sourceB.options, async () => {
            entered.resolve();
            await resume.promise;
          });
          await entered.promise;
          pendingB = registerClientVoiceConsultRun({ ...binding, physicalSource: sourceB });
          void pendingB.catch(() => {});
        }
        releaseA = await registerClientVoiceConsultRun({ ...binding, physicalSource: sourceA });
        const original = resolveClientVoiceRunBinding(runId);
        let supplied = sourceB;
        if (mode === "alias" || mode === "retargeted-alias") {
          const alias = path.join(harness.stateDir, "voice-alias.sqlite");
          await fs.symlink(sourceA.options.path, alias);
          supplied = createClientVoiceSessionSource(
            { ...sourceA.options, path: alias },
            readDatabasePathIdentitySync(alias),
          );
          if (mode === "retargeted-alias") {
            await fs.unlink(alias);
            await fs.symlink(sourceB.options.path, alias);
            await expect(
              registerClientVoiceConsultRun({ ...binding, physicalSource: supplied }),
            ).rejects.toThrow(/database|identity|source/i);
            expect(resolveClientVoiceRunBinding(runId)).toBe(original);
            return;
          }
          await closeClientVoiceSession({ ...target, voiceSessionId, config: {} }, writerA);
          await settleDigestAttempts();
        }
        resume.resolve();
        releaseB = await (pendingB ??
          registerClientVoiceConsultRun({
            ...binding,
            ...(mode === "implicit" ? {} : { physicalSource: supplied }),
            ...(mode === "alias" ? { config: {} } : {}),
          }));
        await blocker;
        const staysOriginal = mode === "implicit" || mode === "alias";
        const chosen = resolveClientVoiceRunBinding(runId);
        if (staysOriginal) {
          expect(chosen).toBe(original);
        } else {
          releaseA();
          expect(resolveClientVoiceRunBinding(runId)).toBe(chosen);
        }
        emitTrustedDiagnosticEvent({
          type: "tool.execution.started",
          runId,
          toolCallId: "source-collision-effect",
          toolName: "message",
          mutatingAction: true,
        });
        emitTrustedDiagnosticEvent({
          type: "tool.execution.completed",
          runId,
          toolCallId: "source-collision-effect",
          toolName: "message",
          durationMs: 5,
        });
        await flushClientVoiceSessionWrites(binding, staysOriginal ? writerA : writerB);
        expect(
          readVoiceSessionRecord("main", voiceSessionId, { env: sourceA.options.env })?.effects,
        ).toHaveLength(staysOriginal ? 1 : 0);
        expect(
          readVoiceSessionRecord("main", voiceSessionId, { env: sourceB.options.env })?.effects,
        ).toHaveLength(staysOriginal ? 0 : 1);
      } finally {
        resume.resolve();
        await blocker;
        if (pendingB && !releaseB) {
          releaseB = await pendingB.catch(() => undefined);
        }
        releaseA?.();
        releaseB?.();
        await settleDigestAttempts();
        await writerA.release();
        await writerB.release();
        env.restore();
        await cleanupSessionStateForTest({ stateDir: otherState });
      }
    },
  );

  it("delivers the completed source digest while a matching voice in another store remains live", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    const voiceSessionId = "same-voice-across-stores";
    const originalEnv = { OPENCLAW_STATE_DIR: harness.stateDir };
    const otherState = path.join(harness.stateDir, "other-state");
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    const runA = "original-store-run";
    const runB = "other-store-run";
    let releaseB: (() => void) | undefined;
    await seedSession(target.sessionKey, { channel: "discord", to: "channel:original-store" });
    await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
    await recordMutation(voiceSessionId, runA);
    await closeClientVoiceSession({ ...target, voiceSessionId, config: {} });
    await settleDigestAttempts();
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
      await seedSession(target.sessionKey, { channel: "discord", to: "channel:other-store" });
      await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
      releaseB = await registerClientVoiceConsultRun({ ...target, voiceSessionId, runId: runB });
      await completeRun(runA);
      await settleDigestAttempts();
      expect(sendDurableMessageBatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ to: "channel:original-store" }),
      );
      expect(readVoiceSessionRecord("main", voiceSessionId, { env: originalEnv })).toMatchObject({
        status: "closed",
        consultRunIds: [runA],
        digestDeliveredAt: expect.any(Number),
      });
      const other = readVoiceSessionRecord("main", voiceSessionId);
      expect(other).toMatchObject({ status: "open", consultRunIds: [runB] });
      expect(other?.digestDeliveredAt).toBeUndefined();
      expect(resolveClientVoiceRunBinding(runA)).toBeUndefined();
      expect(resolveClientVoiceRunBinding(runB)).toMatchObject({ ...target, voiceSessionId });
    } finally {
      releaseB?.();
      await completeRun(runA);
      await settleDigestAttempts();
      env.restore();
      await cleanupSessionStateForTest({ stateDir: otherState });
    }
  });

  it.for([false, true])(
    "preserves a displaced metadata file and confirmed send through marker retry (replacement=%s)",
    async (replacement, { signal }) => {
      const sessionKey = "agent:main:main";
      await seedSession(sessionKey, { channel: "discord", to: "channel:marker-retry" });
      const voiceSessionId = await createCompletedMutationSession();
      const metadataPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const savedPath = `${metadataPath}.displaced`;
      const sending = createDeferred();
      const finishSend = createDeferred();
      sendDurableMessageBatch.mockImplementationOnce(async () => {
        sending.resolve();
        await finishSend.promise;
        return { status: "sent" };
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await withinTest(sending.promise, signal);
        // Context replacement while send is active must share its later committed delivery fact.
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await closeOpenClawAgentDatabasesAsync(harness.stateDir);
        await fs.rename(metadataPath, savedPath);
        if (replacement) {
          await fs.writeFile(metadataPath, new Uint8Array());
        }
        finishSend.resolve();
        await settleDigestAttempts();
        const afterMarker = await fs.stat(metadataPath).catch((error: unknown) => {
          expect(error).toMatchObject({ code: "ENOENT" });
          return undefined;
        });
        const untouched = replacement ? afterMarker?.size === 0 : afterMarker === undefined;
        await closeOpenClawAgentDatabasesAsync(harness.stateDir);
        await fs.rm(metadataPath, { force: true });
        await fs.rename(savedPath, metadataPath);
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await settleDigestAttempts();
        expect({ untouched, sends: sendDurableMessageBatch.mock.calls.length }).toEqual({
          untouched: true,
          sends: 1,
        });
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toEqual(expect.any(Number));
      } finally {
        finishSend.resolve();
        await settleDigestAttempts();
        vi.useRealTimers();
      }
    },
  );

  it("shares a confirmed send across context refresh while the first read waits", async ({
    signal,
  }) => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey, { channel: "discord", to: "channel:read-refresh" });
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    await recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);
    const readStarted = createDeferred();
    const releaseRead = createDeferred();
    const markerFailure = new Error("synthetic marker refusal after confirmed send");
    const capture = voiceWriters.captureClientVoiceSessionWriter;
    let held = false;
    const captureSpy = vi
      .spyOn(voiceWriters, "captureClientVoiceSessionWriter")
      .mockImplementation((params) => {
        const writer = capture(params);
        if (params.physicalSource && !held) {
          held = true;
          const read = writer.read.bind(writer);
          vi.spyOn(writer, "read").mockImplementationOnce(async (id) => {
            readStarted.resolve();
            await releaseRead.promise;
            return read(id);
          });
          vi.spyOn(writer, "mutate").mockRejectedValueOnce(markerFailure);
        }
        return writer;
      });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await closeClientVoiceSession({ ...target, voiceSessionId, config: {} });
      await withinTest(readStarted.promise, signal);
      expect(await closeStaleClientVoiceSessions({ agentId: "main", config: {} })).toBe(0);
      releaseRead.resolve();
      await settleDigestAttempts();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(markerFailure.message));
      expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number));
    } finally {
      releaseRead.resolve();
      await settleDigestAttempts();
      captureSpy.mockRestore();
      warning.mockRestore();
    }
  });

  it.each(["different path", "same path replacement"] as const)(
    "isolates retained digests while recovering another physical store (%s)",
    async (replacement) => {
      const sessionKey = "agent:main:main";
      await seedSession(sessionKey, { channel: "discord", to: "channel:original-store" });
      const voiceSessionId = await createCompletedMutationSession();
      const originalPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const archivedPath = path.join(harness.stateDir, "original-agent.sqlite");
      const otherState =
        replacement === "different path"
          ? path.join(harness.stateDir, "other-state")
          : harness.stateDir;
      const env = captureEnv(["OPENCLAW_STATE_DIR"]);
      sendDurableMessageBatch.mockRejectedValueOnce(new Error("original channel offline"));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await closeClientVoiceSession({
          agentId: "main",
          sessionKey,
          voiceSessionId,
          config: {},
        });
        await settleDigestAttempts();
        expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
          active: 0,
          retained: 1,
        });
        if (replacement === "same path replacement") {
          await closeOpenClawAgentDatabasesAsync(harness.stateDir);
          await fs.rename(originalPath, archivedPath);
        } else {
          setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
        }
        await seedSession(sessionKey);
        const stale = await createVoiceSession({ sessionKey, now: 1 });
        expect(
          await closeStaleClientVoiceSessions({
            agentId: "main",
            config: {},
            now: 6 * 60 * 60_000 + 2,
          }),
        ).toBe(1);
        await settleDigestAttempts();
        expect(clientVoiceSessionTesting.readRecord("main", stale)?.status).toBe("closed");
        expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
          active: 0,
          retained: 1,
        });
        expect(sendDurableMessageBatch).toHaveBeenCalledOnce();

        await createVoiceSession({ sessionKey, voiceSessionId });
        await expect(
          closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} }),
        ).rejects.toThrow("physical source");
        expect(sendDurableMessageBatch).toHaveBeenCalledOnce();

        if (replacement === "same path replacement") {
          await closeOpenClawAgentDatabasesAsync(harness.stateDir);
          await fs.rename(originalPath, path.join(harness.stateDir, "replacement-agent.sqlite"));
          await fs.rename(archivedPath, originalPath);
        }
        env.restore();
        await closeStaleClientVoiceSessions({ agentId: "main", config: {} });
        await settleDigestAttempts();
        expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
        expect(sendDurableMessageBatch).toHaveBeenLastCalledWith(
          expect.objectContaining({ to: "channel:original-store" }),
        );
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toEqual(expect.any(Number));
      } finally {
        vi.useRealTimers();
        env.restore();
        if (otherState !== harness.stateDir) {
          await cleanupSessionStateForTest({ stateDir: otherState });
        }
      }
    },
  );

  it("recovers current stale calls after shared storage retires a failed digest context", async ({
    signal,
  }) => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey, { channel: "discord", to: "channel:retired-digest" });
    const retired = await createOrResumeClientVoiceSession({ ...target, origin: "client", now: 1 });
    await recordMutation(retired);
    await completeRun(`run-${retired}`);
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));
    const failed = createDeferred();
    const warning = vi.spyOn(console, "warn").mockImplementation((message) => {
      if (String(message).includes("channel offline")) {
        failed.resolve();
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await closeClientVoiceSession({ ...target, voiceSessionId: retired, config: {} });
      await withinTest(failed.promise, signal);
      await settleDigestAttempts();
      expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
        pending: 0,
        retained: 1,
      });
      expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
      const agentPath = resolveOpenClawAgentSqlitePath(target);
      const identity = readDatabasePathIdentitySync(agentPath);

      // Retain the digest owner and agent file while replacing only shared-store admission.
      await closeOpenClawStateDatabaseAsync();
      expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
        active: 0,
        retained: 1,
      });
      openOpenClawStateDatabase();
      const stale = await createOrResumeClientVoiceSession({ ...target, origin: "client", now: 1 });
      expect(readDatabasePathIdentitySync(agentPath)).toEqual(identity);
      await expect(
        closeStaleClientVoiceSessions({
          agentId: target.agentId,
          config: {},
          now: 6 * 60 * 60_000 + 2,
        }),
      ).resolves.toBe(1);
      await settleDigestAttempts();
      expect(clientVoiceSessionTesting.readRecord(target.agentId, stale)?.status).toBe("closed");
      expect(
        clientVoiceSessionTesting.readRecord(target.agentId, retired)?.digestDeliveredAt,
      ).toBeUndefined();
      expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
      expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
        active: 0,
        pending: 0,
        retained: 1,
      });
      await vi.advanceTimersByTimeAsync(
        clientVoiceSessionTesting.digestDeliveryPolicy.failureRetentionMs + 1,
      );
      expect(clientVoiceSessionTesting.digestDeliverySnapshot().retained).toBe(0);
      expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { phase: "recovery", replacement: false },
    { phase: "recovery", replacement: true },
    { phase: "publication", replacement: false },
    { phase: "publication", replacement: true },
  ])(
    "does not open a displaced metadata file after $phase (replacement=$replacement)",
    async ({ phase, replacement }) => {
      const target = { agentId: "main", sessionKey: "agent:main:main" };
      await seedSession(target.sessionKey);
      const voiceSessionId = await createVoiceSession({ now: 1 });
      const metadataPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const displace = async () => {
        await closeOpenClawAgentDatabasesAsync(harness.stateDir);
        await fs.rename(metadataPath, `${metadataPath}.displaced`);
        if (replacement) {
          await fs.writeFile(metadataPath, new Uint8Array());
        }
      };
      const lookup = voiceSessionReads.lookupClientVoiceSessions;
      const publish = sessionEvents.publishTranscriptUpdate;
      const boundary =
        phase === "recovery"
          ? vi
              .spyOn(voiceSessionReads, "lookupClientVoiceSessions")
              .mockImplementationOnce(async (...args) => {
                const candidates = await lookup(...args);
                await displace();
                return candidates;
              })
          : vi
              .spyOn(sessionEvents, "publishTranscriptUpdate")
              .mockImplementationOnce(async (...args) => {
                const result = await publish(...args);
                await displace();
                return result;
              });
      try {
        if (phase === "recovery") {
          const warn = vi.fn();
          expect(
            await closeStaleClientVoiceSessions({
              agentId: "main",
              config: {},
              now: 6 * 60 * 60_000 + 2,
              warn,
            }),
          ).toBe(0);
          expect(warn).toHaveBeenCalledOnce();
        } else {
          await expect(
            appendClientVoiceTranscript({
              ...target,
              sessionTarget: { sessionKey: target.sessionKey },
              voiceSessionId,
              entryId: "before-replacement",
              role: "user",
              text: "persisted before replacement",
            }),
          ).rejects.toThrow("Agent database execution admission is closed");
        }
        expect(boundary).toHaveBeenCalledOnce();
        if (replacement) {
          expect(await fs.readFile(metadataPath)).toHaveLength(0);
        } else {
          await expect(fs.stat(metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        boundary.mockRestore();
      }
    },
  );
});
