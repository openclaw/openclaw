import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionEvents from "../config/sessions/session-accessor.sqlite-events.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { prepareClientVoiceSessionClose } from "./client-voice-session-lifecycle.js";
import * as voiceSessionReads from "./client-voice-session-read.js";
import * as voiceSessionStore from "./client-voice-session-store.js";
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
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

// Install digest mocks before the persistence graph loads.
const { useClientVoiceDigestHarness, withClientVoiceDigestSettlement } = await vi.hoisted(
  () => import("./client-voice-session.digest-harness.test-support.js"),
);

describe("client voice digest physical sources", () => {
  const harness = useClientVoiceDigestHarness();
  const { sendDurableMessageBatch } = harness;

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
      const write = voiceSessionStore.writeVoiceSessionRecordInTransaction;
      let failMarker = true;
      const marker = vi
        .spyOn(voiceSessionStore, "writeVoiceSessionRecordInTransaction")
        .mockImplementation((database, record) => {
          if (record.digestDeliveredAt && failMarker) {
            failMarker = false;
            throw new Error("synthetic delivery marker failure");
          }
          return write(database, record);
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
        expect(
          voiceSessionStore.readVoiceSessionRecord("main", voiceSessionId, { path: storePath }),
        ).toBeUndefined();
      } finally {
        marker.mockRestore();
        warning.mockRestore();
        vi.useRealTimers();
      }
    },
  );

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
        await vi.advanceTimersByTimeAsync(0);
        const afterMarker = await fs.stat(metadataPath).catch((error: unknown) => {
          expect(error).toMatchObject({ code: "ENOENT" });
          return undefined;
        });
        const untouched = replacement ? afterMarker?.size === 0 : afterMarker === undefined;
        await closeOpenClawAgentDatabasesAsync(harness.stateDir);
        await fs.rm(metadataPath, { force: true });
        await fs.rename(savedPath, metadataPath);
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
        await vi.advanceTimersByTimeAsync(0);
        expect({ untouched, sends: sendDurableMessageBatch.mock.calls.length }).toEqual({
          untouched: true,
          sends: 1,
        });
        expect(
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
        ).toEqual(expect.any(Number));
      } finally {
        finishSend.resolve();
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    },
  );

  it.each(["different path", "same path replacement"] as const)(
    "isolates retained digests while recovering another physical store (%s)",
    async (replacement) => {
      await withClientVoiceDigestSettlement(async (settle) => {
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
          await settle();
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
          const stale = createVoiceSession({ now: 1 });
          expect(
            await closeStaleClientVoiceSessions({
              agentId: "main",
              config: {},
              now: 6 * 60 * 60_000 + 2,
            }),
          ).toBe(1);
          await vi.advanceTimersByTimeAsync(0);
          expect(clientVoiceSessionTesting.readRecord("main", stale)?.status).toBe("closed");
          expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
            active: 0,
            retained: 1,
          });
          expect(sendDurableMessageBatch).toHaveBeenCalledOnce();

          createVoiceSession({ voiceSessionId });
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
          await settle();
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
      });
    },
  );

  it("recovers current stale calls after shared storage retires a failed digest context", async ({
    signal,
  }) => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(target.sessionKey, { channel: "discord", to: "channel:retired-digest" });
    const retired = createOrResumeClientVoiceSession({ ...target, origin: "client", now: 1 });
    recordMutation(retired);
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
      const stale = createOrResumeClientVoiceSession({ ...target, origin: "client", now: 1 });
      expect(readDatabasePathIdentitySync(agentPath)).toEqual(identity);
      await expect(
        closeStaleClientVoiceSessions({
          agentId: target.agentId,
          config: {},
          now: 6 * 60 * 60_000 + 2,
        }),
      ).resolves.toBe(1);
      await vi.advanceTimersByTimeAsync(0);
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
      const voiceSessionId = createVoiceSession({ now: 1 });
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
          ).rejects.toThrow(/identity|ENOENT/);
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
