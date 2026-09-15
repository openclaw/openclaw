import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { deliverClientVoiceMutationDigest } from "./client-voice-mutation-digest-owner.js";
import {
  captureClientVoiceSessionStore,
  readVoiceSessionRecord,
  readVoiceSessionRecordRows,
  writeVoiceSessionRecordInTransaction,
} from "./client-voice-session-store.js";
import {
  appendClientVoiceTranscript,
  createOrResumeClientVoiceSession,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const mocks = vi.hoisted(() => ({
  beforeAppend: vi.fn(async () => {}),
  send: vi.fn(async () => ({ status: "sent" })),
}));
vi.mock("../channels/message/runtime.js", () => ({ sendDurableMessageBatchCore: mocks.send }));
vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    appendTranscriptMessage: async (...args: Parameters<typeof actual.appendTranscriptMessage>) => {
      await mocks.beforeAppend();
      return actual.appendTranscriptMessage(...args);
    },
  };
});

afterEach(() => {
  clientVoiceSessionTesting.reset();
  mocks.beforeAppend.mockReset().mockResolvedValue(undefined);
  mocks.send.mockReset().mockResolvedValue({ status: "sent" });
});

describe("Talk voice database admission", () => {
  it("leaves absent voice state absent during lookup", async () => {
    await withOpenClawTestState({ label: "voice-missing-read" }, async () => {
      const agentId = "absent";
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId });
      expect(readVoiceSessionRecord(agentId, "missing")).toBeUndefined();
      expect(readVoiceSessionRecordRows(agentId)).toEqual([]);
      expect(fs.existsSync(databasePath)).toBe(false);
    });
  });

  it.each([false, true])(
    "waits for the physical writer before reserving a transcript (cold=%s)",
    async (cold) => {
      await withOpenClawTestState({ label: "voice-reservation-admission" }, async () => {
        const agentId = "main";
        const sessionKey = "agent:main:voice";
        const database = openOpenClawAgentDatabase({ agentId });
        await replaceSessionEntry(
          { agentId, sessionKey, storePath: database.path },
          { sessionId: "voice-chat", updatedAt: 1 },
        );
        const voiceSessionId = createOrResumeClientVoiceSession({
          agentId,
          sessionKey,
          origin: "client",
        });
        if (cold) {
          closeOpenClawAgentDatabasesForTest();
        }
        const gate = createDeferredCore();
        const entered = createDeferredCore();
        const held = runExclusiveSqliteSessionWrite(
          { agentId, path: database.path },
          () => {
            entered.resolve();
            return gate.promise;
          },
          "session.transcript.locked-write",
        );
        await entered.promise;
        const append = appendClientVoiceTranscript({
          agentId,
          sessionKey,
          sessionTarget: { sessionKey, storePath: database.path },
          voiceSessionId,
          entryId: "final",
          role: "user",
          text: "Synthetic final utterance",
        });
        void append.catch(() => {});
        try {
          await setImmediate();
          expect(readVoiceSessionRecord(agentId, voiceSessionId)?.transcriptFailureKeys).toEqual(
            [],
          );
        } finally {
          gate.resolve();
          await Promise.all([held, append]);
        }
        expect(readVoiceSessionRecord(agentId, voiceSessionId)).toMatchObject({
          hasUserTranscript: true,
          transcriptFailureKeys: [],
        });
      });
    },
  );
  it.each(["request", "record", "session"] as const)(
    "rechecks %s ownership after the second writer wait before transcript insertion",
    async (revoked) => {
      await withOpenClawTestState({ label: "voice-append-authority" }, async () => {
        const agentId = "main";
        const sessionKey = "agent:main:voice";
        const database = openOpenClawAgentDatabase({ agentId });
        const target = { agentId, sessionKey, storePath: database.path };
        const sessionId = "voice-chat";
        await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
        const voiceSessionId = createOrResumeClientVoiceSession({
          agentId,
          sessionKey,
          origin: "client",
        });
        const gate = createDeferredCore();
        const entered = createDeferredCore();
        let held: Promise<void> | undefined;
        mocks.beforeAppend.mockImplementationOnce(async () => {
          held = runExclusiveSqliteSessionWrite(
            { agentId, path: database.path },
            () => {
              entered.resolve();
              return gate.promise;
            },
            "session.transcript.locked-write",
          );
          await entered.promise;
        });
        const controller = new AbortController();
        const append = appendClientVoiceTranscript({
          ...target,
          sessionTarget: target,
          voiceSessionId,
          entryId: "revoked",
          role: "user",
          text: "yes",
          assertCommitAllowed: () => controller.signal.throwIfAborted(),
        });
        const outcome = append.catch((error: unknown) => error);
        try {
          await entered.promise;
          await setImmediate();
          expect(
            readVoiceSessionRecord(agentId, voiceSessionId)?.transcriptFailureKeys,
          ).toHaveLength(1);
          if (revoked === "request") {
            controller.abort(new Error("request cancelled"));
          } else if (revoked === "record") {
            const record = readVoiceSessionRecord(agentId, voiceSessionId)!;
            record.status = "closed";
            runOpenClawAgentWriteTransaction(
              (db) => writeVoiceSessionRecordInTransaction(db, record),
              { agentId },
            );
          } else {
            replaceSessionEntrySync(target, { sessionId: "replacement-chat", updatedAt: 2 });
          }
        } finally {
          gate.resolve();
          await Promise.all([held, outcome]);
        }
        expect(await outcome).toBeInstanceOf(Error);
        expect(readSessionTranscriptMessageEvents({ ...target, sessionId })).toEqual([]);
        expect(readVoiceSessionRecord(agentId, voiceSessionId)?.hasUserTranscript).not.toBe(true);
      });
    },
  );

  it("records successful digest delivery on its original store after cancellation", async () => {
    await withOpenClawTestState({ label: "voice-digest-admission" }, async (state) => {
      const agentId = "main";
      const sessionKey = "agent:main:voice";
      openOpenClawAgentDatabase({ agentId });
      const store = captureClientVoiceSessionStore(agentId);
      await replaceSessionEntry(
        { agentId, sessionKey },
        {
          sessionId: "voice-digest",
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "discord", to: "channel:synthetic" },
          }),
        },
      );
      const voiceSessionId = createOrResumeClientVoiceSession({
        agentId,
        sessionKey,
        origin: "client",
      });
      const record = readVoiceSessionRecord(agentId, voiceSessionId)!;
      record.status = "closed";
      record.effects.push({
        runId: "synthetic",
        toolName: "write",
        startedAt: 1,
        finishedAt: 2,
        status: "succeeded",
      });
      runOpenClawAgentWriteTransaction(
        (db) => writeVoiceSessionRecordInTransaction(db, record),
        store,
      );
      const entered = createDeferredCore();
      const gate = createDeferredCore();
      let held: Promise<void> | undefined;
      mocks.send.mockImplementationOnce(async () => {
        held = runExclusiveSqliteSessionWrite(
          store,
          () => {
            entered.resolve();
            return gate.promise;
          },
          "session.transcript.locked-write",
        );
        await entered.promise;
        return { status: "sent" };
      });
      const controller = new AbortController();
      const delivery = deliverClientVoiceMutationDigest(record, {}, controller.signal, store);
      void delivery.catch(() => {});
      try {
        await entered.promise;
        await setImmediate();
        expect(
          readVoiceSessionRecord(agentId, voiceSessionId, store)?.digestDeliveredAt,
        ).toBeUndefined();
        controller.abort(new Error("transport ended after send"));
        process.env.OPENCLAW_STATE_DIR = state.statePath("other-root");
      } finally {
        gate.resolve();
        await Promise.all([held, delivery]);
        process.env.OPENCLAW_STATE_DIR = state.stateDir;
      }
      expect(readVoiceSessionRecord(agentId, voiceSessionId, store)?.digestDeliveredAt).toEqual(
        expect.any(Number),
      );
      expect(mocks.send).toHaveBeenCalledOnce();
    });
  });
});
