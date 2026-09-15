import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  captureClientVoiceSessionStore,
  readVoiceSessionRecord,
  writeVoiceSessionRecordInTransaction,
} from "./client-voice-session-store.js";
import {
  appendClientVoiceTranscript,
  closeClientVoiceSession,
  flushClientVoiceSessionWrites,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const send = vi.hoisted(() =>
  vi.fn(async (_request: { to: string; cfg: unknown }) => ({ status: "sent" })),
);
vi.mock("../channels/message/runtime.js", () => ({ sendDurableMessageBatchCore: send }));

afterEach(() => {
  clientVoiceSessionTesting.reset();
  send.mockClear();
});

describe("voice close digest store custody", () => {
  it.each(["close-wait", "consult-wait"] as const)(
    "keeps its original record and delivery target after a root change during %s",
    async (wait) => {
      await withOpenClawTestState({ label: "voice-digest-store-custody" }, async (state) => {
        const agentId = "main";
        const sessionKey = "agent:main:voice";
        const voiceSessionId = "same-voice-id";
        const config = { agents: { defaults: { workspace: "/synthetic/root-a" } } };
        const seed = async (stateDir: string, to: string, closed: boolean) => {
          process.env.OPENCLAW_STATE_DIR = stateDir;
          const store = captureClientVoiceSessionStore(agentId);
          await replaceSessionEntry(
            { agentId, sessionKey },
            {
              sessionId: `session-${to}`,
              updatedAt: 1,
              delivery: normalizeSessionDeliveryState({ context: { channel: "discord", to } }),
            },
          );
          createOrResumeClientVoiceSession({
            agentId,
            sessionKey,
            voiceSessionId,
            origin: "client",
          });
          const record = readVoiceSessionRecord(agentId, voiceSessionId)!;
          record.status = closed ? "closed" : "open";
          record.effects.push({
            runId: "synthetic-effect",
            toolName: "write",
            startedAt: 1,
            finishedAt: 2,
            status: "succeeded",
          });
          runOpenClawAgentWriteTransaction(
            (database) => writeVoiceSessionRecordInTransaction(database, record),
            store,
          );
          return store;
        };
        const first = await seed(state.stateDir, "channel:root-a", false);
        const second = await seed(state.statePath("root-b"), "channel:root-b", true);
        process.env.OPENCLAW_STATE_DIR = state.stateDir;
        if (wait === "consult-wait") {
          registerClientVoiceConsultRun({
            agentId,
            sessionKey,
            voiceSessionId,
            runId: "live-consult",
          });
          await closeClientVoiceSession({ agentId, sessionKey, voiceSessionId, config });
          await vi.waitFor(() =>
            expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
              active: 0,
              retained: 1,
            }),
          );
          process.env.OPENCLAW_STATE_DIR = second.env.OPENCLAW_STATE_DIR;
          await closeStaleClientVoiceSessions({
            agentId,
            config: { agents: { defaults: { workspace: "/synthetic/root-b" } } },
          });
          emitTrustedDiagnosticEvent({
            type: "run.completed",
            runId: "live-consult",
            durationMs: 1,
            outcome: "completed",
          });
          await waitForDiagnosticEventsDrained();
        } else {
          const gate = createDeferredCore();
          const entered = createDeferredCore();
          const held = runExclusiveSqliteSessionWrite(
            first,
            () => {
              entered.resolve();
              return gate.promise;
            },
            "session.transcript.locked-write",
          );
          await entered.promise;
          const closing = closeClientVoiceSession({
            agentId,
            sessionKey,
            voiceSessionId,
            config,
          });
          void closing.catch(() => {});
          try {
            await setImmediate();
            process.env.OPENCLAW_STATE_DIR = second.env.OPENCLAW_STATE_DIR;
          } finally {
            gate.resolve();
            await Promise.all([held, closing]);
          }
        }
        try {
          await vi.waitFor(() =>
            expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
              active: 0,
              retained: 0,
            }),
          );
          expect(send.mock.calls.map(([request]) => request.to)).toEqual(["channel:root-a"]);
          expect(send.mock.calls[0]?.[0].cfg).toEqual(config);
          expect(readVoiceSessionRecord(agentId, voiceSessionId, first)?.digestDeliveredAt).toEqual(
            expect.any(Number),
          );
          expect(
            readVoiceSessionRecord(agentId, voiceSessionId, second)?.digestDeliveredAt,
          ).toBeUndefined();
        } finally {
          process.env.OPENCLAW_STATE_DIR = state.stateDir;
        }
      });
    },
  );

  it("pins a relative state directory in the captured environment", async () => {
    await withOpenClawTestState({ label: "voice-relative-state" }, async (state) => {
      process.env.OPENCLAW_STATE_DIR = path.relative(process.cwd(), state.stateDir);
      const store = captureClientVoiceSessionStore("main");
      expect(store.env?.OPENCLAW_STATE_DIR).toBe(state.stateDir);
    });
  });
  it("keeps every stale recovery close on the store that was scanned", async () => {
    await withOpenClawTestState({ label: "voice-recovery-store" }, async (state) => {
      const agentId = "main";
      const sessionKey = "agent:main:voice";
      const first = captureClientVoiceSessionStore(agentId);
      for (const voiceSessionId of ["a-blocker", "b-target"]) {
        createOrResumeClientVoiceSession({
          agentId,
          sessionKey,
          voiceSessionId,
          origin: "client",
          now: 1,
        });
      }
      process.env.OPENCLAW_STATE_DIR = state.statePath("root-b");
      const second = captureClientVoiceSessionStore(agentId);
      createOrResumeClientVoiceSession({
        agentId,
        sessionKey,
        voiceSessionId: "b-target",
        origin: "client",
        now: Date.now(),
      });
      process.env.OPENCLAW_STATE_DIR = state.stateDir;
      const gate = createDeferredCore();
      const entered = createDeferredCore();
      const held = runExclusiveSqliteSessionWrite(
        first,
        () => {
          entered.resolve();
          return gate.promise;
        },
        "session.transcript.locked-write",
      );
      await entered.promise;
      const recovery = closeStaleClientVoiceSessions({
        agentId,
        config: {},
        now: 6 * 60 * 60_000 + 2,
      });
      void recovery.catch(() => {});
      try {
        await setImmediate();
        process.env.OPENCLAW_STATE_DIR = second.env.OPENCLAW_STATE_DIR;
      } finally {
        gate.resolve();
        await Promise.all([held, recovery]);
        process.env.OPENCLAW_STATE_DIR = state.stateDir;
      }
      expect(await recovery).toBe(2);
      expect(readVoiceSessionRecord(agentId, "b-target", first)?.status).toBe("closed");
      expect(readVoiceSessionRecord(agentId, "b-target", second)?.status).toBe("open");
      await vi.waitFor(() =>
        expect(clientVoiceSessionTesting.digestDeliverySnapshot().active).toBe(0),
      );
    });
  });

  it.each(["close", "transcript", "flush"] as const)(
    "settles %s independently of a same-ID close in another store",
    async (operation) => {
      await withOpenClawTestState({ label: "voice-operation-store" }, async (state) => {
        const agentId = "main";
        const sessionKey = "agent:main:voice";
        const voiceSessionId = "same-voice";
        const first = captureClientVoiceSessionStore(agentId);
        await replaceSessionEntry(
          { agentId, sessionKey },
          { sessionId: "first-chat", updatedAt: 1 },
        );
        createOrResumeClientVoiceSession({ agentId, sessionKey, voiceSessionId, origin: "client" });
        process.env.OPENCLAW_STATE_DIR = state.statePath("root-b");
        const second = captureClientVoiceSessionStore(agentId);
        await replaceSessionEntry(
          { agentId, sessionKey },
          { sessionId: "second-chat", updatedAt: 1 },
        );
        createOrResumeClientVoiceSession({ agentId, sessionKey, voiceSessionId, origin: "client" });
        process.env.OPENCLAW_STATE_DIR = state.stateDir;
        const gate = createDeferredCore();
        const entered = createDeferredCore();
        const held = runExclusiveSqliteSessionWrite(
          first,
          () => {
            entered.resolve();
            return gate.promise;
          },
          "session.transcript.locked-write",
        );
        await entered.promise;
        const firstAppend = appendClientVoiceTranscript({
          agentId,
          sessionKey,
          voiceSessionId,
          sessionTarget: { sessionKey, storePath: first.path },
          entryId: "first-final",
          role: "user",
          text: "Synthetic root A speech",
        });
        void firstAppend.catch(() => {});
        const firstClose = closeClientVoiceSession({
          agentId,
          sessionKey,
          voiceSessionId,
          config: {},
        });
        void firstClose.catch(() => {});
        process.env.OPENCLAW_STATE_DIR = second.env.OPENCLAW_STATE_DIR;
        let settled = false;
        const secondOperation = (
          operation === "close"
            ? closeClientVoiceSession({ agentId, sessionKey, voiceSessionId, config: {} })
            : operation === "flush"
              ? flushClientVoiceSessionWrites({ agentId, voiceSessionId })
              : appendClientVoiceTranscript({
                  agentId,
                  sessionKey,
                  voiceSessionId,
                  sessionTarget: { sessionKey, storePath: second.path },
                  entryId: "second-final",
                  role: "user",
                  text: "Synthetic root B speech",
                })
        ).then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => error,
        );
        try {
          await vi.waitFor(() => expect(settled).toBe(true));
          expect(readVoiceSessionRecord(agentId, voiceSessionId, first)?.status).toBe("open");
          expect(readVoiceSessionRecord(agentId, voiceSessionId, second)).toMatchObject(
            operation === "close"
              ? { status: "closed" }
              : operation === "transcript"
                ? { status: "open", hasUserTranscript: true }
                : { status: "open" },
          );
        } finally {
          gate.resolve();
          await Promise.all([held, firstAppend, firstClose, secondOperation]);
          await vi.waitFor(() =>
            expect(clientVoiceSessionTesting.digestDeliverySnapshot().active).toBe(0),
          );
          process.env.OPENCLAW_STATE_DIR = state.stateDir;
        }
        expect(await secondOperation).toBeUndefined();
      });
    },
  );
  it.each(["none", "before-speech", "after-speech"] as const)(
    "preserves resumed-call speech accepted before an explicit hangup (hangup=%s)",
    async (hangup) => {
      const explicit = hangup !== "none";
      await withOpenClawTestState({ label: "voice-resumed-recovery" }, async () => {
        const agentId = "main";
        const sessionKey = "agent:main:voice";
        const voiceSessionId = "resumed-voice";
        const store = captureClientVoiceSessionStore(agentId);
        const sessionTarget = { agentId, sessionKey, storePath: store.path };
        const sessionId = "resumed-chat";
        await replaceSessionEntry(sessionTarget, { sessionId, updatedAt: 1 });
        createOrResumeClientVoiceSession({
          agentId,
          sessionKey,
          voiceSessionId,
          origin: "client",
          now: 1,
        });
        const gate = createDeferredCore();
        const entered = createDeferredCore();
        const held = runExclusiveSqliteSessionWrite(
          store,
          () => {
            entered.resolve();
            return gate.promise;
          },
          "session.transcript.locked-write",
        );
        await entered.promise;
        const now = 6 * 60 * 60_000 + 2;
        const recovery = closeStaleClientVoiceSessions({ agentId, config: {}, now });
        void recovery.catch(() => {});
        let explicitClose: Promise<void> | undefined;
        let transcript: Promise<unknown> | undefined;
        try {
          await setImmediate();
          expect(
            createOrResumeClientVoiceSession({
              agentId,
              sessionKey,
              voiceSessionId,
              origin: "client",
              now,
            }),
          ).toBe(voiceSessionId);
          const close = () =>
            closeClientVoiceSession({
              agentId,
              sessionKey,
              voiceSessionId,
              config: {},
            });
          if (hangup === "before-speech") {
            explicitClose = close();
          }
          transcript = appendClientVoiceTranscript({
            agentId,
            sessionKey,
            voiceSessionId,
            sessionTarget,
            entryId: "resumed-final",
            role: "user",
            text: "Synthetic resumed final speech",
          }).catch((error: unknown) => error);
          if (hangup === "after-speech") {
            explicitClose = close();
          }
          if (explicitClose) {
            void explicitClose.catch(() => {});
          }
        } finally {
          gate.resolve();
          await Promise.all([held, recovery, explicitClose, transcript]);
        }
        const messages = readSessionTranscriptMessageEvents({ ...sessionTarget, sessionId });
        if (!explicit) {
          expect(await recovery).toBe(0);
        }
        if (hangup !== "before-speech") {
          expect(await transcript).toBeUndefined();
          expect(messages).toHaveLength(1);
          expect(JSON.stringify(messages[0])).toContain("Synthetic resumed final speech");
        } else {
          expect(await transcript).toBeInstanceOf(Error);
          expect(messages).toEqual([]);
        }
        expect(readVoiceSessionRecord(agentId, voiceSessionId, store)?.status).toBe(
          explicit ? "closed" : "open",
        );
        expect(clientVoiceSessionTesting.digestDeliverySnapshot()).toMatchObject({
          active: 0,
          retained: 0,
        });
      });
    },
  );
});
