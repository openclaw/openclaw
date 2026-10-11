import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { patchSessionEntryCore, replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { acquireSessionInputActor, bindUserTurnInputActor } from "./session-input-actor.js";
import { recordSessionParticipantInWorker } from "./session-sharing-store.async.js";

it.each(["stage", "acceptInput", "adoptRun"] as const)(
  "persists concurrent initial inputs exactly once when participant recording precedes %s admission",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, async (_, index) => {
          const scope = {
            agentId: "main",
            storePath: database.path,
            sessionKey: `agent:main:concurrent-${index}`,
            sessionId: `concurrent-${index}`,
          };
          const entry = { sessionId: scope.sessionId, updatedAt: 1 };
          await replaceSessionEntry(scope, entry);
          const input = expectDefined(
            await acquireSessionInputActor(
              {
                ...scope,
                target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
              },
              { assertCurrent() {}, assertReadable() {} },
            ),
            "created session actor",
          );
          const message = {
            role: "user" as const,
            content: `Initial input ${index}`,
            timestamp: 1,
            idempotencyKey: `concurrent-${index}:user`,
          };
          const recorder = createUserTurnTranscriptRecorder({
            message,
            target: { ...scope, expectedSessionId: scope.sessionId, sessionEntry: entry },
            updateMode: "none",
          });
          bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
          const recordParticipant = () =>
            recordSessionParticipantInWorker(scope, {
              identity: {
                type: "observation",
                pluginId: null,
                accountId: null,
                senderKind: "unknown",
                id: "gateway-client",
              },
              promptedAt: 1,
              sessionAgentId: scope.agentId,
            });
          // The reply path schedules this writer without awaiting it before run adoption.
          if (phase === "adoptRun") {
            const adopt = input.actor.adoptRun;
            vi.spyOn(input.actor, "adoptRun").mockImplementationOnce(async (...args) => {
              await recordParticipant();
              return adopt(...args);
            });
          } else {
            const accept = input.actor.acceptInput;
            vi.spyOn(input.actor, "acceptInput").mockImplementationOnce(async (...args) => {
              await recordParticipant();
              return accept(...args);
            });
          }
          try {
            if (phase !== "acceptInput") {
              await expect(
                recorder.stageApproved?.({ runId: `run-${index}`, assertCurrent() {} }),
              ).resolves.toBe(true);
              bindUserTurnInputActor(recorder, { phase: "adoptRun", acquire: async () => input });
            }
            await expect(recorder.persistApproved()).resolves.toMatchObject({ appended: true });
            await recorder.persistFallback();
            expect(
              readTranscriptEventRows(database, scope.sessionId)
                .map((row) => JSON.parse(row.eventJson))
                .filter((event) => event.type === "message"),
            ).toEqual([expect.objectContaining({ message })]);
          } finally {
            try {
              recorder.finishPendingInput?.("interrupted");
              await recorder.waitForPendingInputSettlement?.();
            } finally {
              await input.actor.release();
            }
          }
        }),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          throw outcome.reason;
        }
      }
    });
  },
);

it.each(["lifecycle", "authority"] as const)(
  "refuses run adoption when %s changes during version rebasing",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = createSessionCompoundWorkerFixture();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Input authority revoked");
        }
      };
      const input = expectDefined(
        await acquireSessionInputActor(
          { ...f.scope, target: f.target },
          { assertCurrent, assertReadable: assertCurrent },
        ),
        "admitted session actor",
      );
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "Keep the original admission", idempotencyKey: "fenced-input" },
        target: { ...f.scope, expectedSessionId: f.scope.sessionId, sessionEntry: f.read() },
        updateMode: "none",
      });
      bindUserTurnInputActor(recorder, { phase: "adoptRun", acquire: async () => input });
      const adopt = input.actor.adoptRun;
      vi.spyOn(input.actor, "adoptRun").mockImplementationOnce(async (...args) => {
        await patchSessionEntryCore(f.scope, () =>
          change === "lifecycle" ? { abortedLastRun: true } : { displayName: "Updated" },
        );
        const outcome = await adopt(...args);
        expect(outcome.kind).toBe("stale-version");
        current = change !== "authority";
        return outcome;
      });
      try {
        await expect(recorder.persistApproved()).rejects.toThrow(
          change === "lifecycle" ? "refused by its current owner" : "Input authority revoked",
        );
        expect(recorder.hasPersisted()).toBe(false);
        expect(f.events()).toEqual([]);
      } finally {
        await input.actor.release();
      }
    });
  },
);
