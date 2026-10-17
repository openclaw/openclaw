import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionEvents from "../config/sessions/session-accessor.sqlite-events.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { readSessionTranscriptBoundedMessageTailPageAsync } from "../gateway/session-transcript-readers.js";
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

const harness = useClientVoiceDigestHarness();
const target = { agentId: "main", sessionKey: "agent:main:main" };
const {
  sendDurableMessageBatch,
  settleDigestAttempts,
  seedDigest,
  holdSend,
  readRecord,
  closeVoice,
  recoverStale,
  expectRetained,
  recordEffect,
} = harness;

function fakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return { [Symbol.dispose]: () => vi.useRealTimers() };
}
const silenceWarnings = () => vi.spyOn(console, "warn").mockImplementation(() => {});
async function displaceMetadata(savedPath: string, replacement: boolean) {
  const metadataPath = resolveOpenClawAgentSqlitePath(target);
  await closeOpenClawAgentDatabasesAsync(harness.stateDir);
  await fs.rename(metadataPath, savedPath);
  if (replacement) {
    await fs.writeFile(metadataPath, new Uint8Array());
  }
}

function mockDigestWriter(
  configure: (writer: voiceWriters.ClientVoiceSessionWriter) => void,
  once = true,
) {
  const capture = voiceWriters.captureClientVoiceSessionWriter;
  let configured = false;
  return vi.spyOn(voiceWriters, "captureClientVoiceSessionWriter").mockImplementation((params) => {
    const writer = capture(params);
    if (params.physicalSource && (!once || !configured)) {
      configured = true;
      configure(writer);
    }
    return writer;
  });
}

it("records a missing conversation instead of silently completing its digest", async () => {
  const voiceSessionId = await createCompletedMutationSession();
  using _ = fakeTimers();
  using warning = silenceWarnings();
  const closing = prepareClientVoiceSessionClose();
  await closeVoice(voiceSessionId);
  await closing.drain();
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("conversation not found"));
  expect(sendDurableMessageBatch).not.toHaveBeenCalled();
  expectRetained();
});

it("does not retry an unknown digest marker when writer cleanup also fails", async () => {
  const voiceSessionId = await seedDigest("channel:unknown-marker");
  const unknown = new SqliteWorkerError("synthetic unknown digest marker", "outcome-unknown");
  const cleanupError = new Error("synthetic digest writer release failure");
  let attempts = 0;
  using _ = mockDigestWriter((writer) => {
    attempts += 1;
    vi.spyOn(writer, "mutate").mockRejectedValueOnce(unknown);
    const release = writer.release.bind(writer);
    vi.spyOn(writer, "release").mockImplementation(async () => {
      await release();
      throw cleanupError;
    });
  }, false);
  using warn = silenceWarnings();
  try {
    await closeVoice(voiceSessionId, target);
    await settleDigestAttempts();
    await closeVoice(voiceSessionId, target);
    await settleDigestAttempts();
    expect(attempts).toBe(1);
    expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("settlement is unknown"));
    expect(readRecord(voiceSessionId)).toMatchObject({ status: "closed" });
    expect(readRecord(voiceSessionId)?.digestDeliveredAt).toBeUndefined();
  } finally {
    await settleDigestAttempts();
  }
});

it.each(["absent", "obsolete"])(
  "delivers from a custom conversation store once through marker retry with an %s default row",
  async (defaultRow) => {
    const { sessionKey } = target;
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
    using _ = fakeTimers();
    using marker = mockDigestWriter((writer) => {
      vi.spyOn(writer, "mutate").mockRejectedValueOnce(
        new Error("synthetic delivery marker failure"),
      );
    });
    using warning = silenceWarnings();
    void marker;
    const firstClose = prepareClientVoiceSessionClose();
    await closeVoice(voiceSessionId, { config });
    await firstClose.drain();
    expect(sendDurableMessageBatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: "channel:custom-recipient" }),
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("synthetic delivery marker failure"),
    );
    expect(readRecord(voiceSessionId)?.digestDeliveredAt).toBeUndefined();

    const retryClose = prepareClientVoiceSessionClose();
    await closeVoice(voiceSessionId);
    await retryClose.drain();
    expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
    expect(readRecord(voiceSessionId)?.digestDeliveredAt).toEqual(expect.any(Number));
    expect(readVoiceSessionRecord("main", voiceSessionId, { path: storePath })).toBeUndefined();
  },
);

it.each(["current", "runtime-entry", "worker-preparation"] as const)(
  "checks prepared requester authority before native bootstrap (%s)",
  async (phase) => {
    await seedSession("agent:main:main");
    const coldTarget = { agentId: "cold-prepared", sessionKey: "agent:cold-prepared:main" };
    const writer = voiceWriters.captureClientVoiceSessionWriter(coldTarget);
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
          ...coldTarget,
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
      const present = await fs.stat(resolveOpenClawAgentSqlitePath(coldTarget)).then(
        () => true,
        () => false,
      );
      expect(present).toBe(phase === "current");
      using database = new DatabaseSync(resolveOpenClawStateSqlitePath(), { readOnly: true });
      expect(
        database
          .prepare("SELECT agent_id FROM agent_databases WHERE agent_id = ?")
          .all(coldTarget.agentId),
      ).toHaveLength(phase === "current" ? 1 : 0);
    } finally {
      opening.mockRestore();
      preparing.mockRestore();
      await writer.release();
    }
  },
);

it.each(["concurrent", "implicit", "alias", "retargeted-alias"] as const)(
  "keeps consult publication and cleanup on their captured source (%s)",
  async (mode) => {
    const voiceSessionId = "source-collision-voice";
    const runId = "source-collision-run";
    const binding = { ...target, voiceSessionId, runId };
    const otherState = path.join(harness.stateDir, "collision-state");
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    await seedSession(target.sessionKey);
    await createVoiceSession({ voiceSessionId });
    const writerA = voiceWriters.captureClientVoiceSessionWriter(target);
    const sourceA = writerA.source;
    setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
    await seedSession(target.sessionKey);
    await createVoiceSession({ voiceSessionId });
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
      recordEffect(runId, "source-collision-effect");
      await flushClientVoiceSessionWrites(binding, staysOriginal ? writerA : writerB);
      expect(
        [sourceA, sourceB].map(
          ({ options }) =>
            readVoiceSessionRecord("main", voiceSessionId, { env: options.env })?.effects.length,
        ),
      ).toEqual(staysOriginal ? [1, 0] : [0, 1]);
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
  const voiceSessionId = "same-voice-across-stores";
  const originalEnv = { OPENCLAW_STATE_DIR: harness.stateDir };
  const otherState = path.join(harness.stateDir, "other-state");
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  const runA = "original-store-run";
  const runB = "other-store-run";
  let releaseB: (() => void) | undefined;
  await seedSession(target.sessionKey, { channel: "discord", to: "channel:original-store" });
  await createVoiceSession({ voiceSessionId });
  await recordMutation(voiceSessionId, runA);
  await closeVoice(voiceSessionId, target);
  await settleDigestAttempts();
  expect(sendDurableMessageBatch).not.toHaveBeenCalled();
  try {
    setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
    await seedSession(target.sessionKey, { channel: "discord", to: "channel:other-store" });
    await createVoiceSession({ voiceSessionId });
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
    const voiceSessionId = await seedDigest("channel:marker-retry");
    const metadataPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const savedPath = `${metadataPath}.displaced`;
    const { sending, finishSend } = holdSend();
    using _ = fakeTimers();
    try {
      await closeVoice(voiceSessionId);
      await withinTest(sending.promise, signal);
      // Context replacement while send is active must share its later committed delivery fact.
      await closeVoice(voiceSessionId);
      await displaceMetadata(savedPath, replacement);
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
      await closeVoice(voiceSessionId);
      await settleDigestAttempts();
      expect({ untouched, sends: sendDurableMessageBatch.mock.calls.length }).toEqual({
        untouched: true,
        sends: 1,
      });
      expect(readRecord(voiceSessionId)?.digestDeliveredAt).toEqual(expect.any(Number));
    } finally {
      finishSend.resolve();
      await settleDigestAttempts();
    }
  },
);

it("shares a confirmed send across context refresh while the first read waits", async ({
  signal,
}) => {
  const voiceSessionId = await seedDigest("channel:read-refresh");
  const readStarted = createDeferred();
  const releaseRead = createDeferred();
  const markerFailure = new Error("synthetic marker refusal after confirmed send");
  using _ = mockDigestWriter((writer) => {
    const read = writer.read.bind(writer);
    vi.spyOn(writer, "read").mockImplementationOnce(async (id) => {
      readStarted.resolve();
      await releaseRead.promise;
      return read(id);
    });
    vi.spyOn(writer, "mutate").mockRejectedValueOnce(markerFailure);
  });
  using warning = silenceWarnings();
  try {
    await closeVoice(voiceSessionId, target);
    await withinTest(readStarted.promise, signal);
    expect(await recoverStale()).toBe(0);
    releaseRead.resolve();
    await settleDigestAttempts();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(markerFailure.message));
    expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
    expect(readRecord(voiceSessionId)?.digestDeliveredAt).toEqual(expect.any(Number));
  } finally {
    releaseRead.resolve();
    await settleDigestAttempts();
  }
});

it.each(["different path", "same path replacement"] as const)(
  "isolates retained digests while recovering another physical store (%s)",
  async (replacement) => {
    const { sessionKey } = target;
    const voiceSessionId = await seedDigest("channel:original-store");
    const originalPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const archivedPath = path.join(harness.stateDir, "original-agent.sqlite");
    const otherState =
      replacement === "different path"
        ? path.join(harness.stateDir, "other-state")
        : harness.stateDir;
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("original channel offline"));
    try {
      using _ = fakeTimers();
      await closeVoice(voiceSessionId, { sessionKey });
      await settleDigestAttempts();
      expectRetained();
      if (replacement === "same path replacement") {
        await closeOpenClawAgentDatabasesAsync(harness.stateDir);
        await fs.rename(originalPath, archivedPath);
      } else {
        setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
      }
      await seedSession(sessionKey);
      const stale = await createVoiceSession({ sessionKey, now: 1 });
      expect(await recoverStale({ now: 6 * 60 * 60_000 + 2 })).toBe(1);
      await settleDigestAttempts();
      expect(readRecord(stale)?.status).toBe("closed");
      expectRetained();
      expect(sendDurableMessageBatch).toHaveBeenCalledOnce();

      await createVoiceSession({ sessionKey, voiceSessionId });
      await expect(closeVoice(voiceSessionId, { sessionKey })).rejects.toThrow("physical source");
      expect(sendDurableMessageBatch).toHaveBeenCalledOnce();

      if (replacement === "same path replacement") {
        await closeOpenClawAgentDatabasesAsync(harness.stateDir);
        await fs.rename(originalPath, path.join(harness.stateDir, "replacement-agent.sqlite"));
        await fs.rename(archivedPath, originalPath);
      }
      env.restore();
      await recoverStale();
      await settleDigestAttempts();
      expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
      expect(sendDurableMessageBatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ to: "channel:original-store" }),
      );
      expect(readRecord(voiceSessionId)?.digestDeliveredAt).toEqual(expect.any(Number));
    } finally {
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
  await seedSession(target.sessionKey, { channel: "discord", to: "channel:retired-digest" });
  const retired = await createVoiceSession({ now: 1 });
  await recordMutation(retired);
  await completeRun(`run-${retired}`);
  sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));
  const failed = createDeferred();
  using _ = fakeTimers();
  using warning = vi.spyOn(console, "warn").mockImplementation((message) => {
    if (String(message).includes("channel offline")) {
      failed.resolve();
    }
  });
  void warning;
  await closeVoice(retired, target);
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
  expectRetained();
  openOpenClawStateDatabase();
  const stale = await createVoiceSession({ now: 1 });
  expect(readDatabasePathIdentitySync(agentPath)).toEqual(identity);
  await expect(recoverStale({ now: 6 * 60 * 60_000 + 2 })).resolves.toBe(1);
  await settleDigestAttempts();
  expect(readRecord(stale)?.status).toBe("closed");
  expect(readRecord(retired)?.digestDeliveredAt).toBeUndefined();
  expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
  expectRetained(0);
  await vi.advanceTimersByTimeAsync(
    clientVoiceSessionTesting.digestDeliveryPolicy.failureRetentionMs + 1,
  );
  expect(clientVoiceSessionTesting.digestDeliverySnapshot().retained).toBe(0);
  expect(sendDurableMessageBatch).toHaveBeenCalledOnce();
});

it.each([
  { phase: "recovery", replacement: false },
  { phase: "recovery", replacement: true },
  { phase: "publication", replacement: false },
  { phase: "publication", replacement: true },
])(
  "leaves displaced metadata untouched after $phase (replacement=$replacement)",
  async ({ phase, replacement }) => {
    await seedSession(target.sessionKey);
    const voiceSessionId = await createVoiceSession({ now: 1 });
    const metadataPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const savedPath = `${metadataPath}.displaced`;
    const afterDisplacement = <A extends unknown[], R>(operation: (...args: A) => Promise<R>) => {
      return async (...args: A) => {
        const result = await operation(...args);
        await displaceMetadata(savedPath, replacement);
        return result;
      };
    };
    const lookup = afterDisplacement(voiceSessionReads.lookupClientVoiceSessions);
    const publish = afterDisplacement(sessionEvents.publishTranscriptUpdate);
    using boundary =
      phase === "recovery"
        ? vi.spyOn(voiceSessionReads, "lookupClientVoiceSessions").mockImplementationOnce(lookup)
        : vi.spyOn(sessionEvents, "publishTranscriptUpdate").mockImplementationOnce(publish);
    if (phase === "recovery") {
      const warn = vi.fn();
      expect(await recoverStale({ now: 6 * 60 * 60_000 + 2, warn })).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    } else {
      // Transcript and voice confirmation commit together before publication.
      await expect(
        appendClientVoiceTranscript({
          ...target,
          sessionTarget: { sessionKey: target.sessionKey },
          voiceSessionId,
          entryId: "before-replacement",
          role: "user",
          text: "persisted before replacement",
        }),
      ).resolves.toBeUndefined();
    }
    expect(boundary).toHaveBeenCalledOnce();
    if (replacement) {
      expect(await fs.readFile(metadataPath)).toHaveLength(0);
    } else {
      await expect(fs.stat(metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    if (phase === "publication") {
      await fs.rm(metadataPath, { force: true });
      await fs.rename(savedPath, metadataPath);
      expect(readVoiceSessionRecord("main", voiceSessionId)).toMatchObject({
        sessionKey: target.sessionKey,
        hasUserTranscript: true,
        transcriptFailureKeys: [],
      });
      const sessionId = await voiceSessionReads.resolveClientVoiceAgentSessionId(target);
      assert(sessionId);
      const transcript = await readSessionTranscriptBoundedMessageTailPageAsync(
        { ...target, sessionId },
        { maxBytes: 4096, maxMessages: 10, offset: 0 },
      );
      expect(transcript.events).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({
            message: expect.objectContaining({
              role: "user",
              content: [{ type: "text", text: "persisted before replacement" }],
            }),
          }),
        }),
      ]);
    }
  },
);
